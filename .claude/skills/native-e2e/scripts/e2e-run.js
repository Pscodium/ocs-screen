// E2E do pipeline nativo: host = app desktop real (Electron, via Playwright `_electron`) +
// espectador = viewer real (vite dev) no Chrome instalado, mesma máquina.
//
// Mede no espectador (requestVideoFrameCallback): fps apresentado, engasgos (intervalo entre
// frames apresentados > 2.5x o esperado), latência captura→apresentação (relógio de parede do host,
// ancorado no log "relógio de mídia" do main process, + timestamp do frame). Imprime também as
// últimas linhas de log do loop nativo do host (acquired/encoded/dropped/bitrate/áudio).
//
// Uso (ver SKILL.md pra subir backend/viewer antes):
//   NODE_PATH=<dir-com-playwright-core>/node_modules node e2e-run.js [segundos] [fps]
// Env opcionais:
//   CODEC=h264|hevc|av1   codec pedido ao encoder (padrão h264)
//   ACK_DELAY_TEST=1      atrasa os acks do espectador em 400ms entre t=5s e t=10s (simula fila de
//                         rede) — valida descarte de frame + keyframe + AIMD
//   BACKEND=http://127.0.0.1:4100  VIEWER=http://localhost:5199  MONITOR=0
//   NO_DECODE=hevc,av1   espectador finge NÃO decodificar esses codecs (isConfigSupported → false) —
//                         testa o fallback de codec do host
//   E2E_HOST_LOG=<arquivo> grava o log inteiro do host (com E2E_ALL_LOGS=1, sem filtro)
//   HWND=<handle>         transmite essa JANELA (WGC) em vez do monitor — ex.: a do gamesim
const path = require("path");
const { _electron, chromium } = require("playwright-core");

const REPO = process.env.OCS_REPO ?? path.resolve(__dirname, "../../../..");
const DESKTOP = path.join(REPO, "desktop");
const SECONDS = Number(process.argv[2] ?? 20);
const FPS = Number(process.argv[3] ?? 60);
const BACKEND = process.env.BACKEND ?? "http://127.0.0.1:4100";
const VIEWER = process.env.VIEWER ?? "http://localhost:5199";

// Global pra poder imprimir no erro também (crash do host = o caso mais importante de ver o log).
const hostLog = [];
const viewerLogs = [];
let hostExit = null;

