<?php
/**
 * Serve o service worker (pwa/sw.js) por aqui em vez de direto - só pra
 * poder mandar o header Service-Worker-Allowed, que é o que permite o
 * escopo do registro (ver js/chat.js, navigator.serviceWorker.register())
 * cobrir o GLPI INTEIRO (/glpi/), não só a pasta deste plugin (onde o
 * arquivo físico mora) - sem esse header, o navegador rejeita qualquer
 * escopo fora de plugins/chatglpi/.
 *
 * Sem bootstrap do GLPI (includes.php) de propósito - não precisa de
 * sessão nem toca no banco, é só um repasse de arquivo estático; incluir
 * o bootstrap inteiro só pra isso seria peso à toa, e exigir login
 * quebraria o registro do SW rodando a partir da própria tela de login.
 */
header('Content-Type: application/javascript; charset=utf-8');
header('Service-Worker-Allowed: /glpi/');
header('Cache-Control: no-cache');
readfile(__DIR__ . '/../pwa/sw.js');
