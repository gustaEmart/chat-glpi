// Chat-GLPI Agent: roda como serviço do Windows em cada computador do domínio
// (instalado via GPO) e expõe nome do computador, IP e MAC address via HTTP
// local em 127.0.0.1, para que o Chat-GLPI (rodando no navegador) anexe essas
// informações automaticamente ao final da descrição de um chamado novo.
package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"net"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"syscall"
	"time"
	"unsafe"

	"golang.org/x/sys/windows"
	"golang.org/x/sys/windows/svc"
	"golang.org/x/sys/windows/svc/eventlog"
	"golang.org/x/sys/windows/svc/mgr"
)

const (
	serviceName        = "ChatGLPIAgent"
	serviceDisplayName = "Chat-GLPI Agent"
	serviceDescription = "Expõe nome do computador, IP e MAC address em 127.0.0.1 para o Chat-GLPI anexar aos chamados, e mostra o chat de acesso remoto (chatwindow.exe) na tela do usuário."
	listenAddr         = "127.0.0.1:47821"

	// Endpoint de mensagem (acesso remoto) - diferente do /info acima: PRECISA
	// ser alcançável pela rede (o backend Node roda em outra máquina), não só
	// em loopback. Porta separada de propósito - assim o /info continua
	// funcionando exatamente como antes, restrito a 127.0.0.1, sem nenhuma
	// mudança de superfície de exposição pra quem já confia no comportamento
	// atual. Token estático (mesmo padrão do checkin acima) - único jeito de
	// impedir qualquer outra máquina da rede de mandar mensagem nesta; vale a
	// pena reforçar com uma regra de firewall restringindo a porta 47823 só
	// ao IP da VM do backend (192.0.2.20), documentado no README.
	messageListenAddr = ":47823"
	messageToken      = "CHANGE_ME_message_token"

	// Janela de chat flutuante (chatwindow/main.go, processo separado deste
	// serviço - ver launchChatWindow() mais abaixo) - conversa contínua
	// durante o acesso remoto, ao contrário do aviso único do handleMessage
	// acima. chatWindowLocalAddr é onde ELA escuta (o serviço empurra
	// mensagens novas ali); backendReplyURL é pra onde ESTE serviço repassa
	// o que a pessoa digitar (handleChatReply, chamado pela janela em
	// /chat-reply, porta 47821 - loopback, só a própria máquina alcança).
	chatWindowExeName   = "chatwindow.exe"
	chatWindowLocalAddr = "127.0.0.1:47825"
	backendReplyURL     = "http://192.0.2.20:4001/api/remote/agent-reply"

	// Check-in de presença: avisa o GLPI que este agente está rodando (pra
	// auditoria em Plug-ins > Chat-GLPI > Agentes conectados). Token igual
	// ao PLUGIN_CHATGLPI_AGENT_CHECKIN_TOKEN do setup.php - só evita lixo na
	// tabela, não protege dado sensível nenhum.
	checkinURL   = "http://192.0.2.10/glpi/plugins/chatglpi/ajax/agentcheckin.php"
	checkinToken = "CHANGE_ME_checkin_token"
	agentVersion = "2026-07-22"
)

func main() {
	if len(os.Args) > 1 {
		switch os.Args[1] {
		case "install":
			mustRun(installService())
			return
		case "uninstall":
			mustRun(uninstallService())
			return
		case "run-console":
			// Executa em primeiro plano (sem instalar serviço) - útil para testar.
			runServer(nil)
			return
		}
	}

	isService, err := svc.IsWindowsService()
	mustRun(err)
	if isService {
		elog, err := eventlog.Open(serviceName)
		if err == nil {
			defer elog.Close()
			globalEventLog = elog // ver logReplyError() - só existe rodando como serviço de verdade
		}
		mustRun(svc.Run(serviceName, &agentService{elog: elog}))
		return
	}

	// Duplo-clique direto no .exe (sem argumento nenhum): como o binário é
	// compilado com -H=windowsgui, não existe console para mostrar a mensagem
	// de uso - então, em vez de só imprimir e sair (o que parecia "não fazer
	// nada"), já sobe o servidor em primeiro plano, igual ao "run-console".
	startServer()
	showMessageBox("Chat-GLPI Agent", "Agente iniciado para teste em http://127.0.0.1:47821/info\n\nEsta janela é só um aviso - feche-a quando terminar o teste; o processo do agente continua rodando em segundo plano até você encerrá-lo pelo Gerenciador de Tarefas.")
	select {}
}

