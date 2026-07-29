<?php
/**
 * Callback servidor-servidor do backend Node (glpi-backend/src/remote.js::
 * postChatTranscriptFollowup()) - registra no chamado a conversa INTEIRA
 * trocada no widget de chat durante uma sessão de acesso remoto (aba
 * "Acesso remoto" do chamado), quando a sessão termina. Irmão de
 * remotefollowup.php (mesma sessão termina -> duração) - os dois disparam
 * juntos no fim da sessão.
 *
 * Mesma autenticação de remotefollowup.php: assinatura HMAC sobre o corpo
 * bruto (nunca sessão GLPI - quem chama é o Node, não um navegador).
 */
include('../../../inc/includes.php');

header('Content-Type: application/json');

$raw = file_get_contents('php://input');
$signature = $_SERVER['HTTP_X_CHATGLPI_SIGNATURE'] ?? '';
$expected = hash_hmac('sha256', $raw, PLUGIN_CHATGLPI_SHARED_SECRET);
if ($signature === '' || !hash_equals($expected, $signature)) {
   http_response_code(401);
   echo json_encode(['error' => 'Assinatura inválida.']);
   exit;
}

$data = json_decode($raw, true);
if (!is_array($data)) {
   http_response_code(400);
   echo json_encode(['error' => 'Corpo inválido.']);
   exit;
}

$ticketsId = (int) ($data['ticketsId'] ?? 0);
$userId = (int) ($data['userId'] ?? 0);
$hostname = trim((string) ($data['hostname'] ?? ''));
$messages = is_array($data['messages'] ?? null) ? $data['messages'] : [];

if ($ticketsId <= 0 || $hostname === '' || empty($messages)) {
   http_response_code(400);
   echo json_encode(['error' => 'Parâmetros inválidos.']);
   exit;
}

global $DB;
$ticket = $DB->request(['FROM' => 'glpi_tickets', 'WHERE' => ['id' => $ticketsId], 'LIMIT' => 1])->current();
if (!$ticket) {
   http_response_code(404);
   echo json_encode(['error' => 'Chamado não encontrado.']);
   exit;
}

$lines = [];
foreach ($messages as $m) {
   $from = ($m['from'] ?? '') === 'user' ? 'Usuário' : 'Técnico';
   $text = trim((string) ($m['text'] ?? ''));
   if ($text === '') continue;
   $ts = (int) ($m['ts'] ?? 0);
   $time = $ts > 0 ? date('H:i', (int) ($ts / 1000)) : '';
   $lines[] = '[' . $time . '] <strong>' . $from . ':</strong> ' . nl2br(htmlspecialchars($text, ENT_QUOTES));
}

$content = 'Chat de acesso remoto ao computador <strong>' . htmlspecialchars($hostname, ENT_QUOTES) . '</strong>:<br>'
   . implode('<br>', $lines);

// Mesma lógica do core pra decidir lado esquerdo/direito na timeline
// (esquerda = solicitante, direita = atribuído) - conforme o papel do
// usuário no chamado (Ticket::getTimelinePosition() em CommonITILObject).
$position = Ticket::getTimelinePosition($ticketsId, 'ITILFollowup', $userId);

$now = date('Y-m-d H:i:s');
$DB->insert('glpi_itilfollowups', [
   'itemtype'          => 'Ticket',
   'items_id'           => $ticketsId,
   'date'               => $now,
   'users_id'           => $userId,
   'users_id_editor'    => $userId,
   'content'            => $content,
   'is_private'         => 1,
   'requesttypes_id'    => 0,
   'date_mod'           => $now,
   'date_creation'      => $now,
   'timeline_position'  => $position,
]);

echo json_encode(['ok' => true]);
