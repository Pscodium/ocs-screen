import {
  app,
  shell,
  screen,
  BrowserWindow,
  Tray,
  Menu,
  ipcMain,
  desktopCapturer,
  clipboard,
  nativeImage,
  MessageChannelMain,
  crashReporter,
  type MessagePortMain,
} from "electron";
import { join } from "path";
import { createWriteStream } from "fs";
import { autoUpdater } from "electron-updater";
import WebSocket from "ws";

// Salva dump LOCAL de crash (sem subir pra lugar nenhum, `uploadToServer: false`) — sem isso o
// crash reporter interno do Chromium tenta conectar num servidor de coleta que não existe nesse
// build de dev e desiste silenciosamente ("crashpad_client_win.cc: not connected"), sem salvar
// nada. Crash sob carga pesada de GPU (jogo + captura+NVENC) já aconteceu 2x nessa sessão sem
// deixar rastro nenhum — isso dá visibilidade real da próxima vez.
crashReporter.start({ submitURL: "", uploadToServer: false, compress: false });
console.log("[crash-reporter] dumps salvos em:", app.getPath("crashDumps"));

// Crashpad acima só pega crash NATIVO (SEH/access violation). Exceção JS não tratada no processo
// main é fatal por padrão no Node (stack impresso no stderr, processo morre) — sem dump, sem
// evento no Windows Event Viewer, e o stderr pode nem chegar no terminal dependendo de como o
// Electron reencaminha stdio dos processos filhos. Gravar em arquivo garante que o erro fica
// visível na próxima reprodução, independente do console.
process.on("uncaughtException", (err) => {
  try {
    const logPath = join(app.getPath("userData"), "uncaught-exception.log");
    const entry = `[${new Date().toISOString()}] ${err.stack ?? err}\n`;
    createWriteStream(logPath, { flags: "a" }).end(entry);
  } catch {
    // se nem isso funcionar, não tem mais nada a fazer — deixa cair mesmo
  }
  console.error("[uncaughtException]", err);
  app.exit(1);
});

// `backgroundThrottling: false` (webPreferences) só evita o Chromium throttlar TIMERS/rAF do
// renderer quando a janela fica oclusa/sem foco — existe uma camada SEPARADA, em nível de
// processo, que baixa a prioridade de agendamento do processo renderer inteiro (não só JS) nesse
// mesmo cenário, e essa aqui só se desliga por flag de linha de comando (tem que rodar ANTES de
// app.whenReady()). Browsers de verdade (Chrome/Edge) já rodam com esse comportamento mais afinado
// pra WebRTC/captura de tela; Electron herda o padrão agressivo do Chromium. Isso explica o app
// desktop continuar perdendo pro navegador mesmo depois do fix de `backgroundThrottling` — o
// processo inteiro (não só os timers) tava sendo despriorizado pelo Windows quando um jogo em
// tela cheia cobre o widget.
app.commandLine.appendSwitch("disable-renderer-backgrounding");
app.commandLine.appendSwitch("disable-backgrounding-occluded-windows");

// O Chromium mantém uma lista interna de GPU/driver marcados como "problemáticos" — quando a
// combinação bate nessa lista, ele cai pra renderização/composição por SOFTWARE silenciosamente,
// sem nenhum aviso na UI (diferente do toggle visível de "aceleração de hardware" que o Chrome/
// Edge de verdade expõem em Configurações). Electron herda essa mesma lista. Como a captura de
// tela (WGC) passa pelo processo de GPU do Chromium antes de chegar no encoder, isso explicaria
// o app desktop entregar FPS pior que o navegador mesmo com o ENCODER confirmado em hardware
// (MediaFoundationVideoEncodeAccelerator) — o gargalo seria a composição/cópia do frame capturado,
// não o encode em si. `ignore-gpu-blocklist` força o Chromium a tentar hardware mesmo se achar
// que o driver é problemático; `enable-gpu-rasterization` força rasterização por GPU em vez de
// software; `disable-gpu-sandbox` é workaround documentado pra travas de captura de tela via GPU
// no Windows quando o processo de GPU roda sandboxado.
app.commandLine.appendSwitch("ignore-gpu-blocklist");
app.commandLine.appendSwitch("enable-gpu-rasterization");
app.commandLine.appendSwitch("disable-gpu-sandbox");

const ICON_PATH = join(__dirname, "../../build/icon.png");

// Altura baixada de 720 pra 420 — a tela inicial (`HomePage`) voltou a ser só título/abas/botão
// (configs migraram pro rodapé do `SourcePicker`, que tem sua própria janela maior), 720 sobrava
// bem mais que o conteúdo real precisa. 420 (não 400) porque a aba "Assistir" (`RoomsBrowser`,
// estado vazio "Nenhuma transmissão ativa") mede 378px de conteúdo real contra 400 — medido com
// Playwright `_electron`, sobrava scrollbar por ~16px em 400.
const NORMAL_SIZE = { width: 440, height: 420 };
// Em dev, o widget cresce um pouco pra caber a HUD de estatísticas sempre visível (sem hover) —
// só existe em `import.meta.env.DEV` no renderer, então em produção o widget continua 340×140.
const WIDGET_SIZE = app.isPackaged ? { width: 340, height: 140 } : { width: 340, height: 320 };
const WIDGET_MARGIN = 24;
const PICKER_SIZE = { width: 720, height: 640 };

// `mainWindow` continua existindo só pra coisas que são inerentemente singulares (tray
// mostrar/focar, mensagens de update) — a primeira janela criada. Comandos que agem "na janela
// que mandou o comando" (minimizar, widget, picker, watch) resolvem a janela via
// `BrowserWindow.fromWebContents(event.sender)`, não mais nesse global — é o que permite abrir
// uma segunda janela de teste (ver `resolveWindow` e window:open-test-window) sem que os
// controles de uma janela mexam na outra por engano.
let mainWindow: BrowserWindow | null = null;
let tray: Tray | null = null;
// O seletor de fonte fecha (e tenta restaurar o tamanho normal) assim que o usuário escolhe uma
// fonte — mas a captura/publish ainda leva um tempo pra terminar depois disso. Se a transmissão
// já tiver ficado ao vivo nesse meio tempo, o fechamento do seletor não pode desfazer o widget.
// Continua global (não por-janela) — não esperado que duas janelas transmitam ao mesmo tempo;
// suficiente pro caso de uso real (uma janela hosteia, outra só assiste pra teste).
let isWidgetMode = false;

function resolveWindow(event: { sender: Electron.WebContents }): BrowserWindow | null {
  return BrowserWindow.fromWebContents(event.sender);
}

function createWindow(): BrowserWindow {
  const window = new BrowserWindow({
    width: NORMAL_SIZE.width,
    height: NORMAL_SIZE.height,
    minWidth: 340,
    minHeight: 200,
    frame: false,
    show: false,
    backgroundColor: "#0e0f13",
    icon: ICON_PATH,
    webPreferences: {
      preload: join(__dirname, "../preload/index.js"),
      sandbox: false,
      // Necessário pra capturar tela sem prompt do navegador — o desktopCapturer resolve o
      // stream via chromeMediaSourceId, que só funciona com Electron não-sandboxed.
      //
      // backgroundThrottling: por padrão o Chromium reduz a prioridade de timers/pipeline de
      // mídia de uma janela que fica OCLUSA (coberta por outra janela) — mesmo com
      // setAlwaysOnTop, um jogo em tela cheia (principalmente fullscreen exclusivo) cobre o
      // widget, e o Chromium trata isso como "não visível". Testado em produção: FPS entregue
      // oscilava 20-55fps especificamente hosteando pelo app desktop (nunca pelo navegador numa
      // aba normal, que não sofre esse throttling porque uma aba de captura não fica "oclusa" da
      // mesma forma) — essa é a causa mais provável. Desligado porque esse app SEMPRE precisa
      // continuar codificando/transmitindo em velocidade plena, mesmo minimizado ou coberto.
      backgroundThrottling: false,
    },
  });

  window.on("ready-to-show", () => window.show());

  // F12 abre o DevTools — não tem menu padrão nessa janela frameless pra chegar nisso de outro jeito.
  window.webContents.on("before-input-event", (_event, input) => {
    if (input.type === "keyDown" && input.key === "F12") {
      window.webContents.toggleDevTools();
    }
  });

  // Só a última janela fechada derruba o processo (window-all-closed já cuida disso) — fechar
  // uma janela de teste secundária não pode matar o app inteiro com a principal ainda aberta.
  window.on("closed", () => {
    if (mainWindow === window) mainWindow = null;
  });

  window.webContents.setWindowOpenHandler((details) => {
    shell.openExternal(details.url);
    return { action: "deny" };
  });

  if (!app.isPackaged && process.env.ELECTRON_RENDERER_URL) {
    window.loadURL(process.env.ELECTRON_RENDERER_URL);
  } else {
    window.loadFile(join(__dirname, "../renderer/index.html"));
  }

  if (!mainWindow) mainWindow = window;
  return window;
}

