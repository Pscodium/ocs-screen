// Harness do encoder nativo isolado (sem transporte/viewer): mede atraso de saída do NVENC
// (chamada em que sai o 1º pacote — tem que ser 1), pacing (codificados/s vs alvo), tempo de encode,
// e grava o bitstream pra inspecionar com ffprobe (tipos de frame, VUI).
// Uso: ELECTRON_RUN_AS_NODE=1 <desktop>/node_modules/electron/dist/electron.exe enc-test.js <out.h264> [fps] [segundos] [codec]
// Precisa de algo mexendo na tela (monitor 0) — DXGI só entrega frame quando a tela muda.
const path = require("path");
const fs = require("fs");
const REPO = process.env.OCS_REPO ?? path.resolve(__dirname, "../../../..");
const addon = require(path.join(REPO, "desktop/native/capture-core/build/Release/capture_core.node"));

const out = process.argv[2] ?? "out.h264";
const fps = Number(process.argv[3] ?? 60);
const seconds = Number(process.argv[4] ?? 5);
const codec = process.argv[5] ?? "h264";

if (!addon.initialize()) throw new Error("initialize falhou");
if (!addon.start(Number(process.env.MONITOR ?? 0))) throw new Error("start falhou");
if (!addon.initEncoder(fps, 8_000_000, codec)) throw new Error("initEncoder falhou");
console.log("codec ativo:", addon.getActiveCodec(), "software:", addon.isUsingSoftwareEncoder());

const fd = fs.openSync(out, "w");
let acquired = 0, timeouts = 0, encodeCalls = 0, emptyCalls = 0, packets = 0, firstPacketAtCall = -1;
const encodeTimes = [];
const t0 = Date.now();
while (Date.now() - t0 < seconds * 1000) {
  const f = addon.acquireFrameGpuOnly(Math.round(1000 / fps));
  if (!f) { timeouts++; continue; }
  if (!f.ok) { console.log("flags:", f); continue; }
  acquired++;
  const s = process.hrtime.bigint();
  const pk = addon.encodeCurrentFrame();
  encodeTimes.push(Number(process.hrtime.bigint() - s) / 1e6);
  encodeCalls++;
  if (pk.length === 0) emptyCalls++;
  if (pk.length > 0 && firstPacketAtCall < 0) firstPacketAtCall = encodeCalls;
  for (const p of pk) { packets++; fs.writeSync(fd, p); }
}
fs.closeSync(fd);
addon.destroyEncoder();
addon.stop();
encodeTimes.sort((a, b) => a - b);
const pct = (q) => encodeTimes[Math.floor(q * (encodeTimes.length - 1))]?.toFixed(2);
console.log(JSON.stringify({ seconds, fps, acquired, timeouts, encodeCalls, emptyCalls, packets,
  encodedPerSec: (packets / seconds).toFixed(1), firstPacketAtCall, encodeMs: { p50: pct(0.5), p95: pct(0.95), max: pct(1) } }));
