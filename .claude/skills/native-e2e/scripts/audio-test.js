// Harness do mixer de áudio por app (AudioCaptureCore) isolado. Precisa de um app tocando som
// (ex.: `ffplay -nodisp -f lavfi -i sine=f=440:sample_rate=48000`). Fases:
//  1) 3s com o app incluído    -> RMS > 0, fonte presente
//  2) 3s com o app silenciado  -> RMS ~0, fonte removida (troca AO VIVO)
//  3) 3s reincluído            -> volta
// Uso: ELECTRON_RUN_AS_NODE=1 <electron.exe> audio-test.js [exe-do-app-de-teste=ffplay.exe]
// Saída esperada: ~100 pacotes/s (Opus 10ms), badSpacing 0, mix.lateSamples 0.
const path = require("path");
const REPO = process.env.OCS_REPO ?? path.resolve(__dirname, "../../../..");
const addon = require(path.join(REPO, "desktop/native/capture-core/build/Release/capture_core.node"));
const TEST_APP = process.argv[2] ?? "ffplay.exe";
const BASE_EXCLUDED = ["Discord.exe", "NVIDIA Broadcast.exe"];
const FRAME_US = 10000;

console.log("apps de áudio:", JSON.stringify(addon.listAudioApps()));
console.log("init:", JSON.stringify(addon.initAudioCapture(BASE_EXCLUDED)));

function phase(label, ms) {
  const t0 = Date.now();
  let packets = 0, bytes = 0, rmsSum = 0, rmsN = 0, lastPts = null, badSpacing = 0;
  const lateness = [];
  while (Date.now() - t0 < ms) {
    const now = addon.nowUs();
    for (const p of addon.pollAudioPackets()) {
      packets++;
      bytes += p.data.length;
      lateness.push((now - p.ptsUs) / 1000);
      if (lastPts !== null && p.ptsUs - lastPts !== FRAME_US) badSpacing++;
      lastPts = p.ptsUs;
    }
    rmsSum += addon.getAudioRms();
    rmsN++;
    const until = Date.now() + 10;
    while (Date.now() < until) {}
  }
  lateness.sort((a, b) => a - b);
  console.log(JSON.stringify({ label, perSec: (packets / (ms / 1000)).toFixed(1), kbps: ((bytes * 8) / ms).toFixed(1),
    rmsAvg: (rmsSum / rmsN).toFixed(4), badSpacing, latenessP50Ms: lateness[Math.floor(lateness.length / 2)]?.toFixed(1),
    sources: addon.getAudioSources(), mix: addon.getAudioMixStats() }));
}

phase("1-incluido", 3000);
addon.setAudioExcludedApps([...BASE_EXCLUDED, TEST_APP]);
phase("2-silenciado", 3000);
addon.setAudioExcludedApps(BASE_EXCLUDED);
phase("3-reincluido", 3000);
addon.destroyAudioCapture();
