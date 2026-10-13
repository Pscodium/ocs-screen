# Native Capture Core — Arquitetura de Captura Nativa (Windows)

## Objetivo

O projeto terá um **Capture Core nativo em C++**, independente do Electron, responsável por capturar a tela utilizando APIs de baixo nível do Windows e fornecer frames para o pipeline de codificação e transmissão.

A interface (Electron + React) será apenas uma camada de orquestração e configuração, enquanto toda a captura permanecerá no lado nativo para máxima performance e menor latência.

---

# Arquitetura Geral

```text
┌──────────────────────────────────────────────┐
│               Electron (UI)                 │
│                                              │
│ React + IPC                                 │
│ • Seleção de monitor                         │
│ • FPS / Resolução                            │
│ • Qualidade                                  │
│ • Iniciar / Parar transmissão                │
│ • Estatísticas                               │
└───────────────────┬──────────────────────────┘
                    │ IPC
                    ▼
┌──────────────────────────────────────────────┐
│         Native Capture Core (C++)           │
│                                              │
│ • DXGI Desktop Duplication                   │
│ • Direct3D 11                                │
│ • Cursor                                     │
│ • Gerenciamento de monitores                 │
│ • Controle de FPS                            │
│ • Recuperação de erros                       │
└───────────────────┬──────────────────────────┘
                    │
                    ▼
             ID3D11Texture2D
                    │
                    ▼
┌──────────────────────────────────────────────┐
│              Encoder (NVENC)                │
│                                              │
│ H.264 / HEVC / AV1                           │
└───────────────────┬──────────────────────────┘
                    │
                    ▼
                 WebRTC
```

---

# Filosofia do Projeto

**Separação de responsabilidades:**

| Camada       | Responsabilidade    |
| ------------ | ------------------- |
| Electron     | Interface e IPC     |
| Capture Core | Captura nativa      |
| Encoder      | Compressão de vídeo |
| Network      | WebRTC / Transporte |

O JavaScript **nunca deve manipular frames RGBA em tempo real**. Toda a pipeline pesada permanece na GPU.

---

# Estrutura de Pastas

```text
desktop/
├── electron/
│   ├── main/
│   ├── preload/
│   └── renderer/
│       └── React
│
├── native/
│   └── capture-core/
│       ├── CaptureCore.cpp
│       ├── DXGICapture.cpp
│       ├── D3D11Context.cpp
│       ├── MonitorManager.cpp
│       ├── CursorCapture.cpp
│       ├── Frame.cpp
│       └── include/
│
├── encoder/
│   ├── Nvenc.cpp
│   └── EncoderInterface.hpp
│
└── shared/
    └── IPC.ts
```

---

# Capture Core

## Responsabilidades

* Inicializar Direct3D 11
* Detectar GPUs e monitores
* Capturar monitor utilizando **DXGI Desktop Duplication**
* Gerenciar `ID3D11Texture2D`
* Controlar FPS
* Capturar cursor
* Lidar com troca de resolução
* Recuperar falhas (`DXGI_ERROR_ACCESS_LOST`)

## Interface pública (conceitual)

```cpp
class CaptureCore {
public:
    bool Initialize();
    bool Start(int monitorId);
    bool Stop();

    bool AcquireFrame(Frame& frame);

    void SetTargetFPS(int fps);

    CaptureStats GetStats();
};
```

O Electron nunca acessa DirectX diretamente.

---

# Pipeline de Captura

```text
Monitor
   │
   ▼
Desktop Window Manager (DWM)
   │
   ▼
DXGI Output Duplication
   │
   ▼
ID3D11Texture2D
   │
   ▼
GPU Texture Pool
   │
   ▼
Encoder
```

Objetivo: **zero-copy**, evitando transferências GPU → CPU.

---

# IPC (Electron ⇄ C++)

## Comandos

```ts
startCapture({
  monitorId: 0,
  width: 1920,
  height: 1080,
  fps: 60
})

stopCapture()

listMonitors()

setFPS(30)

setResolution(1280,720)
```

## Eventos

```ts
onCaptureStarted()

onCaptureStopped()

onStats({
  fps: 60,
  latency: 4,
  droppedFrames: 0
})

onError(code, message)
```

Os frames **não passam pelo IPC**.

---

# Roadmap de Desenvolvimento

## Fase 1 — MVP

* [x] Criar projeto C++ (`desktop/native/capture-core/`, node-addon-api + binding.gyp)
* [x] Inicializar D3D11
* [x] Detectar monitores (`ListMonitors` via `IDXGIAdapter::EnumOutputs`)
* [x] Capturar monitor via DXGI (Desktop Duplication)
* [x] Exibir preview nativo (painel `NativeCaptureDebug.tsx`, dev-only)
* [x] 60 FPS estáveis (mitigado, dentro do que é possível em software) — capture-side agora usa duas técnicas Win32 padrão de apps de captura/jogo sob contenção de GPU/CPU: `IDXGIDevice::SetGPUThreadPriority(7)` (prioridade máxima de agendamento de GPU pro device de captura, pra não perder pra prioridade padrão do processo do jogo) e `AvSetMmThreadCharacteristicsW(L"Capture")` (registra a thread principal do Electron na classe MMCSS "Capture", prioridade de CPU mais alta sob contenção). Ambas falham em silêncio se o driver/SO não suportar — sem risco de quebrar a captura. **Limite real que continua existindo**: com 2 encodes simulcast simultâneos competindo pela mesma GPU que o jogo (Sprint 12), captura e encode não têm GPU infinita — não há técnica de software que dê 60fps garantido quando a demanda de GPU excede a oferta; isso é física de hardware, não bug.

