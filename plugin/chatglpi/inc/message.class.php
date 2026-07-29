<?php
/**
 * Só o que ainda roda localmente no GLPI depois de mover mensagens/DMs/
 * tempo real pro backend Node da VM dedicada (ver glpi-backend/src/chat.js
 * pra versão completa) - aqui sobra só a mensagem de sistema disparada
 * pelo hook nativo de chamado (hook.php), que é uma escrita direta e
 * barata na mesma tabela, sem precisar de round-trip pro backend remoto.
 */
class PluginChatglpiMessage {

   public static function postSystemMessageForTicket(int $ticketsId, string $text, string $variant): void {
      $conversationIds = PluginChatglpiConversation::conversationsLinkedToTicket($ticketsId);
      if (empty($conversationIds)) {
         return; // nenhuma conversa vinculada ainda - nada a notificar
      }
      global $DB;
      foreach ($conversationIds as $convId) {
         $DB->insert('glpi_plugin_chatglpi_messages', [
            'conversations_id' => $convId,
            'users_id'         => null,
            'author_name'      => 'Sistema',
            'is_system'        => 1,
            'content'          => $text,
            'variant'          => $variant,
            'date_creation'    => date('Y-m-d H:i:s'),
         ]);
      }
   }
}