function createTray(): void {
  const icon = nativeImage.createFromPath(ICON_PATH).resize({ width: 16, height: 16 });
  tray = new Tray(icon);
  tray.setToolTip("ScreenShare");
  tray.on("click", () => {
    if (!mainWindow) return;
    mainWindow.show();
    mainWindow.focus();
  });
  const menuTemplate: Electron.MenuItemConstructorOptions[] = [
    {
      label: "Abrir",
      click: () => {
        mainWindow?.show();
        mainWindow?.focus();
      },
    },
  ];

  // Dev-only: `chrome://gpu` mostra "Hardware accelerated" vs "Software only" por recurso — o
  // jeito mais direto de confirmar se o Chromium caiu pra composição por software (ver flags
  // ignore-gpu-blocklist acima) sem depender de inferir isso pelo Gerenciador de Tarefas.
  if (!app.isPackaged) {
    menuTemplate.push({
      label: "GPU Info (debug)",
      click: () => {
        const gpuWindow = new BrowserWindow({ width: 900, height: 700, title: "chrome://gpu" });
        gpuWindow.loadURL("chrome://gpu");
      },
    });
  }

  menuTemplate.push({ label: "Sair", click: () => app.quit() });
  tray.setContextMenu(Menu.buildFromTemplate(menuTemplate));
}

// Baixa só quando o usuário aprovar no modal (não é auto-download nem auto-instala no quit) —
// pede pra "avisar e deixar o usuário escolher", não empurrar a atualização sem avisar.
autoUpdater.autoDownload = false;
autoUpdater.autoInstallOnAppQuit = false;

function setupAutoUpdater(): void {
  autoUpdater.on("update-available", (info) => {
    mainWindow?.webContents.send("update:available", {
      version: info.version,
      // GitHub provider preenche isso com o corpo (markdown) do release — é o changelog.
      releaseNotes: typeof info.releaseNotes === "string" ? info.releaseNotes : null,
    });
  });

  autoUpdater.on("download-progress", (progress) => {
    mainWindow?.webContents.send("update:download-progress", { percent: Math.round(progress.percent) });
  });

  autoUpdater.on("update-downloaded", () => {
    mainWindow?.webContents.send("update:downloaded");
  });

  autoUpdater.on("error", (err) => {
    mainWindow?.webContents.send("update:error", err.message);
  });

  // app.isPackaged: em dev não existe app-update.yml (só gerado no build), checkForUpdates()
  // sempre falha nesse caso — nem tenta.
  if (app.isPackaged) {
    autoUpdater.checkForUpdates().catch(() => {
      // Falha silenciosa de propósito (sem internet, GitHub fora do ar, etc.) — não é motivo
      // pra incomodar o usuário toda vez que abre o app.
    });
  }
}

ipcMain.on("update:download", () => {
  autoUpdater.downloadUpdate().catch((err) => {
    mainWindow?.webContents.send("update:error", err instanceof Error ? err.message : String(err));
  });
});

ipcMain.on("update:install", () => {
  autoUpdater.quitAndInstall();
});

app.whenReady().then(() => {
  createWindow();
  createTray();
  setupAutoUpdater();

  // Dev-only: `npm run dev:multi` seta essa env var pra abrir uma segunda janela junto, pra
  // testar host+espectador no mesmo PC sem precisar de dois computadores (ver scripts/dev-multi.js).
  if (!app.isPackaged && process.env.OPEN_TEST_WINDOW === "1") {
    createWindow();
  }

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  app.quit();
});

// Transmissão nativa não tem NENHUMA rede de segurança do lado do backend (diferente do LiveKit,
// que detecta o host sumindo via webhook + TTL de sala vazia) — sem isso aqui, fechar o app com
// uma transmissão ativa deixava a sala presa pra sempre (bug real: continuava em "Assistir" depois
// do processo já ter morrido). `before-quit` intercepta uma vez (preventDefault), avisa o backend
// (best-effort, com timeout curto pra não travar o app fechando se o backend estiver fora do ar) e
// deixa o quit seguir de verdade na segunda vez.
let quitCleanupDone = false;
app.on("before-quit", (event) => {
  if (quitCleanupDone || !ntActive || !ntRoomId || !ntBackendUrl) return;
  quitCleanupDone = true;
  event.preventDefault();
  const roomId = ntRoomId;
  const backendUrl = ntBackendUrl;
  (async () => {
    try {
      const abort = new AbortController();
      const timeout = setTimeout(() => abort.abort(), 2000);
      await fetch(`${backendUrl}/rooms/${roomId}`, { method: "DELETE", signal: abort.signal }).catch(() => {});
      clearTimeout(timeout);
    } finally {
      stopNativeTransport();
      app.quit();
    }
  })();
});

// Window controls (a janela é frameless — precisa desses comandos vindos do titlebar custom).
// Resolvem a janela que MANDOU o comando (event.sender), não um global — permite ter mais de uma
// janela aberta (ver window:open-test-window) sem uma controlar a outra por engano.
ipcMain.on("window:minimize", (event) => resolveWindow(event)?.minimize());
ipcMain.on("window:toggle-maximize", (event) => {
  const win = resolveWindow(event);
  if (!win) return;
  if (win.isMaximized()) win.unmaximize();
  else win.maximize();
});
ipcMain.handle("window:is-maximized", (event) => resolveWindow(event)?.isMaximized() ?? false);
ipcMain.on("window:close", (event) => resolveWindow(event)?.close());

// Aplica o tamanho/posição/travas do widget — usado tanto ao entrar ao vivo quanto ao voltar de
// um seletor de fonte aberto durante uma troca de fonte ao vivo (mesma forma dos dois casos).
function applyWidgetBounds(mainWindow: BrowserWindow): void {
  // ORDEM IMPORTA no Windows: setSize() enquanto resizable já é false é ignorado silenciosamente
  // em várias versões do Electron/Chromium (setResizable(false) muda o estilo nativo da janela —
  // WS_THICKFRAME — de um jeito que o SetWindowPos do resize seguinte não aplica). Redimensiona
  // PRIMEIRO, só trava resizable DEPOIS — bug real, já apanhado uma vez (não inverter de novo).
  // Pega o monitor onde a janela JÁ está (não sempre o primário) — se o usuário deixou o app no
  // monitor 2, o widget deve aparecer lá também, não "puxar" de volta pro monitor 1.
  const display = screen.getDisplayMatching(mainWindow.getBounds());
  mainWindow.setSize(WIDGET_SIZE.width, WIDGET_SIZE.height);
  mainWindow.setResizable(false);
  // Nível "floating" (padrão de setAlwaysOnTop(true)) ainda fica atrás de outros always-on-top
  // (jogos fullscreen, outros overlays) — "screen-saver" é o nível mais alto que o Electron expõe,
  // fica acima de quase tudo. Também precisa aparecer em todos os workspaces/desktops virtuais e
  // por cima de apps fullscreen (senão some assim que o usuário troca de desktop virtual ou o jogo
  // vai fullscreen exclusivo).
  mainWindow.setAlwaysOnTop(true, "screen-saver");
  mainWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  const x = display.workArea.x + display.workArea.width - WIDGET_SIZE.width - WIDGET_MARGIN;
  const y = display.workArea.y + display.workArea.height - WIDGET_SIZE.height - WIDGET_MARGIN;
  mainWindow.setPosition(Math.round(x), Math.round(y));
}

// Encolhe/restaura a janela quando a transmissão fica ao vivo (widget compacto sempre-no-topo).
// Sem redimensionar à mão nesse modo — tamanho fixo, igual ao overlay de screen share do Discord.
ipcMain.on("window:set-widget-mode", (event, isLive: boolean) => {
  const win = resolveWindow(event);
  if (!win) return;
  if (isLive) {
    if (win.isMaximized()) win.unmaximize();
    if (win.isFullScreen()) win.setFullScreen(false);
    // setSize() é clampado pelo minWidth/minHeight definidos na criação da janela (340x200) —
    // sem abaixar o mínimo primeiro, o widget nunca encolhia de verdade pra 340x140.
    win.setMinimumSize(WIDGET_SIZE.width, WIDGET_SIZE.height);
    applyWidgetBounds(win);
    isWidgetMode = true;
  } else {
    isWidgetMode = false;
    win.setAlwaysOnTop(false);
    win.setVisibleOnAllWorkspaces(false);
    win.setResizable(true);
    win.setMinimumSize(340, 200);
    win.setSize(NORMAL_SIZE.width, NORMAL_SIZE.height);
    win.center();
  }
});

// Expande a janela temporariamente enquanto o seletor de fonte tá aberto — a grade de
// telas/janelas precisa de mais espaço que a janela normal do app pra não ficar espremida.
// Também é usado pra trocar de fonte com a transmissão já ao vivo (a partir do widget).
ipcMain.on("window:set-picker-mode", (event, open: boolean) => {
  const win = resolveWindow(event);
  if (!win) return;
  if (open) {
    // Se vier do modo widget (troca de fonte ao vivo), a janela tá resizable:false — precisa
    // destravar ANTES de redimensionar (mesmo bug de ordem citado em applyWidgetBounds).
    win.setResizable(true);
    win.setAlwaysOnTop(false);
    win.setVisibleOnAllWorkspaces(false);
    win.setSize(PICKER_SIZE.width, PICKER_SIZE.height);
    win.center();
  } else if (isWidgetMode) {
    // Voltando de uma troca de fonte ao vivo — reaplica o widget em vez do tamanho normal.
    applyWidgetBounds(win);
  } else {
    win.setSize(NORMAL_SIZE.width, NORMAL_SIZE.height);
    win.center();
  }
});