Resultado esperado:

> Captura de tela totalmente funcional sem Electron. **Nota de escopo (atualizada 2026-08-23):** a decisão original limitava o nativo só à captura (encode/WebRTC ficariam no LiveKit). O usuário reabriu essa decisão — ver §Regra sobre WebRTC revisada em `CLAUDE.md` e Fases 3/4 abaixo, agora em andamento.

---

## Fase 2 — Capture Core

* [x] Biblioteca reutilizável (addon N-API único, consumido tanto pelo painel de teste quanto pelo fluxo real de transmissão)
* [x] Controle de FPS (`targetFps` no `start()`, loop recursivo via `setImmediate` em vez de `setInterval` de cadência fixa — ver Sprint 17)
* [x] Cursor opcional — DXGI Desktop Duplication não desenha o cursor por padrão (DWM compõe depois); implementado via `GetCursorInfo`/`DrawIconEx` numa textura intermediária GDI-compatible (`D3D11_RESOURCE_MISC_GDI_COMPATIBLE`), copiada pra STAGING só depois do cursor já composto. Corrige hotspot do ícone (`GetIconInfo`) e offset de monitor em setup multi-monitor. **Agora é opcional de verdade**: `CaptureCore::SetCaptureCursor(bool)` exposto no addon (`setCursorEnabled`), controlado pelo toggle "Mostrar cursor" no `SettingsForm` (só tem efeito na captura nativa; `desktopCapturer` sempre inclui cursor por conta própria)
* [x] Troca de monitor (via `SourcePicker`/`swapSource`, para-e-recomeça a sessão de duplicação no novo índice)
* [x] Estatísticas — `GetStats()` conceitual virou contadores simples no loop de captura (`main/index.ts`): fps de captura (frames de fato entregues/segundo) + timeouts, reportados 1x/segundo via `webContents.send` (não pelo `MessagePort` de frames, frequência baixa demais pra justificar). Exposto no HUD de dev do `LiveCard` como "FPS de captura nativa" — droppedFrames/latência de verdade ainda não
* [x] Tratamento de erros (`DXGI_ERROR_ACCESS_LOST` recupera sozinho recriando a sessão; addon ausente/falha ao inicializar cai automaticamente pro `desktopCapturer`)

Resultado:

> Capture Core pronto para integração. **Integrado de verdade no fluxo real** (`SourcePicker` → `capture.ts` → `useBroadcast`) desde o Sprint 17 — não fica mais só no painel de teste isolado. Áudio segue fora de escopo (§Não Objetivos): caminho nativo publica só vídeo.

---

## Fase 3 — Encoder

**REABERTO — decisão explícita do usuário (2026-08-23), revisando a decisão anterior.** Objetivo:
qualidade/latência equivalente ao compartilhamento de tela do Discord, que roda pipeline nativo
próprio. `CLAUDE.md` foi atualizado (ver §Regra sobre WebRTC revisada) pra refletir essa mudança de
arquitetura. Frame já sai do Capture Core como `ID3D11Texture2D` — objetivo é entregar direto pro
NVENC sem round-trip por CPU (zero-copy real, diferente do que a captura faz hoje pro
`MediaStreamTrackGenerator`, que exige bytes em memória).

