// Chat-GLPI - UI vanilla JS (sem build, sem React) montada dentro da div
// #chatglpi-app da página front/chat.php. Reimplementa o essencial de
// frontend/src/components/ChatPanel.jsx e ChannelRail.jsx do app antigo,
// falando com os endpoints ajax/*.php deste plugin em vez da API Node.
//
// Usa classes do Bootstrap (list-group, btn, form-control, bg-primary...)
// em vez de cor/tamanho fixo no CSS - assim a tela herda automaticamente o
// tema escolhido pelo usuário no GLPI, em vez de brigar com ele.
(function () {
   const container = document.getElementById('chatglpi-app');
   if (container) {
      initChat(container);
   }
})();

// PWA - deixa o GLPI instalável (Chrome/Android oferece "Instalar app" -
// abre em tela cheia, sem barra de endereço, ícone próprio na tela
// inicial). Roda em TODA página (inclusive a de login, sem sessão) porque
// o manifest/service worker não dependem de estar logado - diferente do
// resto deste arquivo, que é sobre o chat em si. Sem cache offline de
// propósito (ver pwa/sw.js) - só o mínimo que o Chrome exige pra
// considerar o site instalável.
(function chatglpiInitPwa() {
   if (!document.querySelector('link[rel="manifest"]')) {
      const link = document.createElement('link');
      link.rel = 'manifest';
      link.href = '/glpi/plugins/chatglpi/pwa/manifest.json';
      document.head.appendChild(link);
   }
   if (!document.querySelector('meta[name="theme-color"]')) {
      const meta = document.createElement('meta');
      meta.name = 'theme-color';
      meta.content = '#ffffff';
      document.head.appendChild(meta);
   }
   // Servido via ajax/sw.php (não pwa/sw.js direto) só pra poder mandar o
   // header Service-Worker-Allowed - é o que deixa o escopo (/glpi/)
   // cobrir o GLPI inteiro, não só a pasta deste plugin.
   if ('serviceWorker' in navigator) {
      navigator.serviceWorker.register('/glpi/plugins/chatglpi/ajax/sw.php', { scope: '/glpi/' }).catch(() => {});
   }
})();

// Widget flutuante - presente em QUALQUER página do GLPI (chat.js carrega
// globalmente, ver $PLUGIN_HOOKS['add_javascript'] em setup.php), não só
// na página dedicada do chat. É o que dá "presença certificada": só de
// ter alguma aba do GLPI aberta (não precisa estar na tela do chat) já
// conta presença e recebe notificação nativa do navegador quando alguém
// manda mensagem. Não duplica na própria página do chat (ela já tem o
// #chatglpi-app com o mesmo SSE) nem quando não há sessão GLPI ativa
// (ajax/presencetoken.php responde 401 e o .catch() só desiste quieto).
//
// window.chatglpiOpenFloatingChat(userId, ticketId, ticketTitle) - chamado
// pelo botão "Iniciar chat com solicitante" (hook.php) pra abrir a DM
// AQUI no widget, sem navegar pra lugar nenhum. Definida já de cara (antes
// do fetch do token terminar) só guardando o pedido numa fila - o token
// vem de uma chamada assíncrona, e o técnico pode clicar o botão antes
// dela responder; a versão de verdade (mais abaixo) drena essa fila assim
// que o widget estiver pronto.
let chatglpiPendingOpen = null;
window.chatglpiOpenFloatingChat = function (userId, ticketId, ticketTitle) {
   chatglpiPendingOpen = { userId, ticketId, ticketTitle };
};

(function () {
   if (document.getElementById('chatglpi-app')) return;
   fetch('/glpi/plugins/chatglpi/ajax/presencetoken.php')
      .then(r => r.ok ? r.json() : null)
      .then(info => { if (info && info.token) initFloatingChatWidget(info); })
      .catch(() => {});
})();

// Tamanho do painel flutuante (arrastado pelo canto - resize:both no CSS,
// ver chat.css) - guardado só no navegador (localStorage), igual o
// histórico de hosts do acesso remoto, pra continuar do jeito que o
// técnico deixou da última vez em vez de voltar sempre pro padrão.
const CHATGLPI_PANEL_SIZE_KEY = 'chatglpi-panel-size';

function chatglpiLoadPanelSize() {
   try {
      const s = JSON.parse(localStorage.getItem(CHATGLPI_PANEL_SIZE_KEY));
      if (s && s.width > 0 && s.height > 0) return s;
   } catch (e) {
      // localStorage corrompido/indisponível - segue com o tamanho padrão do CSS.
   }
   return null;
}

function chatglpiSavePanelSize(width, height) {
   localStorage.setItem(CHATGLPI_PANEL_SIZE_KEY, JSON.stringify({ width, height }));
}

// Cor do "menu" do GLPI (mainmenu_bg/mainmenu_fg da paleta escolhida pelo
// usuário - Configurar > Preferências > Paleta de cores) - é uma cor
// SEPARADA de bg-primary/btn-primary (essa é a $primary da mesma paleta,
// já usada nos botões/bolhas). Não existe uma classe Bootstrap genérica
// pra ela (não é --bs-secondary, que é sempre cinza fixo, igual em toda
// paleta - conferido nos CSS compilados do servidor), só o próprio
// cabeçalho do GLPI (.topbar no layout horizontal, .sidebar no vertical -
// ver templates/layout/parts/page_header.html.twig) carrega essa cor.
// Em vez de tentar adivinhar/fixar um hex (ia quebrar assim que o usuário
// trocasse de paleta), lê a cor computada de verdade do elemento real na
// página - sempre bate com a paleta atual, seja qual for.
function chatglpiMenuColors() {
   const el = document.querySelector('.topbar, .sidebar');
   if (!el) return null;
   const style = getComputedStyle(el);
   return { bg: style.backgroundColor, fg: style.color };
}

