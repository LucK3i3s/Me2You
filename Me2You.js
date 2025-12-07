// Me2You.js
import mic from 'mic';
import { fft } from 'fft-js';
import express from 'express';
import fs from 'fs';

// ---------- CONFIGURATION ----------
const SAMPLE_RATE = 16000;
const LOG_FILE = 'me2you_log.txt';
const PORT = 3000;

let lastMessage = "";

// ---------- HELPER FUNCTIONS ----------
function getDominantFrequency(magnitudes) {
    let maxMag = -Infinity;
    let index = -1;
    for (let i = 0; i < magnitudes.length; i++) {
        if (magnitudes[i] > maxMag) {
            maxMag = magnitudes[i];
            index = i;
        }
    }
    return index * SAMPLE_RATE / magnitudes.length;
}

function interpretYesNo(freq) {
    if (freq > 1000) return "YES";
    if (freq < 200) return "NO";
    return "MAYBE";
}

function mapColor(freq) {
    if (freq < 300) return "Red";
    if (freq < 700) return "Green";
    if (freq < 1500) return "Blue";
    return "Violet";
}

function generateMessage(freq, yesNo, color) {
    let msg = "";
    if (yesNo === "YES") msg += "Strong signal detected. ";
    if (yesNo === "NO") msg += "No significant signal. ";
    if (color) msg += `Energy color: ${color}.`;
    return msg.trim();
}

function logMessage(freq, yesNo, color, message) {
    const timestamp = new Date().toISOString();
    const line = `[${timestamp}] Freq: ${freq.toFixed(2)} Hz | Yes/No: ${yesNo} | Color: ${color} | Message: ${message}\n`;
    fs.appendFileSync(LOG_FILE, line);
}

// ---------- MICROPHONE SETUP ----------
const micInstance = mic({
    rate: String(SAMPLE_RATE),
    channels: '1',
    debug: false,
    fileType: 'wav'
});

const micStream = micInstance.getAudioStream();

micStream.on('data', (data) => {
    const samples = new Int16Array(data.buffer);
    if (samples.length === 0) return;

    const phasors = fft(samples);
    const magnitudes = phasors.map(([r, i]) => Math.sqrt(r*r + i*i));

    const freq = getDominantFrequency(magnitudes);
    const yesNo = interpretYesNo(freq);
    const color = mapColor(freq);
    const message = generateMessage(freq, yesNo, color);

    lastMessage = message;

    console.log(`Freq: ${freq.toFixed(2)} Hz | Yes/No: ${yesNo} | Color: ${color} | Message: ${message}`);
    logMessage(freq, yesNo, color, message);
});

micStream.on('error', (err) => console.error("Mic error:", err));

micInstance.start();
console.log("Me2You running... Listening for frequencies...");

// ---------- EXPRESS SERVER FOR WEB / ALEXA ----------
const app = express();

app.get('/me2you', (req, res) => {
    res.json({ message: lastMessage || "No signal detected yet." });
});

app.listen(PORT, () => {
    console.log(`Me2You web endpoint running at http://localhost:${PORT}/me2you`);
});

// ---------- GITHUB INTEGRATION ----------
// Initialize git repo in the folder: `git init`
// Add remote: `git remote add origin https://github.com/YOURNAME/YOURREPO.git`
// Commit & push: `git add . && git commit -m "Initial Me2You commit" && git push -u origin main`