(async () => {
  const res = await fetch(`${BACKEND}/rooms`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ settings: { resolution: "1080p", fps: FPS, quality: "high" }, nativeMode: true }),
  });
  const room = await res.json();
  console.log("sala:", room.roomId);

  // ELECTRON_RUN_AS_NODE vaza do terminal do VS Code/Claude Code — com ele o Electron roda como
  // Node puro e `require("electron")` vira undefined (crash em `crashReporter.start`).
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([k]) => k !== "ELECTRON_RUN_AS_NODE" && k !== "ELECTRON_RENDERER_URL"),
  );
  const app = await _electron.launch({
    executablePath: path.join(DESKTOP, "node_modules/electron/dist/electron.exe"),
    args: [DESKTOP],
    env,
  });
  let wallAnchor = null;
  app.process().on("exit", (code, signal) => (hostExit = { code, signal }));
  const collect = (d) => {
    for (const line of d.toString().split(/\r?\n/)) {
      if (!line.trim()) continue;
      const m = line.match(/relógio de mídia: startUs=(\d+) wallMs=(\d+)/);
      if (m) wallAnchor = Number(m[2]);
      if (/\[native-transport|AudioCaptureCore|EncoderCore|TransportCore|capture-core|uncaught|Error/.test(line) || process.env.E2E_ALL_LOGS) hostLog.push(line);
    }
  };
  app.process().stdout.on("data", collect);
  app.process().stderr.on("data", collect);

  const win = await app.firstWindow();
  await win.waitForLoadState("domcontentloaded");
  const ok = await win.evaluate((args) => window.screenshare.nativeTransport.start(args), {
    roomId: room.roomId,
    backendUrl: BACKEND,
    ...(process.env.HWND ? { hwnd: Number(process.env.HWND) } : { monitorIndex: Number(process.env.MONITOR ?? 0) }),
    targetFps: FPS,
    bitrateBps: 12_000_000,
    stunUrls: [],
    showCursor: true,
    codec: process.env.CODEC ?? "h264",
  });
  console.log("host start:", ok);

  const browser = await chromium.launch({
    channel: "chrome",
    headless: false,
    args: ["--autoplay-policy=no-user-gesture-required", "--window-position=1000,50", "--window-size=900,600"],
  });
  const page = await browser.newPage();
  page.on("console", (msg) => viewerLogs.push(`${msg.type()}: ${msg.text()}`));
  if (process.env.NO_DECODE) {
    await page.addInitScript((blocked) => {
      const orig = VideoDecoder.isConfigSupported.bind(VideoDecoder);
      VideoDecoder.isConfigSupported = async (config) => {
        const kind = config.codec.startsWith("hev") || config.codec.startsWith("hvc") ? "hevc" : config.codec.startsWith("av01") ? "av1" : "h264";
        if (blocked.includes(kind)) return { supported: false, config };
        return orig(config);
      };
    }, process.env.NO_DECODE.split(","));
  }
  if (process.env.ACK_DELAY_TEST) {
    await page.addInitScript(() => {
      window.__ackDelayMs = 0;
      window.__kfRequests = 0;
      const orig = RTCDataChannel.prototype.send;
      RTCDataChannel.prototype.send = function (data) {
        if (data && data.byteLength === 1) window.__kfRequests++;
        if (data && data.byteLength === 8 && window.__ackDelayMs > 0) {
          const copy = data.slice ? data.slice() : data;
          setTimeout(() => {
            try {
              orig.call(this, copy);
            } catch {}
          }, window.__ackDelayMs);
          return;
        }
        return orig.call(this, data);
      };
    });
  }
  await page.goto(`${VIEWER}/s/${room.roomId}`);
  await page.waitForFunction(() => {
    const v = document.querySelector("video");
    return v && v.videoWidth > 0;
  }, null, { timeout: 30000 });
  console.log("espectador recebendo vídeo");

  await page.evaluate(() => {
    const v = document.querySelector("video");
    window.__m = { intervals: [], mediaTimes: [], presentWall: [] };
    let last = null;
    const cb = (now, meta) => {
      if (last !== null) window.__m.intervals.push(now - last);
      last = now;
      window.__m.mediaTimes.push(meta.mediaTime);
      window.__m.presentWall.push(performance.timeOrigin + meta.expectedDisplayTime);
      v.requestVideoFrameCallback(cb);
    };
    v.requestVideoFrameCallback(cb);
  });

  if (process.env.ACK_DELAY_TEST) {
    const presented = () => page.evaluate(() => window.__m.intervals.length);
    let last = await presented();
    for (let s = 0; s < SECONDS; s++) {
      if (s === 5) await page.evaluate(() => (window.__ackDelayMs = 400));
      if (s === 10) await page.evaluate(() => (window.__ackDelayMs = 0));
      await page.waitForTimeout(1000);
      const now = await presented();
      console.log(`t=${s + 1}s ackDelay=${s >= 5 && s < 10 ? 400 : 0} fpsApresentado=${now - last} kfReq=${await page.evaluate(() => window.__kfRequests)}`);
      last = now;
    }
  } else {
    await page.waitForTimeout(SECONDS * 1000);
  }

  const m = await page.evaluate(() => window.__m);
  const expected = 1000 / FPS;
  const iv = m.intervals.slice(30);
  const stutters = iv.filter((x) => x > expected * 2.5).length;
  const sorted = [...iv].sort((a, b) => a - b);
  const pct = (arr, q) => arr[Math.floor(q * (arr.length - 1))]?.toFixed(1);
  // `mediaTime` (s) = timestamp do VideoFrame (µs desde `startUs` do host) / 1e6.
  const lat = [];
  if (wallAnchor !== null) {
    for (let i = 30; i < m.mediaTimes.length; i++) lat.push(m.presentWall[i] - (wallAnchor + m.mediaTimes[i] * 1000));
  }
  lat.sort((a, b) => a - b);
  console.log(
    JSON.stringify({
      framesPresented: m.intervals.length + 1,
      fps: (iv.length / (iv.reduce((a, b) => a + b, 0) / 1000)).toFixed(1),
      intervalMs: { p50: pct(sorted, 0.5), p95: pct(sorted, 0.95), p99: pct(sorted, 0.99), max: pct(sorted, 1) },
      stutters,
      stutterPct: ((stutters / iv.length) * 100).toFixed(2),
      latencyMs: { p5: pct(lat, 0.05), p50: pct(lat, 0.5), p95: pct(lat, 0.95) },
      // Judder: |intervalo entre frames exibidos − intervalo entre os mesmos frames na captura|.
      // Fluidez de movimento = exibir com o MESMO espaçamento em que foi capturado; FPS estável com
      // judder alto é exatamente "60fps mas não parece fluido". Display de 165Hz quantiza em ~6ms.
      judderMs: (() => {
        const j = [];
        for (let i = 31; i < m.mediaTimes.length; i++) {
          const dPresent = m.presentWall[i] - m.presentWall[i - 1];
          const dMedia = (m.mediaTimes[i] - m.mediaTimes[i - 1]) * 1000;
          j.push(Math.abs(dPresent - dMedia));
        }
        j.sort((a, b) => a - b);
        return { p50: pct(j, 0.5), p95: pct(j, 0.95), p99: pct(j, 0.99) };
      })(),
      // latência no último quarto da medição (regime, sem o transitório do começo)
      latencyLastQuarterP50Ms: (() => {
        const tail = [];
        const from = Math.floor(m.mediaTimes.length * 0.75);
        for (let i = from; i < m.mediaTimes.length && wallAnchor !== null; i++) tail.push(m.presentWall[i] - (wallAnchor + m.mediaTimes[i] * 1000));
        tail.sort((a, b) => a - b);
        return pct(tail, 0.5);
      })(),
    }),
  );
  if (wallAnchor !== null) {
    // Latência mediana por segundo de apresentação — mostra transitório de início/picos.
    const perSecond = new Map();
    for (let i = 0; i < m.mediaTimes.length; i++) {
      const sec = Math.floor(m.mediaTimes[i]);
      if (!perSecond.has(sec)) perSecond.set(sec, []);
      perSecond.get(sec).push(m.presentWall[i] - (wallAnchor + m.mediaTimes[i] * 1000));
    }
    const series = [...perSecond.entries()].map(([sec, v]) => {
      v.sort((a, b) => a - b);
      return `${sec}s:${v[Math.floor(v.length / 2)].toFixed(0)}`;
    });
    console.log("latência por segundo (tempo de mídia: ms):", series.join(" "));
  }
  console.log("--- host (últimas linhas) ---\n" + hostLog.slice(-8).join("\n"));
  console.log("--- viewer erros ---\n" + viewerLogs.filter((l) => l.startsWith("error")).slice(-5).join("\n"));

  if (process.env.E2E_HOST_LOG) require("fs").writeFileSync(process.env.E2E_HOST_LOG, hostLog.join("\n"));
  await browser.close();
  await win.evaluate(() => window.screenshare.nativeTransport.stop());
  await app.close();
})().catch((e) => {
  console.error(e);
  console.error("host exit:", JSON.stringify(hostExit));
  console.error("--- viewer console ---\n" + viewerLogs.slice(-15).join("\n"));
  console.error("--- host (últimas linhas) ---\n" + hostLog.slice(-25).join("\n"));
  process.exit(1);
});
