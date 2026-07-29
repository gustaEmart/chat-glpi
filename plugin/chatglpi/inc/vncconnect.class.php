<?php
/**
 * Aba "Acesso remoto" no chamado - resolve automaticamente o computador
 * vinculado ao chamado (Item_Ticket) e o IP/MAC dele
 * (glpi_networkports -> glpi_networknames -> glpi_ipaddresses, direto no
 * banco do GLPI, sem nenhuma chamada de rede), preenchendo o host sozinho.
 *
 * Substitui backend/src/glpiClient.js:459-487 (getComputerIpByName), que
 * fazia a mesma cadeia via 3 chamadas REST separadas por precisar buscar o
 * computador pelo NOME digitado manualmente - aqui já partimos do chamado
 * aberto, então nem precisa buscar por nome.
 *
 * A conexão em si (só nesta aba) é 100% pelo navegador via noVNC +
 * websockify, rodando na mesma VM do backend de chat (192.0.2.20) - ver
 * js/chat.js::chatglpiStartRemoteSession() e glpi-backend/src/remote.js.
 * Nada é executado na máquina do técnico; o botão "Conectar" da lista de
 * Computadores e do painel de agentes continua usando o agente local
 * (ChatGlpiAgent.exe em 127.0.0.1:47652) - troca só aqui, por decisão
 * explícita do usuário ao pedir essa refatoração.
 */
class PluginChatglpiVncconnect extends CommonDBTM {

   public static function getTypeName($nb = 0) {
      return 'Acesso remoto';
   }

   public function getTabNameForItem(CommonGLPI $item, $withtemplate = 0) {
      if ($item instanceof Ticket && $item->fields['id']) {
         return self::getTypeName();
      }
      return '';
   }

   public static function displayTabContentForItem(CommonGLPI $item, $tabnum = 1, $withtemplate = 0) {
      if (!($item instanceof Ticket) || !$item->fields['id']) {
         return false;
      }
      self::showForTicket((int) $item->fields['id']);
      return true;
   }