// Maximiza a janela ao entrar numa sala pra assistir (mais espaço pra ver o stream) e trava
// resize — ao sair, volta pro tamanho normal centralizado, igual ao picker-mode.
ipcMain.on("window:set-watch-mode", (event, watching: boolean) => {
  const win = resolveWindow(event);
  if (!win) return;
  if (watching) {
    // Mesma ordem cuidadosa do widget: ação de tamanho primeiro, trava resizable depois (ver
    // applyWidgetBounds — setSize()/maximize() pode ser ignorado silenciosamente no Windows se
    // já vier depois de setResizable(false)).
    win.maximize();
    win.setResizable(false);
  } else {
    win.unmaximize();
    win.setResizable(true);
    win.setSize(NORMAL_SIZE.width, NORMAL_SIZE.height);
    win.center();
  }
});

ipcMain.on("tray:set-status", (_event, isLive: boolean, viewerCount: number) => {
  tray?.setToolTip(isLive ? `Screen Share — ao vivo (${viewerCount} espectador${viewerCount === 1 ? "" : "es"})` : "ScreenShare");
});

// Clipboard via Electron nativo — mais confiável que navigator.clipboard quando a janela
// não está em foco (acontece direto no modo widget).
ipcMain.handle("clipboard:write-text", (_event, text: string) => {
  clipboard.writeText(text);
});

// Fontes de captura (monitores/janelas) — substitui o diálogo padrão do getDisplayMedia por
// uma lista que a própria UI do app renderiza, sem passar pela permissão do browser.
ipcMain.handle("capture:list-sources", async () => {
  const sources = await desktopCapturer.getSources({
    types: ["screen", "window"],
    thumbnailSize: { width: 300, height: 200 },
    fetchWindowIcons: true,
  });
  return sources
    .filter((source) => {
      // Janelas sem UI real (utilitários invisíveis tipo helper de tray, processo de shutdown,
      // etc. — Raycast e alguns overlays de driver criam várias dessas) não têm conteúdo visual
      // nenhum pro DWM tirar miniatura — thumbnail vem completamente vazia. Filtra por ISSO
      // (genérico, qualquer app pode ter janelas assim), não por nome de app específico. Telas
      // sempre têm thumbnail válida, não são afetadas.
      if (source.id.startsWith("screen:")) return true;
      return !source.thumbnail.isEmpty();
    })
    .map((source) => ({
      id: source.id,
      name: source.name,
      type: source.id.startsWith("screen:") ? "screen" : ("window" as const),
      thumbnailDataUrl: source.thumbnail.toDataURL(),
      // Ícone do app dono da janela — só existe pra fontes do tipo "window" (fetchWindowIcons:
      // true acima). Discord mostra isso sobre a miniatura, ajuda a reconhecer a janela mais rápido.
      appIconDataUrl: source.appIcon && !source.appIcon.isEmpty() ? source.appIcon.toDataURL() : null,
    }));
});

// Captura nativa (DXGI Desktop Duplication + Direct3D 11) — alternativa ao WGC-via-Chromium do
// `desktopCapturer` acima. Ver docs/NATIVE_CAPTURE.md. Só existe em Windows; carregamento com
// try/catch pra cair de volta pro desktopCapturer padrão em qualquer plataforma/ambiente onde o
// addon não tenha sido compilado (ex.: macOS/Linux, ou build sem as ferramentas de C++).
interface NativeMonitor {
  index: number;
  x: number;
  y: number;
  width: number;
  height: number;
}

interface NativeFrame {
  width: number;
  height: number;
  buffer: Buffer;
  accessLost?: boolean;
  // Device D3D11 morreu de vez (TDR) — diferente de accessLost (sessão de duplicação morta mas
  // device sobrevive, dá pra Stop()+Start() de novo). Aqui NENHUMA chamada D3D11/NVENC seguinte
  // é segura — ver AcquireResult::DeviceLost em CaptureCore.h.
  deviceLost?: boolean;
}

interface NativeCaptureAddon {
  initialize(): boolean;
  listMonitors(): NativeMonitor[];
  start(monitorIndex: number): boolean;
  // Backend WGC (Windows.Graphics.Capture) — captura UMA janela específica em vez do monitor
  // inteiro (DXGI Desktop Duplication, usado por `start()`, não consegue isolar janela). `hwnd`
  // é o handle da janela (extraído do id do desktopCapturer — ver `extractHwndFromSourceId`
  // abaixo). Ver docs/NATIVE_CAPTURE.md §Backend Abstrato / WindowCaptureCore.h.
  startWindow(hwnd: number): boolean;
  stop(): void;
  acquireFrame(timeoutMs: number): NativeFrame | null;
  // Mesma captura, sem o readback GPU→CPU (Map+memcpy de um frame inteiro) — usado pelo loop do
  // transporte nativo, que só precisa da textura composta (encodeCurrentFrame lê ela direto da
  // GPU). Sem width/height/buffer, só accessLost/deviceLost/windowClosed/ok.
  acquireFrameGpuOnly(timeoutMs: number): {
    ok?: boolean;
    accessLost?: boolean;
    deviceLost?: boolean;
    windowClosed?: boolean;
    // Só no caminho de janela (WGC) — janela redimensionou desde o frame anterior. `width`/
    // `height` vêm junto quando `true`. Quem recebe precisa reiniciar o(s) encoder(es) NVENC (não
    // aceitam mudar resolução em sessão) — ver runNativeTransportLoop.
    resized?: boolean;
    width?: number;
    height?: number;
  } | null;
  setCursorEnabled(enabled: boolean): void;
  // Encoder NVENC (Fase 3) — opera sobre a captura já em andamento (mesmo device/dimensões do
  // CaptureCore). Ver addon.cpp: InitEncoder/EncodeCurrentFrame/ForceKeyframe/SetEncoderBitrate.
  // `codec` opcional ("h264"/"hevc", padrão "h264") é o PEDIDO — cascata de fallback interna
  // (EncoderCore::Initialize) pode degradar pra H.264 sozinha (GPU/MFT sem suporte a HEVC).
  // `getActiveCodec()` diz o que realmente ficou ativo depois dessa chamada.
  initEncoder(fps: number, bitrateBps: number, codec?: "h264" | "hevc" | "av1"): boolean;
  // Segundo encoder independente, tier "low" do simulcast (Sprint 27, ver docs/NATIVE_CAPTURE.md
  // Fase 4 "Simulcast") — MESMA resolução do encoder "high" (`initEncoder`), só `fps`/`bitrateBps`
  // mais baixos (perfil fixo, ver SIMULCAST_LOW_* em types/stream.ts). `codec` TEM que ser o
  // mesmo já resolvido pro "high" (`getActiveCodec()`), não faz sentido codec diferente por tier.
  initEncoderLow(fps: number, bitrateBps: number, codec?: "h264" | "hevc" | "av1"): boolean;
  // true quando NVENC não inicializou e caiu pro fallback de software (Media Foundation, ver
  // SoftwareEncoderCore.cpp) — bem mais pesado em CPU, o host quer saber pra avisar o usuário.
  // Reflete só o encoder "high" (o "low" segue a mesma cascata, mas não tem HUD próprio ainda).
  isUsingSoftwareEncoder(): boolean;
  getActiveCodec(): "h264" | "hevc" | "av1";
  destroyEncoder(): void;
  destroyEncoderLow(): void;
  encodeCurrentFrame(): Buffer[];
  encodeCurrentFrameLow(): Buffer[];
  // `tier` (opcional, padrão "high") — qual dos dois encoders forçar keyframe.
  forceKeyframe(tier?: "high" | "low"): void;
  // `forceKeyframe` (opcional, padrão true) — passar `false` no ajuste automático de
  // congestionamento (AIMD): forçar keyframe bem na hora que já tá represado piora em vez de
  // ajudar (bug real medido — ver docs/NATIVE_CAPTURE.md Fase 4 "Congestion control"). `tier`
  // (opcional, padrão "high") — cada tier tem seu próprio AIMD independente agora.
  setEncoderBitrate(bitrateBps: number, forceKeyframe?: boolean, tier?: "high" | "low"): boolean;
  // Transporte nativo (libdatachannel, Fase 4) — mesclado neste mesmo addon, ver addon.cpp. 1
  // sessão POR ESPECTADOR (`viewerId`, gerado pelo backend na conexão WS — ver
  // backend/src/services/nativeWsRelay.ts) — é o "SFU" do projeto: cada sessão tem um TIER
  // ("high"/"low", Sprint 27/simulcast) e só recebe o frame codificado daquele tier
  // (`transportSendVideoFrame`), fan-out direto em C++.
  // `codec` TEM que ser o codec REALMENTE ativo do encoder (getActiveCodec()), não o pedido —
  // usado pra detectar keyframe certo no bitstream (ver TransportCore.cpp). `tier` (opcional,
  // padrão "high") — todo espectador novo entra em alta qualidade, troca depois via
  // `transportSetViewerTier` (ver "set-quality" no handler de mensagens WS abaixo).
  transportCreateSession(viewerId: string, stunUrls: string[], codec?: "h264" | "hevc" | "av1", tier?: "high" | "low"): boolean;
  // Troca o tier de uma sessão JÁ ATIVA (não recria a conexão WebRTC) — força keyframe no encoder
  // do tier novo pra essa sessão não ficar sem decodificar até o próximo GOP.
  transportSetViewerTier(viewerId: string, tier: "high" | "low"): boolean;
  // Fecha só a sessão desse espectador — os outros continuam recebendo o stream.
  transportCloseSession(viewerId: string): void;
  // Fecha TODAS as sessões — usado só ao parar a transmissão inteira, não no ciclo normal de um
  // espectador saindo.
  transportCloseAllSessions(): void;
  transportAddVideoChannel(viewerId: string): boolean;
  transportCreateOffer(viewerId: string): boolean;
  transportSetRemoteDescription(viewerId: string, sdp: string, type: string): boolean;
  transportAddRemoteCandidate(viewerId: string, candidate: string, mid: string): boolean;
  transportIsConnected(viewerId: string): boolean;
  // Quantos espectadores estão com sessão conectada agora (todos os tiers somados) — usado pro
  // contador no LiveCard.
  transportConnectedCount(): number;
  // Maior `bufferedAmount()` (bytes represados esperando a rede escoar) entre as sessões
  // conectadas de UM tier (`tier`, opcional, padrão "high") — sinal de congestionamento pro
  // bitrate adaptativo DAQUELE tier (ver docs/NATIVE_CAPTURE.md Fase 4 "Congestion control"/
  // "Simulcast" — cada tier tem AIMD independente agora). 0 = ninguém conectado nesse tier ou tudo
  // escoando bem.
  transportMaxBufferedAmount(tier?: "high" | "low"): number;
  // `tier` diz de qual encoder veio esse frame — só é mandado pras sessões daquele tier.
  transportSendVideoFrame(tier: "high" | "low", data: Buffer, timestampUs: number): boolean;
  // Callbacks GLOBAIS (registrados 1x, não por sessão) — `viewerId` sempre vem primeiro, pra
  // saber de qual espectador é a mensagem (ver addon.cpp, `g_on*Tsfn`).
  transportOnLocalDescription(callback: (viewerId: string, sdp: string, type: string) => void): void;
  transportOnLocalCandidate(callback: (viewerId: string, candidate: string, mid: string) => void): void;
  transportOnStateChange(callback: (viewerId: string, state: string) => void): void;