function initFloatingChatWidget(info) {
   // Classes nativas do GLPI (não cor fixa) - ver comentário em
   // css/chat.css sobre por que isso é o que faz o widget seguir a
   // paleta de cores escolhida pelo usuário, inclusive as escuras.
   const button = document.createElement('button');
   button.id = 'chatglpi-float-button';
   button.className = 'btn btn-primary';
   button.type = 'button';
   button.title = 'Chat-GLPI';
   button.innerHTML = '<i class="ti ti-message-circle"></i>';
   document.body.appendChild(button);

   const badge = document.createElement('span');
   badge.id = 'chatglpi-float-badge';
   badge.className = 'chatglpi-hidden';
   document.body.appendChild(badge);

   const panel = document.createElement('div');
   panel.id = 'chatglpi-float-panel';
   panel.className = 'card chatglpi-hidden';
   const savedSize = chatglpiLoadPanelSize();
   if (savedSize) {
      panel.style.width = savedSize.width + 'px';
      panel.style.height = savedSize.height + 'px';
   }
   // Cabeçalho pequeno acima do resto (rail + mensagens) - cor do MENU do
   // GLPI (ver chatglpiMenuColors()), não a mesma dos botões/bolhas
   // (essas continuam com bg-primary/btn-primary, a $primary da paleta).
   // #chatglpi-panel-body é o que vira o "container" de initChat() (não o
   // panel inteiro) - assim o cabeçalho fica fixo em cima e só o resto
   // preenche o espaço restante (ver display:flex;flex-direction:column
   // do .card no CSS, herdado sem precisar redeclarar).
   const menuColors = chatglpiMenuColors();
   const headerStyle = menuColors
      ? 'background-color:' + menuColors.bg + ';color:' + menuColors.fg + ';'
      : '';
   panel.innerHTML =
      '<div class="chatglpi-panel-title px-3 py-2 d-flex align-items-center gap-2' + (menuColors ? '' : ' bg-primary text-white') + '" style="' + headerStyle + '">' +
         '<i class="ti ti-message-circle"></i>' +
         '<span class="fw-bold">Chat-GLPI</span>' +
      '</div>' +
      '<div id="chatglpi-panel-body"></div>';
   document.body.appendChild(panel);

   // Salva o tamanho toda vez que o técnico solta o arrasto do canto
   // (resize:both no CSS) - debounced porque ResizeObserver dispara a
   // cada pixel durante o arrasto, não só no final.
   if ('ResizeObserver' in window) {
      let resizeSaveTimer = null;
      new ResizeObserver(entries => {
         const entry = entries[0];
         if (!entry) return;
         clearTimeout(resizeSaveTimer);
         resizeSaveTimer = setTimeout(() => {
            chatglpiSavePanelSize(Math.round(entry.contentRect.width), Math.round(entry.contentRect.height));
         }, 300);
      }).observe(panel);
   }

   let panelInited = false;
   let panelOpen = false;
   // Guarda o último "não lidas" de cada canal só pra saber quando SUBIU
   // (mensagem nova de verdade) em vez de notificar em toda consulta.
   const lastUnread = {};

   function openPanel() {
      panelOpen = true;
      panel.classList.remove('chatglpi-hidden');
      if ('Notification' in window && Notification.permission === 'default') {
         // Só pede permissão num clique de verdade do usuário (este) - navegador
         // costuma ignorar/negar silenciosamente um pedido feito sem gesto.
         Notification.requestPermission();
      }
      if (!panelInited) {
         panelInited = true;
         const panelBody = document.getElementById('chatglpi-panel-body');
         panelBody.dataset.userId = info.userId;
         panelBody.dataset.apiBase = info.apiBase;
         panelBody.dataset.authToken = info.token;
         panelBody.dataset.glpiRoot = info.glpiRoot;
         initChat(panelBody);
      }
   }

   button.addEventListener('click', () => {
      if (panelOpen) {
         panelOpen = false;
         panel.classList.add('chatglpi-hidden');
      } else {
         openPanel();
      }
   });

   // Agora que o widget existe de verdade, a função global passa a abrir
   // na hora (em vez de só guardar o pedido) - e já drena um pedido que
   // tenha chegado enquanto o token ainda carregava.
   window.chatglpiOpenFloatingChat = function (userId, ticketId, ticketTitle) {
      openPanel();
      const panelBody = document.getElementById('chatglpi-panel-body');
      if (panelBody._chatglpiStartDm) {
         panelBody._chatglpiStartDm(userId, ticketId, ticketTitle);
      }
   };
   if (chatglpiPendingOpen) {
      const pending = chatglpiPendingOpen;
      chatglpiPendingOpen = null;
      window.chatglpiOpenFloatingChat(pending.userId, pending.ticketId, pending.ticketTitle);
   }

   function updateBadge(total) {
      if (total > 0) {
         badge.textContent = total > 99 ? '99+' : String(total);
         badge.classList.remove('chatglpi-hidden');
      } else {
         badge.classList.add('chatglpi-hidden');
      }
   }

   function notify(channelName) {
      if (!('Notification' in window) || Notification.permission !== 'granted') return;
      if (panelOpen && !document.hidden) return; // já está de olho, não precisa
      const n = new Notification('Chat-GLPI', { body: channelName + ' mandou uma mensagem.' });
      n.onclick = () => {
         window.focus();
         if (!panelOpen) openPanel();
      };
   }

   function pollUnread() {
      fetch(info.apiBase + '/channels', { headers: { 'X-ChatGLPI-Auth': info.token } })
         .then(r => r.json())
         .then(data => {
            const channels = data.channels || [];
            let total = 0;
            channels.forEach(ch => {
               total += ch.unread || 0;
               const prev = lastUnread[ch.id] || 0;
               if (ch.unread > prev) notify(ch.name);
               lastUnread[ch.id] = ch.unread || 0;
            });
            updateBadge(total);
         })
         .catch(() => {});
   }

   // Poll simples (setInterval), NÃO SSE, de propósito - tentei SSE aqui
   // antes e quebrou a coisa toda: quando o painel abre, initChat() já
   // levanta a PRÓPRIA conexão SSE (connectStream(), mais abaixo no
   // arquivo) - com as duas rodando ao mesmo tempo (o widget flutuante
   // sempre tem a dele aberta, o painel abre outra), o navegador estourava
   // o limite de conexões simultâneas pro mesmo domínio (~6 no Chrome), e
   // QUALQUER requisição nova (tipo abrir uma conversa - GET /messages)
   // ficava "pending" pra sempre, travada atrás das duas conexões longas -
   // foi assim que a mensagem sumia depois de recarregar a página. Um
   // poll aqui usa conexões curtas (abre, responde, fecha), não compete
   // pelo mesmo jeito - só a conexão do painel (quando aberto) fica
   // realmente segurada. Servidor toca presença em toda consulta a
   // /api/channels de qualquer forma (ver server.js).
   const PRESENCE_POLL_MS = 20000;

   pollUnread();
   setInterval(pollUnread, PRESENCE_POLL_MS);

   // Marca offline NA HORA ao fechar a aba/navegar pra fora - sem isso, o
   // "online" ficava certo por até a janela de tolerância inteira de
   // isOnline() (90s no backend) depois de a pessoa já ter saído de
   // verdade. "pagehide" (não "beforeunload") porque dispara de forma
   // confiável em fechamento de aba, navegação e mobile - sendBeacon
   // porque é a única forma de garantir que a requisição sai mesmo com a
   // página sendo destruída no mesmo instante.
   window.addEventListener('pagehide', () => {
      navigator.sendBeacon(info.apiBase + '/presence/offline?token=' + encodeURIComponent(info.token));
   });
}

