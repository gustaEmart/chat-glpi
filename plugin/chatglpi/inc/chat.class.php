<?php
// Classe de registro do menu (Plug-ins -> Chat-GLPI) - GLPI espera uma
// classe com getMenuContent() estático. "options" registra os dois itens
// que aparecem dentro do menu Chat-GLPI: o chat em si e o painel de
// auditoria dos agentes locais (front/agents.php, só pra quem tem direito
// de configuração - ver checagem dentro do próprio arquivo).
class PluginChatglpiChat {

   public static function getMenuName() {
      return 'Chat-GLPI';
   }

   public static function getMenuContent() {
      $menu = [
         'title'   => 'Chat-GLPI',
         'page'    => '/plugins/chatglpi/front/chat.php',
         'icon'    => 'fas fa-comments',
         'options' => [
            'chat' => [
               'title' => 'Chat',
               'page'  => '/plugins/chatglpi/front/chat.php',
               'icon'  => 'fas fa-comments',
            ],
         ],
      ];
      // "config" nem sempre está no perfil de quem administra de fato aqui
      // (confirmado: perfil "Admin" desta instância não tem esse direito) -
      // interface "central" (o oposto de "helpdesk"/self-service) já separa
      // staff/técnico de usuário comum, que é o que importa pra essa aba.
      if (($_SESSION['glpiactiveprofile']['interface'] ?? '') === 'central') {
         $menu['options']['agents'] = [
            'title' => 'Agentes conectados',
            'page'  => '/plugins/chatglpi/front/agents.php',
            'icon'  => 'fas fa-desktop',
         ];
      }
      return $menu;
   }
}