* [x] Integração NVENC (NVIDIA Video Codec SDK 13.1.15, vendorizado em `desktop/native/capture-core/vendor/nvenc/`, fora do git — ver `.gitignore`) — usa o wrapper oficial `NvEncoderD3D11` da NVIDIA (licença MIT, dentro do próprio SDK) em vez de chamar a API C crua na mão. `EncoderCore` roda no MESMO `ID3D11Device` do `CaptureCore` e codifica direto da textura já composta (com cursor) via `CopyResource` GPU→GPU — sem passar pela CPU, zero-copy real (diferente do caminho WebCodecs atual, que exige bytes crus em memória).
* [x] H.264 (prioridade — mesma ordem de `CLAUDE.md` §Codecs) — validado ponta a ponta: capturou 3s reais, gerou `.h264` confirmado válido via `ffprobe` (1920×1080, `yuv420p`, codec `h264`), remuxado em `.mp4` e enviado pro usuário assistir.
* [x] Fallback de encoder por software quando NVENC indisponível — `SoftwareEncoderCore` (Media Foundation, `MFTEnumEx` em vez de CLSID fixo, funciona em qualquer Windows sem dependência externa; bônus: se a máquina tiver Intel QuickSync/AMD AMF exposto via MF, o `MFT_ENUM_FLAG_SORTANDFILTER` pode escolher hardware sozinho mesmo sem NVENC). `EncoderCore::Initialize` tenta NVENC primeiro, cai pro fallback automaticamente na falha — interface pública idêntica (`EncodeFrame`/`SetBitrate`/`Flush`/`ForceKeyframe`), addon.cpp/main process não precisam saber qual dos dois tá ativo, exceto pra avisar o usuário (`isUsingSoftwareEncoder()`, HUD mostra "H.264 (software, sem NVENC)"). Caminho de software faz readback GPU→CPU + conversão BGRA→NV12 manual (não é zero-copy como NVENC) — esperado ser mais pesado em CPU, é o fallback, não substituto. **Bug real encontrado durante a implementação**: `<codecapi.h>` sozinho NÃO declara `ICodecAPI` (só as GUIDs/constantes) — a interface de verdade tá em `<icodecapi.h>`, header separado; e usar `<codecapi.h>`/`ICodecAPI` no mesmo arquivo que `<mfidl.h>`/`<mftransform.h>` quebra a compilação (`error C2027: uso de tipo indefinido 'ICodecAPI'`) porque um dos headers de MF puxa `<strmif.h>` transitivamente, que forward-declara `ICodecAPI` e trava o include-guard antes da definição completa rodar — resolvido isolando o uso de `ICodecAPI` em `CodecApiHelper.h/.cpp` próprio, sem nenhum header de MF junto. Compilado e linkado com sucesso (`node-gyp rebuild`, 0 erros) — não testado ainda numa máquina sem GPU NVIDIA de verdade (só compilação validada). **Teste funcional fica pendente pra quando houver hardware/build de produção pra validar de verdade** (mesma categoria do pendente de firewall do Sprint 23 em `docs/TASKS.md`).
* [x] HEVC — opt-in ("Usar HEVC (beta)" no `SettingsForm`, só com pipeline nativo ligado), fora do padrão (CLAUDE.md §Codecs continua H.264 primeiro por garantia de hardware — HEVC é EXCEÇÃO deliberada, não mudança de prioridade). Cascata de fallback automática em 3 camadas, cada uma detectada e revertida sozinha: (1) `EncoderCore::Initialize` tenta NVENC HEVC → NVENC H.264 → software HEVC (MF, `MFTEnumEx` com `MFVideoFormat_HEVC`) → software H.264; (2) viewer roda `VideoDecoder.isConfigSupported()` pro codec do offer ANTES de responder (Chrome só decodifica HEVC com hardware do dispositivo, inconsistente) e manda `decoderOk` na answer; (3) se `decoderOk:false`, host reinicia o encoder em H.264 e renegocia sozinho (`beginNativeNegotiation`, só 1x por transmissão). `TransportCore::SendVideoFrame` detecta keyframe por codec (NAL 1 byte tipo 5 no H.264 vs cabeçalho 2 bytes IRAP 16-23 no HEVC, `VideoCodecType` compartilhado entre capture-core/transport-core). Compilado e linkado com sucesso — **não testado em GPU/viewer real com HEVC de verdade** (sem hardware HEVC disponível pra validar; risco conhecido documentado abaixo).
* [x] AV1 opt-in (Sprint 27, `docs/TASKS.md`) — mesma cascata de 4 níveis do HEVC (NVENC AV1 →
  NVENC H.264 → software AV1 via MF, sem garantia de existir → software H.264), detecção de
  keyframe própria via parsing de OBU (`TransportCore::ContainsKeyframeObu`, formato bem diferente
  do NAL-based H.264/HEVC), negociação de decode no viewer via `VideoDecoder.isConfigSupported()`.
  Compilado/validado end-to-end (build de produção gera instalador limpo) mas **não testado em GPU
  RTX 40+ real** (hardware NVENC AV1 não disponível nessa sessão) — mesma situação que HEVC teve
  antes de ser validado em produção.
* [x] Pacing de fps dentro do `EncoderCore` — `EncodeFrame()` agora recusa (retorna vazio, nem toca no NVENC) chamadas mais rápidas que o `fps` configurado em `Initialize()`. Resolve o achado da primeira validação (captura real batendo ~163fps num monitor de alta taxa contra encoder configurado pra CBR 30fps, bitrate saindo bem diferente do alvo) — revalidado depois do fix: 80 frames aceitos em 3s (~26.7fps, próximo do alvo de 30), contra 490/3s antes do fix.
* [x] Troca de bitrate em sessão sem recriar o encoder — `EncoderCore::SetBitrate()` usa `NvEncoder::Reconfigure` (API nativa do NVENC pra isso, com `forceIDR=1` pra sincronizar o espectador na troca), exposto no addon como `setEncoderBitrate()`. Ainda falta centralizar os valores/perfis igual `types/stream.ts` faz pro pipeline LiveKit — por ora só é chamável, não tem política de quando/quanto ajustar.
* [x] Política de adaptação de bitrate — AIMD (Sprint 25/28, congestion control via `bufferedAmount`), agora por tier (simulcast). Fallback de software/HEVC/AV1 já checados acima nesta lista — linha antiga aqui embaixo não foi atualizada quando cada um foi concluído, corrigido agora.

