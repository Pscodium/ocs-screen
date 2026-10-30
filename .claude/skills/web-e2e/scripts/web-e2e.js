// E2E do caminho WEB: host no Chrome (getDisplayMedia) → LiveKit local → N viewers no Chrome.
// Ver .claude/skills/web-e2e/SKILL.md (variáveis de ambiente, como subir os servidores, referência).
const { chromium } = require("playwright-core");
const { spawn } = require("child_process");
const path = require("path");
const fs = require("fs");

const VIEWER = process.env.VIEWER_URL || "http://localhost:5199";
const BACKEND = process.env.BACKEND_URL || "http://127.0.0.1:4100";
const CHROME = process.env.LOCALAPPDATA + "\\Google\\Chrome\\Application\\chrome.exe";
const RES = process.env.RES || "1080p", FPS = process.env.FPS || "60", QUALITY = process.env.QUALITY || "high";
const VIEWERS = Number(process.env.VIEWERS || 1), SECONDS = Number(process.env.SECONDS || 20);
const MODE = process.env.MODE || "game", SCREEN = process.env.SCREEN || "Screen 1";
// Perfil do Chrome do relógio, screenshots e JSON da série do host — fora do repo.
const OUT = process.env.OUT || path.join(require("os").tmpdir(), "ocs-web-e2e");
fs.mkdirSync(OUT, { recursive: true });
const BG = [`--window-position=${process.env.WINPOS || "1950,40"}`, "--disable-backgrounding-occluded-windows", "--disable-renderer-backgrounding", "--disable-background-timer-throttling", "--lang=en-US"];

const HOOK = (`
window.__pcs = [];
const __HIDE = "HIDEVAL";
if (__HIDE) { const g = RTCRtpSender.getCapabilities.bind(RTCRtpSender); RTCRtpSender.getCapabilities = (k) => { const c = g(k); if (c && k === "video") c.codecs = c.codecs.filter((x) => !__HIDE.split(",").some((h) => x.mimeType.includes(h))); return c; }; }
const __O = window.RTCPeerConnection;
window.RTCPeerConnection = class extends __O { constructor(...a) { super(...a); window.__pcs.push(this); } };
if ("HINTVAL") { const gdm = navigator.mediaDevices.getDisplayMedia.bind(navigator.mediaDevices); navigator.mediaDevices.getDisplayMedia = async (c) => { const st = await gdm(c); st.getVideoTracks()[0].contentHint = "HINTVAL"; return st; }; }
window.__collect = async (kind) => {
  const out = [];
  for (const pc of window.__pcs) {
    if (pc.connectionState === "closed") continue;
    const r = await pc.getStats();
    const codecs = {};
    r.forEach((s) => { if (s.type === "codec") codecs[s.id] = s.mimeType; });
    r.forEach((s) => {
      if (s.type === kind && s.kind === "video") out.push({ ...s, codec: codecs[s.codecId] });
      if (s.type === "candidate-pair" && s.nominated && s.state === "succeeded") out.push({ type: "pair", rtt: s.currentRoundTripTime, out: s.availableOutgoingBitrate, in: s.availableIncomingBitrate });
      if (s.type === "media-source" && s.kind === "video") out.push({ type: "src", fps: s.framesPerSecond, w: s.width, h: s.height });
    });
  }
  return out;
};`).replace('"HIDEVAL"', JSON.stringify(process.env.HIDE || ""));

// Lê o relógio binário do topo do frame + intervalo entre frames apresentados.
const VIEWER_PROBE = `
window.__frames = [];
const CELLS = 26, BAR = 0.07;
const cv = document.createElement("canvas"); cv.width = CELLS * 8; cv.height = 8;
const cx = cv.getContext("2d", { willReadFrequently: true });
function loop(v) {
  v.requestVideoFrameCallback((now, meta) => {
    const vw = v.videoWidth, vh = v.videoHeight;
    let lat = null;
    if (vw && vh) {
      cx.drawImage(v, 0, 0, vw, vh * BAR * 0.8, 0, 0, cv.width, cv.height);
      const px = (i) => { const d = cx.getImageData(i * 8 + 4, 4, 1, 1).data; return (d[0] + d[1] + d[2]) / 3; };
      const black = px(0), white = px(1);
      if (white - black > 120) {
        let t = 0;
        for (let i = 2; i < CELLS; i++) if (px(i) > (black + white) / 2) t |= 1 << (i - 2);
        lat = ((Date.now() % 16777216) - t + 16777216) % 16777216;
      }
    }
    window.__frames.push({ now, lat, w: vw, h: vh });
    loop(v);
  });
}
const wait = setInterval(() => { const v = document.querySelector("video"); if (v && v.videoWidth) { clearInterval(wait); loop(v); } }, 100);`;

