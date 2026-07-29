# Chat-GLPI Agent

Serviço Windows leve (Go), instalado silenciosamente via GPO em todos os
computadores do domínio. Expõe nome do computador, IP e MAC address em
`http://127.0.0.1:47821/info`, para que o Chat-GLPI (rodando no navegador do
usuário) anexe essas informações automaticamente ao final da descrição de um
chamado novo criado pelo Assistente GLPI.

Roda só em loopback (127.0.0.1) - não é acessível pela rede, apenas pelo
navegador que estiver rodando na mesma máquina.

## Build

Requer Go 1.21+. A partir da pasta `agent/`:

```
GOOS=windows GOARCH=amd64 go build -buildvcs=false -ldflags="-H=windowsgui -s -w" -o deploy/agent.exe .
```

- `-H=windowsgui` evita que uma janela de console apareça ao iniciar/instalar.
- `-s -w` reduz o tamanho do binário (remove símbolos de debug).

O executável final fica em `deploy/agent.exe`, pronto para distribuir junto
com `deploy/install-agent.ps1`.

## Testar localmente (sem instalar serviço)

```
agent.exe run-console
```

Depois acesse `http://127.0.0.1:47821/info` no navegador ou `curl` para
conferir o JSON retornado.

## Instalar/remover o serviço manualmente

```
agent.exe install     # cria e inicia o serviço "ChatGLPIAgent"
agent.exe uninstall   # para e remove o serviço
```

(Precisa rodar com privilégios de administrador.)

## Deploy via GPO (Startup Script)

1. Compile `agent.exe` (veja acima) e copie para uma pasta junto com
   `deploy/install-agent.ps1`, por exemplo em um compartilhamento acessível
   pelos computadores do domínio: `\\dominio\netlogon\ChatGLPIAgent\`.
2. No **Group Policy Management Console**, edite (ou crie) uma GPO vinculada
   à OU dos computadores desejados.
3. Vá em **Computer Configuration → Policies → Windows Settings → Scripts
   (Startup/Shutdown) → Startup → PowerShell Scripts** e adicione
   `install-agent.ps1` (aponte para o caminho do compartilhamento).
4. Os computadores instalam o serviço automaticamente no próximo boot
   (o script roda como SYSTEM, então não pede nenhuma interação do usuário).

O script (`install-agent.ps1`) é idempotente: em reboots seguintes, se o
serviço já estiver instalado com o mesmo binário, ele só garante que está
rodando - não reinstala. Para atualizar o agente numa máquina, basta trocar o
`agent.exe` no compartilhamento; o script detecta a mudança de hash e
reinstala o serviço automaticamente.

Para desinstalar de todas as máquinas, use `deploy/uninstall-agent.ps1` da
mesma forma (como Startup Script) e depois remova a GPO.

## Como o Chat-GLPI usa isso

O frontend (`frontend/src/deviceAgent.js`) tenta buscar
`http://127.0.0.1:47821/info` com um timeout curto (800ms) sempre que o
usuário está prestes a criar um chamado pelo Assistente GLPI. Se o agente
não estiver instalado/rodando naquela máquina (ex.: acesso de fora da rede,
notebook pessoal, etc.), a busca falha silenciosamente e o chamado é criado
normalmente, sem os dados do computador.
