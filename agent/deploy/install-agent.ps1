# Chat-GLPI Agent - script de instalação silenciosa via GPO (Startup Script,
# rodando como SYSTEM, no contexto de Computador).
#
# Como configurar no GPO:
#   1. Coloque agent.exe e install-agent.ps1 na mesma pasta em um compartilhamento
#      acessível pelos computadores do domínio (ex.: \\dominio\netlogon\ChatGLPIAgent\).
#   2. Group Policy Management > (GPO) > Computer Configuration > Policies >
#      Windows Settings > Scripts (Startup/Shutdown) > Startup > PowerShell Scripts
#      > adicionar install-agent.ps1.
#   3. O script é idempotente: se o serviço já estiver instalado e atualizado,
#      não faz nada; ao aplicar a GPO novamente (reboot) ele so reinstala se
#      a versão do agent.exe mudou.
#   4. Também garante a regra de firewall da porta 47823 (mensagem de acesso
#      remoto) - nada a configurar à parte na GPO pra isso.

$ErrorActionPreference = 'Stop'

$serviceName = 'ChatGLPIAgent'
$installDir  = Join-Path $env:ProgramFiles 'ChatGLPIAgent'
$targetExe   = Join-Path $installDir 'agent.exe'
$sourceExe   = Join-Path $PSScriptRoot 'agent.exe'
# Janela de chat do acesso remoto (agent/chatwindow/main.go) - o serviço
# espera achar isso do LADO do agent.exe (mesma pasta, ver launchChatWindow()
# em main.go) pra conseguir lançar na sessão do usuário quando necessário.
$targetChatWindowExe = Join-Path $installDir 'chatwindow.exe'
$sourceChatWindowExe = Join-Path $PSScriptRoot 'chatwindow.exe'

function Get-FileHashSafe($path) {
    if (Test-Path $path) { return (Get-FileHash -Path $path -Algorithm SHA256).Hash }
    return $null
}

# Mata qualquer chatwindow.exe rodando ANTES de qualquer coisa. Dois
# motivos: (1) Copy-Item falha se o .exe estiver em uso, deixando a
# máquina numa versão antiga silenciosamente; (2) um processo de versão
# antiga sobrevivente fica segurando a porta 47825 e o chat para de
# funcionar sem erro visível. O agente relança sozinho quando precisar
# (ver launchChatWindow() em main.go).
Get-Process -Name chatwindow -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue

$existingService = Get-Service -Name $serviceName -ErrorAction SilentlyContinue
$needsInstall = $true

if ($existingService -and (Get-FileHashSafe $targetExe) -eq (Get-FileHashSafe $sourceExe)) {
    # Já instalado e com o mesmo binário: só garante que está rodando.
    $needsInstall = $false
    if ($existingService.Status -ne 'Running') {
        Start-Service -Name $serviceName
    }
}

if ($needsInstall) {
    if ($existingService) {
        & $targetExe uninstall 2>$null
        Start-Sleep -Seconds 2
    }

    New-Item -ItemType Directory -Path $installDir -Force | Out-Null
    Copy-Item -Path $sourceExe -Destination $targetExe -Force

    & $targetExe install
}

# chatwindow.exe não é serviço (é lançado sob demanda, na sessão do
# usuário, pelo próprio agent.exe) - só precisa estar presente e
# atualizado, sem parar/reinstalar nada.
if ((Get-FileHashSafe $targetChatWindowExe) -ne (Get-FileHashSafe $sourceChatWindowExe)) {
    Copy-Item -Path $sourceChatWindowExe -Destination $targetChatWindowExe -Force
}

# Regra de firewall pros endpoints de rede do acesso remoto (agent/main.go -
# /chat/open, /chat/send, /chat/close -, porta 47823; diferente do /info em
# 47821, que só ouve em loopback e não precisa de regra nenhuma). Sem isso,
# o backend Node (VM 192.0.2.20) não consegue alcançar esta máquina pela
# rede e o chat falha silenciosamente - a sessão de acesso remoto/VNC em si
# não é afetada. Idempotente (Get-NetFirewallRule primeiro) - roda em todo
# boot junto com o resto deste script, sem precisar mexer na GPO à parte.
$firewallRuleName = 'Chat-GLPI Agent - Mensagem de acesso remoto'
if (-not (Get-NetFirewallRule -DisplayName $firewallRuleName -ErrorAction SilentlyContinue)) {
    New-NetFirewallRule -DisplayName $firewallRuleName `
        -Direction Inbound `
        -Protocol TCP `
        -LocalPort 47823 `
        -RemoteAddress 192.0.2.20 `
        -Action Allow `
        -Profile Domain | Out-Null
}
