// server.js — backend proxy da sua IA (com banco de dados e login por usuário)
require('dotenv').config();
const express = require('express');
const cors = require('cors');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const { Pool } = require('pg');

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3001;
const OPENROUTER_KEY = process.env.OPENROUTER_API_KEY;

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
    CREATE TABLE IF NOT EXISTS conversations (
      id TEXT PRIMARY KEY,
      user_id TEXT,
      title TEXT NOT NULL DEFAULT 'Nova conversa',
      pinned BOOLEAN NOT NULL DEFAULT false,
      messages JSONB NOT NULL DEFAULT '[]'::jsonb,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      email TEXT UNIQUE NOT NULL,
      password_hash TEXT,
      google_sub TEXT UNIQUE,
      token TEXT UNIQUE NOT NULL,
      created_at TIMESTAMPTZ DEFAULT now()
    );
  `);
  console.log('Banco de dados pronto.');
}

// ---------- Login por usuário ----------
function newToken() {
  return crypto.randomBytes(32).toString('hex');
}

app.post('/api/auth/signup', async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password || password.length < 6) {
    return res.status(400).json({ error: 'E-mail e senha (mín. 6 caracteres) são obrigatórios.' });
  }
  try {
    const hash = await bcrypt.hash(password, 10);
    const id = Date.now().toString();
    const token = newToken();
    await pool.query(
      'INSERT INTO users (id, email, password_hash, token) VALUES ($1, $2, $3, $4)',
      [id, email.toLowerCase().trim(), hash, token]
    );
    res.json({ token, email });
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'Esse e-mail já tem uma conta.' });
    res.status(500).json({ error: 'Erro ao criar conta.' });
  }
});

app.post('/api/auth/login', async (req, res) => {
  const { email, password } = req.body;
  const { rows } = await pool.query('SELECT * FROM users WHERE email = $1', [(email || '').toLowerCase().trim()]);
  const user = rows[0];
  if (!user || !user.password_hash) return res.status(401).json({ error: 'E-mail ou senha incorretos.' });
  const ok = await bcrypt.compare(password || '', user.password_hash);
  if (!ok) return res.status(401).json({ error: 'E-mail ou senha incorretos.' });
  res.json({ token: user.token, email: user.email });
});

// Protege todas as rotas /api, exceto o cadastro/login.
app.use('/api', async (req, res, next) => {
  if (req.path === '/auth/signup' || req.path === '/auth/login') return next();
  const token = req.header('x-auth-token');
  if (!token) return res.status(401).json({ error: 'Não autenticado.' });
  const { rows } = await pool.query('SELECT id, email FROM users WHERE token = $1', [token]);
  if (!rows.length) return res.status(401).json({ error: 'Sessão inválida.' });
  req.userId = rows[0].id;
  next();
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

// Endpoint para acionar o estudo de fora (ex: cron-job.org, grátis).
// Protegido por um token de um usuário válido, enviado como ?key=TOKEN
app.post('/api/study', async (req, res) => {
  const { rows } = await pool.query('SELECT id FROM users WHERE token = $1', [req.query.key]);
  if (!rows.length) return res.status(401).json({ error: 'Chave incorreta.' });
  try {
    await studyTopics();
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

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

// ---------- Conversas (cada usuário só vê as suas) ----------
app.get('/api/conversations', async (req, res) => {
  const { rows } = await pool.query(
    'SELECT id, title, pinned, updated_at FROM conversations WHERE user_id = $1 ORDER BY pinned DESC, updated_at DESC',
    [req.userId]
  );
  res.json(rows);
});
app.get('/api/conversations/:id', async (req, res) => {
  const { rows } = await pool.query('SELECT * FROM conversations WHERE id = $1 AND user_id = $2', [req.params.id, req.userId]);
  if (!rows.length) return res.status(404).json({ error: 'Não encontrada.' });
  res.json(rows[0]);
});
app.post('/api/conversations', async (req, res) => {
  const id = Date.now().toString();
  const title = (req.body.title || 'Nova conversa').slice(0, 60);
  await pool.query('INSERT INTO conversations (id, user_id, title, messages) VALUES ($1, $2, $3, $4)', [
    id, req.userId, title, JSON.stringify(req.body.messages || []),
  ]);
  res.json({ id, title, pinned: false, messages: req.body.messages || [] });
});
app.put('/api/conversations/:id', async (req, res) => {
  const { title, pinned, messages } = req.body;
  const fields = [];
  const values = [];
  let i = 1;
  if (title !== undefined) { fields.push(`title = $${i++}`); values.push(title.slice(0, 60)); }
  if (pinned !== undefined) { fields.push(`pinned = $${i++}`); values.push(pinned); }
  if (messages !== undefined) { fields.push(`messages = $${i++}`); values.push(JSON.stringify(messages)); }
  fields.push(`updated_at = now()`);
  values.push(req.params.id, req.userId);
  await pool.query(`UPDATE conversations SET ${fields.join(', ')} WHERE id = $${i} AND user_id = $${i + 1}`, values);
  res.json({ ok: true });
});
app.delete('/api/conversations/:id', async (req, res) => {
  await pool.query('DELETE FROM conversations WHERE id = $1 AND user_id = $2', [req.params.id, req.userId]);
  res.json({ ok: true });
});

initDB()
  .then(() => app.listen(PORT, () => console.log(`Servidor rodando na porta ${PORT}`)))
  .catch(err => {
    console.error('Erro ao conectar no banco:', err.message);
    process.exit(1);
  });