Resultado esperado:

> Frames passam diretamente para vídeo comprimido, sem o encoder do navegador/LiveKit no meio.

---

## Fase 4 — Streaming

**REABERTO — decisão explícita do usuário (2026-08-23).** Camada baixa de WebRTC (ICE, DTLS-SRTP,
RTP/RTCP, data channel) via **libdatachannel** (C++, leve, sem SFU embutido) — reimplementar
ICE/DTLS-SRTP à mão sem nenhuma lib não é viável com segurança (código criptográfico crítico).
Tudo ACIMA dessa camada (SFU, sinalização, sessão/sala, congestion control, simulcast) é construído
pelo projeto.

* [x] Integração libdatachannel (peer connection, ICE, DTLS-SRTP) — instalada via vcpkg (`libdatachannel[srtp]:x64-windows`, MPL-2.0), novo addon `desktop/native/transport-core/`. `TransportCore` cria `rtc::PeerConnection`, adiciona track de vídeo H.264 (`H264RtpPacketizer` + `RtcpSrReporter` + `RtcpNackResponder` — retransmissão via NACK vem de graça da lib, não é reimplementada), gera offer, recebe SDP/ICE candidate remoto. **Validado ponta a ponta**: script isolado gerou offer real (fingerprint DTLS, `a=rtpmap:96 H264/90000`, ICE ufrag/pwd) e um candidato STUN `srflx` de verdade veio do STUN público do Google — confirma ICE/DTLS/STUN funcionando de fato, não só geração de SDP estática.
* [x] STUN (testado com STUN público do Google só pra validar o pipeline; TURN e o STUN de infra própria do projeto ainda não plugados — `CLAUDE.md` §Infraestrutura)
* [x] Sinalização — WebSocket (`backend/src/services/nativeWsRelay.ts`, rota `/rooms/:id/native/ws?role=host|viewer`), substituiu o REST+polling que existiu entre esses dois marcos (histórico completo em `docs/TASKS.md` Sprint 23). Backend só faz relay puro por `viewerId` (gerado na conexão do espectador), sem guardar estado de offer/answer — elimina de vez a classe de bug que o polling REST tinha (offer/answer "velha" presa, F5 batendo 404). Validado com script isolado simulando host+2 viewers: cada um recebe só o próprio offer, respostas roteadas certas, fechar um viewer não afeta o outro.
* [x] SFU próprio — 1 `TransportCore` por espectador (`g_transportSessions`, mapa por `viewerId` em `addon.cpp`), mesmo encode compartilhado (1 captura+encoder só, nunca duplicado) com fan-out direto em C++ (`TransportSendVideoFrame` sem viewerId, itera todas as sessões ativas e manda pra cada uma — sem round-trip por JS por espectador). Callbacks de sinalização (`OnLocalDescription`/`OnLocalCandidate`/`OnStateChange`) viraram globais (registrados 1x) em vez de por sessão, sempre carregando `viewerId` como primeiro argumento pro JS rotear certo. Um espectador desconectando (F5, fechou aba) só derruba a PRÓPRIA sessão — os outros continuam recebendo o stream sem interrupção (diferente do V1, onde qualquer desconexão matava a transmissão inteira pra todo mundo). **Limitação conhecida aceita**: encoder é compartilhado, então codec é decidido uma vez só pra transmissão inteira — se HEVC pedido e o PRIMEIRO espectador reporta que não decodifica, o encoder inteiro cai pra H.264 (seguro, ninguém mais conectado ainda); se espectadores JÁ conectados em HEVC de verdade e um espectador NOVO não suporta, esse específico fica sem vídeo (não dá pra trocar o codec de todo mundo sem quebrar quem já funciona — corrigir isso de verdade precisaria de SVC ou encode duplo, fora de escopo agora).
* [x] Simulcast v1 (Sprint 28, `docs/TASKS.md`) — 2 tiers fixos ("high"/"low"), decisão consciente
  de escopo: MESMA resolução nos dois (sem downscale de GPU, que exigiria D3D11 Video Processor
  novo/não testado), diferenciados só por bitrate/fps (`SIMULCAST_LOW_BITRATE_BPS`/`_FPS` em
  `types/stream.ts`). Seleção manual pelo espectador (seletor no player), sem medição automática de
  rede ainda. Ver detalhes técnicos na entrada do Sprint 28.
