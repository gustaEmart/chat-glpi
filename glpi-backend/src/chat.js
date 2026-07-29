// Porta pra Node de inc/conversation.class.php + inc/message.class.php do
// plugin GLPI - mesmas tabelas (glpi_plugin_chatglpi_*), mesma lógica,
// só que rodando aqui na VM dedicada em vez do PHP do servidor
// compartilhado do GLPI. Sem upload de imagem nesta versão (fora do
// escopo combinado: só chat de texto + preenchimento automático de
// host/IP/MAC, que continua resolvido localmente no plugin PHP).
const pool = require('./db');

function formatUserName(row) {
   const name = `${row.firstname || ''} ${row.realname || ''}`.trim();
   return name !== '' ? name : row.name;
}

function initialsOf(row) {
   let name = `${row.firstname || ''} ${row.realname || ''}`.trim();
   if (name === '') name = row.name;
   const parts = name.split(/[.\s]+/).filter(Boolean);
   return parts.slice(0, 2).map(p => p[0].toUpperCase()).join('');
}

async function getUser(userId) {
   const [rows] = await pool.query(
      'SELECT id, name, realname, firstname FROM glpi_users WHERE id = ? AND is_deleted = 0 LIMIT 1',
      [userId]
   );
   return rows[0] || null;
}

async function getOrCreateDm(userIdA, userIdB) {
   if (userIdA === userIdB) {
      throw new Error('Não é possível iniciar uma conversa consigo mesmo.');
   }
   const [rows] = await pool.query(
      `SELECT p1.conversations_id AS id
       FROM glpi_plugin_chatglpi_participants p1
       INNER JOIN glpi_plugin_chatglpi_participants p2
          ON p1.conversations_id = p2.conversations_id
       WHERE p1.users_id = ? AND p2.users_id = ?
       LIMIT 1`,
      [userIdA, userIdB]
   );
   if (rows.length > 0) return rows[0].id;

   const [ins] = await pool.query('INSERT INTO glpi_plugin_chatglpi_conversations (date_creation) VALUES (NOW())');
   const conversationsId = ins.insertId;
   await pool.query(
      'INSERT INTO glpi_plugin_chatglpi_participants (conversations_id, users_id) VALUES (?, ?), (?, ?)',
      [conversationsId, userIdA, conversationsId, userIdB]
   );
   return conversationsId;
}

async function participantsOf(conversationsId) {
   const [rows] = await pool.query(
      'SELECT users_id FROM glpi_plugin_chatglpi_participants WHERE conversations_id = ?',
      [conversationsId]
   );
   return rows.map(r => r.users_id);
}

// Vincula a conversa a um chamado - depois disso, mudanças de status/
// acompanhamento nesse chamado (postado via inc/message.class.php, direto
// no PHP do GLPI) passam a aparecer como mensagem de sistema aqui também.
// INSERT IGNORE porque a PK é (tickets_id, conversations_id) - o mesmo
// solicitante pode ser chamado de novo a partir do mesmo chamado sem
// problema (ex.: técnico saiu e voltou a conversar). affectedRows === 1
// só quando o par é realmente novo (0 quando o IGNORE descartou uma
// duplicata) - é o que usamos pra postar a mensagem de apresentação do
// chamado só na primeira vez, nunca repetida em conversas já vinculadas.
async function linkTicketToConversation(conversationsId, ticketsId, ticketTitle) {
   const [result] = await pool.query(
      'INSERT IGNORE INTO glpi_plugin_chatglpi_ticketconversations (tickets_id, conversations_id) VALUES (?, ?)',
      [ticketsId, conversationsId]
   );
   if (result.affectedRows > 0) {
      const title = ticketTitle ? ` "${ticketTitle}"` : '';
      await pool.query(
         `INSERT INTO glpi_plugin_chatglpi_messages
            (conversations_id, users_id, author_name, is_system, content, variant, date_creation)
          VALUES (?, NULL, 'Sistema', 1, ?, 'ticket-ref', NOW())`,
         [conversationsId, `Chamado #${ticketsId}${title}`]
      );
   }
}

