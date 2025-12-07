// Me2You.mjs
// Single-file, Termux-friendly "Me2You" — microphone -> FFT -> message -> web endpoint
// Creative & minimal: record -> analyze -> log -> serve
// Usage: node Me2You.mjs

import express from 'express';
import fs from 'fs';
import { fft } from 'fft-js';
import record from 'node-record-lpcm16';

// ---------- CONFIG ----------
const SAMPLE_RATE = 16000;         // audio sample rate (Hz)
const FRAME_SIZE = 2048;           // number of samples per FFT (power of two)
const LOG_FILE = 'me2you_log.txt';
const PORT = process.env.PORT ? parseInt(process.env.PORT) : 3000;
const MIN_GOOD_MAG = 1000;         // optional threshold to consider a spike "real"
const ENABLE_ASCII = false;        // set true to print tiny ASCII spectrum

// ---------- STATE ----------
let lastMessage = "No signal detected yet.";
let lastFreq = 0;
let running = false;

// ---------- HELPERS ----------
function getDominantFrequency(magnitudes, sampleRate) {
  // only consider up to Nyquist (first half)
  const half = Math.floor(magnitudes.length / 2);
  let max = -Infinity;
  let idx = 0;
  for (let i = 1; i < half; i++) {
    if (magnitudes[i] > max) {
      max = magnitudes[i];
      idx = i;
    }
  }
  const freq = idx * (sampleRate / magnitudes.length);
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

function logLine(freq, yesNo, color, message) {
  const ts = new Date().toISOString();
  const line = `[${ts}] Freq:${freq.toFixed(2)}Hz | ${yesNo} | ${color} | ${message}\n`;
  fs.appendFileSync(LOG_FILE, line);
}

// tiny ASCII sparkline for debug
function asciiSpectrum(mags) {
  const half = Math.floor(mags.length / 2);
  const slice = Array.from(mags.slice(0, half));
  const max = Math.max(...slice);
  let out = "";
  for (let i = 0; i < 40; i++) {
    const idx = Math.floor((i / 40) * slice.length);
    const val = slice[idx] / max;
    out += (val > 0.7 ? "#" : val > 0.4 ? "+" : val > 0.15 ? "-" : " ");
  }
  return out;
}

// ---------- AUDIO -> BUFFER HANDLING ----------
/*
 node-record-lpcm16 emits raw PCM buffers (Int16LE). We'll collect bytes until we
 have FRAME_SIZE Int16 samples (FRAME_SIZE*2 bytes), convert them to numbers,
 run FFT, and analyze.
*/
function bufferToSamples(buffer) {
  // ensure even length
  const sampleCount = Math.floor(buffer.length / 2);
  const samples = new Array(sampleCount);
  for (let i = 0; i < sampleCount; i++) {
    samples[i] = buffer.readInt16LE(i * 2) / 32768; // normalize to -1..1
  }
  return samples;
}

function runFFTOnSamples(samples) {
  // pad or trim to FRAME_SIZE
  if (samples.length < FRAME_SIZE) {
    // zero-pad
    const padded = samples.concat(new Array(FRAME_SIZE - samples.length).fill(0));
    samples = padded;
  } else if (samples.length > FRAME_SIZE) {
    samples = samples.slice(0, FRAME_SIZE);
  }
  const phasors = fft(samples);
  const mags = phasors.map(([r, i]) => Math.sqrt(r * r + i * i));
  return mags;
}

// ---------- RECORDING + PROCESS LOOP ----------
function startRecording() {
  if (running) return;
  running = true;
  console.log("Me2You starting microphone capture...");

  // Choose a record program. node-record-lpcm16 will try defaults; on Android
  // installing 'sox' or 'rec' may help. recordProgram can be 'sox'|'rec'|'arecord'.
  const rec = record.record({
    sampleRate: SAMPLE_RATE,
    threshold: 0,
    verbose: false,
    recordProgram: 'sox', // best-effort cross-platform fallback; may use rec/arecord internally
    audioType: 'wav'
  });

  const stream = rec.stream();
  let pending = Buffer.alloc(0);

  stream.on('data', (data) => {
    // append new data
    pending = Buffer.concat([pending, data]);

    const neededBytes = FRAME_SIZE * 2;
    while (pending.length >= neededBytes) {
      const frame = pending.slice(0, neededBytes);
      pending = pending.slice(neededBytes);

      const samples = bufferToSamples(frame);
      const mags = runFFTOnSamples(samples);
      const { freq, magnitude } = getDominantFrequency(mags, SAMPLE_RATE);

      // small noise threshold: ignore tiny mags
      const yesNo = (magnitude && magnitude > MIN_GOOD_MAG) ? interpretYesNo(freq) : "MAYBE";
      const color = mapColor(freq);
      const message = generateMessage(freq, yesNo, color, magnitude);

      lastMessage = message;
      lastFreq = freq;

      // log & print
      const logMsg = `Freq: ${freq.toFixed(2)} Hz | ${yesNo} | ${color} | ${message}`;
      console.log(logMsg);
      if (ENABLE_ASCII) console.log(asciiSpectrum(mags));
      try { logLine(freq, yesNo, color, message); } catch (e) { /* ignore */ }
    }
  });

  stream.on('error', (err) => {
    console.error("Microphone stream error:", err && err.message ? err.message : err);
    console.error("If this is 'spawn ENOENT', install 'sox' or 'arecord' in Termux, or use termux-microphone-record to create files.");
  });

  stream.on('close', () => {
    console.log("Microphone stream closed.");
    running = false;
  });

  console.log("Microphone capture running. Sending audio to analyzer.");
}

// ---------- EXPRESS SERVER ----------
const app = express();

app.get('/me2you', (req, res) => {
  res.json({
    message: lastMessage,
    freq: Number.isFinite(lastFreq) ? Number(lastFreq.toFixed(2)) : null,
    ts: new Date().toISOString()
  });
});

app.get('/status', (req, res) => {
  res.json({
    running,
    lastMessage,
    lastFreq,
    port: PORT
  });
});

app.listen(PORT, () => {
  console.log(`Me2You web endpoint: http://localhost:${PORT}/me2you`);
  // auto-start microphone capture
  startRecording();
});

// Graceful shutdown
process.on('SIGINT', () => {
  console.log("\nShutting down Me2You...");
  process.exit(0);
});
