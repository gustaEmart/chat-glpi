package main

// Conteúdo da janela (ver comentário no topo de main.go sobre por que isso
// é HTML e não controles nativos). O visual espelha o chat do GLPI
// (plugin/chatglpi/css/chat.css): balões estilo WhatsApp - os da própria
// pessoa em vermelho à direita, os do suporte em cinza claro à esquerda -
// cabeçalho azul-marinho, e o botão flutuante redondo vermelho.
//
// Cores FIXAS de propósito: este processo roda fora do navegador/GLPI,
// sem nenhuma página de onde ler a paleta escolhida pelo usuário (ver
// chatglpiMenuColors() em plugin/chatglpi/js/chat.js, que só funciona
// DENTRO de uma página do GLPI). São os mesmos tons já usados lá, só
// fixos em vez de lidos ao vivo.
//
// A janela é sem moldura: quem desenha cabeçalho e botão de recolher é
// este HTML, e o Go só redimensiona/recorta a janela quando o JS chama
// goSetExpanded() (ver applyState() em main.go).
const chatHTML = `<!DOCTYPE html>
<html lang="pt-br">
<head>
<meta charset="utf-8">
<style>
  * { box-sizing: border-box; }
  html, body {
    margin: 0;
    height: 100%;
    overflow: hidden;
    font-family: "Segoe UI", -apple-system, Helvetica, Arial, sans-serif;
    background: transparent;
    user-select: none;
  }

  /* --- Estado recolhido: balão redondo --- */
  #bubble {
    width: 100%;
    height: 100%;
    border-radius: 50%;
    background: #0a4a6e;
    color: #fff;
    display: flex;
    align-items: center;
    justify-content: center;
    font-size: 28px;
    cursor: pointer;
  }
  #bubble:hover { background: #0d5c8a; }
  #badge {
    position: absolute;
    top: 4px;
    right: 6px;
    min-width: 16px;
    height: 16px;
    border-radius: 8px;
    background: #fff;
    color: #0a4a6e;
    font-size: 11px;
    font-weight: 700;
    line-height: 16px;
    text-align: center;
    padding: 0 4px;
    display: none;
  }

  /* --- Estado expandido: painel --- */
  #panel {
    display: none;
    flex-direction: column;
    height: 100%;
    background: #fff;
    border-radius: 12px;
    overflow: hidden;
  }
  #header {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 10px 12px;
    background: #0a4a6e;
    color: #fff;
    font-size: 13px;
    font-weight: 600;
    flex-shrink: 0;
  }
  #header span { flex: 1; }
  #collapse {
    background: none;
    border: none;
    color: #fff;
    opacity: .85;
    font-size: 18px;
    line-height: 1;
    cursor: pointer;
    padding: 0 4px;
  }
  #collapse:hover { opacity: 1; }

  #history {
    flex: 1;
    overflow-y: auto;
    padding: 12px;
    display: flex;
    flex-direction: column;
    gap: 8px;
  }
  .msg { max-width: 78%; display: flex; flex-direction: column; }
  .msg.mine { align-self: flex-end; }
  .msg.theirs { align-self: flex-start; }
  .msg-author {
    font-size: 11px;
    font-weight: 600;
    color: #495057;
    margin-bottom: 2px;
  }
  .msg-bubble {
    padding: 7px 11px;
    border-radius: 12px;
    font-size: 13px;
    line-height: 1.45;
    white-space: pre-wrap;
    word-break: break-word;
    user-select: text;
  }
  .msg.mine .msg-bubble { background: #dc2626; color: #fff; }
  .msg.theirs .msg-bubble { background: #f1f3f5; color: #212529; border: 1px solid #e2e6ea; }
  .msg-time { font-size: 10px; color: #868e96; margin-top: 3px; }
  .msg.mine .msg-time { text-align: right; }
  .msg-system {
    align-self: center;
    font-size: 11px;
    color: #868e96;
    text-align: center;
    padding: 2px 8px;
  }

  #composer {
    display: flex;
    gap: 6px;
    padding: 8px;
    border-top: 1px solid #e2e6ea;
    flex-shrink: 0;
  }
  #text {
    flex: 1;
    border: 1px solid #ced4da;
    border-radius: 6px;
    padding: 7px 9px;
    font-size: 13px;
    font-family: inherit;
    user-select: text;
  }
  #text:focus { outline: none; border-color: #dc2626; }
  #send {
    background: #dc2626;
    color: #fff;
    border: none;
    border-radius: 6px;
    padding: 7px 14px;
    font-size: 13px;
    font-weight: 600;
    cursor: pointer;
  }
  #send:hover { background: #c81e1e; }

  /* Aviso próprio (em vez do alert() nativo do Windows/WebView2, que
     mostra uma caixa cinza genérica "Esta página diz" - destoava do
     resto). Some sozinho depois de alguns segundos. */
  #toast {
    display: none;
    position: absolute;
    left: 50%;
    bottom: 74px;
    transform: translateX(-50%);
    max-width: 88%;
    background: #212529;
    color: #fff;
    font-size: 12px;
    line-height: 1.4;
    padding: 8px 12px;
    border-radius: 8px;
    box-shadow: 0 2px 10px rgba(0, 0, 0, .3);
    text-align: center;
    z-index: 10;
  }
  #toast.visible { display: block; }

  body.expanded #bubble { display: none; }
  body.expanded #panel { display: flex; }
</style>
</head>
<body>
  <div id="bubble">💬<span id="badge"></span></div>

  <div id="panel">
    <div id="header">
      <span>Suporte de TI</span>
      <button id="collapse" title="Minimizar">─</button>
    </div>
    <div id="history">
      <div class="msg-system">Conversa com o suporte de TI durante o acesso remoto.</div>
    </div>
    <div id="toast"></div>
    <div id="composer">
      <input id="text" type="text" placeholder="Escreva sua resposta..." autocomplete="off">
      <button id="send">Enviar</button>
    </div>
  </div>

<script>
  // "history" (não "historyEl"/outro nome) colide com o objeto nativo
  // window.history - em modo não-estrito a atribuição falha em silêncio
  // (sem erro nenhum no console), então "history" continuava apontando
  // pro History API do navegador em vez desta div. Toda chamada de
  // history.appendChild(...) explodia (TypeError: not a function), e como
  // isso acontecia DENTRO de addMessage() - chamada tanto ao mandar quanto
  // ao receber - as duas direções pareciam "sumir" sem nada aparecer.
  var historyEl = document.getElementById('history');
  var textInput = document.getElementById('text');
  var badge = document.getElementById('badge');
  var unanswered = 0;

  function escapeHtml(s) {
    var d = document.createElement('div');
    d.textContent = s;
    return d.innerHTML;
  }

  function nowHHMM() {
    var d = new Date();
    return ('0' + d.getHours()).slice(-2) + ':' + ('0' + d.getMinutes()).slice(-2);
  }

  function addMessage(side, author, text) {
    var el = document.createElement('div');
    el.className = 'msg ' + side;
    el.innerHTML =
      (author ? '<div class="msg-author">' + escapeHtml(author) + '</div>' : '') +
      '<div class="msg-bubble">' + escapeHtml(text) + '</div>' +
      '<div class="msg-time">' + nowHHMM() + '</div>';
    historyEl.appendChild(el);
    historyEl.scrollTop = historyEl.scrollHeight;
  }

  var toast = document.getElementById('toast');
  var toastTimer = null;
  function showToast(text) {
    toast.textContent = text;
    toast.classList.add('visible');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { toast.classList.remove('visible'); }, 3500);
  }

  function setExpanded(expanded) {
    // Não deixa recolher enquanto houver mensagem do suporte sem resposta -
    // é o "não consegue fechar sem responder" pedido, adaptado ao formato
    // de balão (não existe botão de fechar; só recolher).
    if (!expanded && unanswered > 0) {
      showToast('Responda a mensagem do suporte antes de minimizar o chat.');
      return;
    }
    document.body.classList.toggle('expanded', expanded);
    goSetExpanded(expanded);
    if (expanded) {
      unanswered = 0;
      badge.style.display = 'none';
      setTimeout(function () { textInput.focus(); }, 50);
    }
  }

  document.getElementById('bubble').addEventListener('click', function () {
    setExpanded(true);
  });
  document.getElementById('collapse').addEventListener('click', function () {
    setExpanded(false);
  });

  function send() {
    var text = textInput.value.trim();
    if (!text) return;
    textInput.value = '';
    addMessage('mine', '', text);
    unanswered = 0;
    goSend(text);
  }
  document.getElementById('send').addEventListener('click', send);
  textInput.addEventListener('keydown', function (e) {
    if (e.key === 'Enter') { e.preventDefault(); send(); }
  });

  // Chamada pelo Go (pushToJS em main.go) quando o técnico manda algo.
  window.chatIncoming = function (text) {
    addMessage('theirs', 'Suporte de TI', text);
    unanswered++;
    if (!document.body.classList.contains('expanded')) {
      badge.textContent = unanswered;
      badge.style.display = 'block';
    }
  };
</script>
</body>
</html>`