// Visualização em tela cheia de um print colado no chat, sem navegar pra
// lugar nenhum (nem abrir o arquivo numa aba nova) - clique na miniatura
// dentro da conversa chama isso. Overlay único, criado uma vez e
// reaproveitado; clique na própria imagem alterna entre "caber na tela" e
// tamanho nativo (com rolagem) pra dar um zoom; clique fora ou Esc fecha.
function chatglpiOpenLightbox(src) {
   let overlay = document.getElementById('chatglpi-lightbox');
   if (!overlay) {
      overlay = document.createElement('div');
      overlay.id = 'chatglpi-lightbox';
      overlay.className = 'chatglpi-hidden';
      overlay.innerHTML = '<img id="chatglpi-lightbox-img">';
      overlay.addEventListener('click', () => overlay.classList.add('chatglpi-hidden'));
      document.addEventListener('keydown', e => {
         if (e.key === 'Escape') overlay.classList.add('chatglpi-hidden');
      });
      document.body.appendChild(overlay);
   }
   const img = document.getElementById('chatglpi-lightbox-img');
   img.src = src;
   img.classList.remove('chatglpi-lightbox-zoomed');
   img.onclick = e => {
      e.stopPropagation(); // não deixa o clique "vazar" pro fundo e fechar junto
      img.classList.toggle('chatglpi-lightbox-zoomed');
   };
   overlay.classList.remove('chatglpi-hidden');
}

