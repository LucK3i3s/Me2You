// ==============================
// Me2You UI - Multi-Dimensional Communication
// Developed by Thomas Lee Harvey, The Ninth Observer
// ==============================

import 'dotenv/config';
import { spawn } from 'child_process';
import fft from 'fft-js';
import fetch from 'node-fetch';
import express from 'express';
import http from 'http';
import { Server } from 'socket.io';
import chalk from 'chalk';
import fs from 'fs';

// -----------------------------
// Env Variables
// -----------------------------
const {
  ALEXA_SKILL_ID, ALEXA_CLIENT_ID, ALEXA_CLIENT_SECRET, ALEXA_REFRESH_TOKEN,
  MIC_DEVICE = 'plughw:1,0', SAMPLE_RATE = 16000, FFT_SIZE = 2048, FFT_SMOOTHING = 5,
  MIN_CONFIDENCE = 0.05, OPENAI_API_KEY
} = process.env;

if (!ALEXA_SKILL_ID || !ALEXA_CLIENT_ID || !ALEXA_CLIENT_SECRET || !ALEXA_REFRESH_TOKEN || !OPENAI_API_KEY) {
  console.error('[Me2You] Missing required environment variables.');
  process.exit(1);
}

// -----------------------------
// Express + Socket.IO Setup
// -----------------------------
const app = express();
const server = http.createServer(app);
const io = new Server(server);
app.use(express.static('./public')); // serve UI from public folder

server.listen(3000, () => console.log('[Me2You] UI running at http://localhost:3000'));

// -----------------------------
// Smoothing
// -----------------------------
const smoothedData = [];
function smoothFrequencies(magnitudes) {
  smoothedData.push(magnitudes);
  if (smoothedData.length > FFT_SMOOTHING) smoothedData.shift();
  const avg = [];
  for (let i = 0; i < magnitudes.length; i++) {
    let sum = 0;
    for (let buf of smoothedData) sum += buf[i];
    avg.push(sum / smoothedData.length);
  }
  return avg;
}

// -----------------------------
// Alexa Integration
// -----------------------------
async function getAlexaAccessToken() {
  const resp = await fetch('https://api.amazon.com/auth/o2/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      client_id: ALEXA_CLIENT_ID,
      client_secret: ALEXA_CLIENT_SECRET,
      refresh_token: ALEXA_REFRESH_TOKEN
    })
  });
  const data = await resp.json();
  return data.access_token;
}

async function sendMessageToAlexa(message) {
  const token = await getAlexaAccessToken();
  if (!token) return;
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
            slots: { Message: { name: 'Message', value: message } }
          }
        }
      })
    });
    console.log(chalk.green('[Alexa] Sent message:'), message);
  } catch (err) {
    console.error('[Me2You][Alexa] Error sending message:', err);
  }
}

// -----------------------------
// Frequency Band Mapping
// -----------------------------
const bands = [
  { min: 20, max: 200, symbol: '🌑 Low Dimensional' },
  { min: 201, max: 600, symbol: '🌕 Mid Dimensional' },
  { min: 601, max: 2000, symbol: '✨ High Dimensional' }
];

function mapFrequenciesToSymbols(freqData) {
  const symbols = new Set();
  freqData.forEach((mag, idx) => {
    const freq = (idx / FFT_SIZE) * SAMPLE_RATE;
    if (mag / Math.max(...freqData) < MIN_CONFIDENCE) return;
    bands.forEach(b => { if (freq >= b.min && freq <= b.max) symbols.add(b.symbol); });
  });
  return Array.from(symbols);
}

// -----------------------------
// OpenAI Translation
// -----------------------------
async function frequencyToMessage(freqData) {
  const bandSymbols = mapFrequenciesToSymbols(freqData);
  const avgFreq = freqData.reduce((a,b)=>a+b,0)/freqData.length;
  const prompt = `Thomas Lee Harvey, the Ninth Observer interprets a multi-dimensional signal. Avg freq: ${avgFreq}, bands: ${bandSymbols}. Translate to creative, authentic message.`;
  try {
    const resp = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${OPENAI_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model:'gpt-4o-mini', messages:[{role:'user', content:prompt}], max_tokens:150 })
    });
    const data = await resp.json();
    return data.choices?.[0]?.message?.content || bandSymbols.join(' | ');
  } catch { return bandSymbols.join(' | '); }
}

// -----------------------------
// Logging
// -----------------------------
const logFile = './Me2You_log.json';
function logMessage(message, freqData) {
  const logEntry = { timestamp: new Date().toISOString(), message, frequencies: freqData.slice(0,100) };
  fs.appendFileSync(logFile, JSON.stringify(logEntry)+'\n','utf8');
}

