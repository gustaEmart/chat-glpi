# Instalador do Agente de Acesso Remoto do Chat-GLPI (rodar UMA vez em cada
# PC do TI, como o proprio usuario tecnico - nao precisa de admin).
#
# O agente e um executavel pequeno que fica rodando em segundo plano,
# ouvindo em http://127.0.0.1:47652. O botao "Conectar" no Chat-GLPI chama
# esse endereco local pra abrir o UltraVNC Viewer - sem depender de nenhum
# protocolo customizado do navegador (o Edge gerenciado por politica desta
# rede bloqueia isso silenciosamente, mesmo com GPO configurada).
#
# Uso:  powershell -ExecutionPolicy Bypass -File .\instalar-agente.ps1

$ErrorActionPreference = 'Stop'

$dir = "$env:LOCALAPPDATA\ChatGLPI"
New-Item -ItemType Directory -Force $dir | Out-Null

# 1. Grava o codigo-fonte do agente
@'
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Net;
using System.Text;
using System.Threading;
using System.Web.Script.Serialization;

class Agent
{
    // Duas origens validas: o app standalone antigo e a pagina do chamado
    // dentro do GLPI (plugin nativo) - o header Access-Control-Allow-Origin
    // so pode ecoar UMA origem por resposta, entao comparamos com a origem
    // de quem pediu em vez de fixar uma string so (isso quebrava o botao
    // "Conectar" quando chamado a partir do GLPI).
    static readonly string[] AllowedOrigins = { "https://chat.example.local", "https://192.0.2.10", "https://glpi.example.com", "http://glpi.example.com", "http://192.0.2.10" };
    const string SharedToken = "CHANGE_ME_agent_token";
    const int Port = 47652;

    // Check-in de presenca: avisa o GLPI que este agente esta rodando (pra
    // auditoria em Plug-ins > Chat-GLPI > Agentes conectados). Token igual
    // ao PLUGIN_CHATGLPI_AGENT_CHECKIN_TOKEN do setup.php - so evita lixo na
    // tabela, nao protege dado sensivel nenhum.
    const string CheckinUrl = "http://192.0.2.10/glpi/plugins/chatglpi/ajax/agentcheckin.php";
    const string CheckinToken = "CHANGE_ME_checkin_token";
    const string AgentVersion = "2026-07-22";

    static readonly string[] ViewerCandidates = {
        @"C:\Program Files\uvnc bvba\UltraVNC\vncviewer.exe",
        @"C:\Program Files\UltraVNC\vncviewer.exe",
        @"C:\Program Files (x86)\uvnc bvba\UltraVNC\vncviewer.exe",
        @"C:\Program Files (x86)\UltraVNC\vncviewer.exe"
    };

    static string FindViewerPath()
    {
        foreach (var path in ViewerCandidates)
            if (File.Exists(path)) return path;
        return null;
    }

    static void Main()
    {
        var listener = new HttpListener();
        listener.Prefixes.Add("http://127.0.0.1:" + Port + "/");
        listener.Start();

        // Avisa que esta rodando ao iniciar, depois de hora em hora - so pra
        // auditoria (Plug-ins > Chat-GLPI > Agentes conectados). Roda numa
        // thread separada e nunca derruba o agente se o GLPI estiver fora do
        // ar (o try/catch dentro de DoCheckin engole qualquer erro de rede).
        var checkinThread = new Thread(() =>
        {
            while (true)
            {
                DoCheckin();
                Thread.Sleep(60 * 60 * 1000);
            }
        });
        checkinThread.IsBackground = true;
        checkinThread.Start();

        while (true)
        {
            var ctx = listener.GetContext();
            ThreadPool.QueueUserWorkItem(_ => Handle(ctx));
        }
    }

    static void DoCheckin()
    {
        try
        {
            var js = new JavaScriptSerializer();
            string body = js.Serialize(new Dictionary<string, string>
            {
                { "hostname", Environment.MachineName },
                { "username", Environment.UserName },
                { "agent", "vnc" },
                { "version", AgentVersion },
            });
            var req = (HttpWebRequest) WebRequest.Create(CheckinUrl);
            req.Method = "POST";
            req.ContentType = "application/json";
            req.Headers.Add("X-ChatGLPI-Checkin", CheckinToken);
            req.Timeout = 5000;
            var bytes = Encoding.UTF8.GetBytes(body);
            using (var stream = req.GetRequestStream())
                stream.Write(bytes, 0, bytes.Length);
            using (var resp = (HttpWebResponse) req.GetResponse()) { }
        }
        catch
        {
            // GLPI fora do ar ou sem rede agora - tenta de novo na proxima hora.
        }
    }

