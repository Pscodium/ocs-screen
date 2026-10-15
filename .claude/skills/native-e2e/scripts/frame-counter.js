// Lê o contador binário que o gamesim desenha em cada frame (16 quadrados de 24px no canto
// superior esquerdo da área cliente; vermelho = 1) a partir de um bitstream capturado, e conta
// frames únicos, duplicados (mesmo número do anterior — captura mandou frame repetido) e pulados
// (salto > 1 — frame do jogo que nunca chegou ao encoder).
// Uso: node frame-counter.js <arquivo.h264> [offsetX=1] [offsetY=31]
//   offset = canto da área cliente dentro do frame capturado (janela com barra de título do Win11 =
//   1,31; captura de monitor/tela cheia = posição da janela na tela). Confira com
//   `ffmpeg -i x.h264 -frames:v 1 -update 1 f.png` se os números saírem absurdos.
const { execFileSync } = require("child_process");

const file = process.argv[2];
const ox = Number(process.argv[3] ?? 1);
const oy = Number(process.argv[4] ?? 31);
const W = 16 * 24;
const H = 24;
const raw = execFileSync("ffmpeg", ["-v", "error", "-i", file, "-vf", `crop=${W}:${H}:${ox}:${oy}`, "-f", "rawvideo", "-pix_fmt", "rgb24", "-"], {
  maxBuffer: 1 << 30,
});
const frameBytes = W * H * 3;
const values = [];
for (let off = 0; off + frameBytes <= raw.length; off += frameBytes) {
  let v = 0;
  for (let bit = 0; bit < 16; bit++) {
    const i = off + (12 * W + bit * 24 + 12) * 3;
    if (raw[i] > 128 && raw[i + 1] < 100) v |= 1 << bit;
  }
  values.push(v);
}
let duplicates = 0, skipped = 0, maxGap = 0;
for (let i = 1; i < values.length; i++) {
  const d = (values[i] - values[i - 1] + 65536) % 65536;
  if (d === 0) duplicates++;
  else if (d > 1) {
    skipped += d - 1;
    maxGap = Math.max(maxGap, d - 1);
  }
}
const span = values.length ? (values.at(-1) - values[0] + 65536) % 65536 + 1 : 0;
console.log(JSON.stringify({ encodedFrames: values.length, gameFramesInSpan: span, unique: values.length - duplicates, duplicates, skipped, maxConsecutiveSkipped: maxGap }));
