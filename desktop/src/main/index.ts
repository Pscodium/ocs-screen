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
} from "electron";
import { join } from "path";
import { autoUpdater } from "electron-updater";

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

const NORMAL_SIZE = { width: 440, height: 720 };
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
  return sources.map((source) => ({
    id: source.id,
    name: source.name,
    type: source.id.startsWith("screen:") ? "screen" : ("window" as const),
    thumbnailDataUrl: source.thumbnail.toDataURL(),
    // Ícone do app dono da janela — só existe pra fontes do tipo "window" (fetchWindowIcons:
    // true acima). Discord mostra isso sobre a miniatura, ajuda a reconhecer a janela mais rápido.
    appIconDataUrl: source.appIcon && !source.appIcon.isEmpty() ? source.appIcon.toDataURL() : null,
  }));
});