    static void Handle(HttpListenerContext ctx)
    {
        var req = ctx.Request;
        var res = ctx.Response;
        string origin = req.Headers["Origin"];
        string allowOrigin = Array.IndexOf(AllowedOrigins, origin) >= 0 ? origin : AllowedOrigins[0];
        res.Headers.Add("Access-Control-Allow-Origin", allowOrigin);
        res.Headers.Add("Access-Control-Allow-Headers", "Content-Type, X-ChatGLPI-Token");
        res.Headers.Add("Access-Control-Allow-Methods", "POST, GET, OPTIONS");
        // Private Network Access: o Chrome/Edge manda um preflight OPTIONS com
        // Access-Control-Request-Private-Network antes de liberar fetch() de
        // uma pagina "normal" pra um endereco de loopback/rede local - sem
        // este header a resposta e bloqueada silenciosamente (sem popup de
        // permissao nenhum), mesmo com HTTPS e com o agente rodando certinho.
        if (req.Headers["Access-Control-Request-Private-Network"] == "true")
        {
            res.Headers.Add("Access-Control-Allow-Private-Network", "true");
        }

        try
        {
            if (req.HttpMethod == "OPTIONS") { res.StatusCode = 204; res.Close(); return; }

            if (req.HttpMethod == "GET" && req.Url.AbsolutePath == "/ping")
            {
                string viewerPath = FindViewerPath();
                WriteJson(res, 200, "{\"ok\":true,\"viewerFound\":" + (viewerPath != null ? "true" : "false") + "}");
                return;
            }

            if (req.HttpMethod != "POST" || req.Url.AbsolutePath != "/connect")
            {
                res.StatusCode = 404;
                res.Close();
                return;
            }

            if (req.Headers["X-ChatGLPI-Token"] != SharedToken)
            {
                res.StatusCode = 403;
                res.Close();
                return;
            }

            string viewer = FindViewerPath();
            if (viewer == null)
            {
                WriteJson(res, 422, "{\"error\":\"UltraVNC Viewer nao encontrado nesta maquina.\"}");
                return;
            }

            string body;
            using (var reader = new StreamReader(req.InputStream, req.ContentEncoding))
                body = reader.ReadToEnd();

            var js = new JavaScriptSerializer();
            var data = js.Deserialize<Dictionary<string, string>>(body);
            string host = data.ContainsKey("host") ? data["host"] : null;
            string pwd = data.ContainsKey("password") ? data["password"] : null;

            if (string.IsNullOrEmpty(host))
            {
                WriteJson(res, 400, "{\"error\":\"host obrigatorio\"}");
                return;
            }

            string arguments = string.IsNullOrEmpty(pwd)
                ? "\"" + host + "\""
                : "\"" + host + "\" -password \"" + pwd + "\"";
            Process.Start(viewer, arguments);

            WriteJson(res, 200, "{\"ok\":true}");
        }
        catch (Exception ex)
        {
            WriteJson(res, 500, "{\"error\":\"" + ex.Message.Replace("\"", "'") + "\"}");
        }
    }

    static void WriteJson(HttpListenerResponse res, int status, string json)
    {
        res.StatusCode = status;
        res.ContentType = "application/json";
        var bytes = Encoding.UTF8.GetBytes(json);
        res.OutputStream.Write(bytes, 0, bytes.Length);
        res.Close();
    }
}
'@ | Set-Content "$dir\Agent.cs" -Encoding UTF8

# 2. Encerra instancias antigas (agente e o vigia de uma instalacao anterior)
# ANTES de compilar - senao o .exe antigo ainda esta aberto pelo processo
# rodando e o compilador nao consegue sobrescrever o arquivo ("em uso por
# outro processo"). Se o vigia antigo ficar de pe, ele sobe o agente antigo
# de novo sozinho enquanto tentamos recompilar - por isso os dois precisam
# ser encerrados juntos, nesta ordem, antes do passo de compilacao.
Get-CimInstance Win32_Process -Filter "Name = 'powershell.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandLine -like "*watchdog.ps1*" } |
    ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
