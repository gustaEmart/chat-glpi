<?php
// Recebe o "estou vivo" do agente local (VNC/info) - chamado pelo próprio
// executável na inicialização e de hora em hora, NÃO por um navegador, então
// não tem sessão do GLPI: a proteção é um token compartilhado simples
// (PLUGIN_CHATGLPI_AGENT_CHECKIN_TOKEN, embutido no instalar-agente.ps1).
// Grava/atualiza uma linha por máquina em glpi_plugin_chatglpi_agentcheckins,
// consultada pelo painel front/agents.php. Escrita minúscula (1x/hora por
// máquina), não pesa no GLPI.
include('../../../inc/includes.php');
header('Content-Type: application/json');

$token = $_SERVER['HTTP_X_CHATGLPI_CHECKIN'] ?? '';
if (!defined('PLUGIN_CHATGLPI_AGENT_CHECKIN_TOKEN')
    || !hash_equals(PLUGIN_CHATGLPI_AGENT_CHECKIN_TOKEN, $token)) {
   http_response_code(403);
   echo json_encode(['error' => 'token inválido']);
   exit;
}

$body = json_decode(file_get_contents('php://input'), true) ?: [];
$hostname = mb_substr(trim((string) ($body['hostname'] ?? '')), 0, 255);
if ($hostname === '') {
   http_response_code(400);
   echo json_encode(['error' => 'hostname obrigatório']);
   exit;
}
$username = mb_substr(trim((string) ($body['username'] ?? '')), 0, 255);
$agent = mb_substr(trim((string) ($body['agent'] ?? '')), 0, 32);
$version = mb_substr(trim((string) ($body['version'] ?? '')), 0, 32);
$ip = mb_substr((string) ($_SERVER['REMOTE_ADDR'] ?? ''), 0, 64);
$now = date('Y-m-d H:i:s');

global $DB;
// updateOrInsert mantém first_seen (só setado no insert, via default) e
// atualiza o resto a cada check-in.
$DB->updateOrInsert('glpi_plugin_chatglpi_agentcheckins', [
   'username'   => $username,
   'agent_type' => $agent,
   'version'    => $version,
   'ip'         => $ip,
   'last_seen'  => $now,
], ['hostname' => $hostname]);

echo json_encode(['ok' => true]);