  // Áudio (WASAPI process-loopback + Opus, ver AudioCaptureCore.h) — `excludeProcessName`
  // (opcional) = nome do executável a excluir da captura (ex.: "Discord.exe", pedido direto do
  // usuário: já tá na call, ouviria a própria voz 2x se o áudio dele saísse pela transmissão
  // também). Sem argumento, cai pro loopback normal (dispositivo padrão inteiro, sem exclusão).
  initAudioCapture(excludeProcessName?: string): { ok: boolean; excludedPid: number };
  // Caminho de JANELA — INCLUDE em vez de EXCLUDE: só a árvore de processos dona do HWND sai na
  // transmissão (ver AudioCaptureCore::InitializeForWindow). Usado quando a fonte é uma janela
  // específica, não o monitor inteiro (`ntHwnd` != null).
  initAudioCaptureForWindow(hwnd: number): { ok: boolean };
  destroyAudioCapture(): void;
  // 0+ pacotes Opus prontos (o core acumula PCM internamente até fechar um frame de 20ms) —
  // chamado do mesmo loop que já poll vídeo.
  pollAudioPackets(): Buffer[];
  transportAddAudioChannel(viewerId: string): boolean;
  // Áudio não tem tier — manda pra TODAS as sessões que abriram canal de áudio.
  transportSendAudioFrame(data: Buffer, timestampUs: number): boolean;
  // Diagnóstico (ver AudioCaptureCore::LastRms) — amplitude média do PCM cru capturado desde o
  // último poll. Só pra validar ao vivo se um filtro de processo (exclude/include) tá cortando de
  // verdade, não é usado pra nada além de log.
  getAudioRms(): number;
}

let nativeCapture: NativeCaptureAddon | null = null;
try {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  nativeCapture = require(join(__dirname, "../../native/capture-core/build/Release/capture_core.node"));
  if (!nativeCapture?.initialize()) {
    console.error("[native-capture] initialize() retornou false — addon carregou mas D3D11/DXGI falhou.");
    nativeCapture = null;
  } else {
    console.log("[native-capture] addon carregado e inicializado com sucesso.");
  }
} catch (err) {
  console.error("[native-capture] falha ao carregar o addon nativo, caindo pra desktopCapturer:", err);
  nativeCapture = null;
}

let captureFramePort: MessagePortMain | null = null;
let capturing = false;
// Contadores de estatística — resetados a cada `start()`, reportados pro renderer 1x/segundo
// (frequência baixa demais pra justificar o MessagePort de frames; vai por `webContents.send`
// normal mesmo).
let framesSinceStats = 0;
let timeoutsSinceStats = 0;
let lastStatsAt = 0;

function stopNativeCapture(): void {
  capturing = false;
  if (captureFramePort) {
    captureFramePort.close();
    captureFramePort = null;
  }
  nativeCapture?.stop();
}

ipcMain.handle("native-capture:available", () => !!nativeCapture);

ipcMain.handle("native-capture:list-monitors", () => nativeCapture?.listMonitors() ?? []);

ipcMain.on("native-capture:set-cursor-enabled", (_event, enabled: boolean) => {
  nativeCapture?.setCursorEnabled(enabled);
});

// Loop de captura recursivo via setImmediate, NÃO setInterval de cadência fixa — testado em
// produção: com setInterval(cb, ~17ms) mirando 60fps, se `acquireFrame` retornasse ANTES do
// timeout (frame já pronto), o processo ficava ocioso esperando o próximo tick agendado em vez
// de já pedir o próximo frame — desperdiçando tempo morto entre capturas e limitando o FPS real
// abaixo do que o DXGI conseguiria entregar. `AcquireNextFrame` já bloqueia até `timeoutMs`
// esperando frame novo (ou retorna na hora se já tem um pronto), então reagendar assim que a
// chamada anterior volta já respeita o ritmo real de entrega sem dormir tempo extra à toa.
function runCaptureLoop(monitorIndex: number, win: BrowserWindow, timeoutMs: number): void {
  if (!capturing || !nativeCapture || !captureFramePort) return;

  const frame = nativeCapture.acquireFrame(timeoutMs);

  if (frame?.accessLost) {
    // Sessão de duplicação morreu (troca de resolução, prompt de UAC, GPU resetou) — tenta
    // recriar sozinho antes de desistir e avisar o renderer.
    nativeCapture.stop();
    if (!nativeCapture.start(monitorIndex)) {
      win.webContents.send("native-capture:error", "Captura nativa perdeu acesso ao monitor.");
      stopNativeCapture();
      return;
    }
  } else if (frame) {
    framesSinceStats++;

    // `frame.buffer` é um Buffer do Node — `.buffer` é o ArrayBuffer por trás dele. Buffers desse
    // tamanho (múltiplos MB) nunca vêm do pool interno do Node (só objetos pequenos, <4KB, são
    // fatiados de um pool compartilhado), então byteOffset é sempre 0 aqui — ainda assim uma
    // pequena verificação evita mandar lixo se isso mudar de comportamento algum dia.
    //
    // `MessagePortMain.postMessage` (lado Node/main) só aceita OUTROS MessagePortMain na lista de
    // transferência — não ArrayBuffer como o `postMessage` de browser normal. O ArrayBuffer ainda
    // atravessa via structured clone automático do Electron, só não é um transfer sem cópia; dado
    // o resto do pipeline já ter uma cópia GPU→CPU, mais uma cópia aqui é aceitável por agora.
    const buffer =
      frame.buffer.byteOffset === 0
        ? frame.buffer.buffer
        : frame.buffer.buffer.slice(frame.buffer.byteOffset, frame.buffer.byteOffset + frame.buffer.byteLength);

    captureFramePort.postMessage({ width: frame.width, height: frame.height, buffer });
  } else {
    // `frame === null` = timeout normal (tela sem mudança) — não é erro, só não tinha frame novo.
    timeoutsSinceStats++;
  }

  const now = Date.now();
  if (now - lastStatsAt >= 1000) {
    win.webContents.send("native-capture:stats", { fps: framesSinceStats, timeouts: timeoutsSinceStats });
    framesSinceStats = 0;
    timeoutsSinceStats = 0;
    lastStatsAt = now;
  }

  setImmediate(() => runCaptureLoop(monitorIndex, win, timeoutMs));
}