function initChat(container) {
   const myUserId = parseInt(container.dataset.userId, 10);
   // Backend real (mensagens/DMs/SSE) mora na VM dedicada, fora do GLPI -
   // ver inc/authtoken.php e setup.php::PLUGIN_CHATGLPI_BACKEND_URL. O
   // token prova pro Node quem é o usuário logado no GLPI (cookie de
   // sessão do GLPI não atravessa pra outro host/porta).
   const BASE = container.dataset.apiBase;
   const AUTH_TOKEN = container.dataset.authToken;
   const GLPI_ROOT = container.dataset.glpiRoot || '';
   let activeChannelId = null;
   let channels = [];
   let currentMessages = [];
   // Mensagem sendo respondida (estilo WhatsApp) - null quando nenhuma.
   // Guarda o objeto inteiro (não só o id) pra montar a prévia acima do
   // composer sem precisar buscar de novo.
   let replyTarget = null;

   function authFetch(url, opts) {
      opts = opts || {};
      opts.headers = Object.assign({}, opts.headers, { 'X-ChatGLPI-Auth': AUTH_TOKEN });
      return fetch(url, opts);
   }

   container.innerHTML = [
      '<div class="chatglpi-layout d-flex border rounded overflow-hidden">',
      '  <div class="chatglpi-rail p-2 d-flex flex-column border-end">',
      '    <button id="chatglpi-new-chat" type="button" class="btn btn-outline-secondary btn-sm w-100 mb-2">+ Nova conversa</button>',
      '    <div id="chatglpi-new-chat-box" class="chatglpi-hidden mb-2">',
      '      <input id="chatglpi-search-input" type="text" class="form-control form-control-sm mb-1" placeholder="Buscar pessoa...">',
      '      <div id="chatglpi-search-results" class="list-group list-group-flush"></div>',
      '    </div>',
      '    <div id="chatglpi-channel-list" class="list-group list-group-flush flex-fill overflow-auto"></div>',
      '  </div>',
      '  <div class="chatglpi-panel d-flex flex-column flex-fill">',
      '    <div id="chatglpi-panel-header" class="px-3 py-2 border-bottom small chatglpi-hidden"></div>',
      '    <div id="chatglpi-messages" class="chatglpi-messages flex-fill overflow-auto p-3 d-flex flex-column gap-2"></div>',
      '    <div id="chatglpi-pending-image" class="px-2 pt-2 chatglpi-hidden">',
      '      <div class="position-relative d-inline-block">',
      '        <img id="chatglpi-pending-image-preview" class="chatglpi-pending-thumb">',
      '        <button type="button" id="chatglpi-pending-image-remove" class="btn-close chatglpi-pending-remove" aria-label="Remover"></button>',
      '      </div>',
      '    </div>',
      '    <div id="chatglpi-reply-bar" class="px-2 pt-2 chatglpi-hidden">',
      '      <div class="chatglpi-reply-box position-relative">',
      '        <div id="chatglpi-reply-preview"></div>',
      '        <button type="button" id="chatglpi-reply-cancel" class="btn-close chatglpi-reply-cancel" aria-label="Cancelar resposta"></button>',
      '      </div>',
      '    </div>',
      '    <div class="d-flex gap-2 p-2 border-top align-items-end">',
      '      <textarea id="chatglpi-input" class="form-control" rows="1" placeholder="Escreva uma mensagem... (Enter envia, Shift+Enter quebra linha)"></textarea>',
      '      <button id="chatglpi-send" type="button" class="btn btn-primary flex-shrink-0">Enviar</button>',
      '    </div>',
      '  </div>',
      '</div>'
   ].join('');

   function fetchJson(url, opts) {
      return authFetch(url, opts).then(r => r.json());
   }

   function escapeHtml(s) {
      const div = document.createElement('div');
      div.textContent = s || '';
      return div.innerHTML;
   }

   function loadChannels() {
      return fetchJson(BASE + '/channels').then(data => {
         channels = data.channels || [];
         renderChannelList();
      });
   }

   function renderChannelList() {
      const list = document.getElementById('chatglpi-channel-list');
      if (channels.length === 0) {
         list.innerHTML = '<div class="text-muted small p-2">Nenhuma conversa ainda. Clique em "+ Nova conversa".</div>';
         return;
      }
      list.innerHTML = '';
      channels.forEach(ch => {
         const el = document.createElement('button');
         el.type = 'button';
         el.className = 'list-group-item list-group-item-action border-0 d-flex align-items-center gap-2' +
            (ch.id === activeChannelId ? ' active' : '');
         // ticketIds vem de glpi_plugin_chatglpi_ticketconversations (ver
         // chat.js do backend, linkTicketToConversation()) - conversa pode
         // referenciar mais de um chamado se o mesmo solicitante foi
         // chamado a partir de chamados diferentes ao longo do tempo.
         const ticketBadges = (ch.ticketIds || [])
            .map(id => '#' + id).join(', ');
         el.innerHTML =
            '<span class="chatglpi-dot' + (ch.online ? ' chatglpi-dot-online' : '') + '"></span>' +
            '<span class="flex-fill text-truncate">' + escapeHtml(ch.name) +
            (ticketBadges ? '<div class="text-muted" style="font-size:.7rem;">Chamado ' + escapeHtml(ticketBadges) + '</div>' : '') +
            '</span>' +
            (ch.unread ? '<span class="badge bg-danger rounded-pill">' + ch.unread + '</span>' : '');
         el.addEventListener('click', () => selectChannel(ch.id));
         list.appendChild(el);
      });
   }

   function renderPanelHeader() {
      const header = document.getElementById('chatglpi-panel-header');
      const ch = channels.find(c => c.id === activeChannelId);
      const ticketIds = ch ? (ch.ticketIds || []) : [];
      if (!ticketIds.length) {
         header.classList.add('chatglpi-hidden');
         header.innerHTML = '';
         return;
      }
      header.classList.remove('chatglpi-hidden');
      header.innerHTML = 'Chamado' + (ticketIds.length > 1 ? 's' : '') + ': ' +
         ticketIds.map(id =>
            '<span class="me-2 white-space-nowrap">' +
            '<a href="' + escapeHtml(GLPI_ROOT) + '/front/ticket.form.php?id=' + id + '" target="_blank" rel="noopener">#' + id + '</a>' +
            '<button type="button" class="chatglpi-ticket-unlink" data-unlink-ticket="' + id + '" title="Desvincular chamado #' + id + ' desta conversa">×</button>' +
            '</span>'
         ).join('');
   }

   // Delegado no header (não um listener por botão) - o header é
   // reconstruído inteiro a cada troca de conversa/renderPanelHeader().
   document.getElementById('chatglpi-panel-header').addEventListener('click', e => {
      const btn = e.target.closest('[data-unlink-ticket]');
      if (!btn) return;
      const ticketId = Number(btn.dataset.unlinkTicket);
      if (!ticketId || !activeChannelId) return;
      if (!window.confirm('Desvincular o chamado #' + ticketId + ' desta conversa?')) return;
      fetchJson(BASE + '/unlink-ticket', {
         method: 'POST',
         headers: { 'Content-Type': 'application/json' },
         body: JSON.stringify({ usersId: activeChannelId, ticketId })
      }).then(data => {
         if (data.error) { window.alert(data.error); return; }
         if (data.channels) channels = data.channels;
         renderChannelList();
         renderPanelHeader();
         if (data.messages) renderMessages(data.messages);
      });
   });

   function selectChannel(userId) {
      activeChannelId = userId;
      renderChannelList();
      renderPanelHeader();
      loadMessages();
      clearPendingImage(); // imagem colada era pra ESSA conversa - trocar de canal sem enviar descarta
      clearReplyTarget(); // resposta em andamento também era pra ESSA conversa
      // Foca o campo de mensagem sozinho ao trocar de conversa - sem
      // isso, o foco fica no botão da conversa que acabou de ser clicado
      // (não no campo de texto), e um Ctrl+V ali não recorta imagem
      // nenhuma porque o evento de colar vai pro elemento com foco, não
      // pro campo (mesmo com o listener de colar coberto mais abaixo pro
      // painel inteiro, focar aqui já deixa digitar/colar sem clique extra).
      document.getElementById('chatglpi-input').focus();
   }

   function loadMessages() {
      if (!activeChannelId) return Promise.resolve();
      return fetchJson(BASE + '/messages?users_id=' + activeChannelId).then(data => {
         renderMessages(data.messages || []);
      });
   }

   // Texto curto de prévia pra citação/resposta - mesma regra usada tanto
   // na citação reduzida dentro da bolha (renderMessages) quanto na prévia
   // acima do composer (setReplyTarget), pra ficar consistente.
   function replyPreviewText(m) {
      if (m.imageFile && m.text) return '📷 ' + m.text;
      if (m.imageFile) return '📷 Imagem';
      return m.text || '';
   }

   function renderMessages(messages) {
      currentMessages = messages;
      const box = document.getElementById('chatglpi-messages');
      box.innerHTML = messages.map(m => {
         const mine = !m.isBot && m.authorId === myUserId;
         const align = m.isBot ? 'align-self-center' : (mine ? 'align-self-end' : 'align-self-start');
         const bubbleClass = m.isBot
            ? 'bg-warning-subtle text-dark small fw-semibold'
            : (mine ? 'bg-primary text-white' : 'bg-light text-dark border');
         const author = (!mine && !m.isBot) ? '<div class="small fw-bold mb-1">' + escapeHtml(m.authorName) + '</div>' : '';
         // Print colado (Ctrl+V) - m.imageFile é só o nome do arquivo
         // gerado no servidor; a URL de download exige o mesmo token de
         // autenticação de qualquer chamada (aqui só dá pra ir por query
         // string, uma tag <img> não manda header customizado nenhum).
         // Clique abre em tela cheia (chatglpiOpenLightbox) sem navegar
         // pra lugar nenhum - ver essa função mais abaixo no arquivo.
         const imageSrc = m.imageFile
            ? BASE + '/images/' + encodeURIComponent(m.imageFile) + '?token=' + encodeURIComponent(AUTH_TOKEN)
            : null;
         const imageHtml = imageSrc
            ? '<img src="' + escapeHtml(imageSrc) + '" class="chatglpi-msg-image" onclick="chatglpiOpenLightbox(this.src)">'
            : '';
         const textHtml = m.text ? escapeHtml(m.text) : '';
         // Citação reduzida da mensagem original, quando esta é uma
         // resposta (m.replyTo vem do backend, ver glpi-backend/src/
         // chat.js::listForConversation()) - clique nela rola/realça a
         // mensagem original (delegado no container, mais abaixo).
         const quoteHtml = m.replyTo
            ? '<div class="chatglpi-msg-quote" data-quote-target="' + m.replyTo.id + '">' +
               '<div class="fw-bold">' + escapeHtml(m.replyTo.authorName) + '</div>' +
               '<div>' + escapeHtml(replyPreviewText(m.replyTo)) + '</div>' +
              '</div>'
            : '';
         const bubbleContent = quoteHtml + imageHtml + textHtml;
         // Bubble sem padding quando é só imagem sem citação nem texto -
         // com padding normal, sobrava uma faixa de cor em volta do print, feio.
         const bubblePad = (imageSrc && !m.text && !quoteHtml) ? '' : 'px-3 py-2';
         // Botão "responder" só em mensagens de verdade (não em avisos de
         // sistema - não faz sentido citar "Chamado #X mudou de status").
         const replyBtn = !m.isBot
            ? '<button type="button" class="chatglpi-msg-reply-btn" title="Responder">↩</button>'
            : '';
         return '<div class="chatglpi-msg ' + align + '" data-msg-id="' + m.id + '">' + author +
            '<div class="chatglpi-msg-bubble ' + bubblePad + ' ' + bubbleClass + '">' + bubbleContent + '</div>' +
            '<div class="text-muted d-flex align-items-center gap-1" style="font-size:.7rem;margin-top:2px;">' + escapeHtml(m.time) + replyBtn + '</div></div>';
      }).join('');
      box.scrollTop = box.scrollHeight;
   }

   // Prévia acima do composer da mensagem sendo respondida - fica ali até
   // enviar (junto com o texto digitado) ou cancelar (botão "x", ou Esc).
   function setReplyTarget(m) {
      replyTarget = m;
      const who = m.isBot ? 'Sistema' : (m.authorId === myUserId ? 'Você' : m.authorName);
      document.getElementById('chatglpi-reply-preview').innerHTML =
         '<div class="small fw-bold">' + escapeHtml(who) + '</div>' +
         '<div class="small text-truncate">' + escapeHtml(replyPreviewText(m)) + '</div>';
      document.getElementById('chatglpi-reply-bar').classList.remove('chatglpi-hidden');
      document.getElementById('chatglpi-input').focus();
   }

   function clearReplyTarget() {
      replyTarget = null;
      document.getElementById('chatglpi-reply-bar').classList.add('chatglpi-hidden');
      document.getElementById('chatglpi-reply-preview').innerHTML = '';
   }

   document.getElementById('chatglpi-reply-cancel').addEventListener('click', clearReplyTarget);

   // Duplo clique na bolha, OU o botão "↩" junto do horário - as duas
   // formas pedidas ("com dois cliques ou selecionando a opção
   // responder"). Delegado no container (não um listener por mensagem, já
   // que renderMessages() reconstrói o HTML inteiro a cada atualização).
   container.addEventListener('dblclick', e => {
      const bubble = e.target.closest('.chatglpi-msg-bubble');
      if (!bubble) return;
      const wrap = bubble.closest('.chatglpi-msg');
      const id = wrap && Number(wrap.dataset.msgId);
      const m = id && currentMessages.find(x => x.id === id);
      if (m && !m.isBot) setReplyTarget(m);
   });

   container.addEventListener('click', e => {
      const replyBtn = e.target.closest('.chatglpi-msg-reply-btn');
      if (replyBtn) {
         const wrap = replyBtn.closest('.chatglpi-msg');
         const id = wrap && Number(wrap.dataset.msgId);
         const m = id && currentMessages.find(x => x.id === id);
         if (m) setReplyTarget(m);
         return;
      }
      const quote = e.target.closest('.chatglpi-msg-quote');
      if (quote) {
         const targetEl = container.querySelector('.chatglpi-msg[data-msg-id="' + quote.dataset.quoteTarget + '"]');
         if (targetEl) {
            targetEl.scrollIntoView({ block: 'center', behavior: 'smooth' });
            targetEl.classList.add('chatglpi-msg-highlight');
            setTimeout(() => targetEl.classList.remove('chatglpi-msg-highlight'), 1200);
         }
      }
   });

   // Print colado (Ctrl+V) fica pendente, com prévia, até apertar Enter/
   // Enviar - igual WhatsApp: cola a imagem, ainda dá tempo de escrever
   // uma legenda antes de mandar. pendingImageData já fica em data URI
   // base64 (reaproveitado tanto pra prévia local quanto pro upload de
   // verdade na hora de enviar - sem reler o arquivo duas vezes).
   let pendingImageData = null;

   function showPendingImage(dataUri) {
      pendingImageData = dataUri;
      document.getElementById('chatglpi-pending-image-preview').src = dataUri;
      document.getElementById('chatglpi-pending-image').classList.remove('chatglpi-hidden');
   }

   function clearPendingImage() {
      pendingImageData = null;
      document.getElementById('chatglpi-pending-image').classList.add('chatglpi-hidden');
      document.getElementById('chatglpi-pending-image-preview').src = '';
   }

   document.getElementById('chatglpi-pending-image-remove').addEventListener('click', clearPendingImage);

   // Substitui o antigo sendMessage()/sendImageFile() separados - agora
   // uma imagem pendente e o texto digitado (a "legenda") sempre viajam
   // juntos numa única mensagem quando o técnico aperta Enter/Enviar.
   function sendPendingMessage() {
      const input = document.getElementById('chatglpi-input');
      const text = input.value.trim();
      if (!activeChannelId || (!text && !pendingImageData)) return;
      input.value = '';
      const imageData = pendingImageData;
      const replyToId = replyTarget ? replyTarget.id : null;
      clearPendingImage();
      clearReplyTarget();

      const request = imageData
         ? fetchJson(BASE + '/send-image', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ usersId: activeChannelId, imageData, text, replyToId })
           })
         : fetchJson(BASE + '/send', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ usersId: activeChannelId, text, replyToId })
           });

      request.then(data => {
         if (data.error) { window.alert(data.error); return; }
         renderMessages(data.messages || []);
      });
   }

   // No container inteiro (não só no campo de texto) - um Ctrl+V real
   // dispara o evento "paste" no elemento com FOCO no momento, que pode
   // ser o botão da conversa recém-clicada, não o campo de mensagem
   // (descoberto testando de verdade: colar não fazia nada porque o
   // listener só existia no campo). "paste" borbulha, então prender aqui,
   // no container, cobre o painel inteiro independente de qual elemento
   // específico estava focado.
   container.addEventListener('paste', e => {
      const items = e.clipboardData && e.clipboardData.items;
      if (!items) return;
      for (const item of items) {
         if (item.type && item.type.indexOf('image/') === 0) {
            e.preventDefault();
            if (!activeChannelId) break;
            const reader = new FileReader();
            reader.onload = () => showPendingImage(reader.result);
            reader.readAsDataURL(item.getAsFile());
            break;
         }
      }
   });

   document.getElementById('chatglpi-send').addEventListener('click', sendPendingMessage);
   document.getElementById('chatglpi-input').addEventListener('keydown', e => {
      if (e.key === 'Enter' && !e.shiftKey) {
         e.preventDefault();
         sendPendingMessage();
      } else if (e.key === 'Escape' && replyTarget) {
         clearReplyTarget();
      }
   });

   document.getElementById('chatglpi-new-chat').addEventListener('click', () => {
      const box = document.getElementById('chatglpi-new-chat-box');
      box.classList.toggle('chatglpi-hidden');
      if (!box.classList.contains('chatglpi-hidden')) {
         document.getElementById('chatglpi-search-input').focus();
      }
   });

   document.getElementById('chatglpi-search-input').addEventListener('input', e => {
      const q = e.target.value.trim();
      const results = document.getElementById('chatglpi-search-results');
      if (!q) { results.innerHTML = ''; return; }
      fetchJson(BASE + '/searchusers?q=' + encodeURIComponent(q)).then(data => {
         results.innerHTML = '';
         (data.users || []).forEach(u => {
            const el = document.createElement('button');
            el.type = 'button';
            el.className = 'list-group-item list-group-item-action border-0 small d-flex align-items-center gap-2';
            el.innerHTML = '<span class="chatglpi-dot' + (u.online ? ' chatglpi-dot-online' : '') + '"></span>' +
               '<span class="flex-fill text-truncate">' + escapeHtml(u.name) + '</span>';
            el.addEventListener('click', () => {
               fetchJson(BASE + '/dm', {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({ usersId: u.id })
               }).then(() => {
                  document.getElementById('chatglpi-new-chat-box').classList.add('chatglpi-hidden');
                  document.getElementById('chatglpi-search-input').value = '';
                  results.innerHTML = '';
                  loadChannels().then(() => selectChannel(u.id));
               });
            });
            results.appendChild(el);
         });
      });
   });

   function connectStream() {
      // EventSource nativo não manda headers customizados - token vai por
      // query string aqui (única exceção; todo o resto usa o header
      // X-ChatGLPI-Auth via authFetch()).
      const es = new EventSource(BASE + '/stream?token=' + encodeURIComponent(AUTH_TOKEN));
      es.onmessage = () => {
         loadChannels();
         if (activeChannelId) loadMessages();
      };
      es.onerror = () => {
         es.close();
         setTimeout(connectStream, 2000);
      };
   }

   // Inicia/retoma uma DM e a seleciona - reaproveitado tanto pelo fluxo
   // ?dmWith= da página dedicada (abaixo) quanto pelo widget flutuante
   // (chamado sob demanda via container._chatglpiStartDm, ver
   // window.chatglpiOpenFloatingChat mais acima no arquivo). ticketId/
   // ticketTitle são opcionais - só vêm de "Iniciar chat com solicitante"
   // no chamado (hook.php); o backend usa isso pra vincular a conversa e
   // postar a mensagem de apresentação do chamado (ver remote... não,
   // ver glpi-backend/src/chat.js::linkTicketToConversation()).
   function startDm(userId, ticketId, ticketTitle) {
      if (!userId || userId === myUserId) return;
      fetchJson(BASE + '/dm', {
         method: 'POST',
         headers: { 'Content-Type': 'application/json' },
         body: JSON.stringify({ usersId: userId, ticketId: ticketId || null, ticketTitle: ticketTitle || null })
      }).then(() => loadChannels().then(() => selectChannel(userId)));
   }
   container._chatglpiStartDm = startDm;

   // ?dmWith=<id> - fallback caso a página dedicada seja aberta direto por
   // URL (sem passar pelo widget flutuante) - abre a DM sozinho ao
   // carregar a página.
   const startDmWith = parseInt(container.dataset.startDm, 10);
   const startTicketId = parseInt(container.dataset.ticketId, 10) || null;
   const startTicketTitle = container.dataset.ticketTitle || null;
   if (startDmWith) {
      startDm(startDmWith, startTicketId, startTicketTitle);
   } else {
      loadChannels();
   }
   connectStream();

   // O SSE (connectStream) só avisa quando chega mensagem nova - o dot
   // "online" de quem já está na lista muda por um motivo que não gera
   // mensagem nenhuma (a pessoa só abriu/fechou o GLPI em outra aba), então
   // sem isso o dot só atualizava recarregando a página inteira. Poll
   // curto (conexão curta, não fica segurada - mesmo raciocínio do poll do
   // widget flutuante) refaz a lista periodicamente só pra pegar esse tipo
   // de mudança.
   setInterval(loadChannels, 15000);

   // Mesma lógica do widget flutuante (initFloatingChatWidget) - necessária
   // aqui de novo porque a página dedicada (front/chat.php) não roda
   // aquele IIFE (ele desiste cedo quando já existe #chatglpi-app, exatamente
   // o caso desta página) e por isso nunca chegaria a registrar o próprio
   // "pagehide". Rodar duas vezes (quando o painel flutuante é aberto)
   // não é problema - o DELETE do lado do servidor é idempotente.
   window.addEventListener('pagehide', () => {
      navigator.sendBeacon(BASE + '/presence/offline?token=' + encodeURIComponent(AUTH_TOKEN));
   });
}

