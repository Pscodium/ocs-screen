# POC — pipeline de captura fora do `getDisplayMedia()` (ARQUIVADO)

> **Código revertido do app** — voltamos a usar só `getDisplayMedia()` (WebRTC padrão via LiveKit). Este arquivo fica só como registro do que foi tentado, os bugs encontrados e por que travou — pra não repetir o mesmo caminho sem necessidade se alguém retomar isso no futuro. Nenhum dos arquivos citados abaixo existe mais no repo.

Contexto: `docs/TASKS.md` Sprint 1 pede tirar a barra "X está compartilhando sua tela" do Chromium/WebView2 e melhorar performance em jogos/vídeo de alta taxa de frames. `docs/ARCHITECTURE.md#fase-4` já mapeia a investigação; este arquivo detalha e começa a POC específica.

## Mecanismo (corrigido)

Pensamos antes em `RTCRtpScriptTransform` (Insertable Streams sobre `RTCRtpSender`) pra injetar vídeo pré-codificado. **Isso está errado**: essa API só transforma frames que o encoder do próprio browser já produziu (usada pra E2EE) — não existe API pública que deixe substituir o encoder do `RTCPeerConnection` por um bitstream externo.

O mecanismo certo é outro, mais simples e mais bem suportado:

```
Captura nativa (Rust/WGC)          Hoje (getDisplayMedia)
        │                                   │
   VideoFrame cru                     VideoFrame cru
        │                                   │
        ▼                                   ▼
MediaStreamTrackGenerator ──────────────────┘
        │
  MediaStreamTrack "normal"
        │
  room.localParticipant.publishTrack(track, ...)   ← código atual, SEM MUDANÇA
        │
  Encoder do browser (H.264/VP9/AV1, hardware quando disponível) — igual a hoje
```

`MediaStreamTrackProcessor` lê um `MediaStreamTrack` existente como stream de `VideoFrame`s crus. `MediaStreamTrackGenerator` faz o caminho inverso: recebe `VideoFrame`s e produz um `MediaStreamTrack` novo, que o WebRTC trata como qualquer câmera/tela. **O encoder continua sendo o do browser** — não estamos reimplementando encoding, só trocando a fonte dos frames.

Consequência prática: como a fonte final publicada não passa mais por `getDisplayMedia()`, a barra de compartilhamento do Chromium (atrelada especificamente ao fluxo de permissão do `getDisplayMedia`) deixa de aparecer quando o frame vier de captura nativa. Isso resolve a reclamação original sem precisar reimplementar encoder/WebRTC.

## Fases da POC

### Fase A — validar o pipeline em si (sem Rust ainda)

Objetivo: provar que `getDisplayMedia` → `MediaStreamTrackProcessor` → (passthrough) → `MediaStreamTrackGenerator` → `publishTrack()` funciona ponta a ponta no LiveKit, sem regressão de qualidade/latência perceptível.

Nesta fase a barra do Chromium **continua aparecendo** (ainda estamos usando `getDisplayMedia` como fonte) — o objetivo aqui é só validar a mecânica de recriar a track, não remover a barra ainda.

Implementado em `desktop/src/services/framePipeline.ts`, ligado por uma flag experimental na UI ("Pipeline experimental de captura (POC Fase A)") pra não afetar o fluxo padrão.

**Status: concluída e validada em teste real** — usuário confirmou qualidade/conexão perfeitas com a track reconstruída, publicando normalmente no LiveKit.

### Fase B — trocar a fonte por captura nativa (Rust + WGC)

**Status: PAUSADA. Hipótese principal confirmada (a barra some de verdade), mas a implementação atual trava o app inteiro e foi desativada na UI (checkbox desabilitado em `SettingsForm.tsx`). Código fica no repo pra retomar depois com abordagem de transporte diferente — ver "Por que travou" e "Se for retomar" abaixo.**

#### Por que travou (causa raiz final)

