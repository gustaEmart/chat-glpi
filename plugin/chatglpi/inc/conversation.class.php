<?php
/**
 * Só o que ainda roda localmente no GLPI depois de mover mensagens/DMs/
 * tempo real pro backend Node da VM dedicada (ver glpi-backend/src/chat.js,
 * que tem a versão completa desta classe pro que passou a rodar lá) -
 * aqui sobra só o necessário pro hook nativo de "chamado mudou -> mensagem
 * de sistema" (hook.php) e pro token da página do chat (front/chat.php).
 */
class PluginChatglpiConversation {

   public static function conversationsLinkedToTicket(int $ticketsId): array {
      global $DB;
      $rows = iterator_to_array($DB->request([
         'SELECT' => ['conversations_id'],
         'FROM'   => 'glpi_plugin_chatglpi_ticketconversations',
         'WHERE'  => ['tickets_id' => $ticketsId]
      ]));
      return array_map(fn($r) => (int) $r['conversations_id'], $rows);
   }

   public static function initialsOf(User $user): string {
      $name = trim(($user->fields['firstname'] ?? '') . ' ' . ($user->fields['realname'] ?? ''));
      if ($name === '') $name = $user->fields['name'];
      $parts = preg_split('/[.\s]+/', $name, -1, PREG_SPLIT_NO_EMPTY);
      $initials = '';
      foreach (array_slice($parts, 0, 2) as $p) {
         $initials .= mb_strtoupper(mb_substr($p, 0, 1));
      }
      return $initials;
   }
}

// User::getFriendlyName() já existe nativamente no GLPI - helper local só
// pra deixar explícito o formato usado (nome + sobrenome, com fallback pro
// login). Prefixado (plugin_chatglpi_...) porque o GLPI já tem uma função
// global "formatUserName()" própria em inc/db.function.php - reusar o mesmo
// nome causava "Cannot redeclare formatUserName()" (fatal error) em toda
// requisição que carregasse esta classe.
function plugin_chatglpi_format_user_name(int $id, string $login, string $realname, string $firstname): string {
   $name = trim($firstname . ' ' . $realname);
   return $name !== '' ? $name : $login;
}