// Aciona o agente local (ChatGlpiAgent.exe, ouvindo em 127.0.0.1:47652) pra
// abrir o UltraVNC Viewer. Só funciona porque o GLPI roda em HTTPS - o
// Chrome/Edge exige contexto seguro pra conceder a permissão "Local Network
// Access" necessária pra uma página falar com 127.0.0.1 (em HTTP puro essa
// permissão ficava sempre negada, sem prompt algum). Usado tanto pela aba
// "Acesso remoto" do chamado (inc/vncconnect.class.php) quanto pelo botão
// "Conectar" do painel de agentes (front/agents.php) - ver as duas chamadas
// abaixo, ambas reaproveitando este helper único.
function chatglpiDoVncConnect(host, password) {
   return fetch('http://127.0.0.1:47652/connect', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-ChatGLPI-Token': 'CHANGE_ME_agent_token' },
      body: JSON.stringify({ host, password })
   }).then(r => r.json().then(data => ({ ok: r.ok, data })));
}

const CHATGLPI_VNC_AGENT_ERROR = 'Agente não encontrado nesta máquina, ou o navegador bloqueou o acesso à rede local (confira se apareceu um pedido de permissão e clique em Permitir). Instale o agente pelo instalador do TI se ainda não tiver.';

// Acesso remoto via noVNC + websockify (ver glpi-backend/src/remote.js e
// remote-web/remote.html), sem nenhum agente local envolvido. Usado tanto
// pela aba "Acesso remoto" do chamado quanto pelo card avulso do dashboard
// (front/inc/vncconnect.class.php e hook.php::plugin_chatglpi_dashboard_
// widget_remote_access() respectivamente) - os dois só resolvem o host de
// forma diferente e reaproveitam este mesmo pedido ao backend.
function chatglpiRequestRemoteSession(apiBase, authToken, host, ticketsId) {
   const body = { hostname: host };
   // Só a aba do chamado manda isso - é o que permite ao backend registrar
   // o acompanhamento de acesso remoto no chamado certo quando a sessão
   // terminar (ver remote.js::destroySession()). O card avulso do
   // dashboard nunca tem chamado, então nunca manda este campo.
   if (ticketsId) body.ticketsId = ticketsId;
   return fetch(apiBase + '/remote/start', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-ChatGLPI-Auth': authToken },
      body: JSON.stringify(body)
   }).then(r => r.json().then(data => ({ ok: r.ok, data })));
}

