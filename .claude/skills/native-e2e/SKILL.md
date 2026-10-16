---
name: native-e2e
description: Testar/medir o pipeline nativo do app desktop (captura DXGI/WGC → NVENC → libdatachannel → viewer WebCodecs, e o áudio por app) de verdade — harness isolado do addon e E2E real (app Electron + viewer no Chrome via Playwright). Usar ao investigar ou validar stutter, latência, sincronia A/V, artefato de cor, congestionamento, áudio (Discord/retorno de mic/apps silenciados), ou depois de mexer em desktop/native, desktop/src/main ou viewer/src/hooks/useNativeStream.ts.
---

# Testes do pipeline nativo (harness + E2E)

Scripts em `.claude/skills/native-e2e/scripts/` (caminhos resolvidos relativos ao repo; `OCS_REPO`
sobrescreve). Tudo roda no Windows do usuário: GPU NVIDIA real, Chrome instalado, ffmpeg/ffplay no
PATH (`winget install Gyan.FFmpeg`). Requisitos de build em `docs/REQUIREMENTS.md`.

## Pegadinhas do ambiente (já custaram tempo)

- **`ELECTRON_RUN_AS_NODE=1` vaza do terminal do VS Code/Claude Code.** Pros harnesses do addon isso
  é desejado (addon é compilado pro ABI do Electron, roda via `electron.exe` como Node). Pra abrir o
  APP de verdade, tem que remover do env (o `e2e-run.js` já faz) — senão `require("electron")` vira
  `undefined` e o main crasha em `crashReporter.start`.
- **Build do addon: use `scripts/build-addon.sh`.** Rebuild incremental falha com `LNK1103`
  se não apagar `capture_core.iobj/.ipdb/.pdb` antes. `clean` como argumento apaga os `.obj`.
  `build/Release` é versionado no git (o `.node` vai junto nos commits).
- **Depois de mexer no main/preload/renderer do desktop**, rode `npx electron-vite build` em
  `desktop/` — o E2E carrega `desktop/out/`, não o dev server.
- **DXGI só entrega frame quando a tela muda.** Sempre tenha algo animando no monitor capturado:
  `ffplay -loglevel quiet -volume 5 -left 40 -top 40 -f lavfi "testsrc2=s=640x360:r=60[out0];sine=f=440:sample_rate=48000[out1]"`
  (vídeo 60fps + seno — serve pra vídeo e áudio). Mate depois: `taskkill //IM ffplay.exe //F`.
- Display do usuário é 165Hz: intervalos de 12/18ms e 58-60fps apresentados são normais a 60fps.
- Chamar `localhost` no curl pode cair em ::1 — use `127.0.0.1` pro backend.
- Não leia `.env` reais (credenciais). O backend sobe com defaults rodando de um diretório SEM
  `.env` (o `process.loadEnvFile()` lê do cwd).

## 1. Harness isolado (rápido, sem rede/viewer)

```sh
E=desktop/node_modules/electron/dist/electron.exe
S=.claude/skills/native-e2e/scripts
ELECTRON_RUN_AS_NODE=1 $E $S/enc-test.js <scratch>/out.h264 60 5 h264
ELECTRON_RUN_AS_NODE=1 $E $S/audio-test.js ffplay.exe
```

- `enc-test`: esperado `firstPacketAtCall: 1` (NVENC sem atraso de saída), `encodedPerSec` ≈ fps
  alvo. Inspecione o bitstream gravado:
  - tipos de frame: `ffprobe -v error -select_streams v -show_entries frame=key_frame,pict_type -of csv=p=0 out.h264 | sort | uniq -c`
    (GOP infinito → 1 só `I`)
  - VUI/SPS: `ffmpeg -hide_banner -i out.h264 -c copy -bsf:v trace_headers -frames:v 1 -f null NUL 2>&1 | grep -E "bitstream_restriction|max_num_reorder|colour_primaries|matrix_coef"`
    (esperado `bitstream_restriction_flag=1`, `max_num_reorder_frames=0`, BT.709 = 1)
