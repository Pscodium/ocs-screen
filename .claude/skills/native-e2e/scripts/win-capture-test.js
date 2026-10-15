// Harness da captura de JANELA (WGC) + encoder: mede frames entregues pelo WGC/s, codificados/s e a
// distribuição do intervalo entre frames entregues — é aqui que aparece o teto de ~55fps (intervalo
// mínimo do WGC quantizado pelo refresh do monitor).
// Uso: ELECTRON_RUN_AS_NODE=1 <electron.exe> win-capture-test.js <hwnd> [fps=60] [segundos=5]
// Env DUMP=<arquivo.h264> grava o bitstream (pra contar frames únicos com frame-counter.js).
// HWND de uma janela: powershell -NoProfile -c "(Get-Process <nome> | Select -First 1).MainWindowHandle"
const path = require("path");
const fs = require("fs");
const REPO = process.env.OCS_REPO ?? path.resolve(__dirname, "../../../..");
const addon = require(path.join(REPO, "desktop/native/capture-core/build/Release/capture_core.node"));

const hwnd = Number(process.argv[2]);
const fps = Number(process.argv[3] ?? 60);
const seconds = Number(process.argv[4] ?? 5);
if (!addon.initialize()) throw new Error("initialize falhou");
if (!addon.startWindow(hwnd)) throw new Error("startWindow falhou (hwnd inválido/minimizado?)");
if (!addon.initEncoder(fps, 12_000_000, "h264")) throw new Error("initEncoder falhou");

const dumpFd = process.env.DUMP ? fs.openSync(process.env.DUMP, "w") : null;
const timeoutMs = Math.round((1000 / fps) * 1.5);
let acquired = 0, packets = 0, timeouts = 0, last = null;
const intervals = [];
const t0 = Date.now();
while (Date.now() - t0 < seconds * 1000) {
  const f = addon.acquireFrameGpuOnly(timeoutMs);
  if (!f) { timeouts++; continue; }
  if (f.windowClosed) throw new Error("janela fechou");
  if (f.resized) { addon.destroyEncoder(); addon.initEncoder(fps, 12_000_000, "h264"); }
  const now = Number(process.hrtime.bigint()) / 1e6;
  if (last !== null) intervals.push(now - last);
  last = now;
  acquired++;
  for (const p of addon.encodeCurrentFrame()) {
    packets++;
    if (dumpFd !== null) fs.writeSync(dumpFd, p);
  }
}
if (dumpFd !== null) fs.closeSync(dumpFd);
addon.destroyEncoder();
addon.stop();
intervals.sort((a, b) => a - b);
const q = (p) => intervals[Math.floor(p * (intervals.length - 1))]?.toFixed(1);
console.log(JSON.stringify({ deliveredPerSec: (acquired / seconds).toFixed(1), encodedPerSec: (packets / seconds).toFixed(1), timeouts,
  deliveryIntervalMs: { p5: q(0.05), p50: q(0.5), p95: q(0.95), max: q(1) } }));