async function ticketIdsFor(conversationsId) {
   const [rows] = await pool.query(
      'SELECT tickets_id FROM glpi_plugin_chatglpi_ticketconversations WHERE conversations_id = ?',
      [conversationsId]
   );
   return rows.map(r => r.tickets_id);
}

// Contrário de linkTicketToConversation() - some o vínculo e avisa na
// própria conversa (mensagem de sistema), simétrico à que aparece quando o
// vínculo é criado. affectedRows === 0 quando o par já não existia (dá pra
// chamar de novo sem problema, idempotente).
async function unlinkTicketFromConversation(conversationsId, ticketsId) {
   const [result] = await pool.query(
      'DELETE FROM glpi_plugin_chatglpi_ticketconversations WHERE tickets_id = ? AND conversations_id = ?',
      [ticketsId, conversationsId]
   );
   if (result.affectedRows > 0) {
      await pool.query(
         `INSERT INTO glpi_plugin_chatglpi_messages
            (conversations_id, users_id, author_name, is_system, content, variant, date_creation)
          VALUES (?, NULL, 'Sistema', 1, ?, 'ticket-unlink', NOW())`,
         [conversationsId, `Chamado #${ticketsId} desvinculado desta conversa.`]
      );
   }
   return result.affectedRows > 0;
}

// Confirma que a mensagem respondida pertence à MESMA conversa antes de
// gravar o vínculo - sem isso, um cliente malicioso/bugado poderia mandar
// o id de uma mensagem de OUTRA conversa como replyToId, e o outro
// participante desta conversa acabaria vendo um trecho de uma conversa que
// não é dele nenhuma (vazamento de informação entre DMs).
async function validReplyId(conversationsId, replyToId) {
   if (!replyToId) return null;
   const [rows] = await pool.query(
      'SELECT id FROM glpi_plugin_chatglpi_messages WHERE id = ? AND conversations_id = ? LIMIT 1',
      [replyToId, conversationsId]
   );
   return rows[0] ? replyToId : null;
}

async function lastActivity(conversationsId) {
   const [rows] = await pool.query(
      'SELECT id FROM glpi_plugin_chatglpi_messages WHERE conversations_id = ? ORDER BY id DESC LIMIT 1',
      [conversationsId]
   );
   return rows[0] ? rows[0].id : 0;
}

async function isOnline(userId) {
   const [rows] = await pool.query(
      'SELECT last_seen FROM glpi_plugin_chatglpi_presence WHERE users_id = ?',
      [userId]
   );
   if (!rows[0]) return false;
   // 15s original era curto demais na prática: o widget flutuante (em
   // qualquer página do GLPI, não só na do chat) hoje só toca presença
   // via poll a cada 15s - qualquer jitter de rede, ou a aba estando em
   // segundo plano (o navegador atrasa timers de aba não focada de
   // propósito, pra economizar bateria/CPU), já derruba pra "offline"
   // mesmo com a aba genuinamente aberta. 90s tolera isso com folga sem
   // deixar de refletir realisticamente "tem alguém by aí agora".
   return (Date.now() - new Date(rows[0].last_seen).getTime()) / 1000 < 90;
}

// Contrário de touchPresence() - chamado no fechamento da aba/navegação
// (navigator.sendBeacon no "pagehide", ver js/chat.js) pra marcar offline
// NA HORA, em vez de esperar a janela de tolerância de isOnline() (90s)
// expirar sozinha. Sem isso o "online" ficava certo por até ~90s+poll
// depois de a pessoa já ter fechado a aba de verdade - fisicamente
// correto (a pessoa só fica confirmadamente ausente depois desse tempo),
// mas incomodava quem queria ver a saída refletir na hora. DELETE (não só
// um last_seen zerado) porque "sem linha nenhuma" já é o que isOnline()
// trata como offline.
async function clearPresence(userId) {
   await pool.query('DELETE FROM glpi_plugin_chatglpi_presence WHERE users_id = ?', [userId]);
}

