<?php
/**
 * Chat-GLPI - chat interno entre usuários do GLPI + acesso remoto (VNC)
 * com preenchimento automático de host/IP a partir do computador vinculado
 * ao chamado.
 *
 * Portado do app standalone Node/React "glpi-chat-proto" - ver
 * frontend/src/components/ChatPanel.jsx e backend/src/chatStore.js no
 * mesmo repositório para a versão original que este plugin substitui.
 */

define('PLUGIN_CHATGLPI_VERSION', '1.17.0');
define('PLUGIN_CHATGLPI_MIN_GLPI', '10.0');
define('PLUGIN_CHATGLPI_MAX_GLPI', '10.0.99');

// Backend de chat rodando fora deste servidor (VM dedicada 192.0.2.20) -
// só assets/aba/token ficam aqui; mensagens/DMs/tempo real são resolvidos
// lá, pra não competir por recurso com o GLPI compartilhado. Mesmo segredo
// configurado em CHATGLPI_SHARED_SECRET no .env do backend Node.
//
// IMPORTANTE: quem chama esse endereço é o NAVEGADOR do técnico (não este
// servidor) - por isso vai pela porta 443 do nginx da VM (já liberada pra
// rede toda dos PCs clientes, é a mesma porta que o app standalone antigo
// sempre usou) e não pela porta 4001 direta do Node, que só o servidor do
// GLPI conseguia alcançar (bloqueada por algum firewall de rede entre as
// VLANs dos PCs clientes e a VM do chat - já caímos nesse erro uma vez).
define('PLUGIN_CHATGLPI_BACKEND_URL', 'https://chat.example.local/chatglpi-api');

define('PLUGIN_CHATGLPI_SHARED_SECRET', 'CHANGE_ME_generate_64_hex_chars_openssl_rand_hex_32');

// Token que o agente local usa pra registrar presença (ajax/agentcheckin.php);
// mesmo valor embutido no instalar-agente.ps1. Não protege nada sensível -
// só evita que qualquer um pope lixo na tabela de auditoria.
define('PLUGIN_CHATGLPI_AGENT_CHECKIN_TOKEN', 'CHANGE_ME_checkin_token');

// Senha padrão do UltraVNC nas máquinas do domínio (mesma pra todas, definida
// via GPO na instalação do UltraVNC Server) - só um ponto de partida na aba
// "Acesso remoto"; o técnico ainda pode trocar antes de clicar em Conectar
// se alguma máquina tiver senha diferente.
define('PLUGIN_CHATGLPI_VNC_DEFAULT_PASSWORD', 'CHANGE_ME_vnc_password');