- `audio-test`: ~100 pacotes/s, `badSpacing 0`, `mix.lateSamples 0`, RMS cai pra ~0 na fase
  "silenciado" e volta na "reincluido".
- Fidelidade de cor (matriz RGB→YUV): capture 1 frame via `addon.acquireFrame()` (BGRA) + codifique o
  mesmo frame com `encodeCurrentFrame()`, depois compare com o filtro `psnr` do ffmpeg decodificando
  com `scale=in_color_matrix=bt601` vs `bt709` (o certo dá PSNR bem maior; hoje é BT.709).

## 1b. Jogo sintético (gamesim) — captura de jogo sem precisar de jogo

`gamesim/gamesim.cpp`: D3D11 flip model, frame cap preciso, carga de GPU dividida em vários draws,
contador binário do nº do frame desenhado em cada frame. Compilar (uma vez; o .exe é ignorado):
`powershell -NoProfile -c "cmd /c 'E:\dev\ocs-screen\.claude\skills\native-e2e\gamesim\build.cmd'"`.

```sh
G=.claude/skills/native-e2e/gamesim/gamesim.exe
($G --fps 60 --load 4000 --seconds 12 > <scratch>/gs.log &) ; sleep 2   # imprime "gamesim fps=N" 1x/s
H=$(powershell -NoProfile -c "(Get-Process gamesim | Select-Object -First 1).MainWindowHandle")
DUMP=<scratch>/w.h264 ELECTRON_RUN_AS_NODE=1 $E $S/win-capture-test.js $H 60 5
node $S/frame-counter.js <scratch>/w.h264          # janela com barra de título: offset padrão 1,31
```

- `--load`: 0 leve, ~4000 pesado, ~12000 satura uma RTX 3060 (~33fps). `--draws 1` é patológico
  (1 draw gigante não preempta — não representa jogo real).
- `--fullscreen --width 1920 --height 1080`: tela cheia exclusiva (use a resolução nativa senão troca
  o modo de vídeo do monitor). Hoje NADA captura esse modo (ver TASKS.md Sprint 37). Toma a tela
  do usuário enquanto roda — avise.
- `frame-counter`: `unique == gameFramesInSpan`, `skipped 0`, `duplicates 0` = captura perfeita.
  Pra captura de monitor/tela cheia passe o offset da janela na tela (`0 0` em tela cheia).
- E2E com a janela do jogo: `HWND=$H` no `e2e-run.js`.
- Referência (2026-10-15): GPU livre 60/60 fps sem perda; saturada (jogo a 33fps) 33/33.

## 2. E2E real (app desktop + viewer no Chrome)

Subir backend e viewer em portas próprias (em background), a partir de um diretório de scratch:

```sh
cd <scratch> && PORT=4100 VIEWER_URL=http://localhost:5199 CORS_ORIGIN=http://localhost:5199 \
  <repo>/backend/node_modules/.bin/tsx <repo>/backend/src/server.ts > backend.log 2>&1 &
cd <repo>/viewer && VITE_BACKEND_URL=http://localhost:4100 ./node_modules/.bin/vite --port 5199 --strictPort > <scratch>/viewer.log 2>&1 &
```

Instalar o driver de teste fora do repo (uma vez) e rodar:

```sh
cd <scratch> && npm init -y >/dev/null && npm i playwright-core@1.52.0
NODE_PATH=<scratch>/node_modules node <repo>/.claude/skills/native-e2e/scripts/e2e-run.js 20 60
CODEC=hevc NODE_PATH=... node .../e2e-run.js 15 60          # outro codec
ACK_DELAY_TEST=1 NODE_PATH=... node .../e2e-run.js 15 60    # congestionamento simulado
```

Outras variantes:

```sh
NO_DECODE=hevc CODEC=hevc NODE_PATH=... node .../e2e-run.js 8 60   # espectador sem suporte → fallback
NODE_PATH=... node .../codec-fallback-test.js hevc                  # A assistindo + B sem suporte
E2E_ALL_LOGS=1 E2E_HOST_LOG=<scratch>/host.log ...                  # log inteiro do host em arquivo
```

