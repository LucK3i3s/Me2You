// Me2You.mjs
// All-in-one Me2You: mic -> FFT -> message -> log -> web/SSE/TTS/file-fallback
// Usage: node Me2You.mjs
import express from "express";
import fs from "fs";
import { fft } from "fft-js";
import record from "node-record-lpcm16";
import { exec } from "child_process";
import path from "path";
import os from "os";

// ------------- CONFIG -------------
const SAMPLE_RATE = 16000;
const FRAME_SIZE = 2048;
const LOG_FILE = "me2you_log.txt";
const PORT = process.env.PORT ? Number(process.env.PORT) : 3000;
const MIN_GOOD_MAG = 1000;  // magnitude threshold to treat as "real"
const ENABLE_TTS = process.env.ME2YOU_TTS === "1"; // enable termux-tts if set
const ENABLE_FILE_FALLBACK = process.env.ME2YOU_FILEMODE === "1"; // set to 1 to process WAVs from recordings/
const WEBHOOK_ON_MESSAGE = process.env.ME2YOU_WEBHOOK || ""; // optional webhook to POST new message to

// ------------- STATE -------------
let lastMessage = "No signal detected yet.";
let lastFreq = 0;
let lastMag = 0;
let clients = []; // SSE clients

// ------------- HELPERS -------------
function appendLog(line) {
  try {
    fs.appendFileSync(LOG_FILE, line + "\n");
  } catch (e) {
    console.error("Log write failed:", e && e.message ? e.message : e);
  }
}

function nowISO() {
  return new Date().toISOString();
}

function bufferToSamples(buffer) {
  const sampleCount = Math.floor(buffer.length / 2);
  const samples = new Array(sampleCount);
  for (let i = 0; i < sampleCount; i++) {
    samples[i] = buffer.readInt16LE(i * 2) / 32768;
  }
  return samples;
}

function runFFTOnSamples(samples) {
  if (samples.length < FRAME_SIZE) {
    samples = samples.concat(new Array(FRAME_SIZE - samples.length).fill(0));
  } else if (samples.length > FRAME_SIZE) {
    samples = samples.slice(0, FRAME_SIZE);
  }
  const phasors = fft(samples);
  const mags = phasors.map(([r, i]) => Math.sqrt(r * r + i * i));
  return mags;
}

function getDominantFrequency(mags, sampleRate) {
  const half = Math.floor(mags.length / 2);
  let max = -Infinity;
  let idx = 0;
  for (let i = 1; i < half; i++) {
    if (mags[i] > max) {
      max = mags[i];
      idx = i;
    }
  }
  const freq = idx * (sampleRate / mags.length);
  return { freq, magnitude: max };
}

function interpretYesNo(freq) {
  if (!freq || isNaN(freq)) return "MAYBE";
  if (freq > 1000) return "YES";
  if (freq < 200) return "NO";
  return "MAYBE";
}

function mapColor(freq) {
  if (!freq || isNaN(freq)) return "Gray";
  if (freq < 300) return "Red";
  if (freq < 700) return "Green";
  if (freq < 1500) return "Blue";
  return "Violet";
}

function generateMessage(freq, yesNo, color, mag) {
  let m = "";
  if (yesNo === "YES") m += "Affirmative signal present. ";
  else if (yesNo === "NO") m += "No clear signal. ";
  else m += "Unclear response. ";
  m += `Color: ${color}. `;
  m += `Peak: ${freq.toFixed(1)} Hz (mag ${Math.round(mag)}).`;
  return m;
}

function broadcastToSSE(msgObj) {
  const data = `data: ${JSON.stringify(msgObj)}\n\n`;
  clients.forEach((res) => {
    try { res.write(data); } catch (e) { /* ignore */ }
  });
}

function speakTermuxTTS(text) {
  if (!ENABLE_TTS) return;
  // prefer termux-tts-speak (Termux API). Fall back to 'espeak' if available.
  // This only works on Android with termux-api installed and permission granted.
  exec(`termux-tts-speak ${JSON.stringify(text)}`, (err) => {
    if (err) {
      // fallback attempt
      exec(`espeak ${JSON.stringify(text)}`, () => {});
    }
  });
}

