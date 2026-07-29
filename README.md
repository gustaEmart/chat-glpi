# Chat-GLPI

Plugin nativo do [GLPI](https://glpi-project.org/) que adiciona chat interno
entre usuários e acesso remoto (VNC via navegador, sem cliente instalado) às
telas de chamado — pensado pra times de TI que já usam o GLPI como central de
atendimento e querem conversar com quem abriu o chamado e acessar a máquina
dele sem sair da própria tela do GLPI.

## O que tem aqui

- **Chat interno** entre usuários do GLPI — DMs reais, tempo real (poll
  curto), vinculado a chamados (mudança de status/acompanhamento vira
  mensagem de sistema na conversa), com resposta a mensagem, busca de
  pessoa com indicador de online/offline, e um widget flutuante disponível
  em qualquer tela do GLPI.
- **Acesso remoto via navegador** (noVNC/websockify) direto da aba do
  chamado, com preenchimento automático de host/IP/MAC a partir do
  computador vinculado, e um **chat próprio durante a sessão** — aparece
  como um balão na tela de quem está sendo atendido (uma janela nativa
  separada, renderizada com WebView2/Edge) e um painel espelhado do lado
  do técnico, com a conversa anexada como acompanhamento do chamado quando
  a sessão termina.
- **Agente leve para Windows** (Go), instalado via GPO em todos os
  computadores do domínio: expõe hostname/IP/MAC pro GLPI preencher
  sozinho ao abrir um chamado, e mostra o balão de chat acima quando
  alguém está sendo atendido remotamente.
- **Progressive Web App**: o GLPI vira instalável no Android (Chrome) como
  qualquer app nativo.

## Arquitetura

O plugin GLPI (`plugin/chatglpi/`) é **fino de propósito** — só assets,
UI e uma ponte de autenticação. Toda a lógica de chat/DM/acesso remoto
roda num backend Node **separado** (`glpi-backend/`), pensado pra não
competir por recurso com o GLPI compartilhado (pode rodar numa VM
dedicada). A ponte entre os dois é um token HMAC assinado pelo plugin PHP
e validado pelo Node (`inc/authtoken.php` / `glpi-backend/src/auth.js`) —
a sessão do GLPI nunca atravessa pra fora do próprio GLPI.

```
plugin/chatglpi/       Plugin GLPI (PHP) - UI, hooks, ponte de autenticação
  ajax/                Endpoints chamados pelo JS do plugin
  inc/                 Classes PHP (aba de acesso remoto, mensagens de sistema)
  js/ css/             Frontend do chat (vanilla JS, sem build)
  pwa/                 Manifest + service worker (instalável no Android)

glpi-backend/          Backend Node (Express) - roda fora do GLPI
  src/                 Chat, sessões de acesso remoto, auth
  remote-web/          Página do acesso remoto (noVNC embutido)

agent/                 Agente Windows (Go), instalado via GPO
  chatwindow/           Balão de chat mostrado na tela de quem é atendido
                        (WebView2) - processo separado do serviço
  deploy/               Scripts de instalação/GPO

deploy/                Configuração de infraestrutura (systemd, script do
                        agente legado de VNC via cliente nativo)
```

## Configuração

Nenhum segredo real está neste repositório — os valores abaixo (todos
começando com `CHANGE_ME` ou usando IPs de exemplo `192.0.2.x`/
`glpi.example.com`) precisam ser substituídos pelos seus antes de rodar
qualquer coisa:

| Onde | O quê |
|---|---|
| `plugin/chatglpi/setup.php` | `PLUGIN_CHATGLPI_BACKEND_URL`, `PLUGIN_CHATGLPI_SHARED_SECRET`, `PLUGIN_CHATGLPI_AGENT_CHECKIN_TOKEN`, `PLUGIN_CHATGLPI_VNC_DEFAULT_PASSWORD` |
| `glpi-backend/.env.example` | Copie para `.env` e preencha `DB_HOST`, `DB_USER`, `DB_PASSWORD`, `CHATGLPI_SHARED_SECRET` (mesmo valor do setup.php acima), `ALLOWED_ORIGIN` |
| `agent/main.go` | `checkinURL`, `checkinToken`, `messageToken`, `backendReplyURL` (constantes no topo do arquivo - recompile depois de ajustar) |
| `agent/chatwindow/main.go` | URLs padrão de `-reply`/`-poll` (mesmo host do agente) |
| `deploy/instalar-agente.ps1` | `AllowedOrigins`, `SharedToken`, `CheckinUrl` (agente legado de lançamento de cliente VNC nativo) |

Gere o segredo compartilhado com `openssl rand -hex 32` (precisa ser
**idêntico** em `setup.php` e no `.env` do backend).

## Banco de dados

O plugin cria suas próprias tabelas (`glpi_plugin_chatglpi_*`) dentro do
banco do GLPI na instalação (`hook.php::plugin_chatglpi_install()`).
Recomendado criar um usuário MySQL **restrito**, só com acesso a essas
tabelas, para o backend Node usar (ele nunca precisa de acesso ao resto
do GLPI):

```sql
CREATE USER 'chatglpi_svc'@'%' IDENTIFIED BY 'sua-senha-forte-aqui';
GRANT SELECT, INSERT, UPDATE, DELETE ON glpi.glpi_plugin_chatglpi_%
  TO 'chatglpi_svc'@'%';
```

## Instalação (resumo)

1. **Plugin**: copie `plugin/chatglpi/` para `plugins/chatglpi/` do GLPI,
   ajuste `setup.php` (ver tabela acima), instale e ative pela tela de
   Plugins do GLPI (ou `php bin/console plugin:install -u <admin> chatglpi
   && php bin/console plugin:activate chatglpi`).
2. **Backend**: `cd glpi-backend && npm install`, configure `.env`, rode
   com um gerenciador de processo (`systemd`, `pm2`) apontando pra
   `src/server.js`.
3. **noVNC + websockify**: instale o [noVNC](https://github.com/novnc/noVNC)
   em `remote-web/` (ou ajuste o caminho), e o
   [websockify](https://github.com/novnc/websockify) como serviço (ver
   `deploy/websockify.service`) — ele lê/escreve o arquivo de tokens que o
   backend Node gera (`glpi-backend/src/remote.js`).
4. **Agente**: compile com `GOOS=windows GOARCH=amd64 go build` (ver
   `agent/README.md`) e distribua via GPO Startup Script
   (`agent/deploy/install-agent.ps1`) - instala como serviço do Windows,
   se atualiza sozinho quando o binário no compartilhamento muda.
5. **Certificado TLS**: o backend Node espera HTTPS na frente (nginx ou
   similar) - um certificado autoassinado funciona para uso interno, mas
   **bloqueia a instalação como PWA** (Service Worker exige um certificado
   de verdade). Veja a seção sobre isso mais abaixo se quiser o app
   instalável no Android.

## Requisitos

- GLPI 10.x
- Node.js 18+ (backend)
- Go 1.21+ (agente, só se for recompilar)
- MySQL/MariaDB (o mesmo do GLPI)
- Windows 10/11 nas máquinas onde o agente roda (WebView2 já vem
  instalado de fábrica)
