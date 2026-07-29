<?php
/**
 * Existe só pra dar nome de classe GLPI à tabela
 * glpi_plugin_chatglpi_agentcheckins (convenção do GLPI: toda tabela
 * referenciada numa search option "specific" precisa de uma classe
 * CommonDBTM correspondente, senão Search::giveItem() não tem onde chamar
 * getSpecificValueToDisplay() - ver hook.php::plugin_chatglpi_
 * getAddSearchOptionsNew() e o botão de coluna na lista de Computadores.
 */
class PluginChatglpiAgentcheckin extends CommonDBTM {

   // Renderiza o botão "Conectar" na coluna adicionada à busca de
   // Computadores - só aparece se o agente deu sinal recente (mesma janela
   // de 2h do painel front/agents.php). "hostname" vem via
   // 'additionalfields' da search option (ver hook.php).
   public static function getSpecificValueToDisplay($field, $values, array $options = []) {
      if (!is_array($values)) {
         return parent::getSpecificValueToDisplay($field, $values, $options);
      }
      if ($field === 'last_seen') {
         $lastSeen = $values['last_seen'] ?? '';
         $hostname = $values['hostname'] ?? '';
         if ($lastSeen === '' || $hostname === '') {
            return '';
         }
         $active = (time() - strtotime($lastSeen)) <= 2 * 3600;
         if (!$active) {
            return '<span class="text-muted small">sem sinal recente</span>';
         }
         return '<button type="button" class="btn btn-sm btn-outline-primary" '
            . 'onclick="chatglpiConnectFromAgentsPanel(\'' . htmlspecialchars($hostname, ENT_QUOTES) . '\')">'
            . 'Conectar</button>';
      }
      return parent::getSpecificValueToDisplay($field, $values, $options);
   }
}