// Histórico de hosts acessados, estilo o combo do UltraVNC Viewer -
// guardado só no navegador (localStorage), nunca no servidor. Um
// <datalist> por campo (id vem do atributo "list" do próprio input) dá o
// dropdown nativo do navegador sem precisar montar UI nenhuma na mão.
const CHATGLPI_REMOTE_HISTORY_KEY = 'chatglpi-remote-host-history';
const CHATGLPI_REMOTE_HISTORY_MAX = 30;

function chatglpiLoadRemoteHistory() {
   try {
      const list = JSON.parse(localStorage.getItem(CHATGLPI_REMOTE_HISTORY_KEY));
      return Array.isArray(list) ? list : [];
   } catch (e) {
      return [];
   }
}

function chatglpiSaveRemoteHistory(host) {
   const list = chatglpiLoadRemoteHistory().filter(h => h !== host);
   list.unshift(host);
   if (list.length > CHATGLPI_REMOTE_HISTORY_MAX) list.length = CHATGLPI_REMOTE_HISTORY_MAX;
   localStorage.setItem(CHATGLPI_REMOTE_HISTORY_KEY, JSON.stringify(list));
}

function chatglpiPopulateHistoryDatalist(datalistEl) {
   if (!datalistEl) return;
   datalistEl.innerHTML = '';
   chatglpiLoadRemoteHistory().forEach(host => {
      const opt = document.createElement('option');
      opt.value = host;
      datalistEl.appendChild(opt);
   });
}