// `MessageChannelMain` em vez de mandar cada frame por `ipcMain`/`webContents.send` — frame de
// 1080p BGRA é ~8MB; serializar isso a 30-60x por segundo pelo canal de IPC normal (que faz
// structured clone) reintroduziria o mesmo tipo de bloqueio que travou o app na tentativa anterior
// de captura nativa (docs/POC-NATIVE-CAPTURE.md, arquivado). Transferir um ArrayBuffer por um
// MessagePort é só troca de dono do buffer, sem cópia de serialização.
ipcMain.on("native-capture:start", (event, monitorIndex: number, targetFps: number) => {
  if (!nativeCapture) return;
  const win = resolveWindow(event);
  if (!win) return;

  stopNativeCapture();

  if (!nativeCapture.start(monitorIndex)) {
    win.webContents.send("native-capture:error", "Falha ao iniciar a captura nativa desse monitor.");
    return;
  }

  const { port1, port2 } = new MessageChannelMain();
  captureFramePort = port1;
  // MessagePortMain enfileira (ou descarta) mensagens até start() ser chamado explicitamente —
  // sem isso, todo postMessage() abaixo simplesmente nunca chega no outro lado, sem erro nenhum.
  captureFramePort.start();
  win.webContents.postMessage("native-capture:port", null, [port2]);

  capturing = true;
  framesSinceStats = 0;
  timeoutsSinceStats = 0;
  lastStatsAt = Date.now();
  const timeoutMs = Math.max(1, Math.round(1000 / Math.max(1, targetFps)));
  setImmediate(() => runCaptureLoop(monitorIndex, win, timeoutMs));
});

ipcMain.on("native-capture:stop", () => stopNativeCapture());

// Transporte nativo (libdatachannel, ver docs/NATIVE_CAPTURE.md Fase 4) — caminho opt-in que
// substitui LiveKit pro vídeo: DXGI (captura) → NVENC (encode, mesmo device, zero-copy) → RTP H.264
// direto pro espectador, sem o encoder por software do Chromium no meio (gargalo medido em
// produção: `qualityLimitationReason: "cpu"` sob carga de jogo). V1 = 1 espectador (sem SFU
// próprio ainda — `TransportCore` já modela 1 sessão por espectador, mas só uma é usada aqui).
//
// Mesclado no MESMO addon que a captura/encoder (era `transport-core` separado) — motivo
// histórico: uma tentativa de rodar captura+encode+envio inteiros numa thread nativa própria
// (StreamWorker) precisava chamar `TransportCore::SendVideoFrame` direto em C++, sem cruzar N-API
// por frame. Essa thread nunca virou o caminho de produção de verdade (o stutter que motivou ela
// era outro bug, já corrigido — ver docs/NATIVE_CAPTURE.md) e foi removida (Sprint 30), mas o
// addon continua mesclado (1 `.node` só) — sem motivo pra desfazer isso agora. O loop de
// captura+encode+envio roda mesmo é em JS (`runNativeTransportLoop` abaixo, via `setImmediate`),
// só a sinalização (SDP/ICE) cruza pra JS via `ThreadSafeFunction`.

interface NativeTransportStartArgs {
  roomId: string;
  backendUrl: string;
  // Exatamente UM dos dois — monitor inteiro (DXGI) ou janela específica (WGC). O renderer decide
  // qual mandar (`nativeMonitorIndex` só existe em fontes tipo "screen", `hwnd` só em "window" —
  // ver SourcePicker.tsx/capture.ts).
  monitorIndex?: number;
  hwnd?: number;
  targetFps: number;
  bitrateBps: number;
  stunUrls: string[];
  showCursor: boolean;
  // Opcional (padrão "h264") — PEDIDO, não garantia (ver `getActiveCodec()`/cascata de fallback
  // em EncoderCore::Initialize, docs/NATIVE_CAPTURE.md Fase 3 "HEVC").
  codec?: "h264" | "hevc" | "av1";
}

ipcMain.handle("native-transport:available", () => !!nativeCapture);

let ntActive = false;
let ntStatsInterval: ReturnType<typeof setInterval> | null = null;
// Sala/backend da transmissão nativa ativa — guardado só pra poder avisar o backend (DELETE) se o
// app fechar com uma transmissão no ar. Ver app.on("before-quit") mais abaixo: caminho nativo não
// tem NENHUMA rede de segurança do lado do backend (diferente do LiveKit, que detecta o host
// caindo via webhook + TTL) — sem isso aqui, fechar o app com a sala aberta deixava ela presa pra
// sempre (bug real, sala continuava aparecendo em "Assistir" depois do app fechado).
let ntRoomId: string | null = null;
let ntBackendUrl: string | null = null;
// WS de sinalização ativo (host) — UMA conexão pra transmissão inteira (não por espectador). Cada
// espectador negocia sua própria sessão TransportCore por cima dessa mesma conexão, roteado por
// `viewerId` (ver backend/src/services/nativeWsRelay.ts). Substitui o REST+polling antigo.
let ntWs: WebSocket | null = null;
let ntStunUrls: string[] = [];
// Guardados pra poder reiniciar o encoder em H.264 e recriar sessão sem precisar re-plumbar esses
// valores — ver o fallback de "viewer não decodifica HEVC" no handler de mensagens do WS abaixo.
let ntTargetFps = 30;
let ntBitrateBps = 0;
// Perfil FIXO do tier "low" do simulcast — hoisted pro escopo do módulo (era `const` local dentro
// do handler "native-transport:start") porque o handler novo de troca de fonte ao vivo
// ("native-transport:swap-source") também precisa reinicializar o encoder "low" e vive fora
// daquele closure.
const SIMULCAST_LOW_BITRATE_BPS = 800_000;
const SIMULCAST_LOW_FPS = 15;
// Guardado só pra poder re-Start() a mesma fonte depois de um `accessLost` (DXGI) — ver
// `runNativeTransportLoop`. Exatamente um dos dois é não-nulo por vez (mesma regra de
// `NativeTransportStartArgs`). Captura de janela nunca dá `accessLost` (só `windowClosed`,
// tratado como erro definitivo), então esse restart só se aplica quando `ntMonitorIndex` !== null.
let ntMonitorIndex: number | null = null;
let ntHwnd: number | null = null;

// `monitorIndex` OU `hwnd` (nunca os dois) — decide o backend nativo certo (DXGI/monitor vs
// WGC/janela, ver addon.cpp `Start`/`StartWindow`).
function startNativeCaptureSource(monitorIndex?: number, hwnd?: number): boolean {
  if (!nativeCapture) return false;
  if (hwnd !== undefined) return nativeCapture.startWindow(hwnd);
  if (monitorIndex !== undefined) return nativeCapture.start(monitorIndex);
  return false;
}
// Codec ATIVO agora (pode ter degradado de HEVC pra H.264 em qualquer momento — cascata de
// fallback do encoder, ou fallback por decode do primeiro viewer). Toda sessão NOVA usa esse
// valor. Só tenta o fallback HEVC→H.264 UMA vez por transmissão.
let ntActiveCodec: "h264" | "hevc" | "av1" = "h264";
let ntCodecFallbackDone = false;

// Áudio nativo (ver AudioCaptureCore.h) — pedido do usuário: nome do processo cujo áudio NUNCA
// deve sair pela transmissão (excluído do loopback de sistema). Discord é o caso de uso real
// (compartilhar tela DURANTE uma call), mas usuário com "NVIDIA Broadcast" configurado como
// dispositivo de SAÍDA do Discord (efeitos de áudio/remoção de eco) faz TODO o áudio do Discord
// (incluindo voz de call) ser renderizado de verdade pelo processo do Broadcast, não pelo
// Discord.exe — Discord só manda pro dispositivo VIRTUAL do Broadcast, quem realmente toca no
// dispositivo físico (o que o loopback de sistema enxerga) é o Broadcast. Excluir só "Discord.exe"
// nesse setup não pega nada (confirmado com log real: `audioRms` subia com a voz do amigo mesmo
// com a exclusão "ativa"). Lista de candidatos tentados em ordem — primeiro que resolver um PID
// de verdade é o usado; sem UI pra escolher ainda, próximo passo se precisar de mais casos.
const NATIVE_AUDIO_EXCLUDE_CANDIDATES = ["NVIDIA Broadcast.exe", "Discord.exe"];
let ntAudioActive = false;

function stopNativeTransport(): void {
  ntActive = false;
  ntWs?.close();
  ntWs = null;
  if (ntStatsInterval) clearInterval(ntStatsInterval);
  ntStatsInterval = null;
  nativeCapture?.transportCloseAllSessions();
  nativeCapture?.destroyEncoder();
  nativeCapture?.destroyEncoderLow();
  nativeCapture?.destroyAudioCapture();
  ntAudioActive = false;
  nativeCapture?.stop();
  ntRoomId = null;
  ntBackendUrl = null;
}

// WS pode ainda não estar "open" na hora — enfileira via `once("open", ...)` nesse caso raro em
// vez de perder a mensagem.
function sendWhenOpen(ws: WebSocket, payload: Record<string, unknown>): void {
  const json = JSON.stringify(payload);
  if (ws.readyState === WebSocket.OPEN) ws.send(json);
  else ws.once("open", () => ws.send(json));
}