async function touchPresence(userId) {
   // UTC_TIMESTAMP(), não NOW() - o MySQL do GLPI roda no fuso de Brasília
   // (America/Sao_Paulo, UTC-3), mas esta VM roda em UTC. O pool usa
   // dateStrings:true (ver db.js), então last_seen chega aqui como texto
   // puro sem fuso ("2026-07-24 12:49:20") - new Date(...) no Node
   // interpreta isso como se já fosse UTC. Gravando com NOW() (hora LOCAL
   // do MySQL, 3h atrás da real), a conta em isOnline() (Date.now() menos
   // esse valor mal-interpretado) sempre dava ~3h de "atraso" e todo mundo
   // aparecia offline pra sempre, não importava a janela de tolerância.
   // Gravando em UTC_TIMESTAMP(), o texto gravado já bate com o fuso que
   // o Node vai assumir ao interpretar - sem mais descompasso.
   await pool.query(
      `INSERT INTO glpi_plugin_chatglpi_presence (users_id, last_seen) VALUES (?, UTC_TIMESTAMP())
       ON DUPLICATE KEY UPDATE last_seen = UTC_TIMESTAMP()`,
      [userId]
   );
}

async function lastReadMessageId(userId, conversationsId) {
   const [rows] = await pool.query(
      'SELECT last_messages_id FROM glpi_plugin_chatglpi_lastread WHERE users_id = ? AND conversations_id = ?',
      [userId, conversationsId]
   );
   return rows[0] ? rows[0].last_messages_id : 0;
}

async function markRead(userId, conversationsId) {
   const last = await lastActivity(conversationsId);
   if (last === 0) return false;
   const current = await lastReadMessageId(userId, conversationsId);
   if (current >= last) return false;
   await pool.query(
      `INSERT INTO glpi_plugin_chatglpi_lastread (users_id, conversations_id, last_messages_id)
       VALUES (?, ?, ?)
       ON DUPLICATE KEY UPDATE last_messages_id = VALUES(last_messages_id)`,
      [userId, conversationsId, last]
   );
   return true;
}

async function unreadCount(conversationsId, forUserId) {
   const lastRead = await lastReadMessageId(forUserId, conversationsId);
   const [rows] = await pool.query(
      `SELECT COUNT(*) AS n FROM glpi_plugin_chatglpi_messages
       WHERE conversations_id = ? AND id > ? AND (is_system = 1 OR users_id <> ?)`,
      [conversationsId, lastRead, forUserId]
   );
   return rows[0].n;
}

async function listForUser(userId) {
   const [convRows] = await pool.query(
      'SELECT conversations_id FROM glpi_plugin_chatglpi_participants WHERE users_id = ?',
      [userId]
   );
   const channels = [];
   for (const { conversations_id: convId } of convRows) {
      const participants = await participantsOf(convId);
      const otherId = participants.find(id => id !== userId);
      if (!otherId) continue;
      const user = await getUser(otherId);
      if (!user) continue;

      const [unread, activity, online, ticketIds] = await Promise.all([
         unreadCount(convId, userId),
         lastActivity(convId),
         isOnline(otherId),
         ticketIdsFor(convId),
      ]);

      channels.push({
         id: otherId,
         name: formatUserName(user),
         kind: 'dm',
         sub: '',
         initials: initialsOf(user),
         unread,
         online,
         lastActivity: activity,
         ticketIds,
         conversationId: convId,
      });
   }
   channels.sort((a, b) => b.lastActivity - a.lastActivity);
   return channels;
}