const pct = (a, p) => { if (!a.length) return null; const s = [...a].sort((x, y) => x - y); return Math.round(s[Math.min(s.length - 1, Math.floor(p * s.length))] * 10) / 10; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const clock = spawn(CHROME, [`--user-data-dir=${path.join(OUT, "ud-clock")}`, "--kiosk", "--no-first-run", "--window-position=0,0", ...BG.slice(1),
    `file:///${path.join(__dirname, "clock.html").replace(/\\/g, "/")}?mode=${MODE}`], { stdio: "ignore" });
  await sleep(2500);

  const hostB = await chromium.launch({ channel: "chrome", headless: false,
    args: [`--auto-select-desktop-capture-source=${SCREEN}`, "--use-fake-ui-for-media-stream", ...BG, ...(process.env.HOSTARGS ? process.env.HOSTARGS.split(" ") : [])] });
  const host = await (await hostB.newContext({ viewport: { width: 900, height: 900 } })).newPage();
  await host.addInitScript(HOOK);
  host.on("console", (m) => { if (m.type() === "error") console.log("[host err]", m.text().slice(0, 200)); });
  await host.goto(VIEWER);
  const selects = host.locator("select");
  await selects.nth(0).selectOption(RES); await selects.nth(1).selectOption(FPS); await selects.nth(2).selectOption(QUALITY);
  if (process.env.SHARP === "1") await host.locator(".toggle-row input").first().check({ force: true });
  const t0 = Date.now();
  await host.getByRole("button", { name: "Compartilhar tela" }).click();
  await host.locator(".btn-danger").waitFor({ timeout: 20000 });
  const tLive = Date.now() - t0;
  const { rooms } = await (await fetch(`${BACKEND}/rooms`)).json();
  const roomId = rooms[rooms.length - 1].roomId;
  console.log(`room=${roomId} hostLiveIn=${tLive}ms  RES=${RES} FPS=${FPS} Q=${QUALITY} SHARP=${process.env.SHARP || 0} MODE=${MODE} VIEWERS=${VIEWERS}`);
  await host.screenshot({ path: path.join(OUT, "host-live.png") });

  const viewB = await chromium.launch({ channel: "chrome", headless: false, args: ["--autoplay-policy=no-user-gesture-required", ...BG] });
  const viewers = [];
  for (let i = 0; i < VIEWERS; i++) {
    const p = await (await viewB.newContext({ viewport: { width: 1280, height: 720 } })).newPage();
    await p.addInitScript(HOOK); await p.addInitScript(VIEWER_PROBE);
    p.on("console", (m) => { if (m.type() === "error") console.log(`[viewer${i} err]`, m.text().slice(0, 200)); });
    const tv = Date.now();
    await p.goto(`${VIEWER}/s/${roomId}`);
    await p.waitForFunction(() => window.__frames && window.__frames.length > 0, null, { timeout: 20000 });
    if (process.env.PLAYOUT) await p.evaluate((ms) => window.__pcs.forEach((pc) => pc.getReceivers().forEach((r) => (r.playoutDelayHint = ms / 1000))), Number(process.env.PLAYOUT));
    console.log(`viewer${i} firstFrameIn=${Date.now() - tv}ms`);
    viewers.push(p);
  }

  const hostSeries = [], prev = {};
  for (let s = 0; s < SECONDS; s++) {
    await sleep(1000);
    const st = await host.evaluate(() => window.__collect("outbound-rtp"));
    const pair = st.find((x) => x.type === "pair"), src = st.find((x) => x.type === "src");
    const layers = st.filter((x) => x.type === "outbound-rtp").map((o) => {
      const k = o.ssrc, p = prev[k] || o; prev[k] = o;
      const dt = (o.timestamp - p.timestamp) / 1000 || 1, fe = o.framesEncoded - p.framesEncoded;
      return { rid: o.rid ?? "-", res: `${o.frameWidth}x${o.frameHeight}`, fps: o.framesPerSecond ?? 0,
        kbps: Math.round(((o.bytesSent - p.bytesSent) * 8) / dt / 1000), tgt: Math.round((o.targetBitrate ?? 0) / 1000),
        qp: fe > 0 ? Math.round((o.qpSum - p.qpSum) / fe) : null, encMs: fe > 0 ? Math.round(((o.totalEncodeTime - p.totalEncodeTime) / fe) * 10000) / 10 : null,
        lim: o.qualityLimitationReason, impl: o.encoderImplementation, codec: o.codec, active: o.active };
    });
    hostSeries.push({ s, src, pair, layers });
    console.log(`t=${String(s + 1).padStart(2)} src=${src?.fps ?? "?"}fps rtt=${pair ? Math.round(pair.rtt * 1000) : "?"}ms avail=${pair?.out ? Math.round(pair.out / 1000) : "?"}k | ` +
      layers.map((l) => `${l.rid}:${l.res}@${l.fps} ${l.kbps}k/tgt${l.tgt}k qp${l.qp} enc${l.encMs}ms ${l.lim}${l.active === false ? " OFF" : ""}`).join(" | "));
  }

  const hostImpl = hostSeries.at(-1).layers.map((l) => `${l.rid}:${l.codec}/${l.impl}`).join(" ");
  console.log(`\nencoder: ${hostImpl}`);

  for (let i = 0; i < viewers.length; i++) {
    const p = viewers[i];
    const frames = await p.evaluate(() => window.__frames);
    const inb = (await p.evaluate(() => window.__collect("inbound-rtp"))).filter((x) => x.type === "inbound-rtp");
    const half = frames.slice(Math.floor(frames.length / 4));
    const iv = half.slice(1).map((f, k) => f.now - half[k].now);
    const lats = half.map((f) => f.lat).filter((x) => x !== null && x < 5000);
    const span = (half.at(-1).now - half[0].now) / 1000;
    const r = inb[0] || {};
    console.log(`viewer${i}: ${half.at(-1).w}x${half.at(-1).h} presentedFps=${(half.length / span).toFixed(1)} ` +
      `interval p50=${pct(iv, .5)} p95=${pct(iv, .95)} p99=${pct(iv, .99)} max=${pct(iv, 1)}ms stalls>100ms=${iv.filter((x) => x > 100).length} ` +
      `| latency p50=${pct(lats, .5)} p95=${pct(lats, .95)}ms (decoded ${lats.length}/${half.length}) ` +
      `| decoder=${r.decoderImplementation} codec=${r.codec} dropped=${r.framesDropped} freezes=${r.freezeCount}/${Math.round((r.totalFreezesDuration || 0) * 1000)}ms ` +
      `lost=${r.packetsLost} nack=${r.nackCount} pli=${r.pliCount} jb=${r.jitterBufferEmittedCount ? Math.round((r.jitterBufferDelay / r.jitterBufferEmittedCount) * 1000) : "?"}ms`);
    if (i === 0) await p.screenshot({ path: path.join(OUT, "viewer.png") });
  }
  fs.writeFileSync(path.join(OUT, `run-${RES}-${FPS}-${QUALITY}-${MODE}.json`), JSON.stringify({ hostSeries }, null, 1));

  // Encerramento: quanto tempo o viewer leva pra mostrar "encerrada".
  const tEnd = Date.now();
  await host.locator(".btn-danger").click();
  try {
    await viewers[0].getByText("encerrada").waitFor({ timeout: 15000 });
    console.log(`viewer saw end in ${Date.now() - tEnd}ms`);
  } catch { console.log("viewer did NOT show end screen within 15s"); await viewers[0].screenshot({ path: path.join(OUT, "viewer-end.png") }); }

  await viewB.close(); await hostB.close(); clock.kill();
  spawn("taskkill", ["/PID", String(clock.pid), "/T", "/F"]);
})().catch((e) => { console.error(e); process.exit(1); });
