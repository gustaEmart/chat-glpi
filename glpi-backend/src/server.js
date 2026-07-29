require('dotenv').config();
const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const pool = require('./db');
const { requireAuth, verifyToken } = require('./auth');
const chat = require('./chat');
const remote = require('./remote');

// Prints colados no chat (Ctrl+V) - salvos em disco aqui (nome sempre
// gerado pelo servidor, nunca vindo do cliente) e servidos de volta via
// GET /api/images/:filename?token=... (query string porque uma tag <img
// src> não manda header customizado nenhum, mesma razão do token de
// /api/stream).
const UPLOAD_DIR = process.env.CHAT_UPLOAD_DIR || path.join(__dirname, '..', 'uploads');
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });
const MAX_IMAGE_BYTES = 8 * 1024 * 1024; // 8 MB - folgado pra print de tela, sem deixar upload gigante

const SECRET = process.env.CHATGLPI_SHARED_SECRET;
// Aceita várias origens (o GLPI é acessado tanto por IP http://192.0.2.10
// quanto pelo hostname http://glpi.example.com) - CORS_ORIGIN aceita lista
// separada por vírgula; o browser manda a origem exata da página e o
// backend só ecoa de volta se ela estiver na lista.
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGIN || '')
   .split(',')
   .map(s => s.trim())
   .filter(Boolean);
const PORT = Number(process.env.PORT || 4001);

const app = express();
// Limite maior que o padrão (100kb) - print de tela em base64 facilmente
// passa disso; 10mb dá folga sobre o MAX_IMAGE_BYTES (8mb do arquivo
// decodificado, o texto base64 em si é ~33% maior que os bytes reais).
app.use(express.json({ limit: '10mb' }));
app.use(cors({
   origin: (origin, cb) => {
      // Sem Origin = chamada não-browser (curl/servidor) - libera.
      if (!origin || ALLOWED_ORIGINS.includes(origin)) {
         return cb(null, true);
      }
      return cb(null, false);
   }
}));

const auth = requireAuth(SECRET);

app.get('/api/channels', auth, async (req, res) => {
   await chat.touchPresence(req.chatUser.id);
   res.json({ channels: await chat.listForUser(req.chatUser.id) });
});

app.get('/api/messages', auth, async (req, res) => {
   const myId = req.chatUser.id;
   const otherId = Number(req.query.users_id || 0);
   if (!otherId || otherId === myId) {
      return res.status(400).json({ error: 'Parâmetro users_id inválido.' });
   }
   const conversationId = await chat.getOrCreateDm(myId, otherId);
   res.json({ messages: await chat.listForConversation(conversationId, myId), conversationId });
});

app.post('/api/send', auth, async (req, res) => {
   const myId = req.chatUser.id;
   const otherId = Number(req.body.usersId || 0);
   const text = String(req.body.text || '').trim();
   const replyToId = Number(req.body.replyToId || 0) || null;
   if (!otherId || otherId === myId) {
      return res.status(400).json({ error: 'Parâmetro usersId inválido.' });
   }
   if (text === '') {
      return res.status(400).json({ error: 'Mensagem vazia.' });
   }
   const conversationId = await chat.getOrCreateDm(myId, otherId);
   await chat.sendMessage(conversationId, myId, req.chatUser.name, text, replyToId);
   res.json({ messages: await chat.listForConversation(conversationId, myId) });
});

const IMAGE_DATA_URI_RE = /^data:image\/(png|jpe?g|gif|webp);base64,([a-zA-Z0-9+/=]+)$/;

app.post('/api/send-image', auth, async (req, res) => {
   const myId = req.chatUser.id;
   const otherId = Number(req.body.usersId || 0);
   if (!otherId || otherId === myId) {
      return res.status(400).json({ error: 'Parâmetro usersId inválido.' });
   }
   const match = IMAGE_DATA_URI_RE.exec(String(req.body.imageData || ''));
   if (!match) {
      return res.status(400).json({ error: 'Imagem inválida - só PNG, JPEG, GIF ou WEBP.' });
   }
   const ext = match[1] === 'jpeg' ? 'jpg' : match[1];
   const buffer = Buffer.from(match[2], 'base64');
   if (buffer.length > MAX_IMAGE_BYTES) {
      return res.status(413).json({ error: 'Imagem muito grande (máx. 8 MB).' });
   }
   // Nome sempre gerado aqui, nunca a partir de algo que o cliente mandou -
   // elimina qualquer risco de path traversal/colisão de arquivo.
   const filename = `${crypto.randomUUID()}.${ext}`;
   fs.writeFileSync(path.join(UPLOAD_DIR, filename), buffer);
   // Legenda opcional (igual WhatsApp) - texto e imagem viram uma
   // mensagem só, não duas separadas.
   const caption = String(req.body.text || '').trim();
   const replyToId = Number(req.body.replyToId || 0) || null;
   const conversationId = await chat.getOrCreateDm(myId, otherId);
   await chat.sendImageMessage(conversationId, myId, req.chatUser.name, filename, caption, replyToId);
   res.json({ messages: await chat.listForConversation(conversationId, myId) });
});

