<?php
/**
 * Token de autenticação pro widget flutuante de chat (js/chat.js::
 * initFloatingChatWidget()), que aparece em QUALQUER página do GLPI, não
 * só em front/chat.php ou na aba "Acesso remoto" do chamado - por isso
 * precisa de um jeito de mintar o token sem nenhuma div com data-* já
 * pronta na página. Usa a sessão normal do GLPI (cookie), igual qualquer
 * outra página logada - Session::checkLoginUser() já resolve sozinho.
 */
include('../../../inc/includes.php');
include(__DIR__ . '/../inc/authtoken.php');
include(__DIR__ . '/../inc/conversation.class.php');

header('Content-Type: application/json');

if (!Session::getLoginUserID()) {
   http_response_code(401);
   echo json_encode(['error' => 'Sem sessão ativa.']);
   exit;
}

$myId = (int) Session::getLoginUserID();
$me = new User();
$me->getFromDB($myId);
$myName = plugin_chatglpi_format_user_name($me->fields['id'], $me->fields['name'], $me->fields['realname'] ?? '', $me->fields['firstname'] ?? '');
$myInitials = PluginChatglpiConversation::initialsOf($me);
$token = plugin_chatglpi_mint_token($myId, $myName, $myInitials);

global $CFG_GLPI;
echo json_encode([
   'token'    => $token,
   'apiBase'  => PLUGIN_CHATGLPI_BACKEND_URL,
   'userId'   => $myId,
   'glpiRoot' => $CFG_GLPI['root_doc'],
]);