// Cria a sessão TransportCore de UM espectador (viewerId) e manda o offer dele — chamado toda vez
// que o backend avisa `{type:"viewer-joined"}` (espectador novo entrando OU um já conectado antes
// que precisa negociar de novo com um host reconectado). Diferente do V1 (1 sessão global), isso
// nunca derruba os outros espectadores — cada um vive/morre independente.
function createViewerSession(viewerId: string, tier: "high" | "low" = "high"): boolean {
  if (!nativeCapture) return false;
  if (!nativeCapture.transportCreateSession(viewerId, ntStunUrls, ntActiveCodec, tier)) return false;
  if (!nativeCapture.transportAddVideoChannel(viewerId)) return false;
  // Canal de áudio é OPCIONAL — só existe se a captura de áudio nativa foi inicializada com
  // sucesso (`ntAudioActive`). Falhar em adicionar não derruba a sessão (espectador continua
  // recebendo vídeo mudo, mesmo comportamento de antes do áudio nativo existir).
  if (ntAudioActive) nativeCapture.transportAddAudioChannel(viewerId);
  if (!nativeCapture.transportCreateOffer(viewerId)) return false;
  return true;
}

ipcMain.handle("native-transport:start", async (event, args: NativeTransportStartArgs): Promise<boolean> => {
  if (!nativeCapture) return false;
  const win = resolveWindow(event);
  if (!win) return false;

  stopNativeTransport();
  stopNativeCapture(); // caminho antigo (raw frame → LiveKit) e o nativo não rodam ao mesmo tempo — os dois disputam o mesmo CaptureCore singleton.

  const { roomId, backendUrl, monitorIndex, hwnd, targetFps, bitrateBps, stunUrls, showCursor, codec } = args;
  ntRoomId = roomId;
  ntBackendUrl = backendUrl;
  ntTargetFps = targetFps;
  ntBitrateBps = bitrateBps;
  ntStunUrls = stunUrls;
  ntCodecFallbackDone = false;
  ntMonitorIndex = monitorIndex ?? null;
  ntHwnd = hwnd ?? null;

  if (!startNativeCaptureSource(monitorIndex, hwnd)) return false;
  nativeCapture.setCursorEnabled(showCursor);
  if (!nativeCapture.initEncoder(targetFps, bitrateBps, codec ?? "h264")) {
    nativeCapture.stop();
    return false;
  }
  // Codec REALMENTE ativo pode ter degradado do pedido (cascata de fallback dentro do addon) —
  // nunca assume que o pedido foi atendido, lê de volta.
  ntActiveCodec = nativeCapture.getActiveCodec();
  // Avisa o renderer se caiu pro fallback de software (NVENC indisponível) e/ou codec degradou —
  // bem mais pesado em CPU o primeiro, e o usuário pediu HEVC mas ganhou H.264 no segundo (ver
  // docs/NATIVE_CAPTURE.md Fase 3 "Fallback de encoder por software"/"HEVC").
  win.webContents.send("native-transport:encoder", { software: nativeCapture.isUsingSoftwareEncoder(), codec: ntActiveCodec });

  // Áudio nunca bloqueia a transmissão — se falhar (dispositivo indisponível, sem áudio nenhum
  // ativo no sistema, WASAPI ocupado por outro app em modo exclusivo, etc.), a transmissão
  // continua só com vídeo, mesmo comportamento de antes do áudio nativo existir.
  //
  // Compartilhamento de JANELA (`hwnd`) usa INCLUDE (só o áudio daquele app específico) — pedido
  // do usuário: isolar o som da janela em destaque, mais preciso que excluir o Discord (também já
  // resolve o caso Discord automaticamente, sem precisar de exclusão nenhuma nesse caminho).
  // Monitor inteiro continua no modo EXCLUDE (Discord), única opção que faz sentido quando a
  // transmissão é a tela toda.
  if (hwnd !== undefined) {
    const audioResult = nativeCapture.initAudioCaptureForWindow(hwnd);
    ntAudioActive = audioResult.ok;
    if (!ntAudioActive) {
      console.warn("[native-transport] captura de áudio nativa (janela) não iniciou — transmissão segue sem áudio.");
    } else {
      console.log("[native-transport] áudio nativo ativo (só a janela compartilhada).");
    }
  } else {
    // Tenta cada candidato em ordem — o PRIMEIRO que resolver um PID de verdade é o usado.
    // `initAudioCapture` recria a sessão a cada tentativa (barato, só ativa uma vez no início da
    // transmissão) — não dá pra saber de antemão qual candidato tá rodando sem tentar.
    let resolvedName: string | null = null;
    let resolvedPid = 0;
    for (const candidate of NATIVE_AUDIO_EXCLUDE_CANDIDATES) {
      const attempt = nativeCapture.initAudioCapture(candidate);
      if (attempt.ok && attempt.excludedPid !== 0) {
        resolvedName = candidate;
        resolvedPid = attempt.excludedPid;
        break;
      }
      nativeCapture.destroyAudioCapture();
    }
    if (resolvedPid === 0) {
      // Nenhum candidato resolveu (nenhum dos apps tava rodando nesse instante) — inicia sem
      // exclusão mesmo assim (loopback normal), não bloqueia a transmissão por causa disso.
      const fallback = nativeCapture.initAudioCapture();
      ntAudioActive = fallback.ok;
      if (ntAudioActive) {
        console.warn(
          `[native-transport] nenhum de [${NATIVE_AUDIO_EXCLUDE_CANDIDATES.join(", ")}] encontrado ao iniciar áudio — captura SEM exclusão (tudo incluído).`,
        );
      } else {
        console.warn("[native-transport] captura de áudio nativa não iniciou — transmissão segue sem áudio.");
      }
    } else {
      ntAudioActive = true;
      console.log(`[native-transport] áudio nativo ativo, excluindo PID ${resolvedPid} (${resolvedName}).`);
    }
  }

  // Encoder do tier "low" (Sprint 27/simulcast, ver docs/NATIVE_CAPTURE.md Fase 4 "Simulcast") —
  // MESMO codec já resolvido pro "high" (nunca teve chance de degradar diferente, mesma
  // GPU/driver), perfil fixo bem mais baixo (`SIMULCAST_LOW_*`, valor espelhado de
  // `renderer/src/types/stream.ts` — main não pode importar de lá, tsconfig.node.json não inclui
  // `src/renderer`). Falha em silêncio (best-effort): sem tier "low", só o "high" funciona, não
  // vale derrubar a transmissão inteira por causa de um tier secundário.
  if (!nativeCapture.initEncoderLow(SIMULCAST_LOW_FPS, SIMULCAST_LOW_BITRATE_BPS, ntActiveCodec)) {
    console.warn("[native-transport] falha ao inicializar encoder do tier 'low' — simulcast fica só com 'high'.");
  }

  // Callbacks GLOBAIS de sinalização (1x, não por sessão) — `viewerId` vem sempre primeiro (ver
  // addon.cpp, `g_on*Tsfn`). Precisam existir ANTES de qualquer `transportCreateSession`.
  nativeCapture.transportOnStateChange((viewerId, state) => {
    win.webContents.send("native-transport:state", {
      viewerId,
      state,
      connectedCount: nativeCapture?.transportConnectedCount() ?? 0,
    });
    if (state === "failed" || state === "closed" || state === "disconnected") {
      // Só derruba a sessão DESSE espectador — os outros continuam recebendo o stream. Diferente
      // do V1 (sessão global única), não tem "renegociação da transmissão inteira" mais: se esse
      // mesmo espectador voltar (F5), o WS dele reconecta com um `viewerId` NOVO e o backend
      // manda `viewer-joined` de novo sozinho.
      nativeCapture?.transportCloseSession(viewerId);
    }
  });
  nativeCapture.transportOnLocalDescription((viewerId, sdp, type) => {
    if (ntWs) sendWhenOpen(ntWs, { type, viewerId, sdp, codec: ntActiveCodec });
  });
  nativeCapture.transportOnLocalCandidate((viewerId, candidate, mid) => {
    if (ntWs) sendWhenOpen(ntWs, { type: "ice", viewerId, candidate, mid });
  });

  // WS de sinalização — UMA conexão pra transmissão inteira, multiplexada por `viewerId` (ver
  // backend/src/services/nativeWsRelay.ts). Substitui o REST+polling antigo por completo.
  const wsUrl = `${backendUrl.replace(/^http/, "ws")}/rooms/${roomId}/native/ws?role=host`;
  const ws = new WebSocket(wsUrl);
  ntWs = ws;

  ws.on("message", (data) => {
    if (!ntActive) return;
    let msg: {
      type?: string;
      viewerId?: string;
      sdp?: string;
      decoderOk?: boolean;
      candidate?: string;
      mid?: string;
      tier?: "high" | "low";
    };
    try {
      msg = JSON.parse(data.toString());
    } catch {
      return; // mensagem malformada — ignora, próxima que chegar tenta de novo
    }
    if (!msg.viewerId) return;

    if (msg.type === "viewer-joined") {
      // Todo espectador novo entra em "high" — troca depois manualmente (seletor de qualidade no
      // player, ver useNativeStream.ts) via "set-quality" abaixo. Ver docs/NATIVE_CAPTURE.md
      // Fase 4 "Simulcast".
      if (!createViewerSession(msg.viewerId, "high")) {
        console.error(`[native-transport] falha ao criar sessão pro espectador ${msg.viewerId}`);
      }
    } else if (msg.type === "set-quality" && (msg.tier === "high" || msg.tier === "low")) {
      // Espectador trocou de qualidade manualmente (Sprint 27/simulcast) — não recria a conexão
      // WebRTC, só religa qual encoder essa sessão passa a receber (força keyframe sozinho, ver
      // TransportSetViewerTier em addon.cpp).
      nativeCapture?.transportSetViewerTier(msg.viewerId, msg.tier);
    } else if (msg.type === "viewer-left") {
      nativeCapture?.transportCloseSession(msg.viewerId);
    } else if (msg.type === "answer" && msg.sdp) {
      // Viewer checou `VideoDecoder.isConfigSupported()` ANTES de responder e reportou que não
      // consegue decodificar HEVC (Chrome só decodifica com suporte de hardware do dispositivo,
      // nem sempre presente — ver docs/NATIVE_CAPTURE.md Fase 3 "HEVC"). O encoder é
      // COMPARTILHADO entre todos os espectadores (1 encode só, fan-out pra N sessões) — só dá
      // pra derrubar pra H.264 globalmente se ainda não tiver NINGUÉM conectado de verdade em
      // HEVC (senão quebraria quem já tá funcionando). Se já tiver, esse espectador específico
      // fica sem vídeo — limitação conhecida do encoder único (SVC/encode duplo resolveria, fora
      // de escopo agora).
      if (ntActiveCodec !== "h264" && msg.decoderOk === false && !ntCodecFallbackDone) {
        const connectedCount = nativeCapture?.transportConnectedCount() ?? 0;
        if (connectedCount === 0) {
          ntCodecFallbackDone = true;
          console.warn(`[native-transport] viewer não decodifica ${ntActiveCodec.toUpperCase()} — reiniciando encoder em H.264.`);
          nativeCapture?.transportCloseSession(msg.viewerId);
          nativeCapture?.destroyEncoder();
          nativeCapture?.initEncoder(ntTargetFps, ntBitrateBps, "h264");
          ntActiveCodec = nativeCapture?.getActiveCodec() ?? "h264";
          win.webContents.send("native-transport:encoder", {
            software: nativeCapture?.isUsingSoftwareEncoder() ?? false,
            codec: ntActiveCodec,
          });
          createViewerSession(msg.viewerId);
          return;
        }
        console.warn(
          `[native-transport] viewer ${msg.viewerId} não decodifica ${ntActiveCodec.toUpperCase()}, mas já tem espectador(es) recebendo ${ntActiveCodec.toUpperCase()} — não dá pra trocar o codec agora.`,
        );
        nativeCapture?.transportCloseSession(msg.viewerId);
        return;
      }
      nativeCapture?.transportSetRemoteDescription(msg.viewerId, msg.sdp, "answer");
    } else if (msg.type === "ice" && msg.candidate) {
      nativeCapture?.transportAddRemoteCandidate(msg.viewerId, msg.candidate, msg.mid ?? "0");
    }
  });

  ws.on("error", (err) => {
    console.error("[native-transport] erro no WebSocket de sinalização:", err);
  });

  ntActive = true;

  // Loop em JS (setImmediate reagendado a cada volta) em vez de StreamWorker (thread nativa) —
  // ver docs/NATIVE_CAPTURE.md: a thread nativa não eliminou um stutter residual sob movimento
  // contínuo de tela mesmo depois de vários fixes (pacing, VBV, prioridade MMCSS, timestamp de
  // relógio real) — revertido temporariamente enquanto a causa raiz (provável contenção com
  // threads internas do libdatachannel) não é investigada mais a fundo. Mantém os fixes que JÁ
  // se mostraram corretos independente do loop: pacing 8x, VBV, NonBlockingCall no PLI/state.
  const activeWin = win;
  const timeoutMs = Math.max(1, Math.round(1000 / Math.max(1, targetFps)));
  const startTime = Date.now();

  let dbgAcquired = 0;
  let dbgTimeouts = 0;
  let dbgEncodedPackets = 0;
  let dbgEncodedEmptyCalls = 0;
  let dbgSendOk = 0;
  let dbgSendFail = 0;
  let dbgBytes = 0;
  let dbgLastLog = Date.now();

  // Controle de congestionamento (AIMD) — sem RTP/REMB nesse caminho (vídeo vai por DataChannel,
  // não media track), o sinal disponível é o `bufferedAmount()` do canal SCTP: cresce quando a
  // rede não escoa os frames na velocidade que o encoder produz. Sprint 27/simulcast: CADA TIER
  // tem seu próprio AIMD independente agora (`AimdState` por tier — antes era 1 estado global,
  // fazia sentido só com 1 encoder compartilhado). `ceilingBps` de cada tier é o TETO — nunca sobe
  // além do que foi pedido, só desce sob congestionamento e recupera até o teto quando a rede
  // folga de novo. `transportMaxBufferedAmount(tier)` já filtra só as sessões DAQUELE tier.
  interface AimdState {
    currentBitrateBps: number;
    lowStreak: number;
    highStreak: number;
  }
  const CONGESTION_MIN_BITRATE_BPS = 500_000;
  const CONGESTION_DECREASE_FACTOR = 0.7;
  // Exige 2 ticks ALTOS seguidos (não 1 só) antes de baixar — um pico isolado de bufferedAmount
  // (rajada normal de encode, não congestionamento de verdade) não deve disparar queda de bitrate
  // + keyframe à toa. Ver bug real corrigido: mesmo em loopback local sem congestionamento
  // nenhum, 1 tick alto isolado já disparava reação.
  const CONGESTION_HIGH_STREAK_REQUIRED = 2;
  // Exige alguns ticks seguidos de buffer baixo (não só 1) antes de subir — evita ficar
  // oscilando bitrate pra cima e pra baixo repetidamente com jitter momentâneo.
  const CONGESTION_LOW_STREAK_REQUIRED = 5;

  const ntAimdHigh: AimdState = { currentBitrateBps: bitrateBps, lowStreak: 0, highStreak: 0 };
  const ntAimdLow: AimdState = { currentBitrateBps: SIMULCAST_LOW_BITRATE_BPS, lowStreak: 0, highStreak: 0 };

  // `fps` aqui é o fps de PACING do tier (targetFps pro high, SIMULCAST_LOW_FPS pro low) — usado
  // só pra calcular o watermark (~3 frames de orçamento, igual o VBV do EncoderCore).
  function tickAimd(state: AimdState, tier: "high" | "low", ceilingBps: number, fps: number): void {
    if (!nativeCapture) return;
    const maxBuffered = nativeCapture.transportMaxBufferedAmount(tier);
    const highWatermarkBytes = (state.currentBitrateBps / 8 / Math.max(1, fps)) * 3;
    const isHigh = maxBuffered > highWatermarkBytes;
    state.highStreak = isHigh ? state.highStreak + 1 : 0;

    if (isHigh) {
      state.lowStreak = 0;
      if (state.highStreak >= CONGESTION_HIGH_STREAK_REQUIRED) {
        const next = Math.max(CONGESTION_MIN_BITRATE_BPS, Math.round(state.currentBitrateBps * CONGESTION_DECREASE_FACTOR));
        if (next < state.currentBitrateBps) {
          state.currentBitrateBps = next;
          // `false` — forçar keyframe (bem maior que delta frame) exatamente quando já tá
          // represado piora em vez de ajudar (bug real corrigido — ver docs/NATIVE_CAPTURE.md
          // Fase 4 "Congestion control").
          nativeCapture.setEncoderBitrate(state.currentBitrateBps, false, tier);
          console.warn(`[native-transport:${tier}] congestionamento detectado (buffer=${maxBuffered}B) — bitrate reduzido pra ${state.currentBitrateBps}bps.`);
        }
      }
    } else if (state.currentBitrateBps < ceilingBps) {
      state.lowStreak++;
      if (state.lowStreak >= CONGESTION_LOW_STREAK_REQUIRED) {
        state.lowStreak = 0;
        state.currentBitrateBps = Math.min(ceilingBps, state.currentBitrateBps + Math.round(ceilingBps * 0.1));
        nativeCapture.setEncoderBitrate(state.currentBitrateBps, true, tier);
        console.log(`[native-transport:${tier}] rede recuperada — bitrate subindo pra ${state.currentBitrateBps}bps.`);
      }
    }
  }

  // DEBUG temporário — grava o bitstream H.264 cru (mesmos bytes que vão pro DataChannel) num
  // arquivo, pra validar com ffprobe/ffplay FORA do WebCodecs inteiro. Isola se a corrupção
  // visual já vem do encoder (aparece no dump também) ou só surge no decode/transporte (dump
  // limpo, artefato só no lado do espectador).
  const dumpPath = join(app.getPath("temp"), "native-transport-debug.h264");
  const dumpStream = createWriteStream(dumpPath);
  console.log(`[native-transport] gravando bitstream de debug em: ${dumpPath}`);

  function runNativeTransportLoop(): void {
    if (!ntActive || !nativeCapture) return;

    const frame = nativeCapture.acquireFrameGpuOnly(timeoutMs);
    if (frame?.deviceLost) {
      // Device D3D11 morreu (TDR do driver — comum sob contenção pesada de GPU, jogo 3D +
      // captura+NVENC disputando). Recuperar de verdade exigiria recriar todo o pipeline; por
      // ora só para com segurança em vez de continuar chamando encode/send num device morto
      // (esse era o caminho provável do crash sem log nenhum, medido jogando Rocket League).
      console.error("[native-transport] device D3D11 perdido (TDR) — encerrando a transmissão nativa.");
      activeWin.webContents.send("native-transport:error", "A GPU reiniciou (sobrecarga) e a transmissão precisou parar. Tenta de novo.");
      activeWin.webContents.send("native-transport:ended");
      stopNativeTransport();
      return;
    }
    if (frame?.windowClosed) {
      // Janela fechada pelo usuário (ou processo dono morreu) — diferente do accessLost do DXGI,
      // não tem "recuperar sozinho" possível (a janela escolhida não existe mais).
      console.log("[native-transport] janela capturada foi fechada — encerrando a transmissão nativa.");
      activeWin.webContents.send("native-transport:error", "A janela compartilhada foi fechada. A transmissão precisou parar.");
      activeWin.webContents.send("native-transport:ended");
      stopNativeTransport();
      return;
    }
    if (frame?.resized) {
      // Janela (WGC) redimensionou — bug real reportado pelo usuário: sem reiniciar o(s)
      // encoder(es), o NVENC continuava recebendo textura do tamanho ANTIGO (CopyResource entre
      // tamanhos diferentes) e a transmissão travava num frame congelado. NVENC não aceita mudar
      // resolução numa sessão já ativa — só dá pra destruir e criar de novo. As sessões
      // `TransportCore` já conectadas continuam (não dependem do encoder, só recebem bytes) — o
      // primeiro frame do encoder novo já sai como keyframe sozinho (sessão nova do zero).
      console.log(`[native-transport] janela redimensionou pra ${frame.width}×${frame.height} — reiniciando encoder(es).`);
      nativeCapture.destroyEncoder();
      nativeCapture.destroyEncoderLow();
      if (!nativeCapture.initEncoder(targetFps, bitrateBps, ntActiveCodec)) {
        console.error("[native-transport] falha ao reiniciar encoder após resize — encerrando a transmissão nativa.");
        activeWin.webContents.send("native-transport:error", "A janela mudou de tamanho e o encoder não conseguiu reiniciar. A transmissão precisou parar.");
        activeWin.webContents.send("native-transport:ended");
        stopNativeTransport();
        return;
      }
      if (!nativeCapture.initEncoderLow(SIMULCAST_LOW_FPS, SIMULCAST_LOW_BITRATE_BPS, ntActiveCodec)) {
        console.warn("[native-transport] falha ao reiniciar encoder do tier 'low' após resize — simulcast fica só com 'high'.");
      }
    }
    // Microssegundos reais desde o início (relógio real, não passo fixo por frame) — vídeo E
    // áudio vão por DataChannel, não RTP, então não precisa de unidade de clock 90kHz nem de
    // relógios separados entre os dois.
    const timestampUs = (Date.now() - startTime) * 1000;

    if (frame?.accessLost) {
      // Só o backend de monitor (DXGI) dá accessLost — o de janela (WGC) nunca. `ntMonitorIndex`
      // sempre não-nulo aqui.
      nativeCapture.stop();
      if (!startNativeCaptureSource(ntMonitorIndex ?? undefined, undefined)) {
        activeWin.webContents.send("native-transport:ended");
        stopNativeTransport();
        return;
      }
    } else if (frame) {
      dbgAcquired++;
      // Simulcast (Sprint 27) — codifica os DOIS tiers a partir do MESMO frame capturado, cada
      // encoder pacia sozinho pro seu próprio fps (o "low" naturalmente descarta a maioria das
      // chamadas, já que foi inicializado com SIMULCAST_LOW_FPS bem menor que targetFps).
      const packetsHigh = nativeCapture.encodeCurrentFrame();
      const packetsLow = nativeCapture.encodeCurrentFrameLow();
      if (packetsHigh.length === 0) dbgEncodedEmptyCalls++;
      for (const packet of packetsHigh) {
        dbgEncodedPackets++;
        dbgBytes += packet.length;
        dumpStream.write(packet); // dump de debug só do tier "high" (investigação de aberração cromática já em andamento)
        const ok = nativeCapture.transportSendVideoFrame("high", packet, timestampUs);
        if (ok) dbgSendOk++;
        else dbgSendFail++;
      }
      for (const packet of packetsLow) {
        nativeCapture.transportSendVideoFrame("low", packet, timestampUs);
      }
    } else {
      dbgTimeouts++;
    }

    // Áudio poll a cada volta do loop (mesmo ritmo do vídeo, sem timer/thread própria) — o
    // `AudioCaptureCore` já acumula PCM internamente e só devolve pacote quando fecha um frame
    // Opus de 20ms, então isso pode devolver 0, 1 ou vários pacotes por chamada.
    if (ntAudioActive) {
      const audioPackets = nativeCapture.pollAudioPackets();
      for (const packet of audioPackets) {
        nativeCapture.transportSendAudioFrame(packet, timestampUs);
      }
    }

    const now = Date.now();
    if (now - dbgLastLog >= 1000) {
      const maxBufferedHigh = nativeCapture.transportMaxBufferedAmount("high");
      // `audioRms` só existe se a captura de áudio nativa tá ativa (`ntAudioActive`) — diagnóstico
      // pra confirmar AO VIVO se o filtro de processo (exclude/include) tá cortando de verdade:
      // deveria ficar perto de 0 quando só a voz excluída/fora-da-inclusão toca, e subir quando
      // uma fonte DENTRO do filtro toca.
      const audioRms = ntAudioActive ? nativeCapture.getAudioRms().toFixed(5) : "off";
      console.log(
        `[native-transport] acquired=${dbgAcquired} timeouts=${dbgTimeouts} encodedPackets=${dbgEncodedPackets} emptyEncodeCalls=${dbgEncodedEmptyCalls} sendOk=${dbgSendOk} sendFail=${dbgSendFail} bytes=${dbgBytes} viewersConnected=${nativeCapture.transportConnectedCount()} bitrateHighBps=${ntAimdHigh.currentBitrateBps} bitrateLowBps=${ntAimdLow.currentBitrateBps} maxBufferedHigh=${maxBufferedHigh} audioRms=${audioRms}`,
      );
      dbgAcquired = dbgTimeouts = dbgEncodedPackets = dbgEncodedEmptyCalls = dbgSendOk = dbgSendFail = dbgBytes = 0;
      dbgLastLog = now;

      // AIMD: decréscimo multiplicativo rápido sob congestionamento, recuperação aditiva lenta —
      // mesmo espírito de TCP/qualquer congestion control clássico. Cada tier roda o SEU (Sprint
      // 27/simulcast) — `tickAimd` já lê `transportMaxBufferedAmount` do tier certo por dentro.
      tickAimd(ntAimdHigh, "high", bitrateBps, targetFps);
      tickAimd(ntAimdLow, "low", SIMULCAST_LOW_BITRATE_BPS, SIMULCAST_LOW_FPS);
    }

    setImmediate(runNativeTransportLoop);
  }
  setImmediate(runNativeTransportLoop);

  return true;
});

