<?php
// Página principal do chat - entra no menu Plug-ins do GLPI
// (inc/chat.class.php::getMenuContent()). A UI em si é montada pelo
// js/chat.js dentro da div #chatglpi-app.
include('../../../inc/includes.php');
include(__DIR__ . '/../inc/authtoken.php');
// Include explícito - plugin_chatglpi_format_user_name() é uma função solta
// dentro de conversation.class.php; o autoload do GLPI só é acionado por
// referência a CLASSE, então chamar a função direto sem antes referenciar
// PluginChatglpiConversation causava "Call to undefined function" (fatal
// logo após Html::header(), por isso a página ficava em branco - CSS
// carregava mas nem o JS nem a div chegavam a ser emitidos).
include(__DIR__ . '/../inc/conversation.class.php');
Session::checkLoginUser();

Html::header('Chat-GLPI', $_SERVER['PHP_SELF'], 'plugins', 'PluginChatglpiChat');

$myId = (int) Session::getLoginUserID();
$me = new User();
$me->getFromDB($myId);
$myName = plugin_chatglpi_format_user_name($me->fields['id'], $me->fields['name'], $me->fields['realname'] ?? '', $me->fields['firstname'] ?? '');
$myInitials = PluginChatglpiConversation::initialsOf($me);
$token = plugin_chatglpi_mint_token($myId, $myName, $myInitials);

// ?dmWith=<id> - vem do botão "Iniciar chat com solicitante" no chamado
// (hook.php::plugin_chatglpi_show_start_chat_link()); js/chat.js abre essa
// DM automaticamente ao carregar a página. ?ticketId= vai junto pra
// vincular a conversa a este chamado (glpi_plugin_chatglpi_ticketconversations) -
// sem isso as mensagens de sistema de mudança de chamado não tinham pra
// qual conversa ir.
$dmWith = (int) ($_GET['dmWith'] ?? 0);
$ticketId = (int) ($_GET['ticketId'] ?? 0);
$ticketTitle = (string) ($_GET['ticketTitle'] ?? '');

// O chat em si (mensagens/DMs/tempo real) roda no backend Node da VM
// dedicada (PLUGIN_CHATGLPI_BACKEND_URL) - aqui só assina o token que prova
// quem é o usuário logado no GLPI; ver inc/authtoken.php.
global $CFG_GLPI;
echo '<div id="chatglpi-app" data-user-id="' . $myId . '" data-api-base="' . PLUGIN_CHATGLPI_BACKEND_URL . '" data-auth-token="' . htmlspecialchars($token, ENT_QUOTES) . '"'
   . ' data-glpi-root="' . htmlspecialchars($CFG_GLPI['root_doc'], ENT_QUOTES) . '"'
   . ($dmWith > 0 ? ' data-start-dm="' . $dmWith . '"' : '')
   . ($ticketId > 0 ? ' data-ticket-id="' . $ticketId . '"' : '')
   . ($ticketTitle !== '' ? ' data-ticket-title="' . htmlspecialchars($ticketTitle, ENT_QUOTES) . '"' : '')
   . '></div>';

Html::footer();