   public static function showForTicket(int $ticketsId): void {
      $host = '';
      $ip = '';
      $mac = '';
      $found = false;

      // Mesma prioridade do bloco inline: o que o agente capturou na abertura
      // primeiro, inventário do GLPI como fallback.
      $device = self::storedDevice($ticketsId);
      if ($device) {
         $host = $device['hostname'];
         $ip = $device['ip'];
         $mac = $device['mac'];
         $found = true;
      } else {
         $computer = self::findComputerForTicket($ticketsId);
         if ($computer) {
            $host = $computer['name'];
            $network = self::resolveNetworkInfo((int) $computer['id']);
            $ip = $network['ip'];
            $mac = $network['mac'];
            $found = true;
         }
      }

      // Prioriza o NOME do computador (o DNS interno resolve pelo hostname
      // do domínio, e o nome não muda com renovação de DHCP como o IP às
      // vezes muda); cai pro IP só se não tiver nome nenhum.
      $prefillHost = $host !== '' ? $host : $ip;

      // Token assinado pro backend Node saber quem está autenticado -
      // mesmo mecanismo do chat (inc/authtoken.php), só que mintado aqui
      // porque esta aba não carrega front/chat.php.
      include_once __DIR__ . '/authtoken.php';
      $me = new User();
      $me->getFromDB((int) Session::getLoginUserID());
      $token = plugin_chatglpi_mint_token(
         (int) Session::getLoginUserID(),
         $me->fields['name'] ?? '',
         ''
      );

      echo '<div class="chatglpi-vnc-tab" style="padding:16px;max-width:420px;"';
      echo ' data-api-base="' . htmlspecialchars(PLUGIN_CHATGLPI_BACKEND_URL, ENT_QUOTES) . '"';
      echo ' data-auth-token="' . htmlspecialchars($token, ENT_QUOTES) . '"';
      // Vai junto no POST /remote/start - o backend guarda isso na sessão
      // e, quando ela terminar, registra um acompanhamento AQUI no chamado
      // com o computador acessado e a duração (ver remote.js::destroySession()
      // e ajax/remotefollowup.php). Só existe nesta aba (a aba tem chamado);
      // o card avulso do dashboard não manda isso e não gera acompanhamento.
      echo ' data-tickets-id="' . $ticketsId . '">';

      if (!$found) {
         echo '<p>Nenhum computador encontrado pra este chamado. Preencha manualmente o IP/hostname abaixo.</p>';
      } else {
         echo '<p style="margin-bottom:12px;">Computador: <strong>' . htmlspecialchars($host) . '</strong>';
         if ($ip !== '') {
            echo ' &middot; IP: <code>' . htmlspecialchars($ip) . '</code>';
         }
         if ($mac !== '') {
            echo ' &middot; MAC: <code>' . htmlspecialchars($mac) . '</code>';
         }
         echo '</p>';
      }

      // Sem computador resolvido: mantém um campo manual (única exceção ao
      // "nunca digitar host" do md - não há outra forma de recuperar o
      // fluxo quando o backend não sabe qual máquina é). Com computador
      // resolvido, o técnico não vê nem toca em host nenhum.
      if (!$found) {
         echo '<div class="form-group">';
         echo '<label>IP ou hostname da máquina</label>';
         echo '<input type="text" id="chatglpi-vnc-host" class="form-control chatglpi-remote-host-input" '
            . 'list="chatglpi-vnc-host-history" autocomplete="off" value="' . htmlspecialchars($prefillHost) . '">';
         echo '<datalist id="chatglpi-vnc-host-history"></datalist>';
         echo '</div>';
      } else {
         echo '<input type="hidden" id="chatglpi-vnc-host" value="' . htmlspecialchars($prefillHost) . '">';
      }

      echo '<div id="chatglpi-vnc-error" style="color:#c0392b;font-size:12px;margin-top:8px;display:none;"></div>';

      echo '<button type="button" class="btn btn-primary" style="margin-top:14px;" onclick="chatglpiStartRemoteSession(this)">Acessar remotamente</button>';
      // Sem classe "small" do Bootstrap aqui: o CSS nativo do GLPI tem uma
      // regra global "#page .small { width: 1%; }" (pensada pra células de
      // tabela) que colide com esse helper tipográfico e colapsa qualquer
      // bloco pra ~4px de largura, um caractere por linha - já vi acontecer.
      echo '<p class="text-muted" style="margin-top:10px;font-size:12px;">Abre numa aba nova, direto no navegador - só vai pedir a senha do VNC.</p>';
      echo '</div>';
   }

   // Bloco compacto e SÓ-LEITURA logo abaixo da descrição do chamado (hook
   // post_item_form em hook.php) - o técnico vê o computador/IP sem abrir a
   // aba "Acesso remoto", e o usuário não consegue alterar/apagar (diferente
   // de anexar na descrição, que era editável).
   //
   // Fonte preferida: o que o agente local capturou AO VIVO na abertura do
   // chamado (glpi_plugin_chatglpi_ticketdevices, gravado pelo hook
   // plugin_chatglpi_ticket_add) - funciona mesmo que o computador não esteja
   // no inventário. Se não houver nada capturado (chamado antigo, ou agente
   // não rodava), cai pro inventário do GLPI.
   public static function showInline(int $ticketsId): void {
      $host = '';
      $ip = '';
      $mac = '';

      $device = self::storedDevice($ticketsId);
      if ($device) {
         $host = $device['hostname'];
         $ip = $device['ip'];
         $mac = $device['mac'];
      } else {
         $computer = self::findComputerForTicket($ticketsId);
         if ($computer) {
            $host = $computer['name'];
            $network = self::resolveNetworkInfo((int) $computer['id']);
            $ip = $network['ip'];
            $mac = $network['mac'];
         }
      }

      if ($host === '' && $ip === '' && $mac === '') {
         return;
      }

      echo '<div class="alert alert-info d-flex align-items-center gap-2" style="margin:8px 0;">';
      echo '<i class="ti ti-device-desktop"></i> ';
      echo '<span>Computador do solicitante: <strong>' . htmlspecialchars($host !== '' ? $host : '(desconhecido)') . '</strong>';
      if ($ip !== '') {
         echo ' &middot; IP: <code>' . htmlspecialchars($ip) . '</code>';
      }
      if ($mac !== '') {
         echo ' &middot; MAC: <code>' . htmlspecialchars($mac) . '</code>';
      }
      echo '</span></div>';
   }

