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

const ICON_PATH = join(__dirname, "../../build/icon.png");

const NORMAL_SIZE = { width: 440, height: 720 };
const WIDGET_SIZE = { width: 340, height: 140 };
const WIDGET_MARGIN = 24;
const PICKER_SIZE = { width: 720, height: 640 };

let mainWindow: BrowserWindow | null = null;
let tray: Tray | null = null;
// O seletor de fonte fecha (e tenta restaurar o tamanho normal) assim que o usuário escolhe uma
// fonte — mas a captura/publish ainda leva um tempo pra terminar depois disso. Se a transmissão
// já tiver ficado ao vivo nesse meio tempo, o fechamento do seletor não pode desfazer o widget.
let isWidgetMode = false;

function createWindow(): void {
  mainWindow = new BrowserWindow({
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
    },
  });

  mainWindow.on("ready-to-show", () => mainWindow?.show());

  // F12 abre o DevTools — não tem menu padrão nessa janela frameless pra chegar nisso de outro jeito.
  mainWindow.webContents.on("before-input-event", (_event, input) => {
    if (input.type === "keyDown" && input.key === "F12") {
      mainWindow?.webContents.toggleDevTools();
    }
  });

  // Fecha o processo de verdade ao fechar a janela — não deixa pendurado em segundo plano.
  mainWindow.on("closed", () => {
    mainWindow = null;
    app.quit();
  });

  mainWindow.webContents.setWindowOpenHandler((details) => {
    shell.openExternal(details.url);
    return { action: "deny" };
  });

  if (!app.isPackaged && process.env.ELECTRON_RENDERER_URL) {
    mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL);
  } else {
    mainWindow.loadFile(join(__dirname, "../renderer/index.html"));
  }
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
  tray.setContextMenu(
    Menu.buildFromTemplate([
      {
        label: "Abrir",
        click: () => {
          mainWindow?.show();
          mainWindow?.focus();
        },
      },
      { label: "Sair", click: () => app.quit() },
    ]),
  );
}

app.whenReady().then(() => {
  createWindow();
  createTray();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  app.quit();
});

// Window controls (a janela é frameless — precisa desses comandos vindos do titlebar custom).
ipcMain.on("window:minimize", () => mainWindow?.minimize());
ipcMain.on("window:toggle-maximize", () => {
  if (!mainWindow) return;
  if (mainWindow.isMaximized()) mainWindow.unmaximize();
  else mainWindow.maximize();
});
ipcMain.handle("window:is-maximized", () => mainWindow?.isMaximized() ?? false);
ipcMain.on("window:close", () => mainWindow?.close());

// Aplica o tamanho/posição/travas do widget — usado tanto ao entrar ao vivo quanto ao voltar de
// um seletor de fonte aberto durante uma troca de fonte ao vivo (mesma forma dos dois casos).
function applyWidgetBounds(): void {
  if (!mainWindow) return;
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
ipcMain.on("window:set-widget-mode", (_event, isLive: boolean) => {
  if (!mainWindow) return;
  if (isLive) {
    if (mainWindow.isMaximized()) mainWindow.unmaximize();
    if (mainWindow.isFullScreen()) mainWindow.setFullScreen(false);
    // setSize() é clampado pelo minWidth/minHeight definidos na criação da janela (340x200) —
    // sem abaixar o mínimo primeiro, o widget nunca encolhia de verdade pra 340x140.
    mainWindow.setMinimumSize(WIDGET_SIZE.width, WIDGET_SIZE.height);
    applyWidgetBounds();
    isWidgetMode = true;
  } else {
    isWidgetMode = false;
    mainWindow.setAlwaysOnTop(false);
    mainWindow.setVisibleOnAllWorkspaces(false);
    mainWindow.setResizable(true);
    mainWindow.setMinimumSize(340, 200);
    mainWindow.setSize(NORMAL_SIZE.width, NORMAL_SIZE.height);
    mainWindow.center();
  }
});

// Expande a janela temporariamente enquanto o seletor de fonte tá aberto — a grade de
// telas/janelas precisa de mais espaço que a janela normal do app pra não ficar espremida.
// Também é usado pra trocar de fonte com a transmissão já ao vivo (a partir do widget).
ipcMain.on("window:set-picker-mode", (_event, open: boolean) => {
  if (!mainWindow) return;
  if (open) {
    // Se vier do modo widget (troca de fonte ao vivo), a janela tá resizable:false — precisa
    // destravar ANTES de redimensionar (mesmo bug de ordem citado em applyWidgetBounds).
    mainWindow.setResizable(true);
    mainWindow.setAlwaysOnTop(false);
    mainWindow.setVisibleOnAllWorkspaces(false);
    mainWindow.setSize(PICKER_SIZE.width, PICKER_SIZE.height);
    mainWindow.center();
  } else if (isWidgetMode) {
    // Voltando de uma troca de fonte ao vivo — reaplica o widget em vez do tamanho normal.
    applyWidgetBounds();
  } else {
    mainWindow.setSize(NORMAL_SIZE.width, NORMAL_SIZE.height);
    mainWindow.center();
  }
});

// Maximiza a janela ao entrar numa sala pra assistir (mais espaço pra ver o stream) e trava
// resize — ao sair, volta pro tamanho normal centralizado, igual ao picker-mode.
ipcMain.on("window:set-watch-mode", (_event, watching: boolean) => {
  if (!mainWindow) return;
  if (watching) {
    // Mesma ordem cuidadosa do widget: ação de tamanho primeiro, trava resizable depois (ver
    // applyWidgetBounds — setSize()/maximize() pode ser ignorado silenciosamente no Windows se
    // já vier depois de setResizable(false)).
    mainWindow.maximize();
    mainWindow.setResizable(false);
  } else {
    mainWindow.unmaximize();
    mainWindow.setResizable(true);
    mainWindow.setSize(NORMAL_SIZE.width, NORMAL_SIZE.height);
    mainWindow.center();
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