// Delegação no document em vez de um listener por campo: os cards do
// dashboard (e a aba "Acesso remoto" do chamado) são inseridos na página
// via AJAX do próprio GLPI, depois deste script já ter rodado - um
// listener preso a um elemento específico não pegaria campos que ainda
// não existiam nesse momento. Fase de captura é obrigatória aqui porque o
// evento "focus" não borbulha (ao contrário de "click"/"input").
document.addEventListener('focus', e => {
   const el = e.target;
   if (el && el.classList && el.classList.contains('chatglpi-remote-host-input')) {
      chatglpiPopulateHistoryDatalist(document.getElementById(el.getAttribute('list')));
   }
}, true);

// Aba "Acesso remoto" do chamado - host já vem pronto do PHP (ver
// vncconnect.class.php::showForTicket()); devolve uma URL pra abrir numa
// aba nova, lá dentro só se pede a senha do VNC.
window.chatglpiStartRemoteSession = function (buttonEl) {
   const container = buttonEl.closest('.chatglpi-vnc-tab');
   const hostEl = document.getElementById('chatglpi-vnc-host');
   const errorEl = document.getElementById('chatglpi-vnc-error');
   const host = hostEl.value.trim();
   errorEl.style.display = 'none';
   if (!host) return;

   buttonEl.disabled = true;
   chatglpiRequestRemoteSession(container.dataset.apiBase, container.dataset.authToken, host, container.dataset.ticketsId)
      .then(({ ok, data }) => {
         if (!ok) {
            errorEl.textContent = data.error || 'Não foi possível iniciar a sessão remota.';
            errorEl.style.display = 'block';
            return;
         }
         chatglpiSaveRemoteHistory(host);
         window.open(data.url, '_blank');
      })
      .catch(() => {
         errorEl.textContent = 'Não foi possível falar com o servidor de acesso remoto.';
         errorEl.style.display = 'block';
      })
      .finally(() => { buttonEl.disabled = false; });
};