async function sendMessage(conversationsId, userId, authorName, text, replyToId) {
   const safeReplyToId = await validReplyId(conversationsId, replyToId);
   const [ins] = await pool.query(
      `INSERT INTO glpi_plugin_chatglpi_messages
         (conversations_id, users_id, author_name, is_system, content, reply_to_id, date_creation)
       VALUES (?, ?, ?, 0, ?, ?, NOW())`,
      [conversationsId, userId, authorName, text, safeReplyToId]
   );
   return ins.insertId;
}

// filename já vem gerado pelo servidor (UUID + extensão, ver server.js::
// POST /api/send-image) - nunca um nome vindo do cliente, então não tem
// risco de path traversal/colisão aqui.
async function sendImageMessage(conversationsId, userId, authorName, filename, caption, replyToId) {
   const safeReplyToId = await validReplyId(conversationsId, replyToId);
   const [ins] = await pool.query(
      `INSERT INTO glpi_plugin_chatglpi_messages
         (conversations_id, users_id, author_name, is_system, content, image_file, reply_to_id, date_creation)
       VALUES (?, ?, ?, 0, ?, ?, ?, NOW())`,
      [conversationsId, userId, authorName, caption || '', filename, safeReplyToId]
   );
   return ins.insertId;
}

async function listForConversation(conversationsId, forUserId) {
   const [rows] = await pool.query(
      'SELECT * FROM glpi_plugin_chatglpi_messages WHERE conversations_id = ? ORDER BY id ASC',
      [conversationsId]
   );
   const participants = await participantsOf(conversationsId);
   const otherId = participants.find(id => id !== forUserId) || null;
   const otherLastRead = otherId ? await lastReadMessageId(otherId, conversationsId) : 0;

   // Junta o texto/autor/imagem da mensagem ORIGINAL de cada resposta numa
   // única query em lote (não uma por mensagem) - o cliente usa isso pra
   // desenhar a citação reduzida dentro da bolha, estilo WhatsApp. Escopo
   // "AND conversations_id = ?" de novo aqui por defesa em profundidade
   // (reply_to_id já é validado na escrita, mas não custa checar de novo).
   const replyIds = [...new Set(rows.map(r => r.reply_to_id).filter(Boolean))];
   let repliedMap = {};
   if (replyIds.length > 0) {
      const [repliedRows] = await pool.query(
         `SELECT id, author_name, is_system, content, image_file
          FROM glpi_plugin_chatglpi_messages WHERE id IN (?) AND conversations_id = ?`,
         [replyIds, conversationsId]
      );
      repliedMap = Object.fromEntries(repliedRows.map(r => [r.id, r]));
   }

   const messages = rows.map(row => {
      const mine = !row.is_system && row.users_id === forUserId;
      const ts = new Date(row.date_creation).getTime();
      const replied = row.reply_to_id ? repliedMap[row.reply_to_id] : null;
      return {
         id: row.id,
         authorId: row.is_system ? null : row.users_id,
         authorName: row.author_name,
         isBot: !!row.is_system,
         time: new Date(row.date_creation).toTimeString().slice(0, 5),
         ts,
         text: row.content,
         variant: row.variant || null,
         imageFile: row.image_file || null,
         read: mine ? row.id <= otherLastRead : null,
         replyTo: replied ? {
            id: row.reply_to_id,
            authorName: replied.is_system ? 'Sistema' : replied.author_name,
            text: replied.content,
            imageFile: replied.image_file || null,
         } : null,
      };
   });

   await markRead(forUserId, conversationsId);
   return messages;
}

module.exports = {
   formatUserName,
   initialsOf,
   getUser,
   getOrCreateDm,
   linkTicketToConversation,
   unlinkTicketFromConversation,
   participantsOf,
   ticketIdsFor,
   lastActivity,
   isOnline,
   touchPresence,
   clearPresence,
   listForUser,
   sendMessage,
   sendImageMessage,
   listForConversation,
};