Depois de corrigir os 4 bugs de transporte abaixo, o mecanismo passou a decodificar frames corretamente — mas o app inteiro travava (UI sem resposta, nem o botão de copiar link funcionava). Causa: `base64ToBytes()` em `nativeCapture.ts` decodifica cada frame (megabytes, um loop `for` byte-a-byte) **de forma síncrona, na thread principal da UI**, dentro do `channel.onmessage`. Em resolução de tela cheia, isso não é trabalho rápido — e como frames continuam chegando (WGC dispara a cada refresh do monitor), o trabalho de decode se acumula mais rápido do que a thread consegue processar, deixando a UI inteira (React, cliques, tudo) permanentemente bloqueada. Não era intermitência nem falta de otimização fina — é a arquitetura de transporte (JSON + base64 + decode síncrono no main thread) sendo fundamentalmente incompatível com vídeo em tempo real de tela cheia.

#### Se for retomar

Não descarta a abordagem (captura nativa continua sendo o único jeito real de tirar a barra) — só troca a tática de transporte:

- **Decodificar fora da thread principal**: mover o `base64ToBytes`/montagem do `VideoFrame` pra um Web Worker, ou eliminar o base64 e usar transferência binária real (`ArrayBuffer` via `postMessage` com transferable objects) — evita bloquear a UI mesmo que o volume de dados continue alto.
- **Reduzir o volume antes de mais nada**: capturar em resolução/FPS bem menor (ex.: 720p a 10fps) como primeiro teste de corretude visual, escalando depois.
- **Investigar o payload binário puro do `Channel`** (`InvokeResponseBody::Raw`) de verdade, em vez de evitar por precaução — precisa rodar e inspecionar como chega no lado JS, mas eliminaria o overhead de base64 (~33%) e o custo de decode.

Ciclo de bugs de transporte encontrados e corrigidos (nessa ordem):

