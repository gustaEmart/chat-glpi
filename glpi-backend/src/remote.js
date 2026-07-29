// Sessões de acesso remoto via noVNC + websockify (aba "Acesso remoto" do
// chamado) - substitui o agente local + UltraVNC Viewer só nesse fluxo (o
// botão "Conectar" da lista de Computadores e do painel de agentes continua
// usando o agente local, ver chatglpiConnectFromAgentsPanel em chat.js).
//
// Cada sessão vira uma linha no arquivo de tokens do websockify (formato
// "token: host:port", um espaço depois dos dois-pontos - ver
// token_plugins.py). O websockify roda com --token-plugin=TokenFile, que
// relê esse arquivo a CADA conexão nova (diferente do ReadOnlyTokenFile,
// que cacheia só na primeira leitura) - por isso basta reescrever o arquivo
// pra uma sessão nova já ficar válida sem reiniciar o serviço.
const fs = require('fs');
const crypto = require('crypto');

const VNC_PORT = 5900;
const TOKEN_FILE = process.env.WEBSOCKIFY_TOKEN_FILE || '/opt/glpi-chat/glpi-backend/websockify-tokens.txt';
const PUBLIC_BASE = process.env.REMOTE_PUBLIC_BASE || 'https://chat.example.local';
// Callback pro GLPI registrar o acompanhamento "computador X acessado por
// Ymin Zs" no chamado, quando a sessão terminar (só se ela tiver
// ticketsId - a aba do chamado manda, o card avulso do dashboard não).
// HTTP puro (não HTTPS) de propósito: essa chamada é servidor-servidor
// (Node -> Apache do GLPI), nunca passa por navegador nenhum, então o
// certificado autoassinado do GLPI (ver [[project_chatglpi_glpi_plugin]])
// só atrapalharia (Node rejeitaria por padrão) sem ganhar nada em troca -
// a porta 80 do GLPI já está ativa em paralelo pra isso.
const GLPI_FOLLOWUP_URL = process.env.GLPI_FOLLOWUP_URL
   || 'http://192.0.2.10/glpi/plugins/chatglpi/ajax/remotefollowup.php';
// Callback separado do de cima (mesmo padrão de assinatura HMAC) - registra
// no chamado cada mensagem mandada durante a sessão (não só a duração no
// fim), ver postMessageFollowupCallback() mais abaixo.
const GLPI_MESSAGE_FOLLOWUP_URL = process.env.GLPI_MESSAGE_FOLLOWUP_URL
   || 'http://192.0.2.10/glpi/plugins/chatglpi/ajax/remotemessagefollowup.php';
const SHARED_SECRET = process.env.CHATGLPI_SHARED_SECRET;
// Porta/token do endpoint de mensagem do agente (agent/main.go::
// handleMessage()) - roda em CADA computador do domínio (instalado via GPO),
// ouvindo em TODAS as interfaces (não só loopback, diferente do endpoint de
// /info usado pelo Chat-GLPI no navegador). Mesmo valor hardcoded no agente.
const AGENT_MESSAGE_PORT = 47823;
const AGENT_MESSAGE_TOKEN = process.env.CHATGLPI_AGENT_MESSAGE_TOKEN || 'CHANGE_ME_message_token';
// Janela de expiração: a página noVNC manda heartbeat a cada 20s enquanto a
// aba estiver aberta; qualquer coisa acima disso é sessão órfã (aba
// fechada sem o beacon de saída ter chegado, processo do navegador matado
// à força, etc.) - ver "não manter processos órfãos" no md da tarefa.
const TTL_MS = 90 * 1000;
const SWEEP_INTERVAL_MS = 30 * 1000;

// Só aceita o que um hostname/IP de verdade pode ter - o valor entra numa
// linha "token: host:port" no arquivo de tokens do websockify, então
// qualquer espaço ou dois-pontos no meio quebraria o parser (ou, pior,
// deixaria injetar uma linha extra se tivesse quebra de linha).
const HOSTNAME_RE = /^[a-zA-Z0-9.\-]+$/;

const sessions = new Map();

function isValidHostname(host) {
   return typeof host === 'string' && host.length > 0 && host.length <= 255 && HOSTNAME_RE.test(host);
}