// Card avulso do dashboard (Assistência > Chamados > "Adicionar novo
// item") - sem chamado nenhum envolvido, o técnico digita o hostname/IP
// direto. Ver hook.php::plugin_chatglpi_dashboard_widget_remote_access().
window.chatglpiStartRemoteSessionStandalone = function (uid) {
   const hostEl = document.getElementById(uid + '-host');
   const errorEl = document.getElementById(uid + '-error');
   const buttonEl = document.getElementById(uid + '-button');
   const container = hostEl.closest('.chatglpi-remote-dashboard');
   const host = hostEl.value.trim();
   errorEl.style.display = 'none';
   if (!host) {
      errorEl.textContent = 'Informe o hostname ou IP da máquina.';
      errorEl.style.display = 'block';
      return;
   }

   buttonEl.disabled = true;
   chatglpiRequestRemoteSession(container.dataset.apiBase, container.dataset.authToken, host, container.dataset.ticketsId)
      .then(({ ok, data }) => {
         if (!ok) {
            errorEl.textContent = data.error || 'Não foi possível iniciar a sessão remota.';
            errorEl.style.display = 'block';
            return;
         }
         chatglpiSaveRemoteHistory(host);
         window.open(data.url, '_blank');
      })
      .catch(() => {
         errorEl.textContent = 'Não foi possível falar com o servidor de acesso remoto.';
         errorEl.style.display = 'block';
      })
      .finally(() => { buttonEl.disabled = false; });
};

// Botão "Conectar" do painel de agentes (front/agents.php) - lista não tem
// campo de senha por linha (poluiria a tabela), então pede via prompt() já
// com o padrão sugerido; cancelar o prompt não tenta conectar.
window.chatglpiConnectFromAgentsPanel = function (host) {
   const password = window.prompt('Senha do VNC para ' + host + ':', 'CHANGE_ME_vnc_password');
   if (password === null) return;
   chatglpiDoVncConnect(host, password)
      .then(({ ok, data }) => {
         if (!ok) {
            window.alert(data.error || 'Não foi possível conectar.');
         }
      })
      .catch(() => {
         window.alert(CHATGLPI_VNC_AGENT_ERROR);
      });
};

// --- Captura do computador na abertura de chamado ---
// Lê a máquina AO VIVO do agente local (127.0.0.1:47821/info, mesmo agente
// de sempre, CORS liberado pra qualquer origem) e injeta como campos OCULTOS
// no form do chamado. Ao salvar, o hook plugin_chatglpi_ticket_add (hook.php)
// grava numa tabela própria e o dado aparece num bloco SÓ-LEITURA abaixo da
// descrição (inc/vncconnect.class.php::showInline()) - o usuário não
// consegue alterar/apagar (era esse o problema de anexar na descrição).
// Funciona mesmo que o computador NÃO esteja no inventário do GLPI, porque
// lê a máquina de verdade. Só no form de abertura (id=0).
function chatglpiInitTicketDeviceFill() {
   const idField = document.querySelector('input[name="id"]');
   const contentTa = document.querySelector('textarea[name="content"]');
   if (!idField || idField.value !== '0' || !contentTa) {
      return;
   }
   const form = contentTa.closest('form');
   if (!form || form.querySelector('input[name="_chatglpi_hostname"]')) {
      return; // sem form ou já injetado
   }

   let controller;
   try {
      controller = AbortSignal.timeout(1500);
   } catch (e) {
      controller = undefined; // navegadores antigos: sem timeout, tudo bem
   }

   fetch('http://127.0.0.1:47821/info', { signal: controller })
      .then(r => r.ok ? r.json() : null)
      .then(info => {
         if (!info || !info.hostname) {
            return;
         }
         if (form.querySelector('input[name="_chatglpi_hostname"]')) {
            return; // corrida: já injetado
         }
         addHidden(form, '_chatglpi_hostname', info.hostname);
         addHidden(form, '_chatglpi_ip', info.ip || '');
         addHidden(form, '_chatglpi_mac', info.mac || '');
      })
      .catch(() => {
         // Agente não instalado/rodando - segue sem os dados, igual o app antigo.
      });

   function addHidden(form, name, value) {
      const el = document.createElement('input');
      el.type = 'hidden';
      el.name = name;
      el.value = value;
      form.appendChild(el);
   }
}

// O formulário do chamado no GLPI 10 é montado por JS DEPOIS do
// DOMContentLoaded (não vem pronto no HTML inicial) - rodar uma vez só, cedo,
// pegava o form ainda inexistente e saía sem fazer nada. Aqui a gente fica
// tentando até o form de abertura aparecer (ou desiste depois de ~12s), só
// nas páginas de chamado pra não varrer o site inteiro à toa. A injeção é
// idempotente (checa se já existe o campo oculto antes).
(function chatglpiDeviceFillPoller() {
   if (!/ticket\.form\.php/.test(location.pathname)) {
      return;
   }
   let tries = 0;
   const timer = setInterval(function () {
      tries++;
      const idField = document.querySelector('input[name="id"]');
      const contentTa = document.querySelector('textarea[name="content"]');
      if (idField && idField.value === '0' && contentTa) {
         clearInterval(timer);
         chatglpiInitTicketDeviceFill();
      } else if (tries > 40) {
         clearInterval(timer);
      }
   }, 300);
})();
