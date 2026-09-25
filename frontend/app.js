// Troque pela URL do seu backend depois de fazer o deploy (ex: Render)
const API_URL = 'http://localhost:3001';

// ---------- Navegação entre abas ----------
document.querySelectorAll('.nav-item').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.nav-item').forEach(b => b.classList.remove('active'));
    document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
    btn.classList.add('active');
    document.getElementById(`tab-${btn.dataset.tab}`).classList.add('active');
    if (btn.dataset.tab === 'agentes') loadAgents();
    if (btn.dataset.tab === 'cerebro') loadBrain();
    if (btn.dataset.tab === 'plugins') loadPlugins();
  });
});

// ---------- Chat ----------
let history = [];
const chatLog = document.getElementById('chat-log');
const chatInput = document.getElementById('chat-input');

function addMsg(role, text) {
  const div = document.createElement('div');
  div.className = `msg ${role === 'user' ? 'user' : 'bot'}`;
  div.textContent = text;
  chatLog.appendChild(div);
  chatLog.scrollTop = chatLog.scrollHeight;
}

document.getElementById('send-btn').addEventListener('click', sendMessage);
chatInput.addEventListener('keydown', e => { if (e.key === 'Enter') sendMessage(); });

async function sendMessage() {
  const text = chatInput.value.trim();
  if (!text) return;
  addMsg('user', text);
  history.push({ role: 'user', content: text });
  chatInput.value = '';

  const agentPrompt = document.getElementById('agent-select').selectedOptions[0]?.dataset.prompt || null;

  try {
    const res = await fetch(`${API_URL}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ messages: history, agentSystemPrompt: agentPrompt }),
    });
    const data = await res.json();
    addMsg('bot', data.reply || data.error);
    if (data.reply) history.push({ role: 'assistant', content: data.reply });
  } catch (err) {
    addMsg('bot', 'Erro ao conectar com o backend. Confira se ele está rodando.');
  }
}

// ---------- Agentes ----------
async function loadAgents() {
  const res = await fetch(`${API_URL}/api/agents`);
  const agents = await res.json();
  const list = document.getElementById('agent-list');
  const select = document.getElementById('agent-select');
  list.innerHTML = '';
  select.innerHTML = '<option value="">Assistente padrão</option>';
  agents.forEach(a => {
    const card = document.createElement('div');
    card.className = 'card';
    card.textContent = `${a.name} — ${a.prompt.slice(0, 60)}...`;
    list.appendChild(card);

    const opt = document.createElement('option');
    opt.value = a.id;
    opt.textContent = a.name;
    opt.dataset.prompt = a.prompt;
    select.appendChild(opt);
  });
}
document.getElementById('create-agent-btn').addEventListener('click', async () => {
  const name = document.getElementById('agent-name').value.trim();
  const prompt = document.getElementById('agent-prompt').value.trim();
  if (!name || !prompt) return;
  await fetch(`${API_URL}/api/agents`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, prompt }),
  });
  document.getElementById('agent-name').value = '';
  document.getElementById('agent-prompt').value = '';
  loadAgents();
});

// ---------- Cérebro ----------
async function loadBrain() {
  const topics = await (await fetch(`${API_URL}/api/brain/topics`)).json();
  const knowledge = await (await fetch(`${API_URL}/api/brain/knowledge`)).json();
  const topicList = document.getElementById('topic-list');
  const knowledgeList = document.getElementById('knowledge-list');
  topicList.innerHTML = '';
  knowledgeList.innerHTML = '';
  topics.forEach(t => {
    const card = document.createElement('div');
    card.className = 'card';
    card.textContent = `${t.topic} — último estudo: ${t.lastStudied || 'ainda não estudado'}`;
    topicList.appendChild(card);
  });
  knowledge.slice().reverse().forEach(k => {
    const card = document.createElement('div');
    card.className = 'card';
    card.textContent = `[${k.topic}] ${k.summary}`;
    knowledgeList.appendChild(card);
  });
}
document.getElementById('add-topic-btn').addEventListener('click', async () => {
  const topic = document.getElementById('new-topic').value.trim();
  if (!topic) return;
  await fetch(`${API_URL}/api/brain/topics`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ topic }),
  });
  document.getElementById('new-topic').value = '';
  loadBrain();
});

// ---------- Plugins ----------
async function loadPlugins() {
  const plugins = await (await fetch(`${API_URL}/api/plugins`)).json();
  const list = document.getElementById('plugin-list');
  list.innerHTML = '';
  plugins.forEach(p => {
    const card = document.createElement('div');
    card.className = 'card';
    card.textContent = `${p.name} — ${p.endpoint}`;
    list.appendChild(card);
  });
}
document.getElementById('add-plugin-btn').addEventListener('click', async () => {
  const name = document.getElementById('plugin-name').value.trim();
  const endpoint = document.getElementById('plugin-endpoint').value.trim();
  if (!name || !endpoint) return;
  await fetch(`${API_URL}/api/plugins`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, endpoint }),
  });
  document.getElementById('plugin-name').value = '';
  document.getElementById('plugin-endpoint').value = '';
  loadPlugins();
});

// PWA: registra o service worker
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}
