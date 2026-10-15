// Fallback de codec com espectador já conectado: host transmite em HEVC/AV1, espectador A (com
// suporte) entra e assiste, depois entra B que NÃO decodifica esse codec. Esperado: a transmissão
// inteira cai pra H.264, A reconecta sozinho, os dois recebem vídeo e o host não cai.
// Uso: NODE_PATH=<dir-com-playwright-core>/node_modules node codec-fallback-test.js [hevc|av1]
// (backend :4100 e viewer :5199 rodando, ver SKILL.md)
const path = require("path");
const { _electron, chromium } = require("playwright-core");

const REPO = process.env.OCS_REPO ?? path.resolve(__dirname, "../../../..");
const DESKTOP = path.join(REPO, "desktop");
const BACKEND = process.env.BACKEND ?? "http://127.0.0.1:4100";
const VIEWER = process.env.VIEWER ?? "http://localhost:5199";
const CODEC = process.argv[2] ?? "hevc";

const framesOf = (page) =>
  page.evaluate(() => {
    const v = document.querySelector("video");
    return v ? v.getVideoPlaybackQuality().totalVideoFrames : 0;
  });

(async () => {
  const room = await (await fetch(`${BACKEND}/rooms`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ settings: { resolution: "1080p", fps: 60, quality: "high" }, nativeMode: true }),
  })).json();
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => k !== "ELECTRON_RUN_AS_NODE" && k !== "ELECTRON_RENDERER_URL"));
  const app = await _electron.launch({ executablePath: path.join(DESKTOP, "node_modules/electron/dist/electron.exe"), args: [DESKTOP], env });
  let hostExit = null;
  const hostLog = [];
  app.process().on("exit", (code) => (hostExit = code));
  const collect = (d) => d.toString().split(/\r?\n/).forEach((l) => /cair|decodifica|não-std|ignorada|uncaught/.test(l) && hostLog.push(l));
  app.process().stdout.on("data", collect);
  app.process().stderr.on("data", collect);
  const win = await app.firstWindow();
  await win.waitForLoadState("domcontentloaded");
  await win.evaluate((args) => window.screenshare.nativeTransport.start(args), {
    roomId: room.roomId, backendUrl: BACKEND, monitorIndex: 0, targetFps: 60, bitrateBps: 12_000_000, stunUrls: [], showCursor: true, codec: CODEC,
  });

  const browser = await chromium.launch({ channel: "chrome", headless: false, args: ["--autoplay-policy=no-user-gesture-required"] });
  const a = await browser.newPage();
  await a.goto(`${VIEWER}/s/${room.roomId}`);
  await a.waitForFunction(() => document.querySelector("video")?.videoWidth > 0, null, { timeout: 30000 });
  await a.waitForTimeout(2000);
  console.log(`A assistindo em ${CODEC}: ${await framesOf(a)} frames`);

  const b = await browser.newPage();
  await b.addInitScript((blocked) => {
    const orig = VideoDecoder.isConfigSupported.bind(VideoDecoder);
    VideoDecoder.isConfigSupported = async (c) =>
      (c.codec.startsWith("hev") || c.codec.startsWith("hvc") ? "hevc" : c.codec.startsWith("av01") ? "av1" : "h264") === blocked
        ? { supported: false, config: c }
        : orig(c);
  }, CODEC);
  await b.goto(`${VIEWER}/s/${room.roomId}`);
  let bOk = true;
  await b.waitForFunction(() => document.querySelector("video")?.videoWidth > 0, null, { timeout: 30000 }).catch(() => (bOk = false));
  const a1 = await framesOf(a), b1 = await framesOf(b);
  await a.waitForTimeout(3000);
  const a2 = await framesOf(a), b2 = await framesOf(b);
  console.log(JSON.stringify({ bRecebeuVideo: bOk, framesA_3s: a2 - a1, framesB_3s: b2 - b1, hostVivo: hostExit === null }));
  console.log(hostLog.join("\n"));
  await browser.close();
  if (hostExit === null) {
    await win.evaluate(() => window.screenshare.nativeTransport.stop());
    await app.close();
  }
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
