// Me2You.mjs
// Single-file Me2You — Termux-compatible, creative, complete
// Usage: set config below, then: node Me2You.mjs
import { spawn } from "child_process";
import fs from "fs";
import path from "path";
import { fft } from "fft-js";
import crypto from "crypto";
import os from "os";
import http from "http";
import express from "express";

// ---------------- CONFIGURATION ----------------
// Edit these constants to fit your environment
const SAMPLE_RATE = 16000;
const FRAME_SIZE = 2048;
const PORT = process.env.PORT ? Number(process.env.PORT) : 3000;
const LOG_FILE = "me2you_log.txt";
const MIN_MAGNITUDE = 1000;       // threshold to call a peak "real"
const ENABLE_TTS = process.env.ME2YOU_TTS === "1";         // termux-tts on new message
const ENABLE_VIBRATE = process.env.ME2YOU_VIBE === "1";    // termux-vibrate on new message
const ENABLE_OBSERVER = process.env.ME2YOU_OBSERVER === "1";// ascii visual
const SILENT_MODE = process.env.ME2YOU_SILENT === "1";     // no TTS/vibe/logging if set
const ENABLE_FILE_FALLBACK = process.env.ME2YOU_FILEMODE === "1"; // watch recordings/

// Optional webhook to forward messages (will be AES-GCM encrypted if ENCRYPTION_KEY set)
const WEBHOOK_URL = process.env.ME2YOU_WEBHOOK || ""; // e.g. https://your-server/receive

// Encryption: 32-byte base64 key for AES-GCM (optional)
const ENCRYPTION_KEY_B64 = process.env.ME2YOU_KEY_B64 || ""; // set if you want encrypted webhooks

// Alexa / external fetch usage:
// For simple Alexa skill use: skill will call your /alexa endpoint (see instructions)
// For advanced push to Alexa you need AWS + Alexa notifications (advanced)
const ALLOW_PUBLIC = true; // if true you can expose via ngrok; otherwise keep local

// Custom signature mapping (your "flow-state equation")
// Fill with signature keys -> messages. Signature keys are strings like "6R6B"
const SIGNATURES = {
  "6R6B": "Alignment Shift — Observe the transition.",
  "6R7B": "Threshold Expansion — A message is forming.",
  "7R6B": "Observer Phase — Ninth Seal vibration.",
  // add your own custom patterns...
};

// ---------------- STATE ----------------
let lastMessage = "No signal detected yet.";
let lastFreq = 0;
let lastMag = 0;
let lastSignatureKey = null;

// SSE clients
const sseClients = [];

// ---------------- HELPERS ----------------
function nowISO() { return new Date().toISOString(); }
function appendLog(line) {
  try { fs.appendFileSync(LOG_FILE, line + os.EOL); } catch (e) { /* ignore */ }
}
function encryptPayload(plain) {
  if (!ENCRYPTION_KEY_B64) return null;
  const key = Buffer.from(ENCRYPTION_KEY_B64, "base64");
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const enc = Buffer.concat([cipher.update(Buffer.from(plain, "utf8")), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, enc]).toString("base64");
}
function sha1hex(s) { return crypto.createHash("sha1").update(s).digest("hex"); }

// Convert PCM Buffer (Int16LE) to normalized float samples (-1..1)
function bufferToSamples(buffer) {
  const sampleCount = Math.floor(buffer.length / 2);
  const out = new Array(sampleCount);
  for (let i = 0; i < sampleCount; i++) {
    out[i] = buffer.readInt16LE(i * 2) / 32768;
  }
  return out;
}

// Run FFT and return magnitudes
function runFFT(samples) {
  // ensure length FRAME_SIZE
  if (samples.length < FRAME_SIZE) {
    samples = samples.concat(new Array(FRAME_SIZE - samples.length).fill(0));
  } else if (samples.length > FRAME_SIZE) {
    samples = samples.slice(0, FRAME_SIZE);
  }
  const ph = fft(samples);
  const mags = ph.map(([r, i]) => Math.sqrt(r*r + i*i));
  return mags;
}