Get-Process ChatGlpiAgent -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
Start-Sleep -Milliseconds 500

# 3. Compila (csc.exe vem com o .NET Framework, presente em qualquer Windows)
$csc = Get-ChildItem "C:\Windows\Microsoft.NET\Framework64" -Filter csc.exe -Recurse -ErrorAction SilentlyContinue | Select-Object -First 1 -ExpandProperty FullName
if (-not $csc) { $csc = Get-ChildItem "C:\Windows\Microsoft.NET\Framework" -Filter csc.exe -Recurse -ErrorAction SilentlyContinue | Select-Object -First 1 -ExpandProperty FullName }
if (-not $csc) { throw "csc.exe (.NET Framework) nao encontrado - necessario para compilar o agente." }

& $csc /nologo /target:winexe /out:"$dir\ChatGlpiAgent.exe" /reference:System.Web.Extensions.dll "$dir\Agent.cs"
if (-not (Test-Path "$dir\ChatGlpiAgent.exe")) { throw "Falha ao compilar o agente." }
Write-Host "Agente compilado: $dir\ChatGlpiAgent.exe"

# 4. Script "vigia" (watchdog) - fica rodando em loop e sobe o agente de novo
# sozinho se ele cair (crash, fechado sem querer, etc.), sem precisar de
# Servico do Windows nem Tarefa Agendada (as duas exigem admin - a segunda ja
# deu "Acesso negado" nesta rede por politica de grupo). Roda como um
# PowerShell comum, oculto, iniciado pelo mesmo atalho de sempre.
@'
$agentExe = "$env:LOCALAPPDATA\ChatGLPI\ChatGlpiAgent.exe"
while ($true) {
    if (-not (Get-Process ChatGlpiAgent -ErrorAction SilentlyContinue)) {
        Start-Process -FilePath $agentExe -WindowStyle Hidden
    }
    Start-Sleep -Seconds 30
}
'@ | Set-Content "$dir\watchdog.ps1" -Encoding UTF8

# 5. Registra para iniciar sozinho no login - atalho na pasta Inicializar do
# usuario atual (aponta pro vigia, nao mais direto pro agente). Nao precisa
# de admin.
$startupDir = [Environment]::GetFolderPath('Startup')
$shell = New-Object -ComObject WScript.Shell
$shortcut = $shell.CreateShortcut("$startupDir\ChatGLPI Agente.lnk")
$shortcut.TargetPath = "powershell.exe"
$shortcut.Arguments = "-WindowStyle Hidden -ExecutionPolicy Bypass -NoProfile -File `"$dir\watchdog.ps1`""
$shortcut.WorkingDirectory = $dir
$shortcut.Save()
Write-Host "Atalho criado em '$startupDir' - o vigia inicia sozinho a cada login e reinicia o agente automaticamente se ele cair."

# 6. Inicia o vigia agora, sem esperar o proximo login
Start-Process -FilePath "powershell.exe" -ArgumentList "-WindowStyle Hidden -ExecutionPolicy Bypass -NoProfile -File `"$dir\watchdog.ps1`"" -WindowStyle Hidden
Start-Sleep -Seconds 2

# 7. Confere se subiu certinho e se o UltraVNC foi encontrado
try {
  $r = Invoke-WebRequest -Uri "http://127.0.0.1:47652/ping" -UseBasicParsing -TimeoutSec 5
  $status = $r.Content | ConvertFrom-Json
  Write-Host ""
  Write-Host "Agente rodando com sucesso."
  if ($status.viewerFound) {
    Write-Host "UltraVNC Viewer encontrado - tudo pronto, pode usar o botao 'Nova conexao remota' no Chat-GLPI."
  } else {
    Write-Host "ATENCAO: UltraVNC Viewer nao foi encontrado nos caminhos padrao. Instale o UltraVNC nesta maquina antes de usar o acesso remoto."
  }
} catch {
  Write-Host "ATENCAO: o agente nao respondeu apos iniciar. Verifique se a porta 47652 esta livre."
}