// Sem "auth" (middleware de header) de propósito - uma tag <img src> não
// manda X-ChatGLPI-Auth nenhum, só dá pra levar o token via query string
// (mesma exceção já feita pra /api/stream).
app.get('/api/images/:filename', (req, res) => {
   const user = verifyToken(req.query.token, SECRET);
   if (!user) return res.status(401).end();
   const filename = path.basename(req.params.filename); // defesa extra, mesmo o nome já sendo controlado no servidor
   const filePath = path.join(UPLOAD_DIR, filename);
   if (!fs.existsSync(filePath)) return res.status(404).end();
   res.sendFile(filePath);
});

app.post('/api/dm', auth, async (req, res) => {
   const myId = req.chatUser.id;
   const otherId = Number(req.body.usersId || 0);
   if (!otherId || otherId === myId) {
      return res.status(400).json({ error: 'Parâmetro usersId inválido.' });
   }
   const otherUser = await chat.getUser(otherId);
   if (!otherUser) {
      return res.status(404).json({ error: 'Usuário não encontrado.' });
   }
   const conversationId = await chat.getOrCreateDm(myId, otherId);
   // Só vem de "Iniciar chat com solicitante" no chamado (hook.php) - vincula
   // a conversa a ele pra mudanças de status/acompanhamento aparecerem
   // aqui como mensagem de sistema (ver inc/message.class.php no lado PHP).
   const ticketId = Number(req.body.ticketId || 0) || null;
   if (ticketId) {
      const ticketTitle = String(req.body.ticketTitle || '').trim() || null;
      await chat.linkTicketToConversation(conversationId, ticketId, ticketTitle);
   }
   res.json({ channelId: otherId, channels: await chat.listForUser(myId) });
});

// Contrário de "Iniciar chat com solicitante" (POST /api/dm) - some o
// vínculo chamado<->conversa quando não faz mais sentido (ex.: chamado
// errado, ou já resolvido e o técnico não quer mais ver as mudanças dele
// aparecendo aqui). Mensagem de sistema fica pra registro, simétrica à que
// aparece quando o vínculo é criado (ver linkTicketToConversation()).
app.post('/api/unlink-ticket', auth, async (req, res) => {
   const myId = req.chatUser.id;
   const otherId = Number(req.body.usersId || 0);
   const ticketId = Number(req.body.ticketId || 0);
   if (!otherId || otherId === myId || !ticketId) {
      return res.status(400).json({ error: 'Parâmetros inválidos.' });
   }
   const conversationId = await chat.getOrCreateDm(myId, otherId);
   await chat.unlinkTicketFromConversation(conversationId, ticketId);
   res.json({
      channels: await chat.listForUser(myId),
      messages: await chat.listForConversation(conversationId, myId),
   });
});

app.get('/api/searchusers', auth, async (req, res) => {
   const myId = req.chatUser.id;
   const q = String(req.query.q || '').trim();
   if (q === '') return res.json({ users: [] });

   const like = `%${q}%`;
   const [rows] = await pool.query(
      `SELECT id, name, realname, firstname FROM glpi_users
       WHERE is_active = 1 AND is_deleted = 0 AND id <> ?
         AND (name LIKE ? OR realname LIKE ? OR firstname LIKE ?)
       LIMIT 20`,
      [myId, like, like, like]
   );
   // Mesmo isOnline() usado na lista de conversas (chat.listForUser) - dá
   // pra ver se a pessoa está online já na busca, antes de iniciar a DM.
   const users = await Promise.all(rows.map(async r => ({
      id: r.id,
      name: chat.formatUserName(r),
      online: await chat.isOnline(r.id),
   })));
   res.json({ users });
});

// Acesso remoto via noVNC (aba "Acesso remoto" do chamado) - ver
// remote.js. Só quem já provou login no GLPI (token assinado, mesmo
// mecanismo do resto do chat) pode ABRIR uma sessão nova; heartbeat/stop
// não exigem esse token porque o próprio UUID da sessão (aleatório,
// só entregue à aba que a criou) já funciona como credencial de posse.
app.post('/api/remote/start', auth, (req, res) => {
   const host = String(req.body.hostname || '').trim();
   if (!remote.isValidHostname(host)) {
      return res.status(400).json({ error: 'Hostname/IP inválido.' });
   }
   // ticketsId só vem da aba "Acesso remoto" do chamado (o card avulso do
   // dashboard não manda) - é o que permite registrar um acompanhamento no
   // chamado certo quando a sessão terminar (ver remote.js::destroySession()).
   const ticketsId = Number(req.body.ticketsId || 0) || null;
   const result = remote.createSession(host, req.chatUser.name, req.chatUser.id, ticketsId);
   res.json(result);
});