func showMessageBox(title, text string) {
	user32 := syscall.NewLazyDLL("user32.dll")
	proc := user32.NewProc("MessageBoxW")
	titlePtr, _ := syscall.UTF16PtrFromString(title)
	textPtr, _ := syscall.UTF16PtrFromString(text)
	proc.Call(0, uintptr(unsafe.Pointer(textPtr)), uintptr(unsafe.Pointer(titlePtr)), 0)
}

func mustRun(err error) {
	if err != nil {
		fmt.Fprintln(os.Stderr, "erro:", err)
		os.Exit(1)
	}
}

// globalEventLog só é preenchido quando o binário roda como serviço de
// verdade (main(), acima) - permite logar falhas de chamadas assíncronas
// (fire-and-forget, ver handleChatReply) em algum lugar visível de
// verdade (Visualizador de Eventos > Aplicativo, fonte "ChatGLPIAgent"),
// já que -H=windowsgui não tem console nenhum pra mostrar nada.
var globalEventLog *eventlog.Log

func logReplyError(format string, args ...interface{}) {
	msg := fmt.Sprintf(format, args...)
	if globalEventLog != nil {
		globalEventLog.Error(1, msg)
	}
}

type agentService struct {
	elog *eventlog.Log
}

func (s *agentService) Execute(args []string, r <-chan svc.ChangeRequest, changes chan<- svc.Status) (bool, uint32) {
	changes <- svc.Status{State: svc.StartPending}

	servers := startServer()
	changes <- svc.Status{State: svc.Running, Accepts: svc.AcceptStop | svc.AcceptShutdown}

	for {
		req := <-r
		switch req.Cmd {
		case svc.Stop, svc.Shutdown:
			changes <- svc.Status{State: svc.StopPending}
			servers.Close()
			changes <- svc.Status{State: svc.Stopped}
			return false, 0
		}
	}
}

// runServer é usado só pelo modo "run-console" (teste manual, bloqueia a thread).
func runServer(_ interface{}) {
	servers := startServer()
	defer servers.Close()
	select {}
}

// Dois listeners HTTP separados (portas e superfícies de exposição
// diferentes - ver comentário de messageListenAddr) - agrupados aqui só
// pra terem UM Close() só, chamado tanto no encerramento do serviço
// (Execute() acima) quanto no modo de teste (run-console).
type agentServers struct {
	info    *http.Server
	message *http.Server
}

func (s *agentServers) Close() {
	s.info.Close()
	s.message.Close()
}

func startServer() *agentServers {
	mux := http.NewServeMux()
	mux.HandleFunc("/info", handleInfo)
	// Loopback (mesmo mux/porta do /info) de propósito - só a janela de
	// chat RODANDO NESTA MÁQUINA (chatwindow.exe, sessão do usuário) chama
	// isso; nunca precisa ser alcançável pela rede.
	mux.HandleFunc("/chat-reply", handleChatReply)
	mux.HandleFunc("/chat-poll", handleChatPoll)
	server := &http.Server{Addr: listenAddr, Handler: mux}
	go server.ListenAndServe()

	// Segundo listener, porta separada, ouvindo em TODAS as interfaces (não
	// só loopback) - é o que o backend Node (outra máquina) chama durante
	// uma sessão de acesso remoto pra exibir uma mensagem na tela desta.
	messageMux := http.NewServeMux()
	messageMux.HandleFunc("/chat/open", handleChatOpen)
	messageMux.HandleFunc("/chat/send", handleChatSend)
	messageMux.HandleFunc("/chat/close", handleChatClose)
	messageServer := &http.Server{Addr: messageListenAddr, Handler: messageMux}
	go messageServer.ListenAndServe()

	// Avisa que está rodando ao iniciar, depois de hora em hora - só pra
	// auditoria (Plug-ins > Chat-GLPI > Agentes conectados). Nunca derruba
	// o agente se o GLPI estiver fora do ar (erro é só ignorado).
	go func() {
		for {
			doCheckin()
			time.Sleep(1 * time.Hour)
		}
	}()

	return &agentServers{info: server, message: messageServer}
}

