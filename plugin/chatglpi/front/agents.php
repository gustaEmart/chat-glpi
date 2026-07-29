<?php
// Painel de auditoria: em quais máquinas o agente de AUTO-PREENCHIMENTO
// (info, porta 47821, distribuído via GPO - agent/main.go) está realmente
// rodando (dados de ajax/agentcheckin.php). Só staff/técnico. Uma máquina
// conta como "ativa" se deu check-in nas últimas 2h (avisa de hora em hora).
// Não mostra o agente de acesso remoto/VNC (porta 47652, instalado manual
// por técnico) - esse tem cobertura pequena e conhecida, não precisa auditoria.
include('../../../inc/includes.php');
Session::checkLoginUser();

// Restrito a staff/técnico (interface "central") - "config" nem sempre está
// presente no perfil de quem administra de fato aqui, ver inc/chat.class.php.
if (($_SESSION['glpiactiveprofile']['interface'] ?? '') !== 'central') {
   Html::displayRightError();
   exit;
}

Html::header('Agentes Chat-GLPI', $_SERVER['PHP_SELF'], 'plugins', 'PluginChatglpiChat');

global $DB;
$rows = iterator_to_array($DB->request([
   'FROM'  => 'glpi_plugin_chatglpi_agentcheckins',
   'WHERE' => ['agent_type' => 'info'],
   'ORDER' => 'last_seen DESC',
]));

$now = time();
$activeWindow = 2 * 3600; // 2h
$total = count($rows);
$active = 0;
foreach ($rows as $r) {
   if ($now - strtotime($r['last_seen']) <= $activeWindow) {
      $active++;
   }
}
$stale = $total - $active;

echo '<div class="card" style="max-width:1000px;margin:12px auto;padding:18px 22px;">';
echo '<h2 style="margin-top:0;">Agentes de auto-preenchimento instalados</h2>';
echo '<p class="text-muted">Máquinas com o agente de computador/IP/MAC (GPO, porta 47821). Cada uma avisa ao iniciar e a cada hora. "Ativo" = deu sinal nas últimas 2 horas.</p>';

echo '<div class="d-flex gap-3 mb-3" style="gap:12px;">';
echo '<span class="badge bg-secondary" style="font-size:14px;">Total: ' . $total . '</span> ';
echo '<span class="badge bg-success" style="font-size:14px;">Ativos: ' . $active . '</span> ';
echo '<span class="badge bg-warning text-dark" style="font-size:14px;">Sem sinal recente: ' . $stale . '</span>';
echo '</div>';

if ($total === 0) {
   echo '<p>Nenhum agente registrou presença ainda. Assim que uma máquina com o agente atualizado iniciar, ela aparece aqui.</p>';
} else {
   echo '<input type="text" id="chatglpi-agents-search" class="form-control" placeholder="Buscar por usuário ou máquina..." style="max-width:320px;margin-bottom:12px;">';
   echo '<table class="table table-striped table-hover"><thead><tr>';
   echo '<th>Status</th><th>Máquina</th><th>Usuário</th><th>Versão</th><th>IP</th><th>Visto por último</th><th>Primeiro registro</th><th></th>';
   echo '</tr></thead><tbody id="chatglpi-agents-tbody">';
   foreach ($rows as $r) {
      $ageSecs = $now - strtotime($r['last_seen']);
      $isActive = $ageSecs <= $activeWindow;
      $dot = $isActive
         ? '<span class="badge bg-success">● ativo</span>'
         : '<span class="badge bg-warning text-dark">● sem sinal</span>';
      $searchKey = mb_strtolower($r['hostname'] . ' ' . $r['username']);
      echo '<tr data-chatglpi-search="' . htmlspecialchars($searchKey) . '">';
      echo '<td>' . $dot . '</td>';
      echo '<td><strong>' . htmlspecialchars($r['hostname']) . '</strong></td>';
      echo '<td>' . htmlspecialchars($r['username']) . '</td>';
      echo '<td>' . htmlspecialchars($r['version']) . '</td>';
      echo '<td><code>' . htmlspecialchars($r['ip']) . '</code></td>';
      echo '<td>' . Html::convDateTime($r['last_seen']) . ' <span class="text-muted">(' . self_chatglpi_ago($ageSecs) . ')</span></td>';
      echo '<td>' . Html::convDateTime($r['first_seen']) . '</td>';
      echo '<td><button type="button" class="btn btn-sm btn-outline-primary" onclick="chatglpiConnectFromAgentsPanel(\'' . htmlspecialchars($r['hostname'], ENT_QUOTES) . '\')">Conectar</button></td>';
      echo '</tr>';
   }
   echo '</tbody></table>';
   echo '<script>
      document.getElementById("chatglpi-agents-search").addEventListener("input", function (e) {
         var q = e.target.value.trim().toLowerCase();
         document.querySelectorAll("#chatglpi-agents-tbody tr").forEach(function (tr) {
            tr.style.display = tr.dataset.chatglpiSearch.indexOf(q) !== -1 ? "" : "none";
         });
      });
   </script>';
}
echo '</div>';

Html::footer();

function self_chatglpi_ago(int $secs): string {
   if ($secs < 60)    return 'há ' . $secs . 's';
   if ($secs < 3600)  return 'há ' . floor($secs / 60) . ' min';
   if ($secs < 86400) return 'há ' . floor($secs / 3600) . ' h';
   return 'há ' . floor($secs / 86400) . ' d';
}