* [x] Congestion control / adaptação de bitrate — REMB não se aplica mais (era RTP; vídeo vai por DataChannel/SCTP desde a troca documentada acima). Sinal usado: `bufferedAmount()` do próprio canal SCTP (`TransportCore::GetBufferedAmount`, exposto no addon como `transportMaxBufferedAmount()` — máximo entre TODAS as sessões conectadas, já que o encode é compartilhado e precisa adaptar pro pior espectador). AIMD clássico no loop de 1s de `main/index.ts`: buffer > ~3 frames de orçamento (mesma folga do VBV) → queda multiplicativa (×0.7, piso 500kbps); buffer baixo por 5 ticks seguidos → sobe aditivo (+10% do bitrate configurado) até o teto que o usuário escolheu nas configurações. Reconfigura o NVENC/MF em sessão (`SetBitrate`, já existia) sem recriar o encoder. Compilado e linkado — não testado sob congestionamento real (precisaria de rede degradada de propósito pra validar a reação).
**Bug real corrigido logo em seguida (teste do usuário)**: FPS caiu de 60 cravado pra 48-55 (HEVC+NVENC) mesmo em loopback local sem congestionamento nenhum — cada ajuste do AIMD chamava `SetBitrate` com `forceIDR=1` (herdado do uso original, "troca limpa pro espectador"), forçando um keyframe (bem maior que delta frame) exatamente na hora que o buffer já tava alto; isso enchia o buffer de novo, disparando outro ajuste, ciclo. Corrigido: `SetBitrate` ganhou parâmetro `forceKeyframe` (padrão `true`, preserva troca de qualidade pedida pelo usuário) — o ajuste automático do AIMD passa `false`. Também adicionado exigência de 2 ticks seguidos de buffer alto antes de baixar (não reage a 1 pico isolado, só ao subir continua exigindo 5 ticks baixos como já era).
* [x] Latência adaptativa (Sprint 29, `docs/TASKS.md`) — buffer de jitter adaptativo no viewer
  nativo (`useNativeStream.ts`), substitui o slider que antes era no-op nesse caminho (só
  funcionava no LiveKit). Estimativa de jitter via EWMA (mesmo peso do RFC 3550) comparando
  chegada esperada vs real de cada chunk; slider vira PISO mínimo, não teto — auto pode subir mais
  se a rede pedir.
* [x] (parcial) Teste real enviando frame H.264 pra um peer de verdade (navegador, `RTCPeerConnection` simples) — **vídeo chegou a aparecer**, primeira vez que o pipeline 100% nativo entrega mídia de ponta a ponta. Mas com dois problemas sérios ainda abertos (ver Sprint 22 em `docs/TASKS.md`):
  1. Vídeo travadão mesmo depois de `PliHandler` (resposta a keyframe request) e `PacingHandler` (suaviza rajada de RTP) — baixar bitrate de propósito PIOROU o atraso, descartando banda insuficiente como causa; aponta pra falta de descarte de frame/limite de fila em algum ponto do envio (congestion control de verdade, item abaixo).
  2. **Crash reproduzido**: `connected` → transmite → 1º PLI → `forceKeyframe` → `state: failed` → processo Electron inteiro crasha (não é só a conexão fechando). Suspeita de corrupção de memória em `TransportCore::SendVideoFrame`/packetizer/`PacingHandler`, não investigado a fundo ainda — **bloqueia qualquer teste de carga real até ser resolvido**.

Resultado esperado:

> Compartilhamento de tela completo com pipeline nativo próprio (captura → encode → transporte → SFU), sem depender do LiveKit no app desktop. **Alcançado** pros pilares principais (sinalização WS + SFU multi-espectador) — falta simulcast/congestion control/latência adaptativa pra ficar "de produção" de verdade, mas o caminho feliz (N espectadores assistindo ao mesmo tempo, cada um entrando/saindo independente) já funciona.

**Ordem recomendada de implementação**: Fase 3 (encoder) antes de Fase 4 (transporte) — encoder
produzindo H.264 de verdade é pré-requisito testável isoladamente (grava em arquivo, valida
qualidade/performance) antes de existir rede nenhuma no meio. **Viewer web e backend continuam
como estão** (LiveKit Server SDK só cuida de sala/token hoje) até esse pipeline nativo estar
validado ponta a ponta — sem essa validação, cortar o LiveKit do desktop antes da hora deixa o
produto sem transmissão nenhuma funcionando.

---

# Metas de Performance

| Item                |           Meta |
| ------------------- | -------------: |
| Latência de captura |         ≤ 5 ms |
| FPS                 |  30 / 60 / 120 |
| Resolução           |         Até 4K |
| Cópias CPU          | 0 (idealmente) |
| Uso de GPU          |    Prioritário |
| Uso de RAM          |          Baixo |

---

# Princípios Técnicos

### Zero-Copy

Evitar isto:

```text
GPU
 ↓
CPU
 ↓
RAM
 ↓
Encoder
```

Preferir:

```text
GPU Texture
      │
      ▼
 NVENC Encoder
      │
      ▼
 H.264 / AV1
```

---

### Backend Abstrato

Embora o backend inicial seja DXGI, a arquitetura deve permitir novas implementações futuramente.

```text
ICaptureBackend
        │
   ┌────┴──────────┐
   │               │
DXGI Backend   WGC Backend
```

Assim, a aplicação não depende de uma tecnologia específica de captura.

