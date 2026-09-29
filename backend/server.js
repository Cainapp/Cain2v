// server.js — backend proxy da sua IA
require('dotenv').config();
const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3001;
const OPENROUTER_KEY = process.env.OPENROUTER_API_KEY;

const MODEL_FALLBACK = [
  'openrouter/free',
  'nvidia/nemotron-3-ultra-550b-a55b:free',
];

const DB_DIR = path.join(__dirname, 'data');
if (!fs.existsSync(DB_DIR)) fs.mkdirSync(DB_DIR);

function loadJSON(file, fallback) {
  const p = path.join(DB_DIR, file);
  if (!fs.existsSync(p)) {
    fs.writeFileSync(p, JSON.stringify(fallback, null, 2));
    return fallback;
  }
  return JSON.parse(fs.readFileSync(p, 'utf-8'));
}
function saveJSON(file, data) {
  fs.writeFileSync(path.join(DB_DIR, file), JSON.stringify(data, null, 2));
}

async function callModel(model, messages) {
  const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${OPENROUTER_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ model, messages }),
  });
  if (!res.ok) throw new Error(`Modelo ${model} falhou: ${res.status}`);
  const data = await res.json();
  return data.choices[0].message.content;
}

app.post('/api/chat', async (req, res) => {
  const { messages, agentSystemPrompt } = req.body;
  const finalMessages = agentSystemPrompt
    ? [{ role: 'system', content: agentSystemPrompt }, ...messages]
    : messages;

  for (const model of MODEL_FALLBACK) {
    try {
      const reply = await callModel(model, finalMessages);
      return res.json({ reply, modelUsed: model });
    } catch (err) {
      console.warn(err.message);
      continue;
    }
  }
  res.status(500).json({ error: 'Todos os modelos falharam. Tente de novo em instantes.' });
});

app.get('/api/agents', (req, res) => {
  res.json(loadJSON('agents.json', []));
});
app.post('/api/agents', (req, res) => {
  const agents = loadJSON('agents.json', []);
  