function writeTokenFile() {
   const lines = [];
   for (const [id, s] of sessions) {
      lines.push(`${id}: ${s.host}:${s.port}`);
   }
   const tmpPath = `${TOKEN_FILE}.tmp`;
   fs.writeFileSync(tmpPath, lines.join('\n') + '\n', 'utf8');
   fs.renameSync(tmpPath, TOKEN_FILE); // atômico - websockify nunca vê o arquivo pela metade
}

function createSession(host, userName, userId, ticketsId) {
   const id = crypto.randomUUID();
   const now = Date.now();
   const session = { host, port: VNC_PORT, createdAt: now, lastHeartbeat: now, userName, userId, ticketsId, messages: [] };
   sessions.set(id, session);
   writeTokenFile();
   // "Assim que o acesso remoto começa" (decisão tomada com o usuário) - o
   // widget de chat já aparece na tela da pessoa antes de qualquer mensagem
   // ser digitada, não só na primeira vez que o técnico escrever algo.
   openChatForSession(session);
   return { session: id, url: `${PUBLIC_BASE}/remote/${id}` };
}

function heartbeat(id) {
   const s = sessions.get(id);
   if (!s) return false;
   s.lastHeartbeat = Date.now();
   return true;
}

// Assina o corpo com o mesmo segredo compartilhado da ponte de auth
// (inc/authtoken.php) - aqui não é um token de usuário, é só uma
// assinatura HMAC sobre o JSON inteiro, verificada em ajax/
// remotefollowup.php antes de aceitar o registro.
function postFollowupCallback(session, endTime) {
   if (!session.ticketsId) return; // só sessões abertas a partir de um chamado
   const durationSeconds = Math.max(0, Math.round((endTime - session.createdAt) / 1000));
   const payload = JSON.stringify({
      ticketsId: session.ticketsId,
      userId: session.userId || 0,
      hostname: session.host,
      durationSeconds,
   });
   const signature = crypto.createHmac('sha256', SHARED_SECRET).update(payload).digest('hex');
   fetch(GLPI_FOLLOWUP_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-ChatGLPI-Signature': signature },
      body: payload,
   }).catch(err => {
      // Nunca deixa isso derrubar a limpeza da sessão - só loga. Se o
      // acompanhamento falhar (GLPI fora do ar, etc.), a sessão em si já
      // foi encerrada normalmente de qualquer forma.
      console.error('Falha ao registrar acompanhamento de acesso remoto:', err.message);
   });
}

