<?php
/**
 * Install/uninstall e os hooks de "chamado mudou -> mensagem de sistema no
 * chat" (substituem chatStore.notifyTicketUpdate() do app antigo, que era
 * chamado manualmente em cada rota de ação de chamado - aqui é nativo,
 * direto nos eventos do próprio GLPI).
 */

// Adiciona a coluna "Chat-GLPI - Agente" na busca nativa de Computadores
// (Ativos > Computadores), addable pelo seletor de colunas do próprio GLPI -
// GLPI chama esta função automaticamente pra todo itemtype (ver
// Plugin::getAddSearchOptionsNew() em src/Plugin.php). Mostra o botão
// "Conectar" via inc/agentcheckin.class.php::getSpecificValueToDisplay().
function plugin_chatglpi_getAddSearchOptionsNew($itemtype) {
   if ($itemtype !== 'Computer') {
      return [];
   }
   return [
      [
         'id'              => 99010,
         'table'           => 'glpi_plugin_chatglpi_agentcheckins',
         'field'           => 'last_seen',
         'name'            => 'Chat-GLPI - Agente de auto-preenchimento',
         'datatype'        => 'specific',
         'massiveaction'   => false,
         'additionalfields' => ['hostname'],
         'joinparams'      => ['jointype' => 'standard'],
      ],
   ];
}

// O join padrão do GLPI é baseado em chave estrangeira numérica
// (rt.linkfield = nt.id) - não serve aqui, porque o vínculo é por NOME
// (glpi_computers.name = glpi_plugin_chatglpi_agentcheckins.hostname), sem
// nenhuma FK. Tabelas "glpi_plugin_<algo>" acionam automaticamente esta
// função (convenção do GLPI - ver Search::addLeftJoin() em src/Search.php),
// que substitui o join padrão por completo quando devolve algo não-vazio.
function plugin_chatglpi_addLeftJoin($itemtype, $ref_table, $new_table, $linkfield, array &$already_link_tables) {
   if ($itemtype !== 'Computer' || $new_table !== 'glpi_plugin_chatglpi_agentcheckins') {
      return '';
   }
   return " LEFT JOIN `$new_table` ON (`$new_table`.`hostname` = `$ref_table`.`name`) ";
}