ipcMain.handle("native-transport:stop", async () => {
  stopNativeTransport();
});

// Liga/desliga cursor NA HORA (não só no instante em que a transmissão começou) — pedido do
// usuário depois de notar que o toggle "Mostrar cursor" não tinha efeito nenhum durante uma
// transmissão de janela já ativa (WGC só aplicava a preferência na criação da sessão; monitor/DXGI
// já conseguia tecnicamente, só não tinha nenhuma UI que chamasse isso ao vivo).
ipcMain.handle("native-transport:set-cursor", (_event, enabled: boolean) => {
  nativeCapture?.setCursorEnabled(enabled);
});

// Troca de fonte AO VIVO no pipeline nativo (monitor↔monitor, janela↔janela, ou monitor↔janela) —
// antes bloqueado com um aviso fixo ("ainda não é suportado"). Mesma técnica do fix de resize
// (Sprint 33): para a captura+encoder atuais, troca pra fonte nova, reinicializa o(s) encoder(es)
// com o tamanho da fonte nova (`ActiveWidth/Height` em addon.cpp já lê isso sozinho da fonte ATIVA
// no momento). As sessões `TransportCore` já conectadas continuam — não dependem da captura, só
// recebem bytes do encoder; o primeiro frame do encoder novo já sai como keyframe (sessão do zero).
ipcMain.handle(
  "native-transport:swap-source",
  (_event, args: { monitorIndex?: number; hwnd?: number; showCursor: boolean }): boolean => {
    if (!nativeCapture || !ntActive) return false;

    nativeCapture.stop();
    nativeCapture.destroyEncoder();
    nativeCapture.destroyEncoderLow();

    if (!startNativeCaptureSource(args.monitorIndex, args.hwnd)) return false;
    nativeCapture.setCursorEnabled(args.showCursor);
    ntMonitorIndex = args.monitorIndex ?? null;
    ntHwnd = args.hwnd ?? null;

    if (!nativeCapture.initEncoder(ntTargetFps, ntBitrateBps, ntActiveCodec)) return false;
    if (!nativeCapture.initEncoderLow(SIMULCAST_LOW_FPS, SIMULCAST_LOW_BITRATE_BPS, ntActiveCodec)) {
      console.warn("[native-transport] falha ao reiniciar encoder do tier 'low' após troca de fonte — simulcast fica só com 'high'.");
    }
    return true;
  },
);
