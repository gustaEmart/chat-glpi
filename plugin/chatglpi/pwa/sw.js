// Service worker mínimo, só pra satisfazer o critério de "instalável"
// do Chrome/Android (exige um SW registrado com handler de fetch) - sem
// cache offline de propósito: o GLPI é todo dinâmico (sessão, CSRF token
// por página), cachear indiscriminadamente ia quebrar mais do que ajudar.
// Servido via ajax/sw.php (não direto) pra poder mandar o header
// Service-Worker-Allowed e o escopo cobrir o GLPI inteiro (/glpi/), não só
// a pasta deste plugin.
self.addEventListener('install', () => {
   self.skipWaiting();
});

self.addEventListener('activate', event => {
   event.waitUntil(self.clients.claim());
});

self.addEventListener('fetch', event => {
   event.respondWith(fetch(event.request));
});