app.post('/api/remote/heartbeat', (req, res) => {
   const ok = remote.heartbeat(String(req.body.session || ''));
   if (!ok) return res.status(404).json({ error: 'Sessão não encontrada ou expirada.' });
   res.json({ ok: true });
});

app.post('/api/remote/stop', (req, res) => {
   remote.destroySession(String(req.body.session || ''));
   res.json({ ok: true }); // idempotente - a aba pode mandar isso mais de uma vez (unload + beacon)
});

// Widget de chat flutuante na tela da pessoa durante o acesso remoto (ver
// agent/chatwindow/main.go) - aberto automaticamente quando a sessão é
// criada (remote.js::createSession()), não precisa de rota própria aqui
// pra "abrir". Sem "auth" nestas duas rotas, mesmo raciocínio de
// heartbeat/stop acima: o UUID da sessão já é a credencial (só quem abriu
// a aba de acesso remoto tem esse id).
app.post('/api/remote/chat/send', async (req, res) => {
   const sessionId = String(req.body.session || '');
   const text = String(req.body.text || '').trim();
   if (!sessionId || !text) {
      return res.status(400).json({ error: 'Parâmetros inválidos.' });
   }
   try {
      await remote.sendChatMessage(sessionId, text);
      res.json({ ok: true });
   } catch (err) {
      res.status(502).json({ error: err.message });
   }
});

app.get('/api/remote/chat/messages', (req, res) => {
   const sessionId = String(req.query.session || '');
   const messages = remote.getMessages(sessionId);
   if (messages === null) {
      return res.status(404).json({ error: 'Sessão não encontrada ou expirada.' });
   }
   res.json({ messages });
});

// Chamada pelo AGENTE (não pelo navegador do técnico) quando a pessoa
// responde na janela de chat - autenticado pelo mesmo token estático do
// endpoint de mensagem do agente (AGENT_MESSAGE_TOKEN em remote.js, valor
// hardcoded espelhado em agent/main.go). Acha a sessão certa pelo hostname
// (o agente só sabe o próprio nome de máquina, não o id da sessão).
app.post('/api/remote/agent-reply', (req, res) => {
   if (req.headers['x-chatglpi-message-token'] !== (process.env.CHATGLPI_AGENT_MESSAGE_TOKEN || 'CHANGE_ME_message_token')) {
      return res.status(403).json({ error: 'Token inválido.' });
   }
   const hostname = String(req.body.hostname || '').trim();
   const text = String(req.body.text || '').trim();
   if (!hostname || !text) {
      return res.status(400).json({ error: 'Parâmetros inválidos.' });
   }
   const found = remote.appendAgentReply(hostname, text);
   res.json({ ok: found });
});

// Chamado via navigator.sendBeacon no "pagehide" (ver js/chat.js) - marca
// offline NA HORA ao fechar a aba/navegar pra fora, em vez de esperar a
// janela de tolerância de isOnline() (90s) expirar. sendBeacon não manda
// header customizado nenhum (mesma exceção de /api/stream e /api/images),
// então o token vem por query string aqui também.
app.post('/api/presence/offline', async (req, res) => {
   const user = verifyToken(req.query.token, SECRET);
   if (!user) return res.status(401).end();
   await chat.clearPresence(user.id);
   res.status(204).end();
});

// SSE - EventSource não manda headers customizados, então o token vem por
// query string aqui (única exceção; o resto usa X-ChatGLPI-Auth). Mesmo
// padrão de poll curto (~1s) que o endpoint PHP tinha antes de mover pra
// cá - o efeito pro navegador é idêntico (push quase instantâneo).
app.get('/api/stream', async (req, res) => {
   const user = verifyToken(req.query.token, SECRET);
   if (!user) return res.status(401).end();

   res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
   });

   let closed = false;
   req.on('close', () => { closed = true; });

   const convIdsOf = async () => (await pool.query(
      'SELECT conversations_id FROM glpi_plugin_chatglpi_participants WHERE users_id = ?',
      [user.id]
   ))[0].map(r => r.conversations_id);

   const maxActivityOf = async (convIds) => {
      let max = 0;
      for (const id of convIds) {
         max = Math.max(max, await chat.lastActivity(id));
      }
      return max;
   };

   let lastSeenMax = await maxActivityOf(await convIdsOf());
   const start = Date.now();

   while (!closed && Date.now() - start < 110000) {
      await chat.touchPresence(user.id);
      const currentMax = await maxActivityOf(await convIdsOf());
      if (currentMax > lastSeenMax) {
         lastSeenMax = currentMax;
         res.write(`data: ${JSON.stringify({ type: 'update' })}\n\n`);
      } else {
         res.write(': ping\n\n');
      }
      await new Promise(r => setTimeout(r, 1000));
   }
   res.end();
});

app.listen(PORT, () => {
   console.log(`chatglpi-backend ouvindo na porta ${PORT}`);
});