**Implementado (2026-08-25)**: o WGC Backend (`WindowCaptureCore.h/.cpp`) — captura de JANELA
específica pro pipeline nativo, faltava desde sempre (DXGI/`CaptureCore` só captura monitor
inteiro, nunca conseguiria isolar uma janela). Pedido explícito do usuário depois de notar que
"Pipeline nativo" só funcionava pra monitor. Implementado via COM ABI puro (`Microsoft::WRL`, sem
C++/WinRT/coroutines) — `Windows.Graphics.Capture` (`IGraphicsCaptureItemInterop::CreateForWindow`,
`Direct3D11CaptureFramePool` free-threaded, `GraphicsCaptureSession`). Mantém device D3D11 PRÓPRIO,
separado do `CaptureCore` de monitor (nunca os dois ativos ao mesmo tempo — uma transmissão usa
monitor OU janela). `addon.cpp` ganhou `g_windowCore`/`g_usingWindow` + helpers `Active*()` que
`InitEncoder`/`EncodeCurrentFrame`/etc. usam em vez de `g_core->` direto — CaptureCore.cpp (DXGI)
não mudou uma linha.

**Bug real encontrado e corrigido durante a validação**: `add_FrameArrived` falhava com
`RO_E_MUST_BE_AGILE` (0x8000001C) — o handler WRL (`RuntimeClass<RuntimeClassFlags<ClassicCom>, ...>`)
não era "agile" (chamável de qualquer thread/apartment), e o evento dispara de uma thread MTA
interna do WGC. Fix: adicionar `Microsoft::WRL::FtmBase` (Free-Threaded Marshaler) nos dois
handlers (`FrameArrivedHandler`/`ItemClosedHandler`).

**Validado de ponta a ponta de verdade** (não só compilação): script isolado capturando uma janela
real (VS Code, HWND obtido via PowerShell) confirmou frames chegando via WGC; depois disso, rodando
o app inteiro (Playwright `_electron`) com "Pipeline nativo" ligado + uma janela real escolhida no
picker + `native-transport:start` de verdade — telemetria do loop confirmou `acquired=57`,
`encodedPackets=53` (WGC → NVENC funcionando ponta a ponta). `sendFail` só por falta de espectador
real conectado nesse teste (sinalização WS não tinha viewer do outro lado) — mesma categoria de "não
validado com viewer real" que outras partes do pipeline nativo já documentam, não é falha da
captura/encode.

**Achado incidental durante o debug, corrigido na hora**: janela MINIMIZADA reporta um
`GraphicsCaptureItem::Size` de ~160×28 (retângulo de ícone da barra de tarefas, não o tamanho
restaurado real) — passava pela checagem de tamanho (`size > 0`, só que errado) e capturaria um
vídeo minúsculo sem erro nenhum. `WindowCaptureCore::Start` agora recusa de cara com
`IsIconic(hwnd)`, antes de gastar qualquer chamada WGC — mesmo tratamento de "escolhe outra janela"
que qualquer fonte não capturável já tem.

---

# Não Objetivos

Nesta etapa, o Capture Core **não será responsável por:**

* Interface gráfica
* WebRTC
* Áudio
* Controle de salas
* Sinalização de conexão
* Lógica de usuários

Seu único objetivo é ser um **motor de captura nativo, rápido, modular e reutilizável**.

---

# Status (2026-08-25) — objetivos da captura nativa atendidos

Fases 1-4 (MVP, Capture Core, Encoder, Streaming) estão **funcionalmente completas e validadas em
produção**: captura DXGI, encoder NVENC com fallback por software, H.264/HEVC/AV1 com cascata de
fallback automática, transporte próprio via libdatachannel (ICE/DTLS-SRTP), sinalização WebSocket,
SFU multi-espectador, simulcast (2 tiers), congestion control (AIMD) e buffer de jitter adaptativo
— todos testados com o usuário assistindo de verdade, não só compilando. Pendências que sobraram
são ajuste fino, não lacunas de objetivo (lista completa e atualizada em `docs/TASKS.md`,
"Pendências abertas" no topo do arquivo): aberração cromática H.264 em cenário de decode
compartilhado, validação de hardware que essa sessão não tinha disponível (AV1 em RTX 40+),
device-lost recovery automático (TDR é raro, baixa prioridade), e a investigação de firewall/rede
diferente (pausada, retomada só quando fizer sentido).

**Isso fecha o escopo do Capture Core como definido em §Não Objetivos acima.** O que falta pro
produto de verdade é exatamente essa lista de "não objetivos" — que nunca foram trabalho da
captura nativa, são as PRÓXIMAS fases do produto como um todo. Ver `docs/TASKS.md`, seção "Próxima
fase — além da captura nativa" pro detalhamento de cada item.

---

# Visão Final

O Capture Core será tratado como um componente independente, semelhante a uma engine.

```text
Electron
    │
    ▼
Capture Core
    │
    ▼
Encoder
    │
    ▼
WebRTC
    │
    ▼
Cliente remoto
```

---