// Find dominant freq and magnitude
function dominantFreqFromMags(mags, sampleRate) {
  const half = Math.floor(mags.length / 2);
  let idx = 1, max = -Infinity;
  for (let i = 1; i < half; i++) {
    if (mags[i] > max) { max = mags[i]; idx = i; }
  }
  const freq = idx * (sampleRate / mags.length);
  return { freq, mag: max };
}

// Map freq -> yes/no/maybe
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

// Flow-state signature detector — counts "red band" and "blue band" peaks within the FFT frame
function detectSignature(mags) {
  let red = 0, blue = 0;
  const N = mags.length;
  for (let i = 1; i < Math.floor(N/2); i++) {
    const freq = i * (SAMPLE_RATE / N);
    const m = mags[i];
    // thresholds tuned heuristically; you can tweak
    if (freq >= 420 && freq <= 850 && m > MIN_MAGNITUDE) red++;
    if (freq >= 1200 && freq <= 2000 && m > MIN_MAGNITUDE) blue++;
  }
  const key = `${red}R${blue}B`;
  return { red, blue, key };
}

// Tiny ASCII observer sparkline
function asciiSpark(mags) {
  const half = Math.floor(mags.length/2);
  const slice = mags.slice(0, half);
  const max = Math.max(...slice) || 1;
  let s = "";
  const width = 60;
  for (let i = 0; i < width; i++) {
    const idx = Math.floor((i/width) * slice.length);
    const v = slice[idx] / max;
    s += (v > 0.7 ? "#" : v > 0.4 ? "+" : v > 0.15 ? "-" : " ");
  }
  return s;
}

// send webhook (encrypted if key provided)
function sendWebhook(obj) {
  if (!WEBHOOK_URL) return;
  try {
    const payload = JSON.stringify(obj);
    const enc = ENCRYPTION_KEY_B64 ? encryptPayload(payload) : payload;
    const curl = spawn("curl", ["-s", "-X", "POST", "-H", "Content-Type: application/json", "-d", enc, WEBHOOK_URL], { stdio: "ignore" });
    curl.on("error", ()=>{});
  } catch(e){}
}

// TTS and vibrate helpers (Termux)
function ttsSpeak(text) {
  if (!ENABLE_TTS || SILENT_MODE) return;
  // termux-tts-speak must be installed (pkg install termux-api)
  spawn("termux-tts-speak", [text]);
}
function vibratePattern() {
  if (!ENABLE_VIBRATE || SILENT_MODE) return;
  // short vibration
  spawn("termux-vibrate", ["-d", "200"]);
}

// New message handler
function onNewMessage(freq, mag, mags) {
  const yesNo = (mag && mag > MIN_MAGNITUDE) ? interpretYesNo(freq) : "MAYBE";
  const color = mapColor(freq);
  const signature = detectSignature(mags);
  lastFreq = freq; lastMag = mag;
  const signatureKey = signature.key;
  lastSignatureKey = signatureKey;

  // signature message mapping
  const signatureMsg = SIGNATURES[signatureKey] || (signature.red+signature.blue > 0 ? `Pattern ${signatureKey}` : "");
  const creativeMsg = (yesNo === "YES" ? "Affirmative signal." : yesNo === "NO" ? "No clear signal." : "Unclear response.");
  const fullMessage = `${creativeMsg} Color: ${color}. Peak: ${freq.toFixed(1)} Hz. ${signatureMsg}`;

  lastMessage = fullMessage;

  const log = `[${nowISO()}] ${fullMessage} (sig=${signatureKey} red=${signature.red} blue=${signature.blue} mag=${Math.round(mag)})`;
  if (!SILENT_MODE) console.log(log);
  appendLog(log);

  // SSE broadcast
  const sseObj = { ts: nowISO(), message: fullMessage, freq: Number(freq.toFixed(2)), mag: Math.round(mag), signature: signatureKey };
  const sseStr = `data: ${JSON.stringify(sseObj)}\n\n`;
  for (const res of sseClients) {
    try { res.write(sseStr); } catch(e){}
  }

  // actions
  if (!SILENT_MODE) {
    ttsSpeak(fullMessage);
    vibratePattern();
  }

  // webhook (encrypted if key set)
  sendWebhook(sseObj);
}