function plugin_chatglpi_install() {
   global $DB;

   if (!$DB->tableExists('glpi_plugin_chatglpi_conversations')) {
      $DB->query("
         CREATE TABLE `glpi_plugin_chatglpi_conversations` (
            `id` INT UNSIGNED NOT NULL AUTO_INCREMENT,
            `date_creation` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
            PRIMARY KEY (`id`)
         ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
      ") or die('Erro criando glpi_plugin_chatglpi_conversations: ' . $DB->error());
   }

   if (!$DB->tableExists('glpi_plugin_chatglpi_participants')) {
      $DB->query("
         CREATE TABLE `glpi_plugin_chatglpi_participants` (
            `id` INT UNSIGNED NOT NULL AUTO_INCREMENT,
            `conversations_id` INT UNSIGNED NOT NULL,
            `users_id` INT UNSIGNED NOT NULL,
            PRIMARY KEY (`id`),
            UNIQUE KEY `conv_user` (`conversations_id`, `users_id`),
            KEY `users_id` (`users_id`)
         ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
      ") or die('Erro criando glpi_plugin_chatglpi_participants: ' . $DB->error());
   }

   if (!$DB->tableExists('glpi_plugin_chatglpi_messages')) {
      $DB->query("
         CREATE TABLE `glpi_plugin_chatglpi_messages` (
            `id` INT UNSIGNED NOT NULL AUTO_INCREMENT,
            `conversations_id` INT UNSIGNED NOT NULL,
            `users_id` INT UNSIGNED NULL DEFAULT NULL,
            `author_name` VARCHAR(255) NOT NULL DEFAULT '',
            `is_system` TINYINT UNSIGNED NOT NULL DEFAULT 0,
            `content` TEXT NOT NULL,
            `variant` VARCHAR(50) NULL DEFAULT NULL,
            `image_file` VARCHAR(255) NULL DEFAULT NULL,
            `reply_to_id` INT UNSIGNED NULL DEFAULT NULL,
            `date_creation` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
            PRIMARY KEY (`id`),
            KEY `conversations_id` (`conversations_id`, `id`)
         ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
      ") or die('Erro criando glpi_plugin_chatglpi_messages: ' . $DB->error());
   } elseif (!$DB->fieldExists('glpi_plugin_chatglpi_messages', 'reply_to_id')) {
      // Resposta a mensagem (estilo WhatsApp) chegou depois da 1.11 -
      // instalação que já existia de antes ganha a coluna aqui, sem
      // precisar de migração manual em produção; roda de novo em toda
      // reinstalação (plugin:install -f) mas o fieldExists acima já
      // protege contra tentar adicionar duas vezes.
      $DB->query("
         ALTER TABLE `glpi_plugin_chatglpi_messages`
         ADD COLUMN `reply_to_id` INT UNSIGNED NULL DEFAULT NULL AFTER `image_file`
      ") or die('Erro adicionando reply_to_id em glpi_plugin_chatglpi_messages: ' . $DB->error());
   }

   if (!$DB->tableExists('glpi_plugin_chatglpi_lastread')) {
      $DB->query("
         CREATE TABLE `glpi_plugin_chatglpi_lastread` (
            `users_id` INT UNSIGNED NOT NULL,
            `conversations_id` INT UNSIGNED NOT NULL,
            `last_messages_id` INT UNSIGNED NOT NULL,
            PRIMARY KEY (`users_id`, `conversations_id`)
         ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
      ") or die('Erro criando glpi_plugin_chatglpi_lastread: ' . $DB->error());
   }

   if (!$DB->tableExists('glpi_plugin_chatglpi_ticketconversations')) {
      $DB->query("
         CREATE TABLE `glpi_plugin_chatglpi_ticketconversations` (
            `tickets_id` INT UNSIGNED NOT NULL,
            `conversations_id` INT UNSIGNED NOT NULL,
            PRIMARY KEY (`tickets_id`, `conversations_id`)
         ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
      ") or die('Erro criando glpi_plugin_chatglpi_ticketconversations: ' . $DB->error());
   }

   // Computador capturado AO VIVO do agente local na abertura do chamado
   // (js/chat.js injeta campos ocultos no form; plugin_chatglpi_ticket_add
   // grava aqui). Fica só-leitura - o usuário não altera/apaga, e o técnico
   // vê no bloco abaixo da descrição (inc/vncconnect.class.php::showInline()).
   if (!$DB->tableExists('glpi_plugin_chatglpi_ticketdevices')) {
      $DB->query("
         CREATE TABLE `glpi_plugin_chatglpi_ticketdevices` (
            `tickets_id` INT UNSIGNED NOT NULL,
            `hostname` VARCHAR(255) NOT NULL DEFAULT '',
            `ip` VARCHAR(64) NOT NULL DEFAULT '',
            `mac` VARCHAR(64) NOT NULL DEFAULT '',
            `date_creation` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
            PRIMARY KEY (`tickets_id`)
         ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
      ") or die('Erro criando glpi_plugin_chatglpi_ticketdevices: ' . $DB->error());
   }

   // Check-in dos agentes locais (VNC/info) - cada máquina avisa ao iniciar
   // e de hora em hora (ajax/agentcheckin.php); serve pra auditar em quais
   // máquinas o agente está realmente rodando (front/agents.php). hostname
   // é a chave, então re-check-in só atualiza a linha.
   if (!$DB->tableExists('glpi_plugin_chatglpi_agentcheckins')) {
      $DB->query("
         CREATE TABLE `glpi_plugin_chatglpi_agentcheckins` (
            `hostname` VARCHAR(255) NOT NULL,
            `username` VARCHAR(255) NOT NULL DEFAULT '',
            `agent_type` VARCHAR(32) NOT NULL DEFAULT '',
            `version` VARCHAR(32) NOT NULL DEFAULT '',
            `ip` VARCHAR(64) NOT NULL DEFAULT '',
            `first_seen` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
            `last_seen` DATETIME NOT NULL,
            PRIMARY KEY (`hostname`),
            KEY `last_seen` (`last_seen`)
         ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
      ") or die('Erro criando glpi_plugin_chatglpi_agentcheckins: ' . $DB->error());
   }

   // Presença (dot "online"): cada poll/SSE do usuário atualiza seu
   // last_seen; consideramos online quem teve atividade nos últimos ~15s
   // (sem isso teríamos que manter estado em memória compartilhada entre
   // processos PHP-FPM, o que não existe por padrão).
   if (!$DB->tableExists('glpi_plugin_chatglpi_presence')) {
      $DB->query("
         CREATE TABLE `glpi_plugin_chatglpi_presence` (
            `users_id` INT UNSIGNED NOT NULL,
            `last_seen` DATETIME NOT NULL,
            PRIMARY KEY (`users_id`)
         ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
      ") or die('Erro criando glpi_plugin_chatglpi_presence: ' . $DB->error());
   }

   return true;
}

function plugin_chatglpi_uninstall() {
   global $DB;
   foreach ([
      'glpi_plugin_chatglpi_agentcheckins',
      'glpi_plugin_chatglpi_ticketdevices',
      'glpi_plugin_chatglpi_presence',
      'glpi_plugin_chatglpi_ticketconversations',
      'glpi_plugin_chatglpi_lastread',
      'glpi_plugin_chatglpi_messages',
      'glpi_plugin_chatglpi_participants',
      'glpi_plugin_chatglpi_conversations',
   ] as $table) {
      $DB->query("DROP TABLE IF EXISTS `$table`");
   }
   return true;
}

// Chamado mudou de status/campo -> mensagem de sistema em toda conversa
// vinculada a ele (equivalente a chatStore.notifyTicketUpdate() do app
// antigo, chamado hoje via hook nativo em vez de manualmente por rota).
function plugin_chatglpi_ticket_update(\CommonDBTM $item) {
   if (!($item instanceof \Ticket)) {
      return;
   }
   $changed = $item->getField('_changed_fields') ?? [];
   if (!isset($item->oldvalues['status']) && empty($item->updates)) {
      // Sem alteração relevante detectada - GLPI ainda assim dispara o hook
      // em alguns saves sem mudança real; evita post vazio.
      if (empty(array_intersect(['status', 'priority'], (array) ($item->updates ?? [])))) {
         return;
      }
   }

   $text = null;
   if (in_array('status', (array) ($item->updates ?? []), true)) {
      $statusName = \Ticket::getStatus($item->fields['status']);
      $text = "Chamado #{$item->fields['id']} mudou de status para \"$statusName\".";
   }
   if ($text === null) {
      return;
   }

   PluginChatglpiMessage::postSystemMessageForTicket((int) $item->fields['id'], $text, 'status');
}

// post_item_form roda logo depois do form de qualquer item ser desenhado -
// aqui só nos interessa quando é o form do Ticket, pra mostrar o computador/
// IP do solicitante junto da descrição (ver inc/vncconnect.class.php).
function plugin_chatglpi_post_item_form(array $params) {
   $item = $params['item'] ?? null;
   if (!($item instanceof \Ticket) || empty($item->fields['id'])) {
      return;
   }
   PluginChatglpiVncconnect::showInline((int) $item->fields['id']);
   plugin_chatglpi_show_start_chat_link($item);
}

// Botão "Iniciar chat com solicitante" logo abaixo da descrição - abre a
// DM no widget flutuante (js/chat.js::initFloatingChatWidget()), sem
// navegar pra lugar nenhum. Só aparece se tiver um solicitante
// identificado e ele não for o próprio usuário vendo o chamado (evita
// "iniciar chat com você mesmo" pro solicitante olhando o próprio
// chamado).
function plugin_chatglpi_show_start_chat_link(\Ticket $item): void {
   $ticketsId = (int) $item->fields['id'];
   global $DB;
   $requester = $DB->request([
      'SELECT' => ['users_id'],
      'FROM'   => 'glpi_tickets_users',
      'WHERE'  => ['tickets_id' => $ticketsId, 'type' => \CommonITILActor::REQUESTER, 'users_id' => ['>', 0]],
      'LIMIT'  => 1
   ])->current();
   if (!$requester) {
      return;
   }
   $requesterId = (int) $requester['users_id'];
   if ($requesterId === (int) \Session::getLoginUserID()) {
      return;
   }
   // O título vai junto pra virar a mensagem de apresentação ("Chamado
   // #123 'Título do chamado'") postada quando essa DM é vinculada ao
   // chamado pela primeira vez - ver glpi-backend/src/chat.js::
   // linkTicketToConversation(). ticketsId é o que permite o vínculo em
   // si (glpi_plugin_chatglpi_ticketconversations) - sem isso, as
   // mensagens de sistema de mudança de chamado nunca tinham pra qual
   // conversa ir, porque esse vínculo nunca era gravado em lugar nenhum
   // (só existia o SELECT, nunca o INSERT).
   $ticketTitle = $item->fields['name'] ?? '';
   // htmlspecialchars(ENT_QUOTES) sobre o JSON, não só o texto puro - o
   // atributo onclick é delimitado por aspas duplas, e json_encode()
   // também usa aspas duplas pra string; sem isso, um título com aspas
   // fecharia o atributo HTML no meio (o navegador decodifica as
   // entidades de volta pra aspas de verdade antes do JS rodar, então o
   // literal chega intacto).
   echo '<button type="button" class="btn btn-sm btn-outline-primary d-inline-flex align-items-center gap-1" style="margin:4px 0 8px;"'
      . ' onclick="chatglpiOpenFloatingChat(' . $requesterId . ', ' . $ticketsId . ', ' . htmlspecialchars(json_encode($ticketTitle), ENT_QUOTES) . ')">';
   echo '<i class="ti ti-message-circle"></i> Iniciar chat com solicitante';
   echo '</button>';
}

// Chamado recém-criado -> grava o computador que o agente local capturou na
// abertura (js/chat.js injetou os campos ocultos _chatglpi_hostname/ip/mac no
// form). Fica numa tabela própria, só-leitura pro usuário; exibido depois em
// showInline(). Só grava se veio algo (agente rodando na máquina de quem abriu).
function plugin_chatglpi_ticket_add(\CommonDBTM $item) {
   if (!($item instanceof \Ticket) || empty($item->fields['id'])) {
      return;
   }
   $input = $item->input ?? [];
   $hostname = trim((string) ($input['_chatglpi_hostname'] ?? ''));
   $ip = trim((string) ($input['_chatglpi_ip'] ?? ''));
   $mac = trim((string) ($input['_chatglpi_mac'] ?? ''));
   if ($hostname === '' && $ip === '' && $mac === '') {
      return;
   }
   global $DB;
   $DB->insert('glpi_plugin_chatglpi_ticketdevices', [
      'tickets_id' => (int) $item->fields['id'],
      // limita tamanho por segurança (campo vem do cliente, poderia ser adulterado)
      'hostname'   => mb_substr($hostname, 0, 255),
      'ip'         => mb_substr($ip, 0, 64),
      'mac'        => mb_substr($mac, 0, 64),
   ]);
}

// Card avulso "Acesso remoto" no dashboard nativo (Assistência > Chamados >
// "Adicionar novo item") - pra iniciar uma sessão noVNC sem precisar de
// chamado nenhum, digitando o hostname/IP direto. Ver setup.php pros dois
// hooks (dashboard_types + dashboard_cards) e a explicação de por que
// existem os dois.
function plugin_chatglpi_dashboard_types() {
   return [
      'chatglpi_remote_access' => [
         'label'    => 'Acesso remoto (Chat-GLPI)',
         'function' => 'plugin_chatglpi_dashboard_widget_remote_access',
         'width'    => 3,
         'height'   => 2,
      ],
   ];
}

function plugin_chatglpi_dashboard_cards() {
   return [
      'chatglpi_remote_access_card' => [
         'widgettype' => ['chatglpi_remote_access'],
         'label'      => 'Acesso remoto (Chat-GLPI)',
         'group'      => 'Outros',
         'provider'   => 'plugin_chatglpi_dashboard_remote_provider',
         // O HTML deste card embute um token de autenticação (inc/
         // authtoken.php) mintado pro usuário QUE ESTÁ VENDO o dashboard
         // agora. O cache padrão do GLPI (Glpi\Dashboard\Grid::getCardHtml,
         // ~40s) é compartilhado por QUALQUER usuário que abrir o mesmo
         // dashboard/entidade/idioma nessa janela - com cache ligado, o
         // token do primeiro técnico vazaria pro navegador do segundo.
         // Card sem dado nenhum pra mostrar (só um formulário) não ganha
         // nada com cache mesmo, então desligar é estritamente melhor.
         'cache'      => false,
      ],
   ];
}

// Provider não busca dado nenhum - o card é só um formulário. Ainda assim
// GLPI exige a chave 'provider' apontando pra algo chamável quando o card
// tem 'provider' definido (ver Grid::getCardHtml()); devolver vazio é
// suficiente, os $params do form vêm todos de dentro da própria função de
// renderização do widget.
function plugin_chatglpi_dashboard_remote_provider($params = []) {
   return [];
}

function plugin_chatglpi_dashboard_widget_remote_access($params = []) {
   include_once __DIR__ . '/inc/authtoken.php';
   $myId = (int) \Session::getLoginUserID();
   $me = new \User();
   $me->getFromDB($myId);
   $myName = $me->fields['name'] ?? '';
   $token = plugin_chatglpi_mint_token($myId, $myName, '');

   // Sufixo aleatório pros ids ficarem únicos mesmo se o técnico adicionar
   // esse card mais de uma vez no mesmo dashboard.
   $uid = 'chatglpi-remote-' . bin2hex(random_bytes(4));

   // A cor escolhida em "Editar cartão" chega aqui em $params['color']
   // (Grid::getCardHtml() mescla as opções salvas do card nos argumentos
   // do widget antes de chamar esta função) - sem ler isso o botão
   // "Atualizar" da edição nunca tinha efeito nenhum. Mesmo padrão do
   // widget "markdown" do core: fundo na cor escolhida, texto e borda
   // ajustados pra continuar legíveis (Toolbox::getFgColor cuida do
   // contraste sozinho, clareando ou escurecendo conforme a luminância).
   $color = $params['color'] ?? '#2d3d53';
   $fgColor = \Toolbox::getFgColor($color);
   $borderColor = \Toolbox::getFgColor($color, 10);

   ob_start();
   ?>
   <div class="card chatglpi-remote-dashboard"
        data-api-base="<?php echo htmlspecialchars(PLUGIN_CHATGLPI_BACKEND_URL, ENT_QUOTES); ?>"
        data-auth-token="<?php echo htmlspecialchars($token, ENT_QUOTES); ?>"
        style="background-color: <?php echo htmlspecialchars($color, ENT_QUOTES); ?>;
               color: <?php echo htmlspecialchars($fgColor, ENT_QUOTES); ?>;
               border-color: <?php echo htmlspecialchars($borderColor, ENT_QUOTES); ?>;
               padding:14px;height:100%;box-sizing:border-box;overflow:auto;">
      <div style="font-weight:600;margin-bottom:10px;">Acesso remoto</div>
      <input type="text" id="<?php echo $uid; ?>-host" class="form-control form-control-sm chatglpi-remote-host-input"
             list="<?php echo $uid; ?>-history" autocomplete="off"
             placeholder="Hostname ou IP da máquina" style="margin-bottom:8px;">
      <datalist id="<?php echo $uid; ?>-history"></datalist>
      <button type="button" id="<?php echo $uid; ?>-button" class="btn btn-primary btn-sm"
              onclick="chatglpiStartRemoteSessionStandalone('<?php echo $uid; ?>')">Acessar remotamente</button>
      <div id="<?php echo $uid; ?>-error" style="color:#e74c3c;font-size:12px;margin-top:8px;display:none;"></div>
   </div>
   <?php
   return ob_get_clean();
}

// Novo acompanhamento (ITILFollowup) num chamado -> mensagem de sistema nas
// conversas vinculadas a esse chamado.
function plugin_chatglpi_followup_add(\CommonDBTM $item) {
   if (!($item instanceof \ITILFollowup) || $item->fields['itemtype'] !== 'Ticket') {
      return;
   }
   $ticketsId = (int) $item->fields['items_id'];
   $content = trim(strip_tags($item->fields['content'] ?? ''));
   if ($content === '') {
      return;
   }
   $preview = mb_strlen($content) > 140 ? mb_substr($content, 0, 140) . '…' : $content;
   PluginChatglpiMessage::postSystemMessageForTicket(
      $ticketsId,
      "Novo acompanhamento no chamado #{$ticketsId}: {$preview}",
      'followup'
   );
}