1. Frame inteiro (tela cheia, ~8MB BGRA em 1080p → ~11MB em base64) como uma única string numa mensagem de `Channel` estourava algum limite do transporte IPC do WebView2 — chegava truncado, `atob()` rejeitava com `InvalidCharacterError`. Corrigido fatiando em pedaços de 64KB crus (`CHUNK_SIZE_BYTES`), remontados no JS por `frame_id`/`chunk_index`.
2. Depois do chunking, `VideoFrame` falhava ao ler `stride`/`layout` — campos vinham `undefined`. Causa: serde manda os nomes dos campos em snake_case (`row_pitch`) por padrão, só os *argumentos de comando* do Tauri são auto-convertidos pra camelCase, não o payload de `Channel` (é outro caminho de serialização). Corrigido com `#[serde(rename_all = "camelCase")]` no struct `FrameChunk`.
3. Mesmo com os dois acima corrigidos, `atob` ainda falhava intermitentemente. Suspeita (na hora): `native_capture.rs` mandava todos os ~128 chunks de um frame em loop síncrono sem esperar o frontend processar, e o WGC podia disparar frame novo por cima — mitigado com throttle no Rust (`FRAME_IN_FLIGHT`) + validação explícita no JS (chunk faltando / tamanho decodificado não bate com `rowPitch * height` → descarta com aviso em vez de deixar corromper silenciosamente).
4. **Causa raiz de verdade** (a #3 era só sintoma, não a causa): `CHUNK_SIZE_BYTES = 65_536` não é múltiplo de 3. Base64 codifica de 3 em 3 bytes; cada chunk é codificado *separadamente* antes de concatenar no JS. Um chunk cujo tamanho não é múltiplo de 3 termina com padding (`=`/`==`) no meio da string base64 do frame inteiro depois de concatenado — e padding no meio (em vez de só no final) é inválido, `atob` sempre rejeita. Isso explicava os 100% de falha, não intermitência real (o throttle da #3 só mudava a aparência de "às vezes funciona"). Corrigido trocando pra `65_535` (múltiplo de 3).

Escopo desta fatia: só monitor primário inteiro, sem seletor de janela ainda, sem hardware encoding explícito (o browser continua encodando depois que a track chega no publish, igual à Fase A).

Implementado:

1. `desktop/src-tauri/src/native_capture.rs` — `windows-rs` + `Windows.Graphics.Capture`, captura o monitor primário (`MonitorFromPoint` com `MONITOR_DEFAULTTOPRIMARY`), cria device D3D11, sessão de captura, copia cada frame pra uma textura staging (CPU-acessível) via `CopyResource`+`Map`.
2. Frame enviado pro frontend via `tauri::ipc::Channel`, como JSON com os bytes em base64 (`data_base64`) — não usamos o payload binário puro (`InvokeResponseBody::Raw`) porque o contrato de como isso chega desserializado no lado JS não é documentado publicamente o suficiente pra confiar sem testar ao vivo; base64+JSON usa só API pública documentada, ainda que mais lento. Ver "Riscos conhecidos".
3. `desktop/src/services/nativeCapture.ts` — decodifica o base64, monta `VideoFrame` (`format: "BGRA"`, `layout` com `stride` = `row_pitch` da GPU, que pode ter padding além de `width * 4`), escreve no `MediaStreamTrackGenerator` — **mesmo generator/mesmo publish da Fase A**, só troca a origem do frame.
4. `desktop/src/services/capture.ts` — quando `settings.nativeCapture` está marcado, pula `getDisplayMedia()` inteiramente e usa esse caminho.
5. UI: checkbox no `SettingsForm` — **atualmente desabilitado** (`checked={false} disabled`), com aviso de que está pausado por travar o app. O `settings.nativeCapture` no state nunca fica `true` por nenhum caminho da UI agora.

**Status de cada pendência:**
- ✅ Se a barra do Chromium realmente some — **confirmado, sumiu**.
- ❌ App usável durante a captura — **não, trava** (ver "Por que travou" acima). Bloqueador que pausou a fase.
- Não chegou a validar cores/corretude visual do frame — travava antes de dar pra observar isso com calma.
- LiveKit loga `could not determine track dimensions, using defaults` ao publicar — porque `publishTrack` é chamado antes de qualquer frame chegar no generator, então `track.getSettings()` não tem width/height ainda. Não é fatal (LiveKit cai em resolução default), mas pode afetar a escolha de camada simulcast inicial. Fica de follow-up.
- `stop_native_capture` hoje só marca uma flag (`CAPTURE_ACTIVE`) — os handles COM/D3D11 (`item`, `frame_pool`, `session`, device/context) são propositalmente "vazados" (`std::mem::forget`) até o processo do app fechar; parar de verdade a sessão de captura (`session.Close()`) fica pra próxima iteração, precisa guardar esses handles em estado compartilhado.

### Fase C — otimização

Evitar a cópia GPU→CPU→GPU (textura D3D11 → buffer → de volta pro compositor do browser) é o próximo gargalo de performance depois que B funcionar. Existe caminho pra manter na GPU via `VideoFrame` com `WebGPU`/`ImageBitmap` de textura compartilhada, mas só vale investigar se B mostrar que a cópia CPU é o bottleneck real medido.

## Riscos conhecidos

- `MediaStreamTrackGenerator` é suportado no Chromium (WebView2 usa Chromium), mas historicamente ficou atrás de "Experimental Web Platform features" em algumas versões — **confirmado disponível** na versão testada (Fase A rodou com sucesso).
- Cópia de frame JS↔Rust em alta taxa (60fps 4K = ~800MB/s crus) pode virar gargalo se não for bem serializada — Fase B implementada com base64+JSON (mais lento, mais simples) primeiro; trocar pro payload binário raw do Channel é a otimização óbvia depois que a corretude visual for confirmada.
- `publishTrack` já configurado (codec, simulcast, bitrate) não muda — a superfície de risco fica isolada na troca da fonte do frame, não no publish.
- Captura nativa nesta fatia é monitor inteiro só — sem seletor de janela, sem áudio, sem `stop()` que realmente libera os recursos COM/D3D11 (ver Fase B acima).
- Formato de pixel: assumimos `DXGI_FORMAT_B8G8R8A8_UNORM` → `VideoFrame({format: "BGRA"})`. Se a GPU/driver do usuário devolver outro formato por baixo (algumas config exóticas de HDR/10-bit), a imagem sai com cores erradas — não validado em hardware variado.
