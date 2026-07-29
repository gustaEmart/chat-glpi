// Chat-GLPI - janela de chat flutuante mostrada na tela da PESSOA durante
// um acesso remoto. Processo separado do serviço (ChatGLPIAgent, ../main.go)
// de propósito: o serviço roda na Sessão 0 do Windows (isolada, sem acesso
// nenhum à tela de quem está logado) - a única forma de um serviço mostrar
// uma janela de verdade pra um usuário é lançar um PROCESSO NOVO dentro da
// sessão dele (CreateProcessAsUser, ver launchChatWindow() em ../main.go),
// nunca desenhar direto.
//
// Fala só com o serviço LOCAL (127.0.0.1) - nunca com a rede/backend
// diretamente. O serviço é quem sabe qual sessão de acesso remoto isso
// pertence e faz a ponte com o backend (ver ../main.go::handleChatSend/
// handleChatReply).
//
// RENDERIZAÇÃO: WebView2 (motor do Edge, já presente em qualquer Windows
// 10/11 atual), NÃO controles nativos do Windows. A primeira versão usava
// lxn/walk (wrapper fino sobre Win32) e era um beco sem saída pro visual
// pedido: o histórico ali é um EDIT control comum, que só sabe mostrar
// texto corrido - nunca balões; e Composite com cor de fundo + Label
// centralizado não pintavam de forma confiável (o balão redondo saía
// branco/vazio). Com WebView2 o conteúdo é HTML/CSS de verdade, então dá
// pra reaproveitar exatamente o mesmo visual do chat do GLPI
// (plugin/chatglpi/css/chat.css) em vez de tentar imitá-lo com controles
// nativos.
//
// A janela é SEM MOLDURA nos dois estados (balão e painel) - o HTML
// desenha o próprio cabeçalho/botões, e o recorte (círculo no balão,
// cantos arredondados no painel) é feito com SetWindowRgn.
package main

import (
	"bytes"
	"encoding/json"
	"flag"
	"fmt"
	"net/http"
	"os"
	"sync"
	"syscall"
	"time"

	webview2 "github.com/jchv/go-webview2"
)

type incomingMessage struct {
	Text string `json:"text"`
}

const (
	bubbleSize              = 64
	panelWidth, panelHeight = 360, 470
	marginRight, marginTop  = 20, 60 // folga da borda da tela (direita / de baixo)
)

var (
	w        webview2.WebView
	hwnd     uintptr
	replyURL string

	mu            sync.Mutex
	hasUnanswered bool
)

// --- Win32 na unha (o pacote go-webview2 não expõe nada disso) ---

var (
	user32                 = syscall.NewLazyDLL("user32.dll")
	procSetWindowLongPtr   = user32.NewProc("SetWindowLongPtrW")
	procGetWindowLongPtr   = user32.NewProc("GetWindowLongPtrW")
	procSetWindowPos       = user32.NewProc("SetWindowPos")
	procSetWindowRgn       = user32.NewProc("SetWindowRgn")
	procGetSystemMetrics   = user32.NewProc("GetSystemMetrics")
	procShowWindow         = user32.NewProc("ShowWindow")
	procSetForegroundWin   = user32.NewProc("SetForegroundWindow")
	gdi32                  = syscall.NewLazyDLL("gdi32.dll")
	procCreateEllipticRgn  = gdi32.NewProc("CreateEllipticRgn")
	procCreateRoundRectRgn = gdi32.NewProc("CreateRoundRectRgn")
)

// int32 (não constante sem tipo) porque é negativo e vai virar uintptr numa
// chamada de syscall - conversão de constante negativa pra uintptr não
// compila; de variável, sim.
var gwlStyle = int32(-16)

const (
	wsPopup          = 0x80000000
	wsVisible        = 0x10000000
	swpNoMove        = 0x0002
	swpNoSize        = 0x0001
	swpNoZOrder      = 0x0004
	swpFrameChanged  = 0x0020
	hwndTopmost      = ^uintptr(0) // (HWND)-1
	smCXScreen       = 0
	smCYScreen       = 1
	swRestore        = 9
	swShow           = 5
)

func screenSize() (int, int) {
	cx, _, _ := procGetSystemMetrics.Call(smCXScreen)
	cy, _, _ := procGetSystemMetrics.Call(smCYScreen)
	return int(cx), int(cy)
}

// setFrameless tira TODA a moldura nativa (barra de título, bordas,
// botões) - o HTML desenha o próprio cabeçalho, então nada nativo deve
// aparecer em volta em nenhum dos dois estados.
func setFrameless() {
	style, _, _ := procGetWindowLongPtr.Call(hwnd, uintptr(gwlStyle))
	style = (style & 0x0000FFFF) | wsPopup | wsVisible
	procSetWindowLongPtr.Call(hwnd, uintptr(gwlStyle), style)
	procSetWindowPos.Call(hwnd, 0, 0, 0, 0, 0, swpNoMove|swpNoSize|swpNoZOrder|swpFrameChanged)
}

// applyShape recorta a janela: círculo perfeito no balão, retângulo de
// cantos arredondados no painel (sem isso, os cantos quadrados apareceriam
// por trás do HTML arredondado).
func applyShape(width, height int, circle bool) {
	var rgn uintptr
	if circle {
		rgn, _, _ = procCreateEllipticRgn.Call(0, 0, uintptr(width+1), uintptr(height+1))
	} else {
		rgn, _, _ = procCreateRoundRectRgn.Call(0, 0, uintptr(width+1), uintptr(height+1), 14, 14)
	}
	procSetWindowRgn.Call(hwnd, rgn, 1)
}