// -----------------------------
// Microphone Capture & UI
// -----------------------------
function startMic() {
  console.log(chalk.blue('[Me2You] Listening and mapping signals...'));
  const arecord = spawn('arecord', ['-c','1','-r',SAMPLE_RATE.toString(),'-f','S16_LE','-D',MIC_DEVICE]);

  let buffer = Buffer.alloc(0);

  arecord.stdout.on('data', async chunk => {
    buffer = Buffer.concat([buffer, chunk]);
    if (buffer.length >= FFT_SIZE*2) {
      const samples = [];
      for (let i=0;i<FFT_SIZE*2;i+=2) samples.push(buffer.readInt16LE(i));
      const phasors = fft.fft(samples);
      let magnitudes = fft.util.fftMag(phasors);
      magnitudes = smoothFrequencies(magnitudes);

      const message = await frequencyToMessage(magnitudes);
      const symbols = mapFrequenciesToSymbols(magnitudes);

      // Send to UI
      io.emit('frequency', { magnitudes: magnitudes.slice(0,80), symbols, message });

      if (message) {
        console.log(chalk.yellow('[Message] '), message);
        sendMessageToAlexa(message);
        logMessage(message, magnitudes);
      }

      buffer = Buffer.alloc(0);
    }
  });

  arecord.stderr.on('data', data => console.error('[Me2You][Mic Error]', data.toString()));
  arecord.on('close', code => { console.log('[Me2You] arecord exited', code); setTimeout(startMic,1000); });
}

startMic();    } catch (err) {
        console.error('[Me2You][Alexa] Failed to get access token:', err);
        return null;
    }
}

async function sendMessageToAlexa(message) {
    const token = await getAlexaAccessToken();
    if (!token) return;

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
                        slots: { Message: { name: 'Message', value: message } }
                    }
                }
            })
        });
        console.log(chalk.green('[Alexa] Sent message:'), message);
    } catch (err) {
        console.error('[Me2You][Alexa] Error sending message:', err);
    }
}

// -----------------------------
// Frequency to Message
// -----------------------------
async function frequencyToMessage(freqData) {
    const avgFreq = freqData.reduce((a, b) => a + b, 0) / freqData.length;
    const prompt = `Thomas Lee Harvey, the Ninth Observer, interprets a multi-dimensional signal with average frequency: ${avgFreq}. Convert it into a meaningful, authentic message.`;

    try {
        const resp = await fetch('https://api.openai.com/v1/chat/completions', {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${OPENAI_API_KEY}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                model: 'gpt-4o-mini',
                messages: [{ role: 'user', content: prompt }],
                max_tokens: 100
            })
        });
        const data = await resp.json();
        return data.choices?.[0]?.message?.content || '';
    } catch (err) {
        console.error('[Me2You][OpenAI] Error generating message:', err);
        return '';
    }
}

// -----------------------------
// Visualize Frequencies
// -----------------------------
function visualizeFrequencies(freqData) {
    const maxMag = Math.max(...freqData);
    const display = freqData.slice(0, 80).map((mag, idx) => {
        const level = Math.floor((mag / maxMag) * 8);
        const colors = [
            chalk.black, chalk.red, chalk.redBright,
            chalk.yellow, chalk.yellowBright, chalk.green,
            chalk.cyan, chalk.blue, chalk.magenta
        ];
        return colors[Math.min(level, colors.length - 1)]('█');
    }).join('');
    process.stdout.write('\r' + display);
}

// -----------------------------
// Start Microphone Capture
// -----------------------------
function startMic() {
    console.log(chalk.blue('[Me2You] Listening for multi-dimensional signals...'));
    const arecord = spawn('arecord', [
        '-c', '1',
        '-r', SAMPLE_RATE.toString(),
        '-f', 'S16_LE',
        '-D', MIC_DEVICE
    ]);

    let buffer = Buffer.alloc(0);

    arecord.stdout.on('data', async (chunk) => {
        buffer = Buffer.concat([buffer, chunk]);

        if (buffer.length >= FFT_SIZE * 2) {
            const samples = [];
            for (let i = 0; i < FFT_SIZE * 2; i += 2) {
                samples.push(buffer.readInt16LE(i));
            }

            let phasors = fft.fft(samples);
            let magnitudes = fft.util.fftMag(phasors);
            magnitudes = smoothFrequencies(magnitudes);

            visualizeFrequencies(magnitudes);

            buffer = Buffer.alloc(0);

            const message = await frequencyToMessage(magnitudes);
            if (message) {
                console.log('\n' + chalk.yellow('[Message] ') + message);
                sendMessageToAlexa(message);
            }
        }
    });

    arecord.stderr.on('data', (data) => {
        console.error('[Me2You][Mic Error]', data.toString());
    });

    arecord.on('close', (code) => {
        console.log('[Me2You] arecord process exited with code', code);
        setTimeout(startMic, 1000);
    });
}

// -----------------------------
// Run
// -----------------------------
startMic();