// doCheckin avisa o GLPI que esta máquina tem o agente rodando. Esse agente
// roda como serviço do Windows (conta SYSTEM via GPO), então os.Hostname()
// identifica a máquina certinho, mas o "usuário" precisa vir da sessão
// interativa ativa (WTS), já que a conta SYSTEM não corresponde a ninguém
// de verdade sentado na máquina.
func doCheckin() {
	hostname, _ := os.Hostname()
	body, err := json.Marshal(map[string]string{
		"hostname": hostname,
		"username": activeConsoleUsername(),
		"agent":    "info",
		"version":  agentVersion,
	})
	if err != nil {
		return
	}
	req, err := http.NewRequest(http.MethodPost, checkinURL, bytes.NewReader(body))
	if err != nil {
		return
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-ChatGLPI-Checkin", checkinToken)
	client := &http.Client{Timeout: 5 * time.Second}
	resp, err := client.Do(req)
	if err != nil {
		return // GLPI fora do ar ou sem rede agora - tenta de novo na próxima hora.
	}
	resp.Body.Close()
}

var (
	kernel32                         = syscall.NewLazyDLL("kernel32.dll")
	procWTSGetActiveConsoleSessionID = kernel32.NewProc("WTSGetActiveConsoleSessionId")
	wtsapi32                         = syscall.NewLazyDLL("wtsapi32.dll")
	procWTSQuerySessionInformationW  = wtsapi32.NewProc("WTSQuerySessionInformationW")
	procWTSFreeMemory                = wtsapi32.NewProc("WTSFreeMemory")
	// Pega o token de acesso do usuário logado na sessão de console - é o
	// ponto de partida pra lançar a janela de chat NA SESSÃO dele (ver
	// launchChatWindow()); sem isso, CreateProcessAsUser não teria a quem
	// atribuir o processo novo.
	procWTSQueryUserToken = wtsapi32.NewProc("WTSQueryUserToken")
)

const wtsUserName = 5 // WTS_INFO_CLASS.WTSUserName

// activeConsoleUsername devolve o login de quem está com sessão ativa no
// console local (teclado/tela física) - "" se não houver ninguém logado
// (máquina na tela de login) ou em caso de erro.
func activeConsoleUsername() string {
	sessionID, _, _ := procWTSGetActiveConsoleSessionID.Call()
	if int32(sessionID) == -1 {
		return ""
	}
	var buf uintptr
	var bytesReturned uint32
	ret, _, _ := procWTSQuerySessionInformationW.Call(
		0, // WTS_CURRENT_SERVER_HANDLE
		sessionID,
		uintptr(wtsUserName),
		uintptr(unsafe.Pointer(&buf)),
		uintptr(unsafe.Pointer(&bytesReturned)),
	)
	if ret == 0 || buf == 0 {
		return ""
	}
	defer procWTSFreeMemory.Call(buf)
	if bytesReturned < 2 {
		return ""
	}
	return syscall.UTF16ToString((*[1 << 16]uint16)(unsafe.Pointer(buf))[: bytesReturned/2])
}

type messageResponse struct {
	Response string `json:"response,omitempty"`
	Error    string `json:"error,omitempty"`
}

// --- Janela de chat flutuante (conversa contínua durante o acesso remoto) ---
//
// O serviço roda na Sessão 0 do Windows (isolada - nenhum processo ali
// consegue desenhar janela nenhuma na tela de quem está logado). A ÚNICA
// forma de mostrar uma janela de verdade é lançar um PROCESSO NOVO dentro
// da sessão interativa do usuário (mesma técnica usada por ferramentas tipo
// PsExec -i): pega o token de acesso da sessão de console ativa
// (WTSQueryUserToken), duplica pra um token PRIMÁRIO (CreateProcessAsUser
// exige isso, não aceita o token de impersonação original), habilita os
// dois privilégios que essa chamada exige no processo QUE CHAMA (este
// serviço, rodando como LocalSystem já tem os dois concedidos, só não vêm
// habilitados por padrão), e então CreateProcessAsUser no ambiente/desktop
// certo ("winsta0\default" - a estação/desktop interativa de verdade).

var (
	chatWindowMu     sync.Mutex
	chatWindowHandle windows.Handle // handle do processo lançado - 0 se nenhum
)

// chatWindowAlive checa de VERDADE se o processo lançado ainda está de pé
// (GetExitCodeProcess), em vez de confiar numa flag simples "já lancei uma
// vez" - um booleano simples ficava permanentemente errado se a janela
// travasse/fechasse sozinha por qualquer motivo (foi exatamente o que
// aconteceu com o bug do manifesto: CreateProcessAsUser tinha sucesso, a
// flag virava true, mas o processo morria na hora - toda tentativa
// seguinte de abrir a janela era pulada silenciosamente, achando que já
// tinha uma rodando).
const stillActive = 259 // STILL_ACTIVE

func chatWindowAlive() bool {
	if chatWindowHandle == 0 {
		return false
	}
	var exitCode uint32
	if err := windows.GetExitCodeProcess(chatWindowHandle, &exitCode); err != nil {
		return false
	}
	return exitCode == stillActive
}

func enableCurrentProcessPrivilege(name string) error {
	var procToken windows.Token
	if err := windows.OpenProcessToken(windows.CurrentProcess(), windows.TOKEN_ADJUST_PRIVILEGES|windows.TOKEN_QUERY, &procToken); err != nil {
		return err
	}
	defer procToken.Close()

	namePtr, err := syscall.UTF16PtrFromString(name)
	if err != nil {
		return err
	}
	var luid windows.LUID
	if err := windows.LookupPrivilegeValue(nil, namePtr, &luid); err != nil {
		return err
	}

	privileges := windows.Tokenprivileges{
		PrivilegeCount: 1,
		Privileges: [1]windows.LUIDAndAttributes{
			{Luid: luid, Attributes: windows.SE_PRIVILEGE_ENABLED},
		},
	}
	return windows.AdjustTokenPrivileges(procToken, false, &privileges, 0, nil, nil)
}

// launchChatWindow é idempotente (chatWindowAlive()) - chamado tanto por
// /chat/open (início do acesso remoto) quanto defensivamente por
// /chat/send, caso a janela ainda não tenha sido aberta por algum motivo -
// ou tenha morrido sozinha (crash, fechada à força pelo Gerenciador de
// Tarefas etc.), caso em que esta função relança na próxima chamada.
func launchChatWindow() error {
	chatWindowMu.Lock()
	defer chatWindowMu.Unlock()
	if chatWindowAlive() {
		return nil
	}
	if chatWindowHandle != 0 {
		windows.CloseHandle(chatWindowHandle)
		chatWindowHandle = 0
	}

	// Mata qualquer chatwindow.exe órfão antes de subir um novo. Sem isso,
	// um processo de uma versão ANTIGA (sobrevivente de uma atualização do
	// agente, ou de um lançamento que o serviço perdeu de vista) fica
	// segurando a porta 47825 - o novo sobe, não consegue escutar, e as
	// mensagens do técnico simplesmente não chegam em lugar nenhum, sem
	// erro visível. Só um deve existir por máquina, sempre.
	exec.Command("taskkill", "/F", "/IM", chatWindowExeName).Run()

	sessionID, _, _ := procWTSGetActiveConsoleSessionID.Call()
	if int32(sessionID) == -1 {
		return fmt.Errorf("nenhum usuário com sessão ativa nesta máquina no momento")
	}

	var userToken windows.Token
	ret, _, callErr := procWTSQueryUserToken.Call(sessionID, uintptr(unsafe.Pointer(&userToken)))
	if ret == 0 {
		return fmt.Errorf("WTSQueryUserToken falhou: %v", callErr)
	}
	defer userToken.Close()

	var primaryToken windows.Token
	if err := windows.DuplicateTokenEx(userToken, 0, nil, windows.SecurityImpersonation, windows.TokenPrimary, &primaryToken); err != nil {
		return fmt.Errorf("DuplicateTokenEx falhou: %w", err)
	}
	defer primaryToken.Close()

	if err := enableCurrentProcessPrivilege("SeAssignPrimaryTokenPrivilege"); err != nil {
		return fmt.Errorf("privilégio SeAssignPrimaryTokenPrivilege: %w", err)
	}
	if err := enableCurrentProcessPrivilege("SeIncreaseQuotaPrivilege"); err != nil {
		return fmt.Errorf("privilégio SeIncreaseQuotaPrivilege: %w", err)
	}

	var envBlock *uint16
	if err := windows.CreateEnvironmentBlock(&envBlock, primaryToken, false); err != nil {
		return fmt.Errorf("CreateEnvironmentBlock falhou: %w", err)
	}
	defer windows.DestroyEnvironmentBlock(envBlock)

	exePath, err := os.Executable()
	if err != nil {
		return err
	}
	chatWindowPath := filepath.Join(filepath.Dir(exePath), chatWindowExeName)
	if _, err := os.Stat(chatWindowPath); err != nil {
		return fmt.Errorf("%s não encontrado ao lado do agente", chatWindowExeName)
	}

	desktop, err := syscall.UTF16PtrFromString(`winsta0\default`)
	if err != nil {
		return err
	}
	cmdLine, err := syscall.UTF16PtrFromString(fmt.Sprintf(
		`"%s" -listen %s -reply http://127.0.0.1:47821/chat-reply`,
		chatWindowPath, chatWindowLocalAddr,
	))
	if err != nil {
		return err
	}

	si := windows.StartupInfo{Desktop: desktop}
	si.Cb = uint32(unsafe.Sizeof(si))
	var pi windows.ProcessInformation

	if err := windows.CreateProcessAsUser(
		primaryToken,
		nil,
		cmdLine,
		nil,
		nil,
		false,
		windows.CREATE_UNICODE_ENVIRONMENT,
		envBlock,
		nil,
		&si,
		&pi,
	); err != nil {
		return fmt.Errorf("CreateProcessAsUser falhou: %w", err)
	}
	// NÃO fecha o handle do processo (só o da thread) - precisamos dele
	// guardado pra checar de verdade, depois, se ainda está vivo
	// (chatWindowAlive()) em vez de confiar numa flag que nunca se
	// corrige sozinha.
	windows.CloseHandle(pi.Thread)
	chatWindowHandle = pi.Process
	return nil
}

// Fila de mensagens pendentes pra janela de chat. A janela BUSCA isso
// (GET /chat-poll, loopback) em vez de o serviço EMPURRAR pra ela.
//
// A primeira versão fazia o contrário: a janela subia um servidor HTTP
// próprio (porta 47825) e o serviço postava nela. Só que, na prática, esse
// listener às vezes simplesmente não ficava de pé (o erro do
// ListenAndServe some numa goroutine sem console nenhum, já que o binário
// é -H=windowsgui) - e aí a mensagem morria com "connection refused" sem
// nada visível pra depurar. Invertendo o sentido, a janela não precisa
// abrir porta nenhuma: some a porta, some o conflito com processo órfão,
// some a dependência de ordem de inicialização, e a única conexão é a que
// a própria janela abre quando quer.
var (
	chatQueueMu sync.Mutex
	chatQueue   []string
	chatClosing bool
)

func enqueueChatMessage(text string) {
	chatQueueMu.Lock()
	chatQueue = append(chatQueue, text)
	chatQueueMu.Unlock()
}

func resetChatQueue() {
	chatQueueMu.Lock()
	chatQueue = nil
	chatClosing = false
	chatQueueMu.Unlock()
}

// handleChatPoll - só loopback (mesma porta do /info e /chat-reply): a
// janela de chat, rodando nesta máquina, pergunta de tempos em tempos se
// tem mensagem nova ou se é hora de fechar.
func handleChatPoll(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	chatQueueMu.Lock()
	messages := chatQueue
	chatQueue = nil
	closing := chatClosing
	chatQueueMu.Unlock()
	if messages == nil {
		messages = []string{}
	}
	json.NewEncoder(w).Encode(map[string]interface{}{
		"messages": messages,
		"close":    closing,
	})
}

// handleChatOpen - chamado pelo backend quando uma sessão de acesso remoto
// começa (mostra o widget de chat na tela da pessoa desde já, ver decisão
// tomada com o usuário: "assim que o acesso remoto começa").
func handleChatOpen(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	if r.Header.Get("X-ChatGLPI-Message-Token") != messageToken {
		w.WriteHeader(http.StatusForbidden)
		return
	}
	// Sessão de acesso remoto nova - zera qualquer sobra da anterior
	// (mensagem não entregue, pedido de fechamento pendente) antes de
	// abrir a janela.
	resetChatQueue()
	if err := launchChatWindow(); err != nil {
		w.WriteHeader(http.StatusInternalServerError)
		json.NewEncoder(w).Encode(messageResponse{Error: err.Error()})
		return
	}
	json.NewEncoder(w).Encode(messageResponse{Response: "ok"})
}

type chatTextRequest struct {
	Text string `json:"text"`
}

// handleChatSend - chamado pelo backend a cada mensagem que o técnico
// manda; entrega na janela local (relançando-a primeiro, se por algum
// motivo ainda não estiver rodando).
func handleChatSend(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	if r.Header.Get("X-ChatGLPI-Message-Token") != messageToken {
		w.WriteHeader(http.StatusForbidden)
		return
	}
	var req chatTextRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil || strings.TrimSpace(req.Text) == "" {
		w.WriteHeader(http.StatusBadRequest)
		json.NewEncoder(w).Encode(messageResponse{Error: "Mensagem vazia."})
		return
	}
	// Cancela qualquer ordem de fechamento pendente ANTES de enfileirar -
	// sem isso, se um /chat/close anterior tivesse deixado chatClosing=true
	// travado (ex.: sessão anterior expirou e o /chat/open novo nunca veio
	// a tempo de limpar isso), a janela recém-lançada veria "close:true" já
	// na primeira consulta e se fecharia sozinha na hora, e NENHUMA
	// mensagem nova conseguiria ficar de pé tempo suficiente pra aparecer -
	// exatamente o sintoma "mensagem enfileira certinho (200 ok) mas nunca
	// aparece". Mandar mensagem é sinal inequívoco de que o chat deveria
	// estar aberto, então isso sempre tem prioridade sobre qualquer ordem
	// de fechar mais antiga.
	chatQueueMu.Lock()
	chatClosing = false
	chatQueueMu.Unlock()
	enqueueChatMessage(req.Text)
	if err := launchChatWindow(); err != nil {
		w.WriteHeader(http.StatusInternalServerError)
		json.NewEncoder(w).Encode(messageResponse{Error: err.Error()})
		return
	}
	json.NewEncoder(w).Encode(messageResponse{Response: "ok"})
}

// handleChatClose - chamado pelo backend quando a sessão de acesso remoto
// termina de verdade (VNC desconectado) - fecha a janela mesmo que ainda
// tenha mensagem sem resposta (não deixa a pessoa presa numa janela órfã
// depois que o técnico já foi embora).
func handleChatClose(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	if r.Header.Get("X-ChatGLPI-Message-Token") != messageToken {
		w.WriteHeader(http.StatusForbidden)
		return
	}
	chatWindowMu.Lock()
	if chatWindowHandle != 0 {
		windows.CloseHandle(chatWindowHandle)
		chatWindowHandle = 0
	}
	chatWindowMu.Unlock()
	// A janela lê isso no próximo poll (até 1s) e se fecha sozinha. Não
	// mata o processo à força aqui de propósito - assim ela ainda consegue
	// mostrar/enviar o que estiver pendente antes de sair.
	chatQueueMu.Lock()
	chatClosing = true
	chatQueueMu.Unlock()
	json.NewEncoder(w).Encode(messageResponse{Response: "ok"})
}

// handleChatReply - chamado pela JANELA (chatwindow.exe, rodando na sessão
// da pessoa) quando ela responde algo - só loopback (127.0.0.1:47821,
// mesmo endpoint do /info), nunca alcançável de fora desta máquina.
// Repassa pro backend, que decide a qual sessão/chamado isso pertence pelo
// hostname desta máquina (ver glpi-backend/src/remote.js).
func handleChatReply(w http.ResponseWriter, r *http.Request) {
	var req chatTextRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil || strings.TrimSpace(req.Text) == "" {
		w.WriteHeader(http.StatusBadRequest)
		return
	}
	hostname, _ := os.Hostname()
	go func() {
		body, _ := json.Marshal(map[string]string{"hostname": hostname, "text": req.Text})
		httpReq, err := http.NewRequest(http.MethodPost, backendReplyURL, bytes.NewReader(body))
		if err != nil {
			logReplyError("falha ao montar requisição pro backend (%s): %v", backendReplyURL, err)
			return
		}
		httpReq.Header.Set("Content-Type", "application/json")
		httpReq.Header.Set("X-ChatGLPI-Message-Token", messageToken)
		client := &http.Client{Timeout: 10 * time.Second}
		resp, err := client.Do(httpReq)
		if err != nil {
			logReplyError("falha ao mandar resposta pro backend (hostname=%s): %v", hostname, err)
			return
		}
		defer resp.Body.Close()
		if resp.StatusCode >= 300 {
			logReplyError("backend recusou a resposta (hostname=%s): HTTP %d", hostname, resp.StatusCode)
		}
	}()
	w.WriteHeader(http.StatusOK)
}

type deviceInfo struct {
	Hostname string `json:"hostname"`
	IP       string `json:"ip"`
	MAC      string `json:"mac"`
}

func handleInfo(w http.ResponseWriter, r *http.Request) {
	// Só serve GET simples: sem cookies/credenciais, então liberar qualquer
	// origem é seguro (a informação não é sensível e o servidor só escuta em
	// loopback, inacessível de fora da própria máquina).
	w.Header().Set("Access-Control-Allow-Origin", "*")
	w.Header().Set("Content-Type", "application/json")
	if r.Method != http.MethodGet {
		w.WriteHeader(http.StatusMethodNotAllowed)
		return
	}

	info := collectDeviceInfo()
	json.NewEncoder(w).Encode(info)
}

func collectDeviceInfo() deviceInfo {
	hostname, _ := os.Hostname()
	ip, mac := primaryInterface()
	return deviceInfo{Hostname: hostname, IP: ip, MAC: mac}
}

// primaryInterface escolhe a primeira interface de rede física ativa (up,
// não-loopback, com MAC address real) que tenha um endereço IPv4 - normalmente
// a interface Ethernet/Wi-Fi em uso. Adaptadores virtuais (VPN, Hyper-V, etc.)
// costumam não expor HardwareAddr, então são pulados em favor de um com MAC.
func primaryInterface() (string, string) {
	ifaces, err := net.Interfaces()
	if err != nil {
		return "", ""
	}
	var fallbackIP string
	for _, iface := range ifaces {
		if iface.Flags&net.FlagUp == 0 || iface.Flags&net.FlagLoopback != 0 {
			continue
		}
		addrs, err := iface.Addrs()
		if err != nil {
			continue
		}
		for _, addr := range addrs {
			ipNet, ok := addr.(*net.IPNet)
			if !ok || ipNet.IP.IsLoopback() {
				continue
			}
			ip4 := ipNet.IP.To4()
			if ip4 == nil {
				continue
			}
			if len(iface.HardwareAddr) == 0 {
				if fallbackIP == "" {
					fallbackIP = ip4.String()
				}
				continue
			}
			return ip4.String(), iface.HardwareAddr.String()
		}
	}
	return fallbackIP, ""
}

func installService() error {
	exePath, err := os.Executable()
	if err != nil {
		return err
	}
	m, err := mgr.Connect()
	if err != nil {
		return err
	}
	defer m.Disconnect()

	if s, err := m.OpenService(serviceName); err == nil {
		s.Close()
		return fmt.Errorf("serviço %s já está instalado", serviceName)
	}

	s, err := m.CreateService(serviceName, exePath, mgr.Config{
		DisplayName: serviceDisplayName,
		Description: serviceDescription,
		StartType:   mgr.StartAutomatic,
	})
	if err != nil {
		return err
	}
	defer s.Close()

	eventlog.InstallAsEventCreate(serviceName, eventlog.Error|eventlog.Warning|eventlog.Info)

	if err := s.Start(); err != nil {
		return fmt.Errorf("serviço criado, mas falhou ao iniciar: %w", err)
	}
	fmt.Println("Serviço instalado e iniciado com sucesso.")
	return nil
}

func uninstallService() error {
	m, err := mgr.Connect()
	if err != nil {
		return err
	}
	defer m.Disconnect()

	s, err := m.OpenService(serviceName)
	if err != nil {
		return fmt.Errorf("serviço %s não encontrado", serviceName)
	}
	defer s.Close()

	s.Control(svc.Stop)
	time.Sleep(2 * time.Second)

	if err := s.Delete(); err != nil {
		return err
	}
	eventlog.Remove(serviceName)
	fmt.Println("Serviço removido com sucesso.")
	return nil
}
