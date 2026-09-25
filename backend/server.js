// server.js — backend proxy da sua IA
// Guarda a chave da OpenRouter no servidor. O frontend nunca vê a chave.

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

// Ordem de fallback: se o primeiro modelo falhar (erro/limite), tenta o próximo.
// Todos são gratuitos na OpenRouter no momento em que este código foi escrito —
// confira em https://openrouter.ai/models?max_price=0 se a lista mudou.
const MODEL_FALLBACK = [
  'meta-llama/llama-3.3-70b-instruct:free',
  'google/gemini-2.0-flash-exp:free',
  'deepseek/deepseek-chat:free',
];

// ---------- Armazenamento simples em arquivo (sem precisar de banco) ----------
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

// ---------- Chat com fallback automático ----------
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
      continue; // tenta o próximo modelo da lista
    }
  }
  res.status(500).json({ error: 'Todos os modelos falharam. Tente de novo em instantes.' });
});

// ---------- Agentes (painel de criação de agentes) ----------
app.get('/api/agents', (req, res) => {
  res.json(loadJSON('agents.json', []));
});
app.post('/api/agents', (req, res) => {
  const agents = loadJSON('agents.json', []);
  const agent = { id: Date.now().toString(), ...req.body };
  agents.push(agent);
  saveJSON('agents.json', agents);
  res.json(agent);
});
app.delete('/api/agents/:id', (req, res) => {
  let agents = loadJSON('agents.json', []);
  agents = agents.filter(a => a.id !== req.params.id);
  saveJSON('agents.json', agents);
  res.json({ ok: true });
});

// ---------- Cérebro (temas de estudo contínuo) ----------
app.get('/api/brain/topics', (req, res) => {
  res.json(loadJSON('brain-topics.json', []));
});
app.post('/api/brain/topics', (req, res) => {
  const topics = loadJSON('brain-topics.json', []);
  topics.push({ id: Date.now().toString(), topic: req.body.topic, lastStudied: null });
  saveJSON('brain-topics.json', topics);
  res.json({ ok: true });
});
app.get('/api/brain/knowledge', (req, res) => {
  res.json(loadJSON('brain-knowledge.json', []));
});

// Roda a cada X horas: para cada tema, pede um resumo atualizado ao modelo
// e guarda em brain-knowledge.json. Sem acesso à internet o modelo só usa o
// que já sabe — para pesquisa real na web, plugue uma API de busca aqui
// (ex: Tavily, Brave Search API) antes de chamar o modelo.
async function studyTopics() {
  const topics = loadJSON('brain-topics.json', []);
  const knowledge = loadJSON('brain-knowledge.json', []);
  for (const t of topics) {
    try {
      const summary = await callModel(MODEL_FALLBACK[0], [
        { role: 'user', content: `Me dê um resumo atualizado e didático sobre: ${t.topic}` },
      ]);
      knowledge.push({ topic: t.topic, summary, date: new Date().toISOString() });
      t.lastStudied = new Date().toISOString();
    } catch (err) {
      console.warn(`Falha ao estudar ${t.topic}:`, err.message);
    }
  }
  saveJSON('brain-knowledge.json', knowledge);
  saveJSON('brain-topics.json', topics);
}
// Descomente para ativar o estudo automático a cada 6 horas (precisa de node-cron: npm i node-cron)
// const cron = require('node-cron');
// cron.schedule('0 */6 * * *', studyTopics);

// ---------- Plugins/Integrações (painel de APIs) ----------
app.get('/api/plugins', (req, res) => {
  res.json(loadJSON('plugins.json', []));
});
app.post('/api/plugins', (req, res) => {
  const plugins = loadJSON('plugins.json', []);
  plugins.push({ id: Date.now().toString(), ...req.body });
  saveJSON('plugins.json', plugins);
  res.json({ ok: true });
});

app.listen(PORT, () => console.log(`Servidor rodando na porta ${PORT}`));
