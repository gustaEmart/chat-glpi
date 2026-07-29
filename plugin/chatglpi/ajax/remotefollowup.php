<?php
/**
 * Callback servidor-servidor do backend Node (glpi-backend/src/remote.js)
 * quando uma sessão de acesso remoto (aba "Acesso remoto" do chamado)
 * termina - registra um acompanhamento no chamado com o computador
 * acessado e a duração ("Acesso remoto ao computador X - duração: Ymin Zs").
 *
 * Quem chama isso é o Node (192.0.2.20), nunca o navegador de um
 * técnico - por isso não tem sessão GLPI nenhuma aqui (sem cookie, sem
 * Session::getLoginUserID()) e a autenticação é uma assinatura HMAC sobre
 * o corpo bruto, com o MESMO segredo compartilhado da ponte de auth do
 * chat (CHATGLPI_SHARED_SECRET, ver inc/authtoken.php e setup.php).
 *
 * Grava direto via $DB->insert() em vez de ITILFollowup::add() de
 * propósito: o objeto ITILFollowup faz checagem de direitos via sessão
 * ativa (Session::haveRight()), que não existe aqui - forjar uma sessão
 * só pra passar nessa checagem seria mais frágil que inserir direto.
 * $DB aqui é a conexão nativa do próprio GLPI (super-usuário completo nas
 * tabelas do GLPI), não tem nada a ver com o usuário MySQL restrito
 * chatglpi_svc que o Node usa pras tabelas glpi_plugin_chatglpi_* dele.
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
$durationSeconds = max(0, (int) ($data['durationSeconds'] ?? 0));

if ($ticketsId <= 0 || $hostname === '') {
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

$minutes = intdiv($durationSeconds, 60);
$seconds = $durationSeconds % 60;
$durationText = ($minutes > 0 ? "{$minutes}min " : '') . "{$seconds}s";
$content = 'Acesso remoto ao computador <strong>' . htmlspecialchars($hostname, ENT_QUOTES) . '</strong> - duração: ' . $durationText . '.';

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
