<?php
/**
 * Ponte de autenticação entre a sessão nativa do GLPI e o backend Node
 * remoto (VM 192.0.2.20) - ver [[project_serverwatch]] / decisão de mover
 * a lógica de chat pra fora do servidor compartilhado do GLPI.
 *
 * O GLPI mesmo não expõe sessão pra outro host (cookie de sessão é
 * daquele domínio só), então em vez disso a página front/chat.php assina
 * um token curto (HMAC-SHA256) com o usuário já autenticado e manda pro
 * JS, que anexa em cada chamada ao backend remoto. O Node valida a
 * assinatura com o MESMO segredo (variável de ambiente CHATGLPI_SHARED_SECRET
 * no servidor Node) - nunca confia no uid sozinho.
 */

function plugin_chatglpi_base64url_encode(string $data): string {
   return rtrim(strtr(base64_encode($data), '+/', '-_'), '=');
}

// Gera o token pro usuário logado atualmente - válido por 12h (um turno de
// trabalho), renovado sozinho a cada F5/reabertura da página do chat.
function plugin_chatglpi_mint_token(int $userId, string $name, string $initials): string {
   $payload = json_encode([
      'uid'      => $userId,
      'name'     => $name,
      'initials' => $initials,
      'exp'      => time() + 12 * 3600,
   ]);
   $payloadB64 = plugin_chatglpi_base64url_encode($payload);
   $sig = plugin_chatglpi_base64url_encode(hash_hmac('sha256', $payloadB64, PLUGIN_CHATGLPI_SHARED_SECRET, true));
   return $payloadB64 . '.' . $sig;
}