Saída do `e2e-run.js`: `judderMs` = |intervalo exibido − intervalo capturado| (fluidez — p95 ~3-6ms
é o normal com display de 165Hz; p99 alto = solavanco visível), `latencyLastQuarterP50Ms` (regime) e
"latência por segundo" (transitório do começo). Se o host morrer, o script imprime o `exit code` e o
log; `0xE06D7363` (3765269347) = exceção C++ não tratada → dump em
`%APPDATA%/ocs-screen-desktop/Crashpad/reports/*.dmp` (lib Python `minidump`; tipo/módulo que
lançou sai dos parâmetros da exceção; pra nome de função, gere map file do linker temporário —
`VCLinkerTool: GenerateMapFile` no binding.gyp — e reproduza). Exceção da libdatachannel NÃO é pega
por `catch (const std::exception&)` no addon (CRT diferente) — sempre `catch (...)`.

Usa o Chrome instalado (`channel: "chrome"`), não baixa browser. Referência (2026-10-15, 1080p60,
mesma máquina, RTX 3060): fps 58-60, `stutters 0`, latência p50 ~33ms, `droppedHigh=0`,
`audioLate=0`. Com `ACK_DELAY_TEST`: host descarta ~40 frames/s entre t=5-10s, bitrate cai, viewer
sem erro de decoder e volta a ~60fps em t=11s.

No fim, pare os servidores: `netstat -ano | grep -E ":(4100|5199) " | grep LISTEN` → `taskkill //PID <pid> //T //F`.

## 2b. Estalos no áudio do ESPECTADOR (medido, não de ouvido)

Fonte: Chrome à parte tocando seno puro (página com `OscillatorNode` 440Hz, `--autoplay-policy=no-user-gesture-required`,
`--user-data-dir` próprio). Rode o E2E com `UNMUTE=1 HWND=<janela desse Chrome>` e, em paralelo,
grave a saída do Chrome do viewer com o próprio addon: `initAudioCaptureForWindow(<hwnd do viewer>)`
+ dump do PCM mixado (instrumentação temporária no `EncodeReadyFrames` — `fwrite(mix_)` antes do
`opus_encode_float`). Análise: resíduo do preditor de seno `x[n] − 2cos(w)x[n−1] + x[n−2]` > 0.01 =
descontinuidade; pico acima da amplitude da fonte = sobreposição. Referência (2026-10-16, worklet):
0 eventos em janela. Monitor não dá na mesma máquina (o loopback do sistema pega o próprio viewer).

## 3. Decompor latência (quando o número não fechar)

Instrumentação TEMPORÁRIA em `viewer/src/hooks/useNativeStream.ts` (o vite recarrega sozinho;
faça backup e restaure depois — não commitar): um `window.__dbg = {arrive, decoded, audio, wait, offset}`
empurrando, respectivamente, `performance.now() - ts/1000` no `channel.onmessage` do vídeo, no
`output` do VideoDecoder, no `output` do AudioDecoder, o `waitMs` devolvido por `playout.schedule`
e `playout.bufferMs`. Ler com `page.evaluate(() => window.__dbg)` e comparar percentis relativos ao
menor `arrive`: `decoded − arrive` = tempo no decoder (foi assim que apareceram os 67ms de reorder
do H.264), `audio` vs `decoded` = quem é o caminho crítico da sincronia, `offset` ao longo do tempo
= picos do buffer.

Log do host (1x/s, stdout do main): `acquired/encodedPackets/sendOk/droppedHigh/bitrateHighBps`,
`audioSources=[...]`, `audioLag` (atraso de chegada no mixer — tem que ficar abaixo de
`kMixLatency` em AudioCaptureCore.cpp) e `audioLate` (amostras perdidas, tem que ser 0).

## O que NÃO dá pra validar aqui

Rede real entre máquinas/Wi-Fi ruim (só simulado), NVIDIA Broadcast (não instalado), "Escutar este
dispositivo" do mic, AV1 em hardware (precisa RTX 40+), sincronia percebida a olho/ouvido. Diga isso
ao usuário em vez de dar como validado.