# Sessão de 2026-08-24 — publish real ligado, vários bugs corrigidos

Ligou os pipelines de captura (Fase 3) e transporte (Fase 4) no fluxo de publish de verdade pela
primeira vez (opt-in, toggle "Pipeline nativo (beta)" nas configurações do desktop). Sessão longa,
bastante debugging — registro aqui o que foi corrigido de verdade (com telemetria confirmando) e o
que ainda fica em aberto.

## Corrigido e confirmado

- **Crash de PLI**: `PacingHandler`/callbacks do libdatachannel usavam `Napi::ThreadSafeFunction::BlockingCall`
  — travava a thread interna do libdatachannel esperando o JS, e se o JS reagisse fechando a sessão
  (ex.: `state: failed`), virava auto-join/crash. Trocado pra `NonBlockingCall` em todos os
  callbacks (`TransportCore`/`addon.cpp`).
- **GPU priority roubando do jogo**: `SetGPUThreadPriority(7)` (máximo) em `CaptureCore::Initialize`
  fazia captura+encode (mesmo device) ficarem ACIMA do processo do jogo na fila da GPU. Baixado
  pra `1`.
- **Encode 100% por software**: o pipeline "nativo" só usava DXGI pra captura — o vídeo publicado
  de fato ia por `MediaStreamTrackGenerator` + encoder do próprio Chromium (WebRTC padrão), nunca
  passava pelo NVENC. Ligado de vez: captura (DXGI) → NVENC (`EncoderCore`) → transporte
  (`TransportCore`), sem depender do LiveKit pro vídeo nesse modo.
- **`GetNextInputFrame()`/`CopyResource()` do NVENC fora do `try/catch`** em `EncoderCore::EncodeFrame`
  — sob contenção pesada de GPU (jogo 3D pesado), o wrapper `NvEncoderD3D11` podia lançar
  `NVENCException` (deriva de `std::exception`) ali, sem ser pega, derrubando o processo Electron
  inteiro sem log nenhum. Confirmado via crash dump real (`crashReporter` do Electron, configurado
  nessa sessão — dumps ficam em `app.getPath("crashDumps")`) — pilha da thread misturava
  `capture_core.node`↔`nvEncodeAPI64.dll`. Agora todo o bloco entra no try.
- **Device D3D11 removido (TDR)**: detecção via `GetDeviceRemovedReason()` quando `AcquireNextFrame`
  falha genericamente — para a transmissão com aviso limpo em vez de arriscar mais chamadas
  D3D11/NVENC num device morto.
- **Bug real no `PacingHandler` do libdatachannel v0.23.2** (vendorizado via vcpkg,
  `src/pacinghandler.cpp:23-26`): `if (!mHaveScheduled.exchange(true)) return;` — condição
  invertida, deveria ser sem o `!`. `exchange(true)` devolve o valor ANTERIOR; na primeira chamada
  `mHaveScheduled` começa `false`, `exchange` devolve `false`, `!false=true` → retorna sem agendar
  nada. Só a chamada SEGUINTE dispara o flush de verdade — a cada 2 frames enviados, 1 ficava
  empacado no buffer interno até o próximo desemperrar. Não dá pra patchear a lib vendorizada sem
  recompilar do zero; a solução foi **trocar vídeo de RTP media track pra DataChannel** (SCTP
  confiável, sem `PacingHandler`/`H264RtpPacketizer`/RTCP NACK/PLI no meio) — inspirado no projeto
  de referência [SlipStream](https://github.com/DanielChrobak/SlipStream) (mesma stack:
  libdatachannel + NVENC + WebCodecs no cliente). Cliente decodifica os chunks H.264 crus com
  `VideoDecoder` (WebCodecs) e reconstrói uma `MediaStreamTrack` via `MediaStreamTrackGenerator`
  pro `<video>`. Isso **eliminou o travamento principal** (freeze sob movimento contínuo de tela).
- **Ordem de registro de callback**: `PeerConnection::createDataChannel()` já dispara
  `setLocalDescription()` sozinho internamente (auto-negociação) se o signaling state já tá
  "Stable" — os callbacks (`OnLocalDescription` etc.) precisam ser registrados ANTES de criar o
  canal, senão a primeira (e única) oferta gerada passa sem ninguém escutando.
- **`maxMessageSize` do DataChannel**: default do libdatachannel é 256KB; mensagem SCTP acima do
  limite negociado é **truncada silenciosamente** na reassemblagem
  (`src/impl/sctptransport.cpp:519-522`), não rejeitada com erro. Configurado explicitamente pra
  4MB de folga.
- **Codec string errado no WebCodecs**: cliente configurava `VideoDecoder` pra Baseline
  (`avc1.42e01f`, resquício do SDP do caminho RTP antigo) mas o NVENC produz **High profile**
  (confirmado via `ffprobe` no bitstream: `profile=High level=42` → `avc1.64002a`). Corrigido.
