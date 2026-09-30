// server.js — backend proxy da sua IA (com banco de dados e senha)
require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3001;
const OPENROUTER_KEY = process.env.OPENROUTER_API_KEY;
const ACCESS_PASSWORD = process.env.ACCESS_PASSWORD;

const MODEL_FALLBACK = [
  'openrouter/free',
  'nvidia/nemotron-3-ultra-550b-a55b:free',
];

// ---------- Banco de dados ----------
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

async function initDB() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS agents (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      prompt TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS brain_topics (
      id TEXT PRIMARY KEY,
      topic TEXT NOT NULL,
      last_studied TIMESTAMPTZ
    );
    CREATE TABLE IF NOT EXISTS brain_knowledge (
      id SERIAL PRIMARY KEY,
      topic TEXT NOT NULL,
      summary TEXT NOT NULL,
      created_at TIMESTAMPTZ DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS plugins (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      endpoint TEXT NOT NULL
    );
  `);
  console.log('Banco de dados pronto.');
}

// ---------- Senha de acesso ----------
// Protege todas as rotas /api. Se ACCESS_PASSWORD não estiver configurada, libera geral.
app.use('/api', (req, res, next) => {
  if (!ACCESS_PASSWORD) return next();
  const sent = req.header('x-app-password');
  if (sent === ACCESS_PASSWORD) return next();
  res.status(401).json({ error: 'Senha incorreta ou não enviada.' });
});

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
      continue;
    }
  }
  res.status(500).json({ error: 'Todos os modelos falharam. Tente de novo em instantes.' });
});

// ---------- Agentes ----------
app.get('/api/agents', async (req, res) => {
  const { rows } = await pool.query('SELECT * FROM agents ORDER BY name');
  res.json(rows);
});
app.post('/api/agents', async (req, res) => {
  const id = Date.now().toString();
  const { name, prompt } = req.body;
  await pool.query('INSERT INTO agents (id, name, prompt) VALUES ($1, $2, $3)', [id, name, prompt]);
  res.json({ id, name, prompt });
});
app.delete('/api/agents/:id', async (req, res) => {
  await pool.query('DELETE FROM agents WHERE id = $1', [req.params.id]);
  res.json({ ok: true });
});

// ---------- Cérebro ----------
app.get('/api/brain/topics', async (req, res) => {
  const { rows } = await pool.query('SELECT * FROM brain_topics ORDER BY topic');
  res.json(rows.map(r => ({ id: r.id, topic: r.topic, lastStudied: r.last_studied })));
});
app.post('/api/brain/topics', async (req, res) => {
  const id = Date.now().toString();
  await pool.query('INSERT INTO brain_topics (id, topic) VALUES ($1, $2)', [id, req.body.topic]);
  res.json({ ok: true });
});
app.get('/api/brain/knowledge', async (req, res) => {
  const { rows } = await pool.query('SELECT * FROM brain_knowledge ORDER BY created_at');
  res.json(rows.map(r => ({ topic: r.topic, summary: r.summary, date: r.created_at })));
});

async function studyTopics() {
  const { rows: topics } = await pool.query('SELECT * FROM brain_topics');
  for (const t of topics) {
    try {
      const summary = await callModel(MODEL_FALLBACK[0], [
        { role: 'user', content: `Me dê um resumo atualizado e didático sobre: ${t.topic}` },
      ]);
      await pool.query('INSERT INTO brain_knowledge (topic, summary) VALUES ($1, $2)', [t.topic, summary]);
      await pool.query('UPDATE brain_topics SET last_studied = now() WHERE id = $1', [t.id]);
    } catch (err) {
      console.warn(`Falha ao estudar ${t.topic}:`, err.message);
    }
  }
}
// const cron = require('node-cron');
// cron.schedule('0 */6 * * *', studyTopics);

// ---------- Plugins ----------
app.get('/api/plugins', async (req, res) => {
  const { rows } = await pool.query('SELECT * FROM plugins ORDER BY name');
  res.json(rows);
});
app.post('/api/plugins', async (req, res) => {
  const id = Date.now().toString();
  const { name, endpoint } = req.body;
  await pool.query('INSERT INTO plugins (id, name, endpoint) VALUES ($1, $2, $3)', [id, name, endpoint]);
  res.json({ ok: true });
});

initDB()
  .then(() => app.listen(PORT, () => console.log(`Servidor rodando na porta ${PORT}`)))
  .catch(err => {
    console.error('Erro ao conectar no banco:', err.message);
    process.exit(1);
  });