function plugin_init_chatglpi() {
   global $PLUGIN_HOOKS, $CFG_GLPI;

   $PLUGIN_HOOKS['csrf_compliant']['chatglpi'] = true;

   // Contorna um bug no DbUtils::getItemTypeForTable() do GLPI: ele faz
   // `str_replace("glpi_", "", $table)` pra tirar o prefixo da tabela, mas
   // isso remove QUALQUER ocorrência de "glpi_" na string, não só o
   // prefixo - como nosso plugin se chama "chatglpi", a tabela
   // "glpi_plugin_chatglpi_agentcheckins" vira "plugin_chatagentcheckins"
   // (o "glpi_" de "chatglpi_" também some), quebrando a detecção
   // automática da classe. Pré-registrar aqui faz o GLPI usar direto esse
   // mapeamento (é a primeira coisa que a função checa) sem tentar
   // adivinhar - ver inc/agentcheckin.class.php.
   $CFG_GLPI['glpiitemtypetables']['glpi_plugin_chatglpi_agentcheckins'] = 'PluginChatglpiAgentcheckin';
   $CFG_GLPI['glpitablesitemtype']['PluginChatglpiAgentcheckin'] = 'glpi_plugin_chatglpi_agentcheckins';

   // Aba de acesso remoto no chamado - resolve o computador vinculado e
   // preenche host/IP/MAC sozinho (inc/vncconnect.class.php).
   Plugin::registerClass('PluginChatglpiVncconnect', [
      'addtabon' => ['Ticket']
   ]);

   // Entrada no menu "Plug-ins" do GLPI - chat em tela cheia
   // (front/chat.php) + painel de auditoria dos agentes locais
   // (front/agents.php), ver inc/chat.class.php::getMenuContent().
   $PLUGIN_HOOKS['menu_toadd']['chatglpi'] = ['plugins' => 'PluginChatglpiChat'];

   // Mensagem de sistema no chat sempre que um chamado vinculado muda de
   // status ou recebe um acompanhamento - ver inc/message.class.php::
   // notifyTicketUpdate() e as chamadas em hook.php.
   $PLUGIN_HOOKS['item_update']['chatglpi'] = ['Ticket' => 'plugin_chatglpi_ticket_update'];
   $PLUGIN_HOOKS['item_add']['chatglpi'] = [
      'ITILFollowup' => 'plugin_chatglpi_followup_add',
      // Grava o computador capturado do agente na abertura do chamado.
      'Ticket'       => 'plugin_chatglpi_ticket_add',
   ];

   // Mostra computador/IP/MAC do solicitante logo abaixo da descrição do
   // chamado (além da aba "Acesso remoto" já existente) - ver
   // inc/vncconnect.class.php::showInline().
   $PLUGIN_HOOKS['post_item_form']['chatglpi'] = 'plugin_chatglpi_post_item_form';

   // Card avulso "Acesso remoto" addable no dashboard nativo (Assistência >
   // Chamados > "Adicionar novo item") - pra quem quer acessar uma máquina
   // sem precisar abrir/estar num chamado. Dois hooks: dashboard_types
   // registra o TIPO de widget (com sua própria função de renderização,
   // igual "pie"/"bar"/"markdown" do core - ver Glpi\Dashboard\Widget::
   // getAllTypes()), dashboard_cards registra o CARD que usa esse tipo (ver
   // Glpi\Dashboard\Grid::getAllDasboardCards()). Os dois só existem juntos
   // porque o card sozinho não teria pra qual widgettype apontar.
   $PLUGIN_HOOKS['dashboard_types']['chatglpi'] = 'plugin_chatglpi_dashboard_types';
   $PLUGIN_HOOKS['dashboard_cards']['chatglpi'] = 'plugin_chatglpi_dashboard_cards';

   // Sempre registrado (não só quando já há sessão) - checar $_SESSION aqui
   // era pouco confiável porque plugin_init roda cedo no bootstrap do GLPI,
   // antes da sessão estar totalmente disponível em toda página; isso fazia
   // o CSS/JS às vezes não carregar (tela sem estilo nenhum). A tela do
   // chat em si continua exigindo login normalmente (Session::checkLoginUser()
   // em front/chat.php e em cada endpoint de ajax/).
   // IMPORTANTE: o GLPI checa se o caminho passado aqui existe como
   // arquivo de verdade no disco (file_exists) - colocar "?v=..." direto
   // no caminho quebra isso ("chat.js?v=123" não existe como arquivo),
   // gerando um aviso em TODA página do GLPI, não só na nossa. O caminho
   // tem que ser sempre só o caminho puro do arquivo.
   $PLUGIN_HOOKS['add_javascript']['chatglpi'] = ['js/chat.js'];
   $PLUGIN_HOOKS['add_css']['chatglpi'] = ['css/chat.css'];
}

function plugin_version_chatglpi() {
   return [
      'name'           => 'Chat-GLPI',
      'version'        => PLUGIN_CHATGLPI_VERSION,
      'author'         => 'Equipe de TI',
      'license'        => 'GPLv2+',
      'homepage'       => '',
      'requirements'   => [
         'glpi' => [
            'min' => PLUGIN_CHATGLPI_MIN_GLPI,
            'max' => PLUGIN_CHATGLPI_MAX_GLPI
         ]
      ]
   ];
}

function plugin_chatglpi_check_prerequisites() {
   return true;
}

function plugin_chatglpi_check_config($verbose = false) {
   return true;
}