// POST genérico pro agente (agent/main.go) da máquina da sessão, na porta de
// rede dedicada (AGENT_MESSAGE_PORT) - usado pelas três chamadas de chat
// abaixo (open/send/close). "melhor esforço" quando indicado: falha aqui
// nunca deve travar o resto do fluxo (a sessão de acesso remoto em si
// funciona mesmo sem o agente instalado/alcançável).
async function agentPost(host, path, body, timeoutMs) {
   const url = `http://${host}:${AGENT_MESSAGE_PORT}${path}`;
   const controller = new AbortController();
   const timer = setTimeout(() => controller.abort(), timeoutMs);
   try {
      const res = await fetch(url, {
         method: 'POST',
         headers: { 'Content-Type': 'application/json', 'X-ChatGLPI-Message-Token': AGENT_MESSAGE_TOKEN },
         body: JSON.stringify(body),
         signal: controller.signal,
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
         throw new Error(data.error || `Falha ao falar com o agente (HTTP ${res.status}).`);
      }
      return data;
   } finally {
      clearTimeout(timer);
   }
}

// Mostra o widget de chat na tela da pessoa - chamado assim que a sessão de
// acesso remoto é criada (ver createSession()). Melhor esforço: se a
// máquina não tiver o agente novo instalado ainda, o acesso remoto em si
// continua funcionando normalmente, só sem o chat.
function openChatForSession(session) {
   agentPost(session.host, '/chat/open', {}, 10000).catch(err => {
      console.error('Falha ao abrir o widget de chat na máquina remota:', err.message);
   });
}

// Manda uma mensagem do técnico pro widget de chat da pessoa - ao contrário
// do antigo aviso bloqueante, isso NÃO espera resposta (a conversa é
// assíncrona agora); a resposta da pessoa chega depois, separada, via
// appendAgentReply() (chamada pelo agente em /api/remote/agent-reply).
async function sendChatMessage(id, text) {
   const session = sessions.get(id);
   if (!session) {
      throw new Error('Sessão de acesso remoto não encontrada ou expirada.');
   }
   await agentPost(session.host, '/chat/send', { text }, 15000);
   session.messages.push({ from: 'tech', text, ts: Date.now() });
}

// Contrário de sendChatMessage - chamado pelo endpoint que o AGENTE bate
// (não o navegador do técnico) quando a pessoa responde algo na janela.
// Acha a sessão pelo hostname (o agente não sabe o id da sessão, só o nome
// da própria máquina) - só sessões ATIVAS entram no Map, então isso já
// ignora automaticamente respostas tardias de uma sessão já encerrada.
function appendAgentReply(hostname, text) {
   // Case-insensitive de propósito - o hostname que o agente manda vem de
   // os.Hostname() (Go), que pode divergir em maiúsculas/minúsculas do que
   // foi digitado/resolvido na hora de abrir a sessão (session.host).
   const target = hostname.toLowerCase();
   for (const session of sessions.values()) {
      if (session.host.toLowerCase() === target) {
         session.messages.push({ from: 'user', text, ts: Date.now() });
         return true;
      }
   }
   console.error(`appendAgentReply: nenhuma sessão ativa para o hostname "${hostname}" (sessões ativas: ${
      [...sessions.values()].map(s => s.host).join(', ') || 'nenhuma'
   })`);
   return false;
}

function getMessages(id) {
   const session = sessions.get(id);
   return session ? session.messages : null;
}

// Fecha o widget de chat na tela da pessoa - chamado quando a sessão de
// acesso remoto termina de verdade (ver destroySession/sweepExpired
// abaixo), pra não deixar uma janela órfã depois que o técnico já saiu.
function closeChatForSession(session) {
   agentPost(session.host, '/chat/close', {}, 10000).catch(() => {
      // Melhor esforço - a máquina pode já estar desligada/fora da rede.
   });
}

// Registra a conversa INTEIRA da sessão como um acompanhamento só no
// chamado (não mensagem por mensagem) - atende ao pedido de anexar o chat
// ao chamado "em algum momento": aqui é quando a sessão termina, já com a
// conversa completa pra dar contexto de uma vez.
function postChatTranscriptFollowup(session) {
   if (!session.ticketsId || session.messages.length === 0) return;
   const payload = JSON.stringify({
      ticketsId: session.ticketsId,
      userId: session.userId || 0,
      hostname: session.host,
      messages: session.messages,
   });
   const signature = crypto.createHmac('sha256', SHARED_SECRET).update(payload).digest('hex');
   fetch(GLPI_MESSAGE_FOLLOWUP_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-ChatGLPI-Signature': signature },
      body: payload,
   }).catch(err => {
      console.error('Falha ao registrar a conversa de acesso remoto no chamado:', err.message);
   });
}

function destroySession(id) {
   const s = sessions.get(id);
   const existed = sessions.delete(id);
   if (existed) {
      writeTokenFile();
      closeChatForSession(s);
      // Parada explícita (POST /stop, via beacon no fechamento da aba) -
      // "agora" É o fim real da sessão, dá pra usar direto.
      postFollowupCallback(s, Date.now());
      postChatTranscriptFollowup(s);
   }
   return existed;
}

function sweepExpired() {
   const now = Date.now();
   let changed = false;
   for (const [id, s] of sessions) {
      if (now - s.lastHeartbeat > TTL_MS) {
         sessions.delete(id);
         changed = true;
         closeChatForSession(s);
         // Órfã (aba fechada sem o beacon chegar, processo morto à força
         // etc.) - "agora" pode ser até TTL_MS depois do fim de verdade,
         // então o último heartbeat confirmado é a estimativa melhor.
         postFollowupCallback(s, s.lastHeartbeat);
         postChatTranscriptFollowup(s);
      }
   }
   if (changed) writeTokenFile();
}

setInterval(sweepExpired, SWEEP_INTERVAL_MS);
// Arquivo sempre existe desde o boot, mesmo sem nenhuma sessão ainda -
// senão o websockify falha ao subir procurando um arquivo inexistente.
writeTokenFile();

module.exports = {
   isValidHostname,
   createSession,
   heartbeat,
   destroySession,
   sendChatMessage,
   appendAgentReply,
   getMessages,
   VNC_PORT,
};