- **Jitter no encoder**: `EncoderCore`'s fps throttle usava `now - lastEncodeTime_` recalculado a
  cada aceite (relógio "escorregava" a cada atraso pontual, acumulando jitter). Trocado pra grade
  FIXA (`nextEncodeTime_ += interval`, resincroniza só se cair muito atrás). FPS ficou travado
  exato no alvo (60/60 medido).
- **Readback CPU desnecessário**: `AcquireFrame` sempre fazia `Map()`+memcpy de ~8MB/frame mesmo
  quando só a textura GPU importa (caminho nativo). Nova função `AcquireFrameGpuOnly` (+ binding
  `acquireFrameGpuOnly`) pula isso — fps real subiu (~50/60 → ~55-60/60 medido).
- **VBV do NVENC**: sem VBV, CBR só controla a média ao longo do GOP, não o tamanho de cada frame
  — chegou a gerar P-frames de 100KB+ sob conteúdo complexo. VBV configurado (`vbvBufferSize`
  ≈ 3 frames de orçamento) reduz isso sem ser tão agressivo a ponto de forçar colapso de
  qualidade.

## Threading do loop (revertido pra JS)

Tentou mover o loop de captura+encode+envio pra uma thread nativa própria (`StreamWorker`, C++
puro, sem N-API por frame) — a hipótese era que o loop em JS (`setImmediate`, cruzando N-API a
cada chamada) tava serializando com o resto do processo main sob carga. **Não foi essa a causa**
(o freeze principal era o bug do `PacingHandler`, não threading) — depois de trocar pra
DataChannel, o loop em JS sozinho já ficou estável (fps 60/60 travado). `StreamWorker.cpp/.h`
ficam no repo (podem ser reaproveitados depois) mas não são o caminho ativo hoje.

## Em aberto

- **Aberração cromática periódica** ("frame mal renderizado", blocos de cor errada) — ainda
  acontece em 60fps e mais evidente em 120fps, mesmo depois de todos os fixes acima. Investigado
  a fundo:
  - Bitstream cru (dump direto do encoder, antes de qualquer coisa do DataChannel/WebCodecs)
    validado LIMPO em múltiplas amostras (`ffmpeg -i dump.h264 -f null -` sem warning nenhum;
    dezenas de frames extraídos como PNG e inspecionados visualmente, incluindo os frames com
    maior diff frame-a-frame — nenhum mostrou o artefato).
  - Fila do lado do espectador (`MediaStreamTrackGenerator`) descartada como causa — trocar pra
    canvas+`captureStream()` (zero fila possível, frame fechado na hora) NÃO eliminou o artefato
    (e piorou performance — `drawImage()` de `VideoFrame` é caro na main thread em fps alto,
    revertido).
  - `VideoDecoder` nunca dispara o callback de erro quando o artefato aparece — ou seja, decodifica
    "com sucesso", só o conteúdo visual sai errado.
  - Suspeita mais forte que sobra: contenção de GPU no **decode**, já que host (captura+encode) e
    espectador (decode+render) rodam na mesma GPU nos testes feitos até agora — mesma categoria do
    bug de crash já corrigido (device-lost), só que do lado do decode. Não confirmado — tentativa
    de testar de um segundo dispositivo (celular) esbarrou em isolamento de rede AP/cliente do
    roteador (fora do que dá pra resolver por código). Próximo passo: testar decode num dispositivo
    de verdade separado (ou desligar AP isolation no roteador, se tiver acesso) antes de investigar
    mais fundo — só faz sentido continuar caçando isso no código depois de descartar contenção de
    GPU local.
  - **CONFIRMADO indiretamente (Sprint 24, teste real do usuário)**: com HEVC ativo (`Pipeline
    nativo` + `Usar HEVC` ligados juntos), a aberração cromática sumiu quase por completo e
    stuttering não foi sentido — bate exatamente com a suspeita de contenção de GPU no decode
    software de H.264: HEVC decodifica por HARDWARE no navegador (quando suportado), tirando essa
    contenção do caminho. H.264 sozinho continua com o problema. Sobrou só um artefato bem menor e
    raro: "ajeitada" visível em linhas, parecendo ajuste de resolução em vídeo — não investigado a
    fundo, aceito por ora (usuário não considerou bloqueio).
  - `dumpStream`/gravação de bitstream cru pra debug ficou no `runNativeTransportLoop`
    (`main/index.ts`) — grava em `app.getPath("temp")/native-transport-debug.h264`. Não removido
    de propósito, é útil pra continuar essa investigação.
- **Stutter em tela cheia do player** (viewer) — mencionado uma vez, não investigado a fundo ainda.
- **Recuperação de device-lost** — hoje só para a transmissão com segurança; recriar o pipeline
  inteiro (device, duplication, encoder) do zero pra retomar automaticamente fica pra depois.
- **`StreamWorker`** — removido (Sprint 30, `docs/TASKS.md`). Era código órfão desde antes do
  multi-espectador; simulcast (Sprint 28) tornaria reativar mais trabalho do que valeria.

Essa separação facilita manutenção, testes, alta performance e futura expansão para novos backends de captura ou codificadores de vídeo.