function notifyWebhook(payload) {
  if (!WEBHOOK_ON_MESSAGE) return;
  // simple POST using curl (keeping file single and avoiding extra npm deps)
  const tmp = JSON.stringify(payload).replace(/"/g, '\\"');
  const cmd = `curl -s -X POST -H "Content-Type: application/json" -d "${tmp}" ${WEBHOOK_ON_MESSAGE} >/dev/null 2>&1`;
  exec(cmd, () => {});
}

function handleNewMessage(freq, mag) {
  const yesNo = (mag && mag > MIN_GOOD_MAG) ? interpretYesNo(freq) : "MAYBE";
  const color = mapColor(freq);
  const message = generateMessage(freq, yesNo, color, mag);
  lastMessage = message;
  lastFreq = freq;
  lastMag = mag;
  const logLine = `[${nowISO()}] Freq:${freq.toFixed(2)}Hz | ${yesNo} | ${color} | ${message}`;
  console.log(logLine);
  appendLog(logLine);
  // SSE broadcast
  broadcastToSSE({ ts: nowISO(), message, freq: Number(freq.toFixed(2)), mag: Math.round(mag) });
  // TTS
  speakTermuxTTS(message);
  // webhook
  notifyWebhook({ ts: nowISO(), message, freq: Number(freq.toFixed(2)), mag: Math.round(mag) });
}

// ------------- RECORDING (Live) -------------
let recording = null;
function startMicrophoneCapture() {
  if (recording) return;
  console.log("Starting microphone capture...");
  recording = record.record({
    sampleRate: SAMPLE_RATE,
    threshold: 0,
    verbose: false,
    recordProgram: "sox", // cross-platform fallback
    audioType: "wav"
  });
  const stream = recording.stream();
  let pending = Buffer.alloc(0);
  stream.on("data", (chunk) => {
    pending = Buffer.concat([pending, chunk]);
    const needed = FRAME_SIZE * 2;
    while (pending.length >= needed) {
      const frame = pending.slice(0, needed);
      pending = pending.slice(needed);
      const samples = bufferToSamples(frame);
      const mags = runFFTOnSamples(samples);
      const { freq, magnitude } = getDominantFrequency(mags, SAMPLE_RATE);
      handleNewMessage(freq, magnitude);
    }
  });
  stream.on("error", (err) => {
    console.error("Mic stream error:", err && err.message ? err.message : err);
    console.error("If you see spawn ENOENT, install 'sox' (pkg install sox) or enable file-fallback mode.");
  });
  console.log("Microphone capture running.");
}

// ------------- FILE FALLBACK (optional) -------------
function processWavFile(filePath) {
  // quick WAV parsing for PCM16LE (minimal dependency): read header and raw samples
  try {
    const buf = fs.readFileSync(filePath);
    // very naive WAV header parsing: assume 44-byte header, PCM16LE, mono or stereo
    if (buf.length < 44) return;
    const audioStart = 44;
    const audioBuf = buf.slice(audioStart);
    // If stereo, we'll just read every 2nd sample (simple downmix)
    const samples = [];
    for (let i = 0; i + 1 < audioBuf.length; i += 2) {
      samples.push(audioBuf.readInt16LE(i) / 32768);
      if (samples.length >= FRAME_SIZE) break;
    }
    if (samples.length < FRAME_SIZE) return;
    const mags = runFFTOnSamples(samples);
    const { freq, magnitude } = getDominantFrequency(mags, SAMPLE_RATE);
    handleNewMessage(freq, magnitude);
  } catch (e) {
    console.error("Failed to process wav file:", filePath, e && e.message ? e.message : e);
  }
}

function watchRecordingsFolder() {
  const dir = path.join(process.cwd(), "recordings");
  if (!fs.existsSync(dir)) fs.mkdirSync(dir);
  console.log("File-fallback mode active. Watching recordings/ for new WAV files.");
  fs.watch(dir, { persistent: true }, (event, fname) => {
    if (!fname) return;
    const fp = path.join(dir, fname);
    // tiny delay to ensure file write finished
    setTimeout(() => {
      if (fs.existsSync(fp)) processWavFile(fp);
    }, 800);
  });
}

// ------------- EXPRESS SERVER & SSE -------------
const app = express();

app.get("/", (req, res) => {
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.send(`
  <!doctype html>
  <html>
  <head><meta charset="utf-8"><title>Me2You</title></head>
  <body style="font-family:system-ui,Segoe UI,Roboto,Helvetica,Arial,sans-serif;padding:18px;">
    <h1>Me2You</h1>
    <div id="msg">Latest: ${lastMessage}</div>
    <div id="meta"></div>
    <script>
      const evt = new EventSource("/events");
      evt.onmessage = e => {
        const d = JSON.parse(e.data);
        document.getElementById('msg').textContent = d.ts + " — " + d.message;
        document.getElementById('meta').textContent = "Freq: " + d.freq + " Hz, mag: " + d.mag;
      };
    </script>
  </body>
  </html>`);
});

// simple JSON endpoint for Alexa or quick fetch
app.get("/me2you", (req, res) => {
  res.json({ message: lastMessage, freq: Number.isFinite(lastFreq) ? Number(lastFreq.toFixed(2)) : null, ts: nowISO() });
});

// dedicated Alexa-friendly endpoint (returns plain text)
app.get("/alexa", (req, res) => {
  // Alexa will convert JSON/SSML to speech in the skill; we provide text.
  res.json({ speech: lastMessage });
});

// SSE streaming endpoint
app.get("/events", (req, res) => {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.write(`retry: 10000\n\n`);
  clients.push(res);
  req.on("close", () => {
    clients = clients.filter((r) => r !== res);
  });
});

// status
app.get("/status", (req, res) => {
  res.json({ running: !!recording, lastMessage, lastFreq, lastMag, port: PORT });
});

app.listen(PORT, () => {
  console.log(`Me2You HTTP: http://localhost:${PORT}/`);
  if (ENABLE_FILE_FALLBACK) watchRecordingsFolder();
  // start mic capture if not using file fallback only
  if (!ENABLE_FILE_FALLBACK) startMicrophoneCapture();
});

// graceful exit
process.on("SIGINT", () => {
  console.log("Shutting down Me2You...");
  try { if (recording) recording.stop(); } catch (e) {}
  process.exit(0);
});