// applyState posiciona/redimensiona a janela e reaplica o recorte -
// sempre ancorada no canto inferior direito da tela (igual ao botão
// flutuante do chat no navegador).
func applyState(expanded bool) {
	width, height := bubbleSize, bubbleSize
	if expanded {
		width, height = panelWidth, panelHeight
	}
	screenW, screenH := screenSize()
	x := screenW - width - marginRight
	y := screenH - height - marginTop

	procSetWindowPos.Call(hwnd, hwndTopmost,
		uintptr(int32(x)), uintptr(int32(y)),
		uintptr(int32(width)), uintptr(int32(height)),
		swpFrameChanged)
	applyShape(width, height, !expanded)
}

func bringToFront() {
	procShowWindow.Call(hwnd, swRestore)
	procSetForegroundWin.Call(hwnd)
}

// --- Ponte com o serviço local ---

// pushToJS entrega uma mensagem nova pro HTML. Sempre via Dispatch() - os
// handlers HTTP rodam em goroutines separadas, e mexer na WebView fora da
// thread de UI trava/quebra silenciosamente. json.Marshal cuida do escape
// (aspas, quebras de linha, acentos) sem precisar montar string na mão.
func pushToJS(fn string, arg interface{}) {
	payload, err := json.Marshal(arg)
	if err != nil {
		return
	}
	w.Dispatch(func() {
		w.Eval(fmt.Sprintf("%s(%s)", fn, payload))
	})
}

type pollResponse struct {
	Messages []string `json:"messages"`
	Close    bool     `json:"close"`
}

// pollLoop pergunta ao serviço local, de segundo em segundo, se chegou
// mensagem nova do técnico ou se a sessão de acesso remoto acabou.
//
// É a janela que BUSCA - o serviço não empurra nada pra cá. Assim esta
// janela não precisa abrir porta nenhuma (ver comentário da fila em
// ../main.go sobre por que o sentido foi invertido).
func pollLoop(pollURL string) {
	client := &http.Client{Timeout: 5 * time.Second}
	for {
		resp, err := client.Get(pollURL)
		if err != nil {
			time.Sleep(2 * time.Second) // serviço reiniciando? tenta de novo
			continue
		}
		var data pollResponse
		err = json.NewDecoder(resp.Body).Decode(&data)
		resp.Body.Close()
		if err != nil {
			time.Sleep(time.Second)
			continue
		}

		if len(data.Messages) > 0 {
			mu.Lock()
			hasUnanswered = true
			mu.Unlock()
			for _, text := range data.Messages {
				pushToJS("window.chatIncoming", text)
			}
			w.Dispatch(func() {
				// O redimensionamento nativo (applyState) e o estado do
				// HTML/CSS (classe "expanded" no <body>) são coisas
				// SEPARADAS - só chamar applyState aqui, sem isso, deixava
				// a janela do tamanho do painel só que ainda com o CSS do
				// balão (#bubble é width:100%;height:100%;border-radius:
				// 50% - num container agora grande, isso vira uma ELIPSE
				// gigante em vez do painel). setExpanded() do lado do JS
				// já faz as duas coisas quando é a PESSOA que clica; aqui,
				// como quem decide expandir é o Go (mensagem nova), tem
				// que empurrar a mudança de classe manualmente também.
				w.Eval("document.body.classList.add('expanded')")
				applyState(true)
				bringToFront()
			})
		}

		if data.Close {
			w.Dispatch(func() { w.Terminate() })
			return
		}

		time.Sleep(time.Second)
	}
}

func main() {
	defer func() {
		if r := recover(); r != nil {
			fmt.Fprintln(os.Stderr, "panic:", r)
			os.Exit(1)
		}
	}()

	// -listen continua aceito (e ignorado) só pra não quebrar se uma versão
	// antiga do agente lançar esta janela com ele durante uma atualização.
	flag.String("listen", "", "obsoleto - a janela não escuta mais em porta nenhuma")
	reply := flag.String("reply", "http://127.0.0.1:47821/chat-reply", "URL do serviço local pra onde mandar as respostas digitadas")
	poll := flag.String("poll", "http://127.0.0.1:47821/chat-poll", "URL do serviço local de onde buscar as mensagens do técnico")
	flag.Parse()
	replyURL = *reply

	w = webview2.NewWithOptions(webview2.WebViewOptions{
		Debug:     false,
		AutoFocus: true,
		WindowOptions: webview2.WindowOptions{
			Title:  "Chat-GLPI",
			Width:  bubbleSize,
			Height: bubbleSize,
		},
	})
	if w == nil {
		fmt.Fprintln(os.Stderr, "não foi possível iniciar o WebView2 (runtime do Edge ausente?)")
		os.Exit(1)
	}
	defer w.Destroy()

	hwnd = uintptr(w.Window())

	// Chamado pelo HTML quando a pessoa clica no balão / no botão de
	// recolher - o Go é quem sabe redimensionar/reposicionar a janela.
	w.Bind("goSetExpanded", func(expanded bool) {
		applyState(expanded)
	})

	// Envia a resposta digitada pro serviço local (nunca direto pra rede) -
	// o serviço é quem sabe repassar pro backend certo.
	w.Bind("goSend", func(text string) {
		mu.Lock()
		hasUnanswered = false
		mu.Unlock()
		go func() {
			body, _ := json.Marshal(map[string]string{"text": text})
			client := &http.Client{Timeout: 5 * time.Second}
			client.Post(replyURL, "application/json", bytes.NewReader(body))
		}()
	})

	w.SetHtml(chatHTML)

	setFrameless()
	applyState(false)

	go pollLoop(*poll)

	w.Run()
}