// ---------------- RECORDING & PROCESS ----------------
let recorderProc = null;
function startRecordingStream() {
  // Use termux-microphone-record to write a rolling file and we will stream in chunks.
  // Alternatively we spawn the CLI and read the wav file repeatedly.
  // We'll create /data/data/com.termux/files/home/me2you/audio_stream.wav
  const out = path.join(process.cwd(), "audio_stream.wav");
  // Remove existing if present
  try { if (fs.existsSync(out)) fs.unlinkSync(out); } catch(e){}

  // run termux-microphone-record with -l infinity and write to audio_stream.wav
  recorderProc = spawn("termux-microphone-record", ["-l", "infinity", "-f", "wav", "-o", out], { detached: true });

  recorderProc.on("error", (e) => {
    console.error("Recorder start failed:", e && e.message ? e.message : e);
    console.error("Make sure termux-api is installed and granted microphone permission.");
  });

  recorderProc.on("spawn", () => {
    if (!SILENT_MODE) console.log("Recorder spawned; audio file:", out);
  });

  // Poll the file for new data and read frames
  let lastRead = 0;
  const frameBytes = FRAME_SIZE * 2; // 2 bytes per sample (Int16)
  setInterval(() => {
    try {
      if (!fs.existsSync(out)) return;
      const stats = fs.statSync(out);
      if (stats.size <= 44 + lastRead) return; // WAV header 44 bytes
      const fd = fs.openSync(out, "r");
      const start = 44 + lastRead;
      const toRead = Math.min(frameBytes * 4, stats.size - start); // read a chunk of several frames
      const buf = Buffer.alloc(toRead);
      fs.readSync(fd, buf, 0, toRead, start);
      fs.closeSync(fd);
      // process buffer in FRAME_SIZE-chunks
      let pos = 0;
      while (pos + frameBytes <= buf.length) {
        const frameBuf = buf.slice(pos, pos + frameBytes);
        const samples = bufferToSamples(frameBuf);
        const mags = runFFT(samples);
        const { freq, mag } = dominantFreqFromMags(mags, SAMPLE_RATE);
        if (mag > MIN_MAGNITUDE) onNewMessage(freq, mag, mags);
        else onNewMessage(freq, mag, mags); // still process but may be MAYBE
        pos += frameBytes;
      }
      lastRead += pos;
    } catch (e) {
      // ignore transient read errors
    }
  }, 600); // poll ~every 600ms
}

// File fallback: watch recordings/ and process new files
function watchRecordings() {
  const dir = path.join(process.cwd(), "recordings");
  if (!fs.existsSync(dir)) fs.mkdirSync(dir);
  fs.watch(dir, (evt, fname) => {
    if (!fname) return;
    setTimeout(() => {
      const fp = path.join(dir, fname);
      if (!fs.existsSync(fp)) return;
      try {
        const buf = fs.readFileSync(fp);
        // naively treat as wav file
        if (buf.length < 44) return;
        const audio = buf.slice(44, 44 + FRAME_SIZE*2);
        const samples = bufferToSamples(audio);
        const mags = runFFT(samples);
        const { freq, mag } = dominantFreqFromMags(mags, SAMPLE_RATE);
        onNewMessage(freq, mag, mags);
      } catch(e){}
    }, 900);
  });
}

// ---------------- EXPRESS / SSE / UI ----------------
const app = express();

