# Remove o Chat-GLPI Agent (serviço + arquivos). Rodar como GPO Startup Script
# ou manualmente com privilégios de administrador.

$ErrorActionPreference = 'SilentlyContinue'

$serviceName = 'ChatGLPIAgent'
$installDir  = Join-Path $env:ProgramFiles 'ChatGLPIAgent'
$targetExe   = Join-Path $installDir 'agent.exe'

if (Get-Service -Name $serviceName -ErrorAction SilentlyContinue) {
    & $targetExe uninstall
    Start-Sleep -Seconds 2
}

Remove-Item -Path $installDir -Recurse -Force -ErrorAction SilentlyContinue