   private static function storedDevice(int $ticketsId): ?array {
      global $DB;
      if (!$DB->tableExists('glpi_plugin_chatglpi_ticketdevices')) {
         return null;
      }
      $row = $DB->request([
         'FROM'  => 'glpi_plugin_chatglpi_ticketdevices',
         'WHERE' => ['tickets_id' => $ticketsId],
         'LIMIT' => 1
      ])->current();
      return $row ?: null;
   }

   // Primeiro tenta o computador explicitamente vinculado ao chamado (aba
   // "Itens" do chamado); se não achar nenhum, cai pro computador principal
   // cadastrado do solicitante (glpi_computers.users_id) - cobre o caso
   // comum de um chamado aberto sem vincular ativo nenhum manualmente.
   private static function findComputerForTicket(int $ticketsId): ?array {
      return self::findLinkedComputer($ticketsId) ?? self::findRequesterComputer($ticketsId);
   }

   private static function findLinkedComputer(int $ticketsId): ?array {
      global $DB;
      $row = $DB->request([
         'SELECT'    => ['glpi_computers.id', 'glpi_computers.name'],
         'FROM'      => 'glpi_items_tickets',
         'INNER JOIN' => [
            'glpi_computers' => [
               'FKEY' => ['glpi_items_tickets' => 'items_id', 'glpi_computers' => 'id']
            ]
         ],
         'WHERE' => [
            'glpi_items_tickets.tickets_id' => $ticketsId,
            'glpi_items_tickets.itemtype'   => 'Computer'
         ],
         'LIMIT' => 1
      ])->current();
      return $row ?: null;
   }

   private static function findRequesterComputer(int $ticketsId): ?array {
      global $DB;
      $requester = $DB->request([
         'SELECT' => ['users_id'],
         'FROM'   => 'glpi_tickets_users',
         'WHERE'  => ['tickets_id' => $ticketsId, 'type' => \CommonITILActor::REQUESTER],
         'LIMIT'  => 1
      ])->current();
      if (!$requester) {
         return null;
      }
      $row = $DB->request([
         'SELECT' => ['id', 'name'],
         'FROM'   => 'glpi_computers',
         'WHERE'  => ['users_id' => (int) $requester['users_id'], 'is_deleted' => 0],
         'LIMIT'  => 1
      ])->current();
      return $row ?: null;
   }

   private static function resolveNetworkInfo(int $computerId): array {
      global $DB;

      $ports = iterator_to_array($DB->request([
         'FROM'  => 'glpi_networkports',
         'WHERE' => ['itemtype' => 'Computer', 'items_id' => $computerId, 'is_deleted' => 0]
      ]));

      foreach ($ports as $port) {
         $names = iterator_to_array($DB->request([
            'FROM'  => 'glpi_networknames',
            'WHERE' => ['itemtype' => 'NetworkPort', 'items_id' => $port['id'], 'is_deleted' => 0]
         ]));
         foreach ($names as $networkName) {
            $ips = iterator_to_array($DB->request([
               'FROM'  => 'glpi_ipaddresses',
               'WHERE' => ['itemtype' => 'NetworkName', 'items_id' => $networkName['id'], 'is_deleted' => 0]
            ]));
            foreach ($ips as $ipRow) {
               if (!empty($ipRow['name'])) {
                  return ['ip' => $ipRow['name'], 'mac' => $port['mac'] ?? ''];
               }
            }
         }
      }

      // Nenhum IP cadastrado - ainda assim devolve o MAC da primeira porta,
      // se tiver.
      return ['ip' => '', 'mac' => $ports[0]['mac'] ?? ''];
   }
}