app.get("/", (req, res) => {
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.send(`
    <html><head><title>Me2You</title></head><body style="font-family: system-ui, Roboto, -apple-system; padding:18px;">
      <h1>Me2You</h1>
      <p>Latest: <b id="msg">${lastMessage}</b></p>
      <p id="meta"></p>
      <button onclick="fetch('/me2you').then(r=>r.json()).then(j=>alert(j.message))">Get Latest</button>
      <pre id="log" style="height:220px;overflow:auto;border:1px solid #ddd;padding:8px;"></pre>
      <script>
        const es = new EventSource('/events');
        es.onmessage = e => {
          const d = JSON.parse(e.data);
          document.getElementById('msg').textContent = d.message;
          document.getElementById('meta').textContent = 'Freq: ' + d.freq + ' Hz, mag: ' + d.mag + ', sig:' + d.signature;
          const log = document.getElementById('log');
          log.textContent = (new Date(d.ts)).toLocaleString() + ' — ' + d.message + '\\n' + log.textContent;
        };
        // fetch last log lines
        fetch('/log').then(r=>r.text()).then(t=>document.getElementById('log').textContent = t.split('\\n').reverse().slice(0,40).join('\\n'));
      </script>
    </body></html>`);
});

// JSON endpoints
app.get("/me2you", (req,res) => {
  res.json({ message: lastMessage, freq: Number.isFinite(lastFreq) ? Number(lastFreq.toFixed(2)) : null, ts: nowISO(), signature: lastSignatureKey });
});

// Alexa-friendly endpoint: return simple speech text (skill should fetch this and speak it)
app.get("/alexa", (req,res) => {
  res.json({ speech: lastMessage });
});

// SSE events
app.get("/events", (req,res) => {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.write("retry: 10000\n\n");
  sseClients.push(res);
  req.on("close", () => { const i = sseClients.indexOf(res); if (i>=0) sseClients.splice(i,1); });
});

// return raw log
app.get("/log", (req,res) => {
  try { const t = fs.readFileSync(LOG_FILE, "utf8"); res.type("text/plain").send(t); } catch(e){ res.type("text/plain").send(""); }
});

// status
app.get("/status", (req,res) => res.json({ running: !!recorderProc, lastMessage, lastFreq, lastMag }));

app.listen(PORT, () => {
  console.log(`Me2You HTTP: http://localhost:${PORT}/  (SSE: /events, Alexa: /alexa)`);
  if (ENABLE_FILE_FALLBACK) watchRecordings();
  startRecordingStream();
  if (ENABLE_OBSERVER && !SILENT_MODE) console.log("Observer mode ASCII enabled.");
});

// ---------------- graceful exit ----------------
process.on("SIGINT", () => {
  try { if (recorderProc) recorderProc.kill(); } catch(e){}
  console.log("Shutting down Me2You...");
  process.exit(0);
});    samples.push(chunk.readInt16LE(i));
  }

  const phasors = FFT(samples);
  const mags = fftUtil.fftMag(phasors);

  // Example detection (very simple)
  let redCount = 0;
  let blueCount = 0;

  mags.forEach((m, i) => {
    const freq = i * (16000 / mags.length);

    if (freq > 400 && freq < 800 && m > 3000) redCount++;
    if (freq > 1200 && freq < 2000 && m > 3000) blueCount++;
  });

  return { redCount, blueCount };
}

// ----------------------------
// MAIN: Listen for PCM
// ----------------------------
async function startMe2You() {
  console.log("Me2You running… Listening for frequencies…");

  const stream = new DeviceStream({
    sampleRate: 16000,
    channelCount: 1,
    chunkSize: 4096
  });

  stream.on("data", async chunk => {
    const { redCount, blueCount } = analyzeFrequencies(chunk);

    if (redCount + blueCount === 0) return;

    const message = decodeBlinkPattern(redCount, blueCount);

    console.log(`Detected: R${redCount} / B${blueCount} → ${message}`);

    // Alexa speaks it instantly
    await speakToAlexa(message);
  });

  stream.on("error", err => console.error("Mic error:", err));
}

startMe2You();function nowISO() {
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
