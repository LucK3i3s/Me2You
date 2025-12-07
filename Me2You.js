// =========================
// Me2You: Multi-Dimensional Communication Node.js Script
// =========================

import 'dotenv/config';
import { spawn } from 'child_process';
import fft from 'fft-js';
import fetch from 'node-fetch';
import fs from 'fs';
import path from 'path';

// -------------------------
// Load Environment Variables
// -------------------------
const {
    ALEXA_SKILL_ID,
    ALEXA_CLIENT_ID,
    ALEXA_CLIENT_SECRET,
    ALEXA_REFRESH_TOKEN,
    MIC_DEVICE = 'plughw:1,0',
    SAMPLE_RATE = 16000,
    FFT_SIZE = 1024,
    OPENAI_API_KEY
} = process.env;

// -------------------------
// Helper: Get Alexa OAuth Token
// -------------------------
async function getAlexaAccessToken() {
    const response = await fetch('https://api.amazon.com/auth/o2/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
            grant_type: 'refresh_token',
            client_id: ALEXA_CLIENT_ID,
            client_secret: ALEXA_CLIENT_SECRET,
            refresh_token: ALEXA_REFRESH_TOKEN
        })
    });
    const data = await response.json();
    return data.access_token;
}

// -------------------------
// Helper: Send Message to Alexa
// -------------------------
async function sendMessageToAlexa(message) {
    const token = await getAlexaAccessToken();
    try {
        await fetch(`https://api.amazonalexa.com/v1/skills/${ALEXA_SKILL_ID}/messages`, {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${token}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                type: 'intentRequest',
                payload: {
                    intent: {
                        name: 'SendMe2YouMessageIntent',
                        slots: {
                            Message: { name: 'Message', value: message }
                        }
                    }
                }
            })
        });
        console.log('[Alexa] Sent message:', message);
    } catch (err) {
        console.error('[Alexa] Error sending message:', err);
    }
}

// -------------------------
// Helper: Convert Frequency Array to Message (via OpenAI)
// -------------------------
async function frequencyToMessage(freqData) {
    const avgFreq = freqData.reduce((a,b)=>a+b,0)/freqData.length;
    const prompt = `Interpret the following frequency data as a meaningful text message: ${avgFreq}`;
    
    const response = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: {
            'Authorization': `Bearer ${OPENAI_API_KEY}`,
            'Content-Type': 'application/json'
        },
        body: JSON.stringify({
            model: 'gpt-4o-mini',
            messages: [{ role: 'user', content: prompt }],
            max_tokens: 50
        })
    });
    const data = await response.json();
    return data.choices?.[0]?.message?.content || '';
}

// -------------------------
// Start Mic Listening via arecord
// -------------------------
function startMic() {
    console.log('[Me2You] Listening for frequencies...');
    
    const arecord = spawn('arecord', [
        '-c', '1',
        '-r', SAMPLE_RATE.toString(),
        '-f', 'S16_LE',
        '-D', MIC_DEVICE
    ]);

    let buffer = Buffer.alloc(0);

    arecord.stdout.on('data', async (chunk) => {
        buffer = Buffer.concat([buffer, chunk]);

        // Once buffer reaches FFT_SIZE, analyze
        if (buffer.length >= FFT_SIZE*2) {
            const samples = [];
            for (let i=0; i<FFT_SIZE*2; i+=2) {
                samples.push(buffer.readInt16LE(i));
            }

            const phasors = fft.fft(samples);
            const magnitudes = fft.util.fftMag(phasors);
            buffer = Buffer.alloc(0);

            // Convert frequency to message
            const message = await frequencyToMessage(magnitudes);
            if(message) {
                sendMessageToAlexa(message);
            }
        }
    });

    arecord.stderr.on('data', (data) => {
        console.error('[arecord error]', data.toString());
    });

    arecord.on('close', (code) => {
        console.log('[arecord] Process exited with code', code);
    });
}

// -------------------------
// Run
// -------------------------
startMic();.existsSync(dir)) fs.mkdirSync(dir);
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
