---
name: web-e2e
description: Testar/medir a transmissão WEB (host no navegador via getDisplayMedia → LiveKit → espectadores no navegador) de verdade — E2E com Chrome real via Playwright, mede FPS exibido, congelamentos, latência ponta a ponta (relógio binário na tela) e stats de encoder/BWE do host. Usar ao investigar travadas/latência da transmissão pelo navegador, ou depois de mexer em viewer/src/services (publish, capture, codecs), viewer/src/hooks/useRoomStream.ts, useBroadcast.ts ou nos perfis de types/stream.ts.
---

# E2E da transmissão web (LiveKit)

Scripts em `.claude/skills/web-e2e/scripts/`. Roda no Windows do usuário, com Chrome instalado
(`%LOCALAPPDATA%\Google\Chrome\Application\chrome.exe`) e o LiveKit local do `docker-compose.yml`
de pé (`docker ps` → `ocs-screen-livekit-1`, chaves `devkey`/`devsecret1234567890`, que são o default do backend).
Para o caminho NATIVO do app desktop, use a skill `native-e2e`.

## Como funciona

1. Abre `clock.html` num Chrome em `--kiosk` no monitor principal. A página tem movimento pesado
   (`MODE=game`: 220 retângulos, fundo mudando de cor, texto rolando) ou código quase parado
   (`MODE=text`), e no topo uma barra com `Date.now() % 2^24` em binário.
2. Host: Chrome via Playwright em `/`, preenche Resolução/FPS/Qualidade, clica em "Compartilhar
   tela". `--auto-select-desktop-capture-source="Screen 1"` escolhe o monitor sem diálogo
   (`--lang=en-US` deixa o nome previsível).
3. N espectadores abrem `/s/<id>`. Um `requestVideoFrameCallback` lê a barra em cada frame
   exibido → latência real ponta a ponta + intervalo entre frames.
4. 1x/s imprime os stats do host por camada. Ao fim: resumo por espectador, e mede o tempo até
   o espectador ver "encerrada" depois que o host encerra.

As janelas do host e dos espectadores vão para o 2º monitor (`WINPOS`, padrão `1950,40`), para não
cobrirem a barra do relógio no monitor capturado. Esta máquina tem 2 monitores 1080p, e o principal
é `\\.\DISPLAY1` em 0,0. Com 1 monitor só, as janelas cobrem a barra e a latência sai `null`. As
outras medidas continuam valendo.

**Toma a tela do usuário enquanto roda** (relógio em kiosk). Avise antes.

## Rodar

Subir backend e viewer em portas próprias (em background), a partir de um diretório de scratch
SEM `.env` (não leia `.env` reais):

```sh
cd <scratch> && PORT=4100 VIEWER_URL=http://localhost:5199 CORS_ORIGIN=http://localhost:5199 \
  <repo>/backend/node_modules/.bin/tsx <repo>/backend/src/server.ts > backend.log 2>&1 &
cd <repo>/viewer && VITE_BACKEND_URL=http://localhost:4100 ./node_modules/.bin/vite --port 5199 --strictPort > <scratch>/viewer.log 2>&1 &
```

Driver de teste fora do repo (uma vez): `cd <scratch> && npm init -y >/dev/null && npm i playwright-core@1.52.0`.

```sh
unset ELECTRON_RUN_AS_NODE   # vaza do terminal do VS Code
NODE_PATH=<scratch>/node_modules node <repo>/.claude/skills/web-e2e/scripts/web-e2e.js
```

Variáveis de ambiente (todas opcionais):

| var | padrão | o quê |
|---|---|---|
| `RES` / `FPS` / `QUALITY` | `1080p` / `60` / `high` | valores dos `<select>` do formulário |
| `SHARP=1` | – | liga "Melhorar texto" (→ H.264, ver `services/codecs.ts`) |
| `MODE` | `game` | `game` (movimento pesado) ou `text` |
| `VIEWERS` | `1` | nº de espectadores |
| `SECONDS` | `20` | duração da medição |
| `HIDE` | – | esconde codecs do `getCapabilities` do host, ex. `HIDE=VP9` (cai pro próximo da prioridade), `HIDE=H264,VP9,AV1` (VP8) |
| `HINT` | – | força `contentHint` na track (`motion`/`detail`/`text`) |
| `PLAYOUT` | – | `playoutDelayHint` (ms) nos receivers do espectador depois de conectar |
| `HOSTARGS` | – | flags extras do Chrome do host, ex. `--disable-accelerated-video-encode` (H.264 → OpenH264) |
| `SCREEN` | `Screen 1` | fonte do auto-select |
| `OUT` | `%TEMP%/ocs-web-e2e` | screenshots (`host-live.png`, `viewer.png`, `viewer-end.png`) e `run-*.json` |

Filtrar a saída: `... 2>&1 | grep -E "^(viewer[0-9]:|encoder|t=(10|20) |\[)"`.

No fim, pare os servidores: `netstat -ano | grep -E ":(4100|5199) " | grep LISTEN` → `taskkill //PID <pid> //T //F`.

## Ler a saída

- Linha `t=N`: `src` = FPS da captura; `avail` = banda estimada pelo GCC; por camada (`rid` q/h/f
  no simulcast, `-` no SVC): `resolução@fpsCodificado kbps/tgt(alvo) qp enc(ms/frame) limitação`.
  - **FPS codificado muito abaixo do `src` com limitação `none`** = o encoder está descartando
    frames sozinho (foi o que acontecia com H.264 no navegador).
  - `bandwidth`/`cpu` = o WebRTC sabe do limite e reduz a resolução (comportamento saudável).
- `viewerN`: `presentedFps`, `interval p50/p95/p99/max`, `stalls>100ms`, `latency p50/p95` (ponta a
  ponta via relógio, inclui captura + encode + SFU + jitter buffer + render) e, do `inbound-rtp`,
  `freezes` (contagem/duração total), `dropped`, `pli`, `jb` (jitter buffer médio).
- O primeiro quarto dos frames é descartado (rampa da estimativa de banda).

## Referência (2026-10-29, esta máquina, RTX 3060, localhost)

| cenário | presentedFps | latência p50 | freezes |
|---|---|---|---|
| H.264 (antiga prioridade web), 1080p60 game | 7–10 | 380–600ms | 7–13 |
| VP9 SVC (atual), 1080p60 game | ~35 | ~215ms | 0 |
| VP9, 720p60 game, 2 espectadores | ~44 | ~222ms | 0 |
| H.264, `SHARP=1 MODE=text` | ~55 | ~183ms | 0 |

O H.264 no navegador (MFT da NVIDIA e OpenH264) trava o QP em 35 e descarta frames quando falta
bitrate, sem reportar limitação. `contentHint=motion` e desligar o simulcast não resolvem.

Em algumas rodadas, a própria página do relógio caiu para ~30 fps (`src`) por carga da máquina.
Compare sempre com o `src` da mesma rodada.

Bug conhecido (quando esta skill foi criada): o espectador NÃO mostra "encerrada" depois que o host
encerra, porque o backend só remove a sala da memória e não do LiveKit. O script imprime
`viewer did NOT show end screen`.

## O que NÃO dá pra validar aqui

Rede real/Wi-Fi ruim (sem netem no Windows; o CDP `emulateNetworkConditions` não afeta WebRTC),
hardware de outras pessoas, celular/Safari, espectador sem suporte a VP9 (fallback `backupCodec`).
Diga isso ao usuário em vez de dar como validado.
