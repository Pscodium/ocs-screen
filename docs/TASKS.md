# Roadmap execução

## ✅ Item 3/3 da entrega concluído: WebRTC (TURN + resiliência)

Último item da "Escopo da próxima entrega" (ver seção mais abaixo) — Interface gráfica e Áudio já
fechados antes deste.

- [x] **TURN de verdade provisionado** — `docker-compose.yml` ganhou serviço `coturn`
  (`coturn/coturn`, `network_mode: host` — precisa ver o IP de origem real dos pacotes UDP pra
  relay funcionar, bridge do Docker mascara isso). Credencial por REST API do coturn
  (`--use-auth-secret`/`--static-auth-secret`): `backend/src/services/turn.ts` gera
  username=`"<expiry-unix>:ocs-screen"` / password=`base64(HMAC-SHA1(secret, username))` por
  requisição — nunca usuário/senha fixos, expira sozinho (`TURN_CREDENTIAL_TTL_SECONDS`, padrão
  1h), mesmo princípio de token de sala que já existia (CLAUDE.md §Segurança). Nova rota
  `GET /ice-servers` (`routes/rooms.ts`) devolve STUN público + TURN (só se `TURN_SECRET`
  configurado — sem TURN configurado, comportamento continua idêntico a antes, só STUN).
- [x] **Desktop (host) usa o TURN de verdade** — `nativeTransport.ts` busca `/ice-servers` antes
  de iniciar a transmissão nativa e converte pro formato de URL única que o libdatachannel entende
  (`turn:user:pass@host:port` — `TransportCore.cpp`/`rtc::IceServer` só aceita esse formato pro
  construtor de string, diferente do `{urls,username,credential}` estruturado do navegador).
  **Bug relevante evitado**: o username do coturn tem um `:` literal dentro (formato REST API,
  `"<expiry>:id"`) — sem `encodeURIComponent`, o parser de URL do libdatachannel quebraria ali
  pensando que é o separador user:pass; corrigido codificando username/password antes de montar a
  URL (o `url_decode` do libdatachannel do outro lado desfaz certinho).
- [x] **Viewer usa o TURN de verdade** — `useNativeStream.ts` cria o `RTCPeerConnection` com STUN
  síncrono (navegador não aceita config assíncrona no construtor) e troca pro TURN/STUN reais via
  `setConfiguration()` assim que o fetch de `/ice-servers` resolve (rápido o bastante pra sempre
  correr antes da negociação de verdade começar, na prática).
- [x] **Resiliência de sinalização (WS)** — antes, se o WS de sinalização do HOST caísse (backend
  reiniciou, blip de rede), a transmissão continuava "ativa" mas surda: nenhum espectador NOVO
  conseguia entrar, nenhum ICE candidate/SDP saía mais — e não existia NENHUM handler de
  reconexão. Espectadores JÁ conectados não eram afetados (DataChannel de mídia é independente do
  WS). `main/index.ts`: reconecta sozinho com backoff exponencial (1s→2s→4s→8s, teto 10s) enquanto
  a transmissão continuar ativa — o backend já sabia lidar com host reconectando
  (`registerHostSocket` substitui o socket antigo e reenvia `viewer-joined` de cada espectador
  ainda conectado, `nativeWsRelay.ts`), só faltava o host tentar de novo.
- [x] **Resiliência do lado do viewer** — reconecta com o mesmo backoff, mas só ENQUANTO a
  negociação inicial não terminou (`everConnected` ainda `false`) — é a janela real de risco (rede
  ruim bem no início). Depois de conectado, não tenta reagir a uma renegociação do host (ex.: host
  caiu e voltou) — isso continua exigindo remontar o player, mesma limitação de sempre (documentada
  desde o Sprint 23), só a fase de handshake inicial ficou resiliente. Melhorar isso mais (aceitar
  um offer novo pós-conexão) fica pra outra entrega — mudança de comportamento maior, risco maior.
- `tsc --noEmit`/`tsc -b` limpo em backend, desktop (main+web) e viewer.
- [x] **Validado com coturn real rodando** (`docker compose up -d coturn`, imagem
  `coturn/coturn`) — **bug real de configuração encontrado e corrigido**: o `TURN_SECRET` só
  existia no `.env.example`/placeholder, nunca foi configurado de verdade nos `.env` reais
  (raiz e `backend/.env`) nem batia entre backend e coturn. Primeiro teste do usuário
  ("transmiti e assisti, foi de boa") **não validava TURN nenhum** — `/ice-servers` só devolvia
  STUN (sem `TURN_SECRET`, o backend nunca oferece TURN, por design) e mesma rede local usa
  candidato direto de qualquer jeito, funcionaria idêntico com ou sem TURN configurado. Corrigido:
  gerado um secret de verdade (`openssl`-equivalente, `crypto.randomBytes`), colocado igual nos
  dois `.env` (raiz, usado pelo `docker compose`; `backend/.env`, lido pelo processo Node — TEM que
  bater), coturn e backend reiniciados pra pegar o valor novo.
- [x] **Autenticação TURN confirmada de ponta a ponta com `turnutils_uclient`** (ferramenta de
  teste que já vem na imagem oficial do coturn) — credencial gerada por `services/turn.ts` de
  verdade: `allocate` → `success`, endereço de relay devolvido. Controle negativo: credencial
  errada nunca autentica (fica em loop de `allocate` sem sucesso, sem vazar diferença de erro que
  ajudasse a adivinhar a senha). Confirma que o HMAC-SHA1 compartilhado entre backend e coturn
  bate certinho na prática, não só na conta manual.
- **Ainda não testado**: cliente atrás de NAT simétrico de verdade (só a autenticação/alocação foi
  validada, não uma sessão relay completa host↔espectador em rede restritiva real) — precisa de 2
  redes diferentes de verdade pra confirmar; e forçar queda do WS matando o processo do backend no
  meio de uma transmissão ativa, pra confirmar a reconexão automática (host e viewer) na prática.

## 🚧 Em andamento (2026-08-26): Áudio nativo (exclusão de app) — passo 1 de 3

Escopo desta entrega (ver "Escopo da próxima entrega" mais abaixo): 1) Interface gráfica (✅ feito
— picker centraliza conteúdo verticalmente quando poucas fontes), 2) Áudio (⭐ prioridade,
**em andamento**), 3) WebRTC/TURN (não iniciado).

- [x] **Captura WASAPI process-loopback + exclusão por processo, validada isolada** —
  `AudioCaptureCore.h/.cpp` (novo, `capture-core`): usa `ActivateAudioInterfaceAsync` +
  `AUDIOCLIENT_ACTIVATION_PARAMS{ActivationType=PROCESS_LOOPBACK, ProcessLoopbackMode=
  EXCLUDE_TARGET_PROCESS_TREE}` — a API de exclusão (pesquisa do sprint anterior) existe de
  verdade e funciona. `FindProcessIdByName` acha a RAIZ da árvore de processos (não só o primeiro
  PID com aquele nome) — necessário pra apps multi-processo tipo Discord/Electron, onde
  `EXCLUDE_TARGET_PROCESS_TREE` só cobre descendentes do PID passado; se fosse um processo filho
  qualquer, processos irmãos emitindo áudio ficariam de fora da exclusão.
- [x] Encode Opus (libopus 1.5.2, instalado via vcpkg) — 48kHz/estéreo/20ms, 64kbps/canal.
  Acumula PCM float32 do polling WASAPI (sem thread própria, mesmo estilo do resto do addon —
  chamado do loop `setImmediate` existente) até fechar um frame Opus.
- [x] Canal de dados "audio" espelhando o de vídeo em `TransportCore` (`AddAudioChannel`/
  `SendAudioFrame`) — mesma decisão de arquitetura do vídeo (Sprint 21): vai por DataChannel/SCTP,
  não RTP track (sem jitter buffer/NACK/PLI nativo do RTP no meio, cliente reconstrói do lado de
  lá com WebCodecs, mesmo raciocínio documentado em `TransportCore.h`). Áudio não tem tier
  high/low (bitrate baixo o bastante pra não valer codificar 2x) — `TransportSendAudioFrame` manda
  pra TODAS as sessões que abriram o canal.
- [x] **Bug real corrigido durante a validação**: `GetMixFormat()` retorna `WAVEFORMATEXTENSIBLE`
  (maior que `WAVEFORMATEX`) — atribuir o struct direto num campo `WAVEFORMATEX` truncava os bytes
  de extensão mas MANTINHA o `cbSize` antigo (22), fazendo `IAudioClient::Initialize` ler lixo
  depois do fim do buffer alocado e falhar com `E_INVALIDARG` (0x80070057). Corrigido: passa o
  ponteiro ORIGINAL (tamanho completo) pro `Initialize`, só extrai os campos escalares depois.
- [x] **Validado com script isolado** (mesmo padrão dos Sprints 19-22 — addon requerido direto via
  `ELECTRON_RUN_AS_NODE`, sem passar pelo app ainda): loopback normal (~150 pacotes Opus/3s,
  ritmo de 20ms batendo certo) e loopback com exclusão real (`Discord.exe` rodando de verdade na
  máquina, 6 processos) — ambos inicializam e produzem pacotes sem erro.
- **Pendente (wiring real, ainda não feito)**: plugar no fluxo de produção —
  `main/index.ts` (chamar `initAudioCapture`/`pollAudioPackets`/`transportSendAudioFrame` no
  `runNativeTransportLoop`, `transportAddAudioChannel` quando um viewer conecta), toggle/config na
  UI (qual app excluir — hoje só testado chamando a função direto), e o lado do VIEWER (decodificar
  o canal "audio" — `AudioDecoder` do WebCodecs + `MediaStreamTrackGenerator({kind:"audio"})`,
  mesmo padrão que o vídeo já usa com `VideoFrame`/`VideoDecoder`). Isso é o que falta pra ouvir
  áudio de verdade ponta a ponta.
- **Ainda não resolvido, categoria diferente**: "retorno do microfone" (2º pedido do usuário) —
  loopback captura SAÍDA, mic é ENTRADA; só apareceria misturado se "Escutar este dispositivo"
  estiver ligado no mic (config de mixer do Windows, não um processo pra excluir). Exclusão por
  processo não resolve isso. Precisa confirmar se essa config tá ligada antes de decidir a
  abordagem (pode não precisar de código nenhum, mesma categoria do fix do Sprint 4).
- [x] **Loopback por-JANELA resolvido** (pedido do usuário: isolar só o som da janela em destaque
  no compartilhamento de janela) — mesma API, modo invertido: `InitializeForWindow(hwnd)` resolve
  o processo dono do HWND (`GetWindowThreadProcessId`), acha a raiz da árvore dele
  (`FindProcessIdByName` reaproveitado via nome do executável resolvido) e ativa em
  `PROCESS_LOOPBACK_MODE_INCLUDE_TARGET_PROCESS_TREE` — só a árvore daquele app sai na
  transmissão, resto do sistema (Discord incluído) fica de fora automaticamente, sem exclusão
  manual nenhuma. `main/index.ts`: caminho de janela (`hwnd` definido) usa isso; caminho de
  monitor continua no EXCLUDE (Discord). **Validado com script isolado** (janela do Discord
  incluída = RMS alto/audível; janela do VS Code incluída = RMS zero mesmo com Discord+Chrome
  tocando ao lado — as duas direções confirmadas).
- [x] **Wiring real feito** (antes só existia o core isolado) — `main/index.ts` inicia a captura
  certa (monitor→exclude Discord, janela→include árvore do hwnd) ao começar a transmissão, abre
  canal "audio" por espectador, manda os pacotes Opus no loop. Viewer (`useNativeStream.ts`)
  decodifica com `AudioDecoder` (WebCodecs) e injeta num `MediaStreamTrackGenerator` de áudio na
  mesma `MediaStream` do vídeo — `hasAudio` reflete de verdade agora (era `false` fixo antes).
- [x] **Diagnóstico adicionado**: `AudioCaptureCore::LastRms()` (RMS do PCM cru, exposto como
  `getAudioRms()` no addon) — só pra validar de verdade se um modo de exclusão/inclusão tá
  filtrando o processo certo, comparando amplitude com/sem filtro enquanto uma fonte conhecida
  toca (não é usado no caminho de produção).
- [x] **Causa raiz real do "Discord não bloqueia" achada com dado de verdade** (log de
  `audioRms` por tick, comparado com o amigo falando na call): RMS ficava perto de 0 na maior
  parte do tempo e subia (até 0.178) exatamente quando o amigo falava — a exclusão de
  `Discord.exe` tava "ativa" (PID resolvido certo) mas não filtrava a voz da call. Causa: usuário
  usa **NVIDIA Broadcast** como dispositivo de SAÍDA do Discord (efeitos/remoção de eco) — Discord
  manda áudio pro dispositivo VIRTUAL do Broadcast, e é o **processo do Broadcast** quem renderiza
  de verdade no dispositivo físico (confirmado: `NVIDIA Broadcast.exe` tem a MESMA arquitetura
  multi-processo do Discord, com seu próprio `audio.mojom.AudioService` filho da raiz). Do ponto
  de vista do WASAPI, quem "fala" no dispositivo padrão é o Broadcast, não o Discord — excluir
  `Discord.exe` nunca tocava nisso.
- [x] **Fix**: `NATIVE_AUDIO_EXCLUDE_CANDIDATES = ["NVIDIA Broadcast.exe", "Discord.exe"]` — tenta
  cada candidato em ordem, usa o primeiro que resolver um PID de verdade (`main/index.ts`). Testado
  isolado: `FindProcessIdByName("NVIDIA Broadcast.exe")` resolve a raiz certa (PID 20324, mesma
  lógica de árvore que já funcionava pro Discord). **Confirmado pelo usuário em call real**: era
  isso mesmo, exclusão do Broadcast resolve o vazamento de voz.
- [x] Log de diagnóstico (`audioRms` no log periódico de 1s de `runNativeTransportLoop`) — foi
  essencial pra achar essa causa (a RMS subindo em sincronia com a fala do amigo, mesmo com
  "exclusão ativa", provou que o filtro errava o processo, não que a exclusão em si não
  funcionasse). Mantido no código pra debug futuro.
- **Sem UI ainda pra escolher o processo a excluir** — lista fixa de candidatos no código. Se o
  usuário trocar de setup (outro software de efeito de áudio, ex. Voicemeeter), precisa adicionar
  na lista manualmente por ora.

## ✅ Demanda concluída (2026-08-25): captura de janela no pipeline nativo

Pedido original: "encoder nativo também pra janelas, não só monitor". **Fechada** — usuário
confirmou testando de verdade (não só compilação). Cobre Sprints 31-35 abaixo. Resumo do que foi
entregue:

- Backend WGC novo (`WindowCaptureCore.h/.cpp`) do zero, sem tocar no `CaptureCore` (DXGI/monitor).
- 2 bugs reais de COM corrigidos (`RO_E_MUST_BE_AGILE`/`FtmBase`, janela minimizada reportando
  tamanho de ícone).
- Bug real de resize (travava a transmissão) — encoder reinicia sozinho no tamanho novo.
- Cursor ao vivo (não existia nem pro monitor antes disso).
- Troca de fonte ao vivo (janela↔janela, monitor↔monitor, monitor↔janela) — antes bloqueada.
- Fallback silencioso corrigido (badge de aviso) + defaults (`nativeTransport`/`preferHevc` ON).
- Ícone de cursor no LiveCard refeito (estado visual, não só cor).

**Pendências opcionais, não bloqueiam nada, só pegar se for mexer na área de novo**:
- HEVC/AV1 nunca validados isolado especificamente pelo caminho de JANELA (só H.264 testado de
  ponta a ponta nesse caminho; a arquitetura é a mesma do monitor, risco baixo).
- Simulcast (tier "low") nunca validado isolado pelo caminho de janela.
- Resize/swap ao vivo nunca testado com um espectador REAL do outro lado no momento exato da
  troca (só validado localmente — capture+encode confirmados, decode remoto não).

## Sprint 35 — Polish do ícone de cursor ao vivo

Usuário achou o ícone do botão de cursor (Sprint 34) feio e a referência ligado/desligado confusa
(só mudava de cor, não de forma).

- [x] Ícone trocado por uma seta de cursor moderna (mesmo tamanho de botão) — estado ligado = seta
  limpa, desligado = seta com risco diagonal por cima (mesmo padrão de botão de mudo:
  alto-falante vs alto-falante riscado). Reflete o ESTADO atual, não só a ação do clique.
- [x] **Bug de design corrigido**: primeira tentativa de risco usava a mesma diagonal da própria
  seta (paralelo, quase invisível por cima dela) — trocado pra diagonal OPOSTA, cruza a seta de
  verdade. Confirmado com screenshot zoomado no botão (antes ficava imperceptível em screenshot
  full-size).

## Sprint 34 — Cursor ao vivo + troca de fonte ao vivo no pipeline nativo

Últimos 2 gaps da captura de janela (lista do Sprint 31/33): cursor dinâmico e troca de janela ao
vivo. Os outros 2 gaps daquela lista (minimizar/fechar janela ao vivo) o usuário já validou
manualmente — minimizar congela e recupera ao focar de novo (esperado, WGC só entrega frame
quando algo muda), fechar volta pro início do app (esperado).

- [x] **Cursor ao vivo** — antes NENHUM caminho (nem monitor, nem janela) tinha jeito de
  ligar/desligar cursor DURANTE uma transmissão; só valia a preferência do instante em que
  começou. `WindowCaptureCore::SetCaptureCursor` agora aplica na hora se já tiver sessão ativa
  (`IGraphicsCaptureSession2::put_IsCursorCaptureEnabled`), e ganhou UI de verdade: botão novo no
  `LiveCard` (só aparece com pipeline nativo ativo — `info.nativeMode`), IPC
  `native-transport:set-cursor` novo. Validado rodando de verdade: classe/título do botão trocam
  (`live-swap-btn-off`/"Mostrar cursor" ↔ "Esconder cursor") confirmando que o IPC dispara.
- [x] **Troca de fonte ao vivo** — antes bloqueada com aviso fixo pro pipeline nativo inteiro
  (monitor OU janela). Mesma técnica do fix de resize (Sprint 33): IPC novo
  `native-transport:swap-source` para a captura+encoders atuais, troca pra fonte nova
  (monitor↔monitor, janela↔janela, ou monitor↔janela), reinicia os encoders (`ActiveWidth/Height`
  já pega o tamanho da fonte nova sozinho) — sessões `TransportCore` conectadas continuam.
  **Validado de ponta a ponta rodando de verdade** (Playwright `_electron`, Paint↔monitor): as
  DUAS direções confirmadas — swap pra monitor (`encodedPackets` 44-60/tick fluindo) e swap de
  volta pra janela (`encodedPackets` 56-58/tick fluindo), sem crash, "Ao vivo" continua as duas
  vezes. Se a troca falhar, a transmissão agora encerra de verdade (`stop()`) em vez de deixar a
  UI mostrando "ao vivo" com pipeline morto por trás.
- `tsc --noEmit` limpo (main + renderer).

## Sprint 33 — Bug real: redimensionar janela travava a transmissão

Usuário reproduziu o gap #1 já sinalizado (Sprint 31): redimensionar a janela compartilhada
DURANTE a transmissão travava num frame congelado. Causa exata: `WindowCaptureCore` já recriava o
frame pool sozinho no tamanho novo (WGC), mas o NVENC (`EncoderCore`) continuava com a resolução
ANTIGA — não avisava ninguém, e NVENC não aceita mudar resolução numa sessão já ativa.

- [x] **Fix**: `addon.cpp` agora rastreia largura/altura do frame anterior (`g_lastWindowWidth/
  Height`, resetados em `StartWindow`) e devolve `{ok:true, resized:true, width, height}` quando
  muda. `main/index.ts` (`runNativeTransportLoop`) reage destruindo e recriando os dois encoders
  (`destroyEncoder`+`initEncoder`, `destroyEncoderLow`+`initEncoderLow`) com o tamanho novo — as
  sessões `TransportCore` já conectadas continuam (não dependem do encoder, só recebem bytes); o
  primeiro frame do encoder novo já sai como keyframe sozinho (sessão do zero).
- [x] **Validado de ponta a ponta de verdade**: script automatizado abriu o Paint de verdade,
  iniciou transmissão nativa da janela dele, redimensionou via `SetWindowPos` (Win32 real) duas
  vezes seguidas em transmissão ativa. Log confirmou "`janela redimensionou pra 886×693 —
  reiniciando encoder(es)`" nas duas vezes, frames voltando a fluir logo em seguida
  (`encodedPackets` positivo) — sem travar, sem crashar, "Ao vivo" continua depois.
- `tsc --noEmit` limpo.
- Ainda não testado: resize acontecendo com espectador REAL conectado do outro lado (o decoder
  WebCodecs do viewer precisa aceitar a mudança de SPS/resolução inline no bitstream — deveria
  funcionar por spec, não verificado na prática).

## Sprint 32 — Aviso de fallback silencioso + defaults

Usuário testou Rocket League achando que tava no pipeline nativo (HUD mostrava
"SimulcastEncoderAdapter (MediaFoundationVideoEncodeAccelerator)" — LiveKit por software, não
NVENC) — descobriu comparando FPS manualmente. Causa raiz: "Pipeline nativo" vinha DESLIGADO por
padrão, e cair pro caminho antigo era 100% silencioso (nem quando o usuário liga o toggle mas a
fonte falha em ser preparada pro nativo, nem quando o addon tá indisponível).

- [x] **Bug real de UX corrigido**: `BroadcastInfo` ganhou `nativeFallbackReason: string | null` —
  preenchido em `useBroadcast.ts` quando `settings.nativeTransport` tava ligado mas a transmissão
  caiu pro caminho antigo mesmo assim (2 motivos possíveis: addon indisponível, ou fonte não
  taggeada com `nativeMonitorIndex`/`nativeWindowHandle`). Aparece como badge 🐌 no `LiveCard`
  (mesmo estilo do aviso de encoder por software), com tooltip explicando o motivo.
- [x] **Defaults mudados** (pedido direto do usuário) — `nativeTransport: true` e `preferHevc: true`
  em `defaultStreamSettings` (`types/stream.ts`). AV1 continua opt-in (exige RTX 40+, raro).
  Confirmado com screenshot: abre "Avançado" já com os dois switches ligados.
- `tsc --noEmit` limpo, build ok.

## Sprint 31 — Pipeline nativo (WGC) pra captura de janela

Usuário notou que "Pipeline nativo" (NVENC) só funcionava pra monitor inteiro, nunca pra janela —
lacuna real desde o início (DXGI Desktop Duplication, usado pelo `CaptureCore`, só sabe capturar
monitor). Implementado o "WGC Backend" que `docs/NATIVE_CAPTURE.md` §Backend Abstrato já previa
desde o começo mas nunca tinha sido construído.

- [x] **`WindowCaptureCore.h/.cpp`** (novo) — captura de UMA janela via `Windows.Graphics.Capture`,
  COM ABI puro (`Microsoft::WRL`, sem C++/WinRT/coroutines, mesmo estilo do `CaptureCore`). Device
  D3D11 próprio, separado do de monitor (nunca os dois ativos ao mesmo tempo). `addon.cpp` ganhou
  `g_windowCore`/`g_usingWindow` + helpers `ActiveDevice()`/`ActiveComposeTexture()`/etc. usados
  por `InitEncoder`/`EncodeCurrentFrame`/`AcquireFrameGpuOnly` em vez de `g_core->` direto —
  `CaptureCore.cpp` (DXGI/monitor) não mudou nenhuma linha, por pedido explícito do usuário.
- [x] **Bug real corrigido**: `add_FrameArrived` falhava com `RO_E_MUST_BE_AGILE` (0x8000001C) — os
  handlers WRL precisavam de `FtmBase` (Free-Threaded Marshaler) pra serem chamáveis da thread MTA
  interna do WGC que dispara o evento.
- [x] **Bug real corrigido**: janela minimizada reporta tamanho de ~160×28 (ícone da barra de
  tarefas) em vez do tamanho restaurado — capturaria vídeo minúsculo sem erro. `Start()` agora
  recusa de cara com `IsIconic(hwnd)`.
- [x] Fiação completa: `preload/index.ts` (`nativeWindowHandle` no `CaptureSource`,
  `NativeTransportStartArgs.hwnd`), `SourcePicker.tsx` (extrai HWND do id do desktopCapturer,
  formato `"window:<hwnd>:<n>"`), `useBroadcast.ts` (gate por monitor OU janela),
  `nativeTransport.ts`/`main/index.ts` (`startNativeCaptureSource`, `startWindow` no addon).
  `tsc --noEmit` limpo (main + renderer).
- [x] **Validado de ponta a ponta de verdade**: script isolado (addon requerido direto, HWND real
  via PowerShell) confirmou frames WGC chegando; depois disso, app inteiro via Playwright
  `_electron` com "Pipeline nativo" + janela real escolhida no picker + `native-transport:start`
  real — telemetria confirmou `acquired=57`/`encodedPackets=53` (WGC → NVENC funcionando). Só não
  teve espectador real conectado nesse teste (mesma categoria "não validado com viewer real" que o
  resto do pipeline nativo já tinha documentado — não é falha da captura/encode).
- Efeito colateral bônus (achado sem querer testando "Janelas" pra esse trabalho): confirma que o
  filtro de `thumbnail.isEmpty()` (Sprint da passada de UI polish anterior) já reduz bastante o
  ruído de janelas sem conteúdo real na lista.

## Pendências abertas (atualizado ao fim do Sprint 30) — outra frente, sem relação com a demanda de janelas acima (já concluída)

Em ordem sugerida (mas qualquer uma pode ser escolhida direto):

1. **Aberração cromática H.264** (`docs/NATIVE_CAPTURE.md` "Em aberto") — suspeita forte é
   contenção de GPU no DECODE por software (H.264 sozinho ainda mostra o artefato, HEVC quase
   elimina — decodifica por hardware). Próximo passo: testar decode num dispositivo separado de
   verdade (não host+viewer na mesma máquina) — travou por isolamento de AP do roteador na última
   tentativa, retomar só depois de resolver isso ou achar rede sem isolamento.
2. **Validar fix de FPS do Sprint 25** — `SetBitrate` ganhou `forceKeyframe` opcional pra não
   forçar keyframe em todo ajuste do AIMD (causava queda de 60→48-55fps). Corrigido e recompilado,
   usuário ainda não confirmou que os 60fps cravados voltaram de verdade em teste real.
3. **AV1 em hardware real** (Sprint 27) — implementado e compilando limpo, mas nunca testado numa
   GPU RTX 40+ de verdade (só a cascata de fallback foi validada, cai pra H.264 sem GPU AV1).
4. **Device-lost recovery** (`docs/NATIVE_CAPTURE.md` Fase 4) — hoje um TDR do driver (comum sob
   GPU muito sobrecarregada, jogo 3D pesado + captura/encode brigando) só para a transmissão com
   segurança; recriar o pipeline inteiro (device D3D11 → duplication → encoders high/low) sozinho
   pra retomar automaticamente, sem derrubar as sessões `TransportCore` já conectadas (essas não
   dependem do device, só recebem bytes), fica pra depois — avaliado como baixa prioridade (TDR é
   raro).
5. **Firewall/rede diferente do host** (Sprint 26, PARADO) — app fecha sozinho quando um segundo
   dispositivo tenta conectar em rede diferente (cabo→WiFi). Já descartado: firewall do Windows
   (regra allow já existe) e isolamento de rede (sinalização TCP chega certinho). Achado: processo
   nunca abre socket UDP nesse caso, fecha limpo (sem crash nativo, sem dump). Handler de
   `process.on("uncaughtException")` já foi adicionado (grava em
   `{userData}/uncaught-exception.log`) mas ainda não foi reproduzido com esse log novo — próximo
   passo é ler esse arquivo depois de reproduzir de novo.

## Próxima fase — além da captura nativa

A captura nativa (`docs/NATIVE_CAPTURE.md` Fases 1-4) atingiu os objetivos dela — ver seção
"Status" nesse arquivo. O que sobra é exatamente o que o Capture Core sempre disse que NÃO era
trabalho dele (§Não Objetivos): a lista abaixo é essa lista, com o estado real de cada item hoje
(nem tudo é "zero" — algumas dessas coisas já existem no caminho LiveKit e precisam só chegar no
caminho nativo, outras não existem em lugar nenhum ainda).

- [x] **Interface gráfica (2ª passada — reestrutura da tela inicial)** — usuário reportou que a
  pilha de selects+toggles quebrava o tamanho da janela principal (`HomePage`, 440×720 fixa,
  não-redimensionável — `NORMAL_SIZE` em `main/index.ts`). Causa real: configs (resolução/FPS/
  qualidade/cursor/texto/beta) e o formulário de fonte (`SourcePicker`) viviam em DUAS telas
  separadas de tamanhos diferentes, cramando tudo numa janela pequena e fixa em vez de seguir o
  mockup original de `CLAUDE.md` (Monitor/Janela/Qualidade/FPS numa tela só). Corrigido: `HomePage`
  volta a ser só título/abas/botão "Compartilhar tela" (mockup original); `SettingsForm` (resolução/
  FPS/qualidade em linha via `settings-form-row`, mais nome da sala) migrou pro rodapé do
  `SourcePicker`, que já abre numa janela maior (720×640, `PICKER_SIZE`) com espaço de sobra. Toggle
  "Avançado" da 1ª passada (pipeline nativo/HEVC/AV1) continua dentro desse formulário, só mudou de
  endereço.
- [x] **Bug real achado rodando o app de verdade** (Playwright `_electron`, não só compilação) —
  `NORMAL_SIZE` baixado pra 400 (pedido do usuário, tela ficou bem menor sem as configs) quebrou a
  aba "Assistir": conteúdo mede 378px contra 400 disponíveis, sobrava scrollbar visível de ~16px só
  pro texto "Nenhuma transmissão ativa". Subido pra 420 (medido de novo, sem overflow nas duas
  abas). Screenshots conferidos: tela inicial, aba assistir, picker (config em linha) e picker com
  "Avançado" aberto — todos limpos.
- Sobra menor, não corrigida: grade de fontes no `SourcePicker` deixa bastante espaço vazio entre
  as thumbnails e o rodapé de config quando só tem 1-2 telas (a `PICKER_SIZE` de 720×640 foi
  dimensionada pra caber telas+janelas+config todos juntos, não encolhe com poucas fontes) —
  cosmético, não quebra nada, não bloqueou o fechamento desta passada.
- [x] **2 bugs reais achados testando a aba "Janelas" de verdade** (pedido do usuário — 8 janelas
  reais abertas, não só 1-2 telas):
  1. **Grid blowout clássico do CSS Grid** — `.picker-tile-label` tem `white-space: nowrap`; um
     nome de janela sem espaço (`RzMonitorForegroundWindow`) virava o min-content do item do grid,
     esticando o track de 150px além do previsto e quebrando o layout de 4 colunas. Fix:
     `min-width: 0` em `.picker-tile` (deixa o ellipsis do label cortar de verdade em vez de inflar
     a coluna).
  2. **Scroll horizontal fantasma** mesmo depois do fix acima (~60px de sobra) — causa é uma regra
     da spec CSS: `overflow-y: auto` sozinho faz `overflow-x` (que tava no default `visible`)
     virar `auto` também, e o paradoxo grid+scrollbar-vertical (a barra vertical reduz a largura
     disponível, o grid recalcula colunas, o recálculo ainda sobra alguns px) expunha esse eixo.
     Grid nunca devia rolar de lado (só quebra linha) — fix: `overflow-x: hidden` explícito em
     `.picker-body`.
  Confirmado com medição real (Playwright `_electron`, `scrollWidth`/`clientWidth` antes/depois) e
  screenshot: 8 janelas quebram em 2 linhas limpas, só scroll vertical, sem corte lateral.
  Testado também ligar "Pipeline nativo" com Avançado aberto (HEVC/AV1 aparecendo) — grid encolhe e
  ganha scroll próprio quando o rodapé cresce, comportamento correto, nada quebra.
- [x] **3 pedidos diretos do usuário depois de ver os screenshots**:
  1. Ligar "Pipeline nativo" empurrava HEVC/AV1 de golpe (entra/sai condicional no React) — trocado
     pra sempre no DOM, altura anima via CSS puro (`grid-template-rows: 0fr↔1fr`,
     `settings-advanced-extra`/`-open`/`-inner` em `styles.css`) — sem JS medindo pixel, funciona
     com qualquer altura de conteúdo.
  2. "Janelas" tinha imagem de fallback quebrada vazando texto pra fora do card, e tinha janelas
     sem UI real na lista (`RzMonitorForegroundWindow`, helpers do Raycast) — **sem hardcodar nome
     de app**: filtro genérico em `capture:list-sources` (`main/index.ts`) descarta janelas cuja
     `thumbnail.isEmpty()` (o DWM não tem conteúdo visual nenhum pra tirar miniatura dessas —
     mesmo sinal pra qualquer app). Contagem real caiu de 8→7 janelas depois do filtro (confirmado
     rodando). Defesa extra no `SourceTile` (`SourcePicker.tsx`): `onError` no `<img>` troca pra um
     placeholder controlado (ícone do app ou inicial do nome) em vez do ícone de imagem quebrada
     nativo do navegador (que ignora overflow/object-fit e desenha o `alt` por cima do card).
  3. Botão "Voltar" (seta + texto) no header do `SourcePicker`, ao lado do X — mesmo handler
     (`onCancel`), só mais explícito que só o X pra "sair pro menu principal".
  `tsc --noEmit` limpo, tudo revalidado com screenshot real (Playwright `_electron`) depois dos 3
  fixes.
- [x] **Vazamento de texto ainda sobrava** (usuário mandou screenshot real apontando) — mesma causa
  do grid blowout já corrigido, só um nível mais fundo: `.picker-tile-label` é item FLEX (não
  grid) dentro de `.picker-tile` (coluna) com `white-space:nowrap` — `min-width:0` no pai não
  cobre o próprio label, que tem seu próprio `min-width:auto` valendo como piso mesmo com
  `align-items:stretch`. Fix: `min-width:0` + `width:100%` direto no `.picker-tile-label`. Bônus
  pedido junto: `title={source.name}` no span — nome completo aparece em tooltip nativo no hover,
  sem precisar caber na largura do card. Revalidado com screenshot.
- **WebRTC** — a base (ICE/DTLS-SRTP via libdatachannel) já é o que existe hoje no pipeline
  nativo; o que falta pra "completo" nesse sentido é infraestrutura de produção: **TURN** nunca foi
  plugado (só STUN público do Google, usado só pra validar — CLAUDE.md §Infraestrutura já previa
  isso desde o início), e reconexão/resiliência de sinalização além do que já existe (backoff
  exponencial no polling antigo virou WS no Sprint 24, mas reconexão de WS caído não foi testada a
  fundo).
- **Áudio** — caminho LiveKit já tem ("Compartilhar áudio do sistema", Sprint 1) mas é loopback do
  sistema INTEIRO, sem seleção por app. O caminho nativo (DXGI→NVENC→libdatachannel) **não publica
  áudio nenhum** ainda (documentado como fora de escopo desde a Fase 2). Pedido específico do
  usuário — **escolher uma faixa/app de áudio pra NUNCA ser capturado** (ex.: Discord deixa excluir
  um app específico do compartilhamento) — precisa de pesquisa: Windows tem uma API de captura de
  loopback por PROCESSO desde o 10 2004 (`ActivateAudioInterfaceAsync` +
  `AUDIOCLIENT_ACTIVATION_PARAMS` com modo de inclusão/exclusão por árvore de processo), diferente
  do loopback de dispositivo inteiro que qualquer um dos dois caminhos usaria hoje — não validado
  ainda se dá pra fazer "excluir 1 app" (em vez de "incluir só 1 app") com essa API sem capturar
  tudo e filtrar depois.
- **Controle de salas** — existe e funciona (`backend/src/routes/rooms.ts`, criação/token/TTL),
  mas ganhou vários remendos específicos do modo nativo ao longo do caminho (Sprint 23: sala nativa
  não tinha rede de segurança nenhuma do lado do backend, precisou de `isOrphan` pular salas
  nativas + `before-quit` deletando a sala ao fechar o app) — funcional, não robusto/testado sob
  cenários adversos (múltiplos hosts na mesma sala, sala travada, etc.).
- **Sinalização de conexão** — caminho nativo tem WS dedicado (`nativeWsRelay.ts`, Sprint 24,
  relay puro sem storage), caminho LiveKit usa a sinalização própria do LiveKit. Os dois funcionam,
  nenhum foi estressado sob reconexão de rede ruim de propósito.
- **Lógica de usuários** — **não existe nada aqui ainda**. `CLAUDE.md` §Segurança lista
  autenticação do host, autorização de espectadores, rate limiting, validação de entrada — hoje só
  existe token de sala com TTL (`ROOM_TOKEN_TTL_SECONDS`), sem conceito de usuário/conta/permissão
  nenhum. Maior lacuna real da lista inteira, se o produto for além de "link temporário entre
  conhecidos".

### Escopo da próxima entrega (decisão do usuário, 2026-08-26)

Próxima frente são os "Não Objetivos" acima (não as pendências de teste do Sprint 30) — mas
**escopo fechado nos 3 primeiros abaixo (Interface gráfica, Áudio, WebRTC/TURN)**, pra não
sobrecarregar uma entrega só. **Controle de salas, Sinalização de conexão e Lógica de usuários
ficam pra depois** — usuário quer testar essa entrega com calma antes de expandir mais.

Ordenados do mais fácil pro mais difícil — **exceto Áudio, que o usuário quer priorizado mesmo
não sendo o mais fácil da lista**:

1. **Interface gráfica** — mais fácil: é polish visual contido, sem tocar em C++/rede/protocolo.
   Boa parte já avançou nas sessões anteriores (reestrutura da tela inicial, picker) — o que sobra
   é mais fino (ex.: espaço vazio no picker com poucas fontes, já anotado acima).
2. **Áudio** ⭐ **(prioridade do usuário, independente da posição nessa lista)** — pedido
   específico: excluir 1 app do loopback (tipo o "excluir do compartilhamento" do Discord).
   Pesquisa já apontada acima: API de loopback por PROCESSO do Windows
   (`ActivateAudioInterfaceAsync`/`AUDIOCLIENT_ACTIVATION_PARAMS`), incerteza real é se ela
   suporta modo "excluir" (em vez de só "incluir só estes") sem precisar capturar tudo e filtrar
   depois — primeiro passo é essa pesquisa, antes de qualquer código.
   - **Adendo do usuário (2026-08-25) — 2 fontes específicas a bloquear, motivo real por trás**:
     objetivo é ninguém se ouvir duplicado (o usuário nem o espectador que também tá na call).
     1. **Retorno do microfone** (o usuário ouve o próprio mic sendo capturado e retransmitido).
     2. **Áudio do Discord** especificamente — motivo direto: o uso real dessa aplicação é
        compartilhar tela DURANTE uma call de Discord, então o áudio do Discord (vozes da call)
        sair pela transmissão nativa faz o espectador (que já tá na mesma call) ouvir a call
        duas vezes.
     Ambos são "excluir só isso", não "incluir só isso" — reforça a pesquisa acima sobre o modo
     de exclusão da API de loopback por processo.
   - **Nota separada (nível de dificuldade em aberto)**: em modo JANELA (WGC), o ideal seria capturar
     só o áudio DA JANELA ATIVA (equivalente de áudio ao que a captura de vídeo já faz isolando
     a janela) — ainda não pesquisado se o Windows expõe loopback por-janela (só por-processo é
     conhecido até agora, ver acima) ou se isso precisa ser resolvido por outro caminho. Avaliar
     dificuldade antes de comprometer com isso — pode não haver API que sirva.
3. **WebRTC (TURN + resiliência)** — último item DESSA entrega. Precisa de infraestrutura nova de
   verdade (servidor TURN provisionado, não só código) além do código de reconexão.

**Adiados pra uma entrega futura** (não pegar nessa, mesmo estando prontos/elegíveis):

- **Controle de salas** — código já existe e funciona; o trabalho seria hardening/teste de
  cenários adversos (múltiplos hosts na mesma sala, sala travada) em cima do que já tá escrito.
- **Sinalização de conexão** — mesma categoria (WS nativo + sinalização LiveKit já existem),
  trabalho seria estressar reconexão de rede ruim de propósito.
- **Lógica de usuários** — mais difícil e maior de longe: não existe NADA hoje (autenticação,
  autorização, rate limiting, contas) — subsistema novo inteiro. Explicitamente **tarefa futura**,
  não entra em nenhuma entrega próxima por enquanto.

## Sprint 1 — Mudanças sistemicas
- [x] app tauri não fecha ao clicar no botão de fechar, aliás, não funciona nem minimizar ou maximizar — faltavam permissões `core:window:allow-close/minimize/maximize/unmaximize/toggle-maximize` no capabilities (só tínhamos `core:default`, que não inclui essas)
- [x] falta o recurso de compartilhar tela com audio — checkbox "Compartilhar áudio do sistema" no desktop e no viewer, publica track de áudio (`Track.Source.ScreenShareAudio`) junto do vídeo
- [x] o viewer poderia também criar as transmissões, seria interessante não depender só do app desktop para compartilhar tela — viewer ganhou fluxo completo de criar sala (captura, publish, link, stats, encerrar), espelhando a lógica do desktop

## Sprint 2 — Mudanças visuais
- [x] deixar o app desktop/web mais apresentável — logo mark (`Logo.tsx`, gradiente) em ambos, tipografia/hierarquia refeita, sombras e transições em botões/cards, select customizado (seta própria, focus ring), titlebar do desktop com logo pequeno
- [x] criar uma tela legal no app web para criação de screen shares também — `home-card` com sombra/borda, glow radial de fundo, layout tipo landing em vez de formulário solto
- [x] deixar com mais cara de profissional ambas as aplicações visuais — tokens `--accent-2` pra gradiente/links, cards com elevação (`box-shadow`) em vez de fundo plano, `live-card` também virou card com borda/sombra no viewer

## Sprint 3 — Melhoria de vida (validações)
- [x] validar se tem como adicionar o change screen no widget de ao vivo — dá, e foi implementado. `LiveKit`/WebRTC tem `replaceTrack()`, que troca o `MediaStreamTrack` por trás do `RTCRtpSender` já existente **sem renegociar a conexão** — espectadores não veem reconexão nenhuma, só o vídeo trocando. Botão novo (ícone de troca) no widget ao vivo abre o mesmo `SourcePicker`, escolhe a fonte nova, troca vídeo e áudio (`swapVideoTrack`/`swapAudioTrack` em `services/livekit.ts`), só derruba a captura antiga depois que a nova já tá no ar. A janela também sabe abrir o seletor a partir do modo widget e voltar pra ele depois (não pro tamanho normal) — precisou generalizar a lógica de resize que já tinha pro modo widget (`applyWidgetBounds()` em `main/index.ts`).
- [x] validar se tem como transmitir janelas de apps com audio também — dá. Eu mesmo tinha bloqueado isso no código (`capture.ts`) baseado em suposição, sem nunca testar de verdade. `chromeMediaSource: "desktop"` no áudio pede o loopback do **sistema inteiro** (não é isolado por janela — a API não permite capturar o áudio de um app específico), mas nada impede de pedir esse áudio junto com uma janela específica de vídeo. Removida a restrição.
- [x] validar se tem como trazer tudo que foi feito pro electron lá para o web — **parcialmente possível, uma parte é impossível por design**. A parte de **lógica de publish** (prioridade de codec H.264, bitrate calculado pela resolução real, `degradationPreference: balanced`, estatísticas de codec/encoder) **já estava espelhada** no viewer desde as mudanças anteriores desta sessão (`viewer/src/services/{publish,codecs}.ts`, `types/stream.ts`) — conferido, não precisou de nada novo. A parte que **não dá pra portar**: a barra "X está compartilhando sua tela" com botão de esconder é do próprio motor do navegador (Chromium), disparada especificamente pelo fluxo de permissão do `getDisplayMedia()` — API padrão da web, sem alternativa pra sites comuns. O Electron consegue evitar isso porque `desktopCapturer` é uma API **fora da spec web**, exclusiva de apps Electron/Chromium embarcado — um site rodando num navegador normal não tem (e não pode ter, por design de segurança) acesso a isso. Não é limitação de implementação, é fronteira de segurança do navegador — só sai daí virando app instalado (que é exatamente o que o desktop já é).


## Sprint 4 — Pequenas melhorias
- [x] validar se tem como "evitar" captura de áudio de um determinado aplicativo — **não dá via código**. `chromeMediaSource: "desktop"` só expõe o loopback do dispositivo de saída **padrão** do Windows pra JS/Electron, sem seletor de app nem de dispositivo — excluir um app específico exigiria WASAPI nativo (mesma complexidade da POC de captura nativa que já deu errado, não vale a pena reabrir essa porta). **Solução sem código, 100% no Windows**: Configurações → Sistema → Som → "Preferências de volume por app" — roteia a saída do Discord (ou qualquer app) pra um dispositivo diferente do padrão (ex.: fones), mantendo jogo/música no padrão. Como a captura sempre pega o dispositivo padrão, o app roteado pra outro lugar fica automaticamente fora do loopback.
- [x] criar visualizador dentro do app desktop (onde tu pode clicar nas transmissões ativas e ver direto no app) — nova rota `GET /rooms` no backend lista salas ativas (em memória, sem endpoint de ID antes); `HomePage` ganhou abas "Compartilhar"/"Assistir" — a segunda mostra `RoomsBrowser` (poll a cada 4s) e ao clicar abre `RoomViewer`, que conecta direto via `livekit-client` (mesma lógica de `useRoomStream` do viewer web, portada pra `useRoomViewer`) sem passar por navegador nenhum.

## Sprint 5 — Aba assistir + slug de sala
- [x] visual da aba assistir mais parecido com o viewer web — `RoomViewer` do desktop agora usa os mesmos `live-quality-badge`/`video-controls-bar`/`pill-btn` do viewer (portados pro `styles.css` do desktop), som muted por padrão como no viewer web.
- [x] deixar as abas Transmitir/Assistir e a lista de salas mais bonitas — `mode-tabs` (segmented control) substitui o `picker-tab` reaproveitado; `RoomsBrowser` virou lista de linhas (`room-row`, ponto verde "ao vivo", tempo relativo) em vez dos tiles de thumbnail do picker de fontes (que não fazem sentido pra sala sem preview).
- [x] slug de sala escolhido pelo usuário — `POST /rooms` aceita `slug` opcional (normalizado, valida `^[a-z0-9-]{3,32}$`, 409 se já em uso); campo "Nome da sala" no desktop e no viewer web, sala usa o slug como ID quando informado, senão gera aleatório como antes.

## Sprint 6 — Paridade do player desktop + salas no web
- [x] áudio da aba assistir do desktop vinha ligado por padrão — a tag `<video muted>` sozinha não é confiável (a track pode chegar antes do primeiro render aplicar o atributo); trocado pro mesmo padrão do viewer web: `muted` fixo no JSX + `useEffect` que força `videoRef.current.muted` via DOM direto.
- [x] player do desktop ganhou os mesmos controles do viewer web — portado o `VideoPlayer.tsx` (pill de controles: estatísticas, suavização/playout delay, volume, tela cheia) e o `useRoomStream` completo (renomeado `useRoomViewer`, mesmos stats de bitrate/latência/perda) pro desktop; `RoomViewer.tsx` agora só monta o player, sem reimplementar UI própria.
- [x] aba de salas ativas no viewer web — mesmo `GET /rooms` do desktop, componente `RoomsBrowser` (lista com ponto "ao vivo" + tempo relativo) numa aba "Assistir" ao lado de "Transmitir" na home; clicar navega pra `/s/:roomId` (mesma rota que o link direto já usava).

## Sprint 7 — Correções finas
- [x] pill de controles do player desktop vinha toda "aberta" e sem hover — CSS de `.pill-flyout`/`.pill-popover-group`/`.pill-divider`/`.stats-flyout` nunca tinha sido portada de fato pro `styles.css` do desktop (só `.pill-btn` foi parar lá), então os flyouts não colapsavam por falta de `max-width:0`. Adicionada a portada completa.
- [x] widget "ao vivo" sempre nascia no monitor 1 mesmo com o app deixado no monitor 2 — `applyWidgetBounds()` usava `screen.getPrimaryDisplay()` fixo em vez do monitor onde a janela já estava; trocado pra `screen.getDisplayMatching(mainWindow.getBounds())`.
- [x] barra de controles do player (desktop + web) some sozinha quando o mouse se afasta do player, volta ao aproximar — `.video-controls-bar` com opacidade condicionada a `.video-container:hover`.

## Sprint 8 — Ajustes finos
- [x] tela de assistir do desktop maximiza a janela ao entrar numa sala (mais espaço pro player) e trava resize; ao sair, volta pro tamanho normal centralizado — novo `window:set-watch-mode` no main process, mesma ordem cuidadosa maximize-antes-de-travar do widget (`RoomViewer.tsx` chama no mount/unmount).
- [x] padrão de qualidade trocado pra 1080p / alta (era automática/automática) nos dois apps — só muda `defaultStreamSettings`, usuário ainda pode trocar antes de compartilhar.

- [x] sala fantasma na lista "Assistir" (transmissão já morta, host caiu sem chamar DELETE) — o mapa em memória de `rooms.ts` só é limpo por `DELETE /rooms/:id` explícito ou pelo `scheduleRoomCleanup`, que nunca é chamado (não existe webhook do LiveKit implementado); `GET /rooms` agora cruza com `RoomServiceClient.listRooms()` (a fonte de verdade real de quem tá ao vivo no LiveKit) e descarta sozinho qualquer sala órfã com mais de 20s (folga pra não apagar uma sala que acabou de ser criada e ainda não conectou) — resolve sozinho sem precisar reiniciar o backend.
- [x] widget "ao vivo" se escondia atrás de outras janelas — `setAlwaysOnTop(true)` sem nível explícito usa "floating", que ainda perde pra outros always-on-top (overlays, jogos fullscreen exclusivo); trocado pro nível "screen-saver" (o mais alto que o Electron expõe) + `setVisibleOnAllWorkspaces(true, {visibleOnFullScreen:true})` pra não sumir ao trocar de desktop virtual ou um jogo ir fullscreen.

## Sprint 9 - Auto update
- [x] sistema de auto-update via Releases do GitHub — `electron-updater` (`autoDownload:false`) checa `checkForUpdates()` no boot (só se `app.isPackaged`, dev não tem `app-update.yml`); publish configurado em `electron-builder.yml` (`provider: github`, owner/repo do remote); changelog é o `releaseNotes` que o provider do GitHub já preenche com a descrição do release.
- [x] instruções no README de como publicar — seção nova "Publicando uma nova versão": subir version no package.json, gerar `GH_TOKEN` (escopo `repo`), `npm run dist:publish` (script novo), explica que sobe como **rascunho** de propósito (dá pra revisar/editar o changelog antes de publicar de verdade).
- [x] modal de nova versão — `UpdateModal.tsx`, changelog renderizado linha-a-linha (sem lib de markdown, cobre o formato normal de bullet list), estados `available`/`downloading` (barra de progresso)/`downloaded`/`error`; escondido enquanto o widget "ao vivo" tá ativo (janela pequena demais, ia atrapalhar a transmissão).
- [x] negar ou atualizar, com progresso e reinício — botão "Agora não" fecha o aviso; "Atualizar" dispara `autoUpdater.downloadUpdate()`, mostra `%` ao vivo via `download-progress`, e quando termina (`update-downloaded`) troca pro botão "Reiniciar e instalar" que chama `quitAndInstall()`.
- [x] botão de debug (`🐞 update`, só em `import.meta.env.DEV`) simula o modal inteiro com dados falsos — dá pra validar visual sem publicar uma versão de verdade no GitHub.

## Sprint 10 — Insights de encoder aplicados (docs/INSIGHTS-ENCODER.md)
- [x] `contentHint = "detail"` na track de vídeo capturada (desktop e viewer) — avisa o encoder do browser que é conteúdo de tela/texto, não câmera, sem custo de renegociação.
- [x] áudio de tela republicado com `AudioPresets.musicHighQualityStereo` + `dtx:false` + `red:true` + `forceStereo:true` (era o preset "music" padrão do LiveKit, sem esses ajustes) — evita cortar nuance de som de sistema/jogo pensando que é pausa de fala.
- [x] QP médio (quantization parameter) exposto nas estatísticas ao vivo — calculado por delta (`qpSum`/`framesEncoded`) em `readPublishStats`, mostrado como "QP N" quando o browser reporta.
- [x] aviso "⚠️ CPU" nas estatísticas quando `encoderImplementation` indica software (libvpx/libaom/openh264/libx264) em vez de hardware — só avisa, não troca codec sozinho em pleno vivo.
- Itens não implementados por decisão consciente (documentado no próprio `docs/INSIGHTS-ENCODER.md`): reescolha dinâmica de codec, simulcast fixo de 3 camadas vs encode único adaptativo, bitrate por conteúdo, keyframe interval — fora do que o LiveKit SDK expõe ou exigem mudança arquitetural maior.
- [x] **revertido após teste real**: `contentHint = "detail"` piorou stutter/queda de FPS em jogos de movimento rápido (Rocket League, que sempre rodou bem via Discord) — o hint prioriza nitidez sobre fluidez incondicionalmente, ruim pra conteúdo majoritariamente em movimento. Removido dos dois clientes.
- [x] `degradationPreference` trocado de `"balanced"` pra `"maintain-framerate"` nos dois clientes, como correção direta do mesmo teste — nunca cai de FPS, reduz resolução primeiro (CLAUDE.md já prioriza fluidez de jogos sobre nitidez máxima).
- [x] toggle "Melhorar texto" nas configurações (desligado por padrão) — `contentHint: "text"` vira opt-in por sessão em vez de forçado sempre, já que só ajuda em conteúdo parado (código/documento) e atrapalha em jogo.
- [x] `BITS_PER_PIXEL` de `0.1` pra `0.15` — QP médio ficava 30-40 mesmo com encoder de hardware confirmado (sem aviso de CPU) rodando jogo de movimento rápido a 10-15 Mbps; teto de bitrate baixo demais pro hardware disponível, não limite do encoder. 1080p60 "alta" sobe de ~12.4 pra ~18.7 Mbps.
- [x] **bug real corrigido**: resolução/FPS mostrados no host e no viewer eram lidos **uma vez só** (`getSettings()` no instante do subscribe/captura) e nunca mais atualizados — congelava em valor de placeholder do browser antes do primeiro frame real chegar (`"2 × 2"`, `"640 × 480"`, `"Infinity FPS"`). Trocado pra ler `frameWidth`/`frameHeight`/`framesPerSecond` do `getStats()` (inbound-rtp no viewer, outbound-rtp no host) a cada poll de 2s — reflete o que tá sendo codificado/decodificado de verdade, continuamente.
- [x] **bug real corrigido**: com simulcast (3 camadas publicadas), `readPublishStats` pegava "o primeiro outbound-rtp que aparecesse no Map" — sem ordem garantida entre as 3 camadas, podia estar lendo QP/bitrate/resolução da camada de qualidade mais baixa (360p) em vez da camada base. Agora escolhe a camada de maior área (`frameWidth × frameHeight`) como "primária" pra esses campos, e soma bytes de todas as camadas pro bitrate total exibido (reflete o upload real gasto).

## Sprint 11 — Itens 12-15 do INSIGHTS-ENCODER.md (transição hardware↔software)
- [x] **item 12**: `hasSoftwareLayer` — checa `encoderImplementation` de TODAS as camadas do simulcast, não só a primária/base. GPU de consumo limita sessões de hardware encode simultâneas (3 no driver padrão da NVIDIA); publicar 3 camadas simulcast podia deixar a base em hardware e as menores em software sem o aviso de CPU nunca detectar. Aviso agora dispara se qualquer camada cair em software.
- [x] **item 13**: ação "⚡ Otimizar codec" — aparece só quando o codec ativo é AV1/VP9 E caiu em software (os pesados de verdade; H.264 por software já é o mais leve que existe, forçar de novo não ajudaria). Despublica e republica a mesma track forçando `videoCodec: "h264"` (`switchToH264` em `livekit.ts`/`publish.ts`). Sempre ação do usuário, nunca automática — republicar causa soluço visual curto pros espectadores.
- [x] **item 14**: `qualityLimitationReason` (o Chromium já sabe dizer "cpu"/"bandwidth"/"other" — mais direto que inferir pelo QP) e `avgEncodeMs` (tempo médio de encode por frame, indicador antecedente de sobrecarga antes de frame cair de verdade) expostos e incluídos no tooltip do aviso de CPU.
- [x] **item 15**: `resetCodecCache()` — `cachedCodec` era uma variável de módulo que sobrevivia entre transmissões na mesma sessão do app; se a primeira transmissão caiu em software por motivo passageiro, todas as seguintes herdavam a escolha ruim. Resetado em `disconnect()`, cada nova transmissão reavalia do zero.

## Sprint 12 — Confirmação real do item 4 (simulcast custoso) + fix
- [x] **teste real confirmou item 4**: usuário testou Rocket League (desktop→Edge) com as novas estatísticas — FPS entregue caía com o tempo (20-55fps oscilando) mesmo com as 3 camadas do simulcast confirmadas em hardware (`MediaFoundationVideoEncodeAccelerator`), sem sinal de rede (LiveKit local) nem software fallback. Conclusão: GPU não sustenta 3 encodes simultâneos + renderizar o jogo por tempo prolongado.
- [x] `pickSimulcastLayers()` reduzido de 2 camadas extras (3 encodes totais) pra 1 camada extra (2 encodes totais) nos dois clientes — prioriza estabilidade de FPS do host sobre diversidade de qualidade entre espectadores.
- [x] tooltip do aviso de CPU ganhou dica de checar "aceleração de hardware" nas configs do navegador — segundo teste do usuário (Chrome host) mostrou fallback completo pra `OpenH264` software só no Chrome, não no Edge, no mesmo PC — configuração do navegador, não bug do app.

## Sprint 13 — App desktop hosteando pior que navegador (achado real)
- [x] **causa real encontrada**: usuário comparou hostear pelo app desktop (Electron) vs pelo navegador — só o app desktop oscilava 20-55fps num alvo de 60fps, navegador ficava estável em 55fps. `backgroundThrottling` (default `true` no Electron) reduz a prioridade de timers/pipeline de mídia de uma janela OCLUSA — mesmo com `setAlwaysOnTop`, um jogo em tela cheia cobre o widget e o Chromium trata isso como "não visível", throttlando a própria captura/encode. Uma aba de navegador comum não sofre isso do mesmo jeito. Desligado (`backgroundThrottling: false`) no `webPreferences` da janela principal — esse app precisa continuar codificando em velocidade plena mesmo coberto/minimizado.
- [x] opção de 120 FPS adicionada ao seletor (desktop e viewer) — best-effort como todo o resto de captura, só faz sentido com monitor de alto refresh e GPU de sobra.

## Sprint 14 — Segunda causa do FPS baixo no desktop + ferramenta de teste
- [x] **segunda causa investigada**: captura no desktop (`capture.ts`) não mandava `frameRate` nenhum na negociação INICIAL da sessão WGC (só via `applyConstraints()` depois, best-effort) — o comentário no próprio código já dizia "o WGC costuma cair num FPS conservador (30)" nesse caso. O navegador manda `frameRate` já no `getDisplayMedia()` inicial, dando à sessão WGC a chance de inicializar direto em 60fps. Adicionado `optional: [{minFrameRate}, {maxFrameRate}]` (formato legado do Chrome pra hint NEGOCIÁVEL, diferente do `mandatory` min/max exato que já causou hang antes) na constraint inicial — o timeout de 8s existente continua como rede de segurança caso trave mesmo assim.
- [x] `npm run dev:multi` — abre uma segunda janela do app junto com o dev normal (env var `OPEN_TEST_WINDOW`), pra testar host+espectador no mesmo PC sem precisar de duas máquinas. Exigiu corrigir os handlers de janela (`window:minimize/toggle-maximize/close/set-widget-mode/set-picker-mode/set-watch-mode`) pra resolver a janela via `BrowserWindow.fromWebContents(event.sender)` em vez de um `mainWindow` global — antes, fechar QUALQUER janela matava o app inteiro (`app.quit()` direto no handler `closed`) e todo controle de janela mexia sempre na mesma janela global, o que quebraria com duas janelas abertas.

## Sprint 15 — STUN local, HUD de dev, higiene do LiveKit
- [x] `wgc_capture_session.cc ProcessFrame failed... using existing frame` nos logs — **não é bug do app nem do LiveKit**, é a API nativa do Windows (WGC) falhando em entregar frame novo pro capture session (erro `E_FAIL` genérico do Windows), provavelmente por saturação de GPU durante o jogo. Fora do alcance de correção via JS/config — registrado como limitação conhecida, não "consertado".
- [x] STUN público (Google/Twilio) gerando erro de DNS/timeout em toda interface de rede virtual da máquina (VPN/WSL/Hyper-V) mesmo em LiveKit 100% local — cliente agora passa `rtcConfig: {iceServers: []}` quando detecta `LIVEKIT_URL` local (`localhost`/`127.0.0.1`), nos dois apps, nas duas pontas (publish e subscribe). Deploy real (URL externa) continua usando STUN/TURN normalmente.
- [x] `infra/livekit/livekit.yaml`: `stun_servers: []` (mesma coisa do lado do servidor) e `use_ice_lite: true` (SFU nunca inicia conexão, não precisa descobrir candidato próprio) — higiene geral, não relacionado ao bug do WGC.
- [x] HUD de estatísticas de dev, sempre visível (sem hover) — `import.meta.env.DEV` mostra codec/encoder/perda/QP/tempo de encode/motivo de limitação/camada-software direto na tela, estilo contador de FPS de jogo. Desktop: widget nasce mais alto em dev (340×320 em vez de 340×140) pra caber sem cortar. Viewer: sem restrição de tamanho, só aparece como bloco extra.
- [x] **causa real confirmada com dado**: `qualityLimitationReason: "none"` + encode médio de 7-8ms/frame (bem abaixo do orçamento de 60fps) nas duas transmissões testadas — descarta CPU/GPU-de-encode e banda como gargalo. FPS baixo entregue só pode vir de ANTES do encoder: a captura (WGC) não tá produzindo frame novo o suficiente (bate com o log `ProcessFrame failed, using existing frame`).
- [x] **app desktop ainda perdia pro navegador mesmo em prod** — `backgroundThrottling:false` só evita throttling de timers/JS; existe uma camada separada, em nível de PROCESSO, que baixa a prioridade de agendamento do renderer inteiro quando a janela fica oclusa (jogo em tela cheia cobrindo o widget), e só desliga via flag de linha de comando. Adicionado `app.commandLine.appendSwitch("disable-renderer-backgrounding")` + `"disable-backgrounding-occluded-windows"` antes do `app.whenReady()`.
- [x] **suspeita de GPU-blocklist do Chromium** — Electron herda a lista interna do Chromium que marca combinações de driver/GPU como "problemáticas" e cai pra composição por software silenciosamente (sem toggle visível como o Chrome/Edge têm). Adicionado `ignore-gpu-blocklist` + `enable-gpu-rasterization` + `disable-gpu-sandbox` (esse último é workaround documentado pra travas de captura de tela via GPU sandboxada no Windows). Ainda não confirmado se era essa a causa raiz — pendente de teste real do usuário.
- [x] item de tray "GPU Info (debug)" (dev-only) — abre `chrome://gpu` numa janela, mostra "Hardware accelerated" vs "Software only" por recurso do Chromium. Gerenciador de Tarefas do Windows não rotula processos filhos do Electron (não tem "Electron.exe (GPU Process)" como no Chrome com sua marca própria), então não dá pra confirmar aceleração de hardware só olhando os processos ali — só pelo `chrome://gpu` mesmo. **Confirmado via teste real**: Compositing/Video Decode/Video Encode/Rasterization todos "Hardware accelerated", GPU discreta NVIDIA ativa — hipótese de fallback pra software refutada.
- [x] **bug real corrigido**: "automático" de FPS não mandava NENHUM hint de frame rate pra captura (nem no desktop nem no viewer), apostando que o WGC/navegador escolheria algo razoável sozinho — testado em produção, ficou em ~20fps em vez dos ~30 "conservadores" que o comentário do código presumia (pior que pedir 30 explicitamente, que fica estável). Criado `AUTO_FPS_TARGET = 30` exportado (mesmo valor que `getMaxBitrate()` já assumia internamente pra "auto", agora consistente) e usado como alvo real de captura nos dois clientes — "automático" agora significa "um bom padrão", não "sem controle nenhum".
- [x] **investigação fechada**: confirmado que 30fps é o teto real sustentável da captura WGC nesse hardware quando o jogo também consome GPU — pedir 60fps nesse cenário causa quedas bruscas (55→25-30) que 30fps não tem. Não é bug, é característica real do hardware/contenção de GPU já mapeada (`ProcessFrame failed`, `docs/INSIGHTS-ENCODER.md`) — 60fps continua funcionando bem pra conteúdo leve (vídeo, apresentação, código) onde a GPU não divide com um jogo.

## Sprint 16 — Captura nativa (DXGI Desktop Duplication) — MVP validado ponta a ponta
- [x] Capture Core em C++ (`desktop/native/capture-core/`) — DXGI Desktop Duplication + Direct3D 11, `binding.gyp` + `node-addon-api`. Exige VS2022 Build Tools (VS2026 Insiders não é reconhecido pelo node-gyp que vem com o Electron — sem mapeamento de versão pra major 18).
- [x] Ponte main→renderer via `MessageChannelMain` (não IPC normal — frame de 1080p BGRA é ~8MB, serializar isso 30-60x/s pelo IPC padrão travaria o app de novo, igual à tentativa anterior arquivada). Recuperação automática de `DXGI_ERROR_ACCESS_LOST`.
- [x] Renderer: frame cru → `VideoFrame` (WebCodecs) → `MediaStreamTrackGenerator` → `MediaStreamTrack` normal, publicável no LiveKit exatamente como a do `desktopCapturer`.
- [x] Painel de teste dev-only (`NativeCaptureDebug.tsx`) — validado rodando de verdade: vídeo ao vivo, 35-55fps em uso normal (ainda não testado sob carga de jogo, que é o ponto real).
- **3 bugs reais achados e corrigidos durante a validação** (nenhum era óbvio de antemão):
  1. `MessagePortMain.postMessage()` no lado main fica **enfileirado sem erro nenhum** até `.start()` ser chamado explicitamente — sem isso, frame nenhum chegava no renderer.
  2. `MessagePort` não atravessa o `contextBridge` de forma confiável como argumento de callback — trocado pra `window.postMessage` com transfer list (padrão documentado do Electron pra isso), ouvido via `window.addEventListener("message", ...)` no lado do app em vez de uma função exposta.
  3. `contentHint`... não, esse não — os reais: canal alfa do DXGI Desktop Duplication não é confiável (`"BGRA"` tratava esse byte como transparência de verdade, dava tela preta); trocado pra `"BGRX"` (ignora o 4º byte, sempre opaco). E um bug de timing de ref do React no painel de teste (`<video>` só existe no DOM depois de `setRunning(true)`, mas o código tentava atribuir `srcObject` antes disso, contra um ref ainda `null`, silenciosamente).
- **Pendente**: integração no `SourcePicker`/`useBroadcast` de verdade (hoje só existe no painel de teste isolado), empacotamento do `.node` no `electron-builder.yml` pra build de produção, e principalmente — **testar sob carga real de jogo**, que é o motivo de tudo isso ter começado.

## Sprint 17 — Captura nativa sob carga de jogo + integração no fluxo real
- [x] **teste real sob carga confirmou o ganho**: usuário testou Rocket League com a captura nativa — média ~42fps (36-52, a maior parte do tempo em 40-45), **sem stuttering evidente e sem sensação de frame perdido**. Comparado ao `desktopCapturer`/WGC antigo sob a mesma carga (Sprint 12): oscilava 20-55fps com stutter visível e `ProcessFrame failed` nos logs. Resultado qualitativamente melhor mesmo sem ganho médio de fps enorme.
- [x] loop de captura trocado de `setInterval` de cadência fixa pra loop recursivo via `setImmediate` (`main/index.ts`) — o `setInterval` deixava tempo morto entre um `acquireFrame()` que retornava antes do timeout e o próximo tick agendado; o loop novo sempre repede na hora, imediatamente depois de cada tentativa (sucesso ou timeout).
- [x] captura nativa integrada no fluxo real (`SourcePicker` → `capture.ts` → `useBroadcast`), não só no painel de teste: `SourcePicker` marca os tiles de tipo "screen" com `nativeMonitorIndex` quando o addon tá disponível (assume mesma ordem de enumeração entre Chromium e DXGI `EnumOutputs` — não validado em multi-monitor ainda); `capture.ts` vira um dispatcher que escolhe nativo vs `desktopCapturer` pela presença desse índice. Janela nunca usa nativo (DXGI só captura monitor inteiro).
- [x] **bug real achado e corrigido**: pedir áudio do sistema via `getUserMedia({audio: {mandatory: {chromeMediaSource: "desktop"}}, video: false})` no caminho nativo, mesmo com `video: false`, ainda disparava um capturer de vídeo (WGC) internamente no Chromium pra validar a fonte "desktop" — e esse capturer falhava (`Source is not capturable`) e derrubava o renderer inteiro (`Terminating renderer for bad IPC message`). Fix: caminho nativo não pede áudio nenhum por enquanto (áudio nunca foi objetivo do Capture Core, ver `docs/NATIVE_CAPTURE.md` §Não Objetivos) — só vídeo.
- **Limitações conhecidas, não são bugs novos da captura nativa**: teto de simulcast em 720p (`pickSimulcastLayers` em `livekit.ts`, existe desde antes — 1440p/4K real é Fase 3 do CLAUDE.md) e oscilação de fps sob jogo pesado (parte é o DXGI só entregar frame quando a tela muda de verdade, parte é a mesma limitação de GPU com 3 camadas simulcast simultâneas já confirmada no Sprint 12).
- [x] cursor no frame — DXGI Desktop Duplication não desenha cursor por padrão (composto pelo DWM depois da captura). Implementado em `CaptureCore.cpp` via textura intermediária GDI-compatible (`D3D11_RESOURCE_MISC_GDI_COMPATIBLE`) + `GetCursorInfo`/`DrawIconEx`, com correção de hotspot (`GetIconInfo`) e offset de origem do monitor — testado e confirmado funcionando tanto no monitor primário quanto no secundário (valida também que o mapeamento de `nativeMonitorIndex` entre Chromium e DXGI `EnumOutputs` bate certo em multi-monitor).
- [x] empacotamento do `.node` no `electron-builder.yml` — addon nunca vivia em `node_modules`, então não entrava em `files` por padrão nem seria auto-detectado. Adicionado explicitamente em `files` + `asarUnpack` (`.node` não pode ser carregado de dentro do `app.asar`, precisa ser extraído pro `app.asar.unpacked` — o `require()` de dentro do asar é redirecionado pro caminho extraído automaticamente pelo Electron). Verificado com `electron-builder --win --dir`: o binário aparece em `dist/win-unpacked/resources/app.asar.unpacked/native/capture-core/build/Release/capture_core.node`, no caminho exato que o `require()` do `main/index.ts` resolve. **Não verificado ainda**: rodar a build empacotada de verdade e confirmar `[native-capture] addon carregado...` no log (não consegui capturar stdout de um app GUI empacotado nesse ambiente).
- [x] toggle de cursor na UI real — `StreamSettings.showCursor` (padrão `true`) no `SettingsForm`, chama `nativeCapture.setCursorEnabled()` antes de iniciar a captura. Exigiu recompilar o addon (`CaptureCore::SetCaptureCursor`, exportado em `addon.cpp` como `setCursorEnabled`). Só tem efeito no caminho nativo — ignorado (sem erro) no `desktopCapturer`.
- [x] estatísticas nativas expostas no host UI real — loop de captura em `main/index.ts` conta frames entregues/timeouts por segundo e manda por `webContents.send("native-capture:stats", ...)` (não pelo `MessagePort` de frame, frequência baixa demais pra precisar disso); `useBroadcast` assina via `onCaptureStats` (só existe quando a fonte atual é nativa) e mostra no HUD de dev do `LiveCard` como "FPS de captura nativa" — reassina automaticamente ao trocar de fonte (`swapSource`), inclusive quando a troca sai/entra do caminho nativo.
- [x] **investigado e descartado como bug**: usuário reportou transmissão caindo pra 720p com Rocket League aberto mesmo capturando 1920×1080 nativo (monitor na resolução normal, não em fullscreen exclusivo trocando modo de vídeo). Causa real: `degradationPreference: "maintain-framerate"` em `livekit.ts` (decisão já tomada e documentada ali, testada antes com o mesmo jogo) — sob pressão de CPU/encoder, o WebRTC reduz a RESOLUÇÃO publicada pra manter o FPS estável, de propósito. Confirmado que a captura nativa continua entregando 1080p full (fps de captura nativa no HUD ficou normal) — só o encode degrada a saída. Não é regressão nem bug, é o trade-off já aceito antes; usuário confirmou manter como está.
- [x] mitigação de FPS de captura sob contenção de GPU/CPU (fecha o item "60 FPS estáveis" do `docs/NATIVE_CAPTURE.md` Fase 1) — `CaptureCore::Initialize()` chama `IDXGIDevice::SetGPUThreadPriority(7)` (prioridade máxima de agendamento de GPU pro device de captura, técnica usada por ferramentas tipo OBS Game Capture pra não perder timing pro processo do jogo) e `addon.cpp` registra a thread principal do Electron na classe MMCSS `"Capture"` via `AvSetMmThreadCharacteristicsW` (prioridade de CPU mais alta sob contenção). Ambas falham em silêncio se não suportado — zero risco de regressão. Continua existindo um teto físico real (GPU compartilhada entre jogo + 2 encodes simulcast, Sprint 12) que nenhuma técnica de software resolve sozinha.
- [x] **validado em produção**: usuário testou de novo com Rocket League após as mitigações de prioridade de GPU/CPU — "parece mais estável mesmo".
- **Pendente**: sem áudio na captura nativa (aceito por ora, é o comportamento documentado do Capture Core); dropped frames/latência de verdade ainda não medidos (só fps + contagem de timeout).

## Sprint 18 — Decisão de arquitetura: pipeline nativo completo (reabre Fases 3/4)
- **Mudança de escopo grande, decisão explícita do usuário (2026-08-23)**: reabertas as Fases 3 (encoder NVENC) e 4 (WebRTC/SFU próprio) do `docs/NATIVE_CAPTURE.md`, que antes estavam marcadas fora de escopo por contradizerem a regra original do `CLAUDE.md` contra reimplementar SFU/WebRTC. Objetivo declarado: app desktop com qualidade/latência equivalente ao compartilhamento de tela do Discord, que roda pipeline nativo próprio — não LiveKit por baixo.
- `CLAUDE.md` §"Regra sobre WebRTC" **reescrita** pra refletir isso (documentado como revisão consciente, não drift silencioso) — ver nota de arquitetura ali.
- Decisão técnica tomada junto: camada baixa de WebRTC (ICE/DTLS-SRTP/RTP/data channel) via **libdatachannel** (C++, leve), não libwebrtc do Google (build gigante, complexo demais pra manter) e não reimplementação 100% do zero (ICE/DTLS-SRTP à mão é código criptográfico crítico, inviável com segurança sem lib madura por trás). SFU/sinalização/sessão continuam sendo construídos pelo projeto por cima da lib.
- **Ordem de implementação combinada**: Fase 3 (NVENC, testável isolado — grava em arquivo, valida qualidade/perf) antes de Fase 4 (transporte). Viewer web e backend (LiveKit Server SDK pra sala/token) continuam como estão até o pipeline nativo estar validado ponta a ponta — não corta o LiveKit do desktop antes de ter substituto funcionando.
- **Nada implementado ainda nesse sprint** — só a decisão de arquitetura e atualização de `CLAUDE.md`/`docs/NATIVE_CAPTURE.md`. Próximo passo real: começar a integração NVENC (Fase 3).

## Sprint 19 — NVENC integrado e validado (Fase 3 do NATIVE_CAPTURE.md)
- [x] Usuário baixou e forneceu o NVIDIA Video Codec SDK 13.1.15 (login/EULA da NVIDIA, não automatizável) — vendorizado em `desktop/native/capture-core/vendor/nvenc/` (headers, `nvencodeapi.lib`, e o wrapper oficial `NvEncoderD3D11`/`NvEncoder` da própria NVIDIA, licença MIT dentro do SDK). Fora do git (`.gitignore` atualizado — SDK proprietário e binário compilado nunca versionam, só o código-fonte próprio em `src/`).
- [x] `EncoderCore` novo no addon `capture_core` — encapsula `NvEncoderD3D11`, roda no mesmo `ID3D11Device` do `CaptureCore` (não cria device próprio), codifica H.264 direto da textura já composta (com cursor) via `CopyResource` GPU→GPU, sem round-trip pela CPU (zero-copy real). Exposto no addon como `initEncoder(fps, bitrateBps)` / `encodeCurrentFrame()` / `destroyEncoder()` — só existe pra validação isolada por enquanto, ainda não plugado no fluxo de transmissão.
- [x] **bug real corrigido durante a integração**: os `.cpp` vendorizados usavam `#include "NvEncoder/NvEncoderD3D11.h"` (caminho relativo assumindo a estrutura de pastas original do SDK) — corrigido pra `"NvEncoderD3D11.h"` já que os arquivos foram vendorizados lado a lado, sem o subdiretório `NvEncoder/`. Também faltava vendorizar `NvCodecUtils.h`/`Logger.h` (dependências transitivas do `NvEncoder.h` não óbvias de antemão).
- [x] **validado ponta a ponta via script isolado** (`ELECTRON_RUN_AS_NODE=1 electron test.js`, já que o addon foi compilado contra a ABI do Electron, não do Node do sistema): capturou 3s reais de tela, codificou 490 frames, gerou `.h264` confirmado válido via `ffprobe` (H.264, 1920×1080, `yuv420p`), remuxado em `.mp4` e enviado pro usuário assistir — qualidade visual aprovada.
- [x] **bloqueio real encontrado e resolvido**: primeira tentativa falhou com `NvEncoder::LoadNvEncApi : Current Driver Version does not support this NvEncodeAPI version` — driver NVIDIA instalado (596.49) era mais antigo do que o SDK 13.1.15 exige. Usuário atualizou o driver (610.88) e o encoder passou a inicializar normalmente.
- **Achado a resolver na integração de verdade (não bloqueia, só anotado)**: o teste alimentou o encoder mais rápido que o fps configurado nele (captura bateu ~163fps num monitor de alta taxa contra encoder configurado pra CBR de 30fps) — bitrate de saída ficou bem diferente do alvo. Precisa sincronizar fps do encoder com o fps real de entrega da captura antes de virar produção.
- **Pendente**: fallback de software quando NVENC indisponível, HEVC/AV1, bitrate configurável de verdade (hoje é valor fixo do teste manual), e principalmente — plugar isso no fluxo real (ainda é só um script de validação isolado, não toca no `SourcePicker`/`useBroadcast`/transmissão de verdade).

## Sprint 20 — Lapidação do encoder (fps pacing + bitrate reconfigurável)
- [x] **fix do achado do Sprint 19**: `EncoderCore::EncodeFrame()` agora recusa chamadas mais rápidas que o `fps` configurado (compara `std::chrono::steady_clock` contra o intervalo mínimo, pula sem tocar no NVENC se vier cedo demais) — captura real batendo mais rápido que o fps do encoder inflava/distorcia o bitrate real de saída porque o NVENC assume taxa de quadros constante pro cálculo de CBR. Revalidado: 80 frames aceitos em 3s (~26.7fps, perto do alvo de 30) contra 490/3s antes do fix.
- [x] `EncoderCore::SetBitrate()` — troca bitrate em sessão via `NvEncoder::Reconfigure` (com `forceIDR=1`), sem precisar destruir/recriar a sessão NVENC inteira (evitaria um soluço visível). Exposto no addon como `setEncoderBitrate()`. Ainda não tem política de quando chamar isso nem valores centralizados — só a capacidade existe.
- **Pendente**: fallback de software, HEVC/AV1, e o item maior — plugar o encoder no fluxo real (continua isolado num script de teste).

## Sprint 21 — Transporte WebRTC próprio (Fase 4, primeiro marco)
- [x] `libdatachannel[srtp]:x64-windows` instalado via vcpkg (já tinha vcpkg na máquina, evitou compilar a lib manualmente) — MPL-2.0, ICE/DTLS-SRTP/RTP/RTCP prontos, sem SFU embutido (SFU é responsabilidade do projeto, por cima da lib).
- [x] Novo addon `desktop/native/transport-core/` — `TransportCore` (C++) encapsula `rtc::PeerConnection`: cria sessão com STUN configurável, adiciona track de vídeo H.264 (`H264RtpPacketizer` + `RtcpSrReporter` pra RTCP Sender Report + `RtcpNackResponder` pra retransmissão via NACK — tudo da própria lib, não reimplementado à mão), gera offer, aceita SDP/candidate remoto, manda frame codificado via `SendVideoFrame`. Modelado como 1 sessão por espectador (`g_sessions` no addon) — é o desenho mais próximo de "SFU" que existe até agora (ainda falta a lógica de fan-out de verdade).
- [x] **validado ponta a ponta via script isolado** (mesmo padrão dos Sprints 19/20): criou sessão, adicionou track, gerou offer — SDP real veio com fingerprint DTLS, `a=rtpmap:96 H264/90000`, ICE ufrag/pwd, e um candidato STUN `srflx` de verdade veio do STUN público do Google, confirmando ICE/DTLS/STUN funcionando (não só geração de SDP estática).
- **Achado durante a implementação**: escrevi a primeira versão do `TransportCore.cpp` de memória (API do libdatachannel) e ao conferir contra os headers reais instalados (`C:/vcpkg/installed/x64-windows/include/rtc/`), a maioria bateu — só precisou trocar `H264RtpPacketizer::defaultClockRate` (deprecated) por `::ClockRate`, e um `magic_enum::enum_name()` que eu tinha usado pro estado da conexão (não existe na lib) por `operator<<` que o header expõe pra isso.
- **Pendente (grande)**: sinalização entre host e espectador (troca de SDP/ICE candidate por algum canal — WebSocket no backend Fastify, ainda não implementado); teste real enviando um frame H.264 pra um peer de verdade (hoje só validamos a negociação, não a mídia fluindo); SFU de fan-out pra múltiplos espectadores; congestion control (REMB já é anunciado no SDP mas não tá conectado ao `EncoderCore::SetBitrate()`); TURN; simulcast.

## Sprint 22 — Teste ponta a ponta real (captura→encode→transporte→navegador) — vídeo chegou, mas com bug sério
- **Contexto**: primeiro teste de verdade juntando os 3 pilares nativos (captura DXGI + encode NVENC + transporte libdatachannel) num navegador de verdade, via um relay de sinalização MÍNIMO feito só pra esse teste (`signaling-server.js` — polling HTTP simples, NÃO é o backend real nem o protocolo de sinalização definitivo da Fase 4, arquivos ficaram no scratchpad da sessão, não no repo).
- [x] **vídeo chegou a aparecer no navegador** — primeira vez que o pipeline 100% nativo (sem LiveKit nenhum) entregou vídeo de verdade numa `<video>` via `RTCPeerConnection` padrão. Mas "travadão, passando frame de tempos em tempos".
- [x] **bug real corrigido (parcial)**: sem tratamento de PLI (Picture Loss Indication) — quando o navegador perde referência de decode, pede keyframe imediato via RTCP; sem responder isso, o vídeo ficava travado/corrompido até o próximo keyframe do GOP normal (a cada ~2s). Adicionado `rtc::PliHandler` na cadeia do `TransportCore` + `EncoderCore::ForceKeyframe()` (usa `NV_ENC_PIC_FLAG_FORCEIDR` no próximo `EncodeFrame`). Ajudou um pouco, não resolveu.
- [x] **tentativa 2**: adicionado `rtc::PacingHandler` (suaviza rajada de pacotes RTP por frame, casado com o bitrate configurado) — não resolveu o lag.
- [x] **diagnóstico feito**: baixar bitrate de propósito (6Mbps → 1.5Mbps) pra separar "banda insuficiente" de "bug real". Resultado: **piorou** (ficou "MUITO atrasado", atraso crescendo com o tempo) — descarta banda como causa raiz. Aponta pra fila sem limite/sem descarte de frame em algum lugar da cadeia de envio (falta congestion control de verdade, item já previsto como pendente grande da Fase 4).
- [x] **bug real e mais sério encontrado, NÃO resolvido ainda**: em pelo menos duas execuções, a sequência foi `state: connected` → começa a transmitir → 1 PLI recebido (`forceKeyframe` disparado) → `state: failed` → `state: closed` → **o processo Electron inteiro crasha** (exit code 127, não é só o WebRTC fechando graciosamente). Suspeita: corrupção de memória em algum lugar do caminho de envio (`TransportCore::SendVideoFrame`/packetizer/`PacingHandler`) que só se manifesta depois do primeiro keyframe forçado via PLI — não investigado a fundo ainda, sessão parou aqui de propósito (bug de baixo nível merece debug cuidadoso, não mais tentativa-e-erro).
- Instrumentação adicionada pro próximo retomar: `test-viewer.html` (scratchpad) ganhou um painel de `pc.getStats()` ao vivo (fps decodificado, kbps, jitter, packetsLost, framesDropped, jitterBufferDelay, pliCount, nackCount, keyFramesDecoded, RTT) — não chegou a ser lido antes do crash acontecer de novo, mas fica pronto pra próxima tentativa.
- **Pendente pra próxima sessão, em ordem de prioridade**: 1) achar a causa do crash pós-PLI (suspeita: memória/lifetime em `TransportCore`, testar isolando `PacingHandler` primeiro já que foi o último handler adicionado); 2) só depois disso voltar a investigar o lag/atraso crescente com os dados reais do `getStats()` que já ficaram prontos; 3) congestion control de verdade (a causa provável do lag, mas não dá pra confirmar enquanto o crash não for resolvido — ele interrompe o teste antes de coletar dado suficiente).

## Correções recentes

- `desktop/src-tauri/capabilities/default.json`: adicionadas permissões de fechar/minimizar/maximizar (bug real, botões clicavam mas o invoke era negado silenciosamente).
- `viewer` agora tem `types/stream.ts`, `services/{capture,codecs,backend,publish}.ts`, `hooks/useBroadcast.ts`, `components/{SettingsForm,LiveCard}.tsx` — mesma lógica de publish do desktop, adaptada pra web (clipboard via `navigator.clipboard`, sem widget/tray/janela nativa).
- Áudio: sempre pedido no `getDisplayMedia({audio: true})` (desktop e viewer) — tirado o checkbox, já que o navegador exige confirmação separada (switch no próprio diálogo) de qualquer forma, então não tem custo pedir por padrão. Só funciona de fato ao compartilhar "Tela inteira" na maioria dos navegadores/SO.
- Indicador de áudio nos dois lados: host mostra "🔊 áudio" quando a track foi entregue de verdade; viewer mostra controle de volume (popover estilo Discord, hover revela slider) só quando a track de áudio chega, senão mostra "sem áudio" — nunca finge que tem som quando não tem.
- Player do viewer começa mudo por padrão (`muted` direto no `<video>`, não via effect) — autoplay com som é bloqueado pelo navegador sem gesto do usuário; antes disso o ícone mostrava 🔊 mas não tocava nada até mexer em algo, parecia bug.
- POC de captura nativa (Fase A: pipeline `MediaStreamTrackProcessor`→`Generator`; Fase B: `Windows.Graphics.Capture` via Rust) foi **revertida por completo** — Fase A funcionou, Fase B tirava a barra do Chromium mas travava o app inteiro (decode síncrono de frame grande na thread da UI). Registro do que foi tentado e por que ficou em `docs/POC-NATIVE-CAPTURE.md` (arquivado, código não existe mais no repo).

## Sprint 23 — Sessão real ponta a ponta: F5, sala presa, flood de polling, contador de espectadores

Primeiro teste real do pipeline nativo com backend+viewer+desktop rodando juntos (não isolado em
script). Vários bugs reais encontrados e corrigidos, um débito técnico confirmado e adiado de
propósito, um pendente de firewall que só dá pra validar com build de produção.

### Corrigido e confirmado

- [x] **F5 no viewer derrubava a transmissão inteira**: sessão nativa é singleton (V1 = 1 viewer,
  sem SFU ainda). `transportOnStateChange` chamava `stopNativeTransport()` (mata captura+encoder)
  em qualquer `failed`/`closed`/`disconnected` — F5 fecha o `RTCPeerConnection` do viewer, host via
  isso como desconexão e matava tudo. `beginNativeNegotiation()` (`desktop/src/main/index.ts`) virou
  função reentrante: recria só a sessão WebRTC (fecha, recria, novo offer) sem tocar captura/encoder.
- [x] **`/native/offer` 404 eterno depois do F5**: `beginNativeNegotiation` disparava o
  `POST /native/reset` sem `await`, concorrente com o offer novo (que `AddVideoChannel()` já dispara
  sozinho via auto-negociação do libdatachannel) — se o reset chegasse DEPOIS do offer no backend,
  apagava o offer recém-setado pra sempre. Corrigido com `await` antes de recriar a sessão.
- [x] **sala nativa sumia da lista "Assistir" sozinha**: `GET /rooms` cruza com `LiveKit.listRooms()`
  e apaga quem não aparece lá depois de 20s — mas sala nativa NUNCA entra no LiveKit (vídeo não passa
  por lá), então toda sala nativa virava "órfã" e se autodestruía ~20s depois de criada, mesmo ativa.
  `routes/rooms.ts`: `isOrphan` agora pula salas com `nativeMode: true`.
- [x] **sala nativa presa pra sempre se o app fechasse**: caminho LiveKit tem rede de segurança
  (webhook + TTL); nativo não tinha nenhuma — `window-all-closed` só chamava `app.quit()`. Adicionado
  `app.on("before-quit")`: manda `DELETE /rooms/:id` (best-effort, timeout 2s) antes de deixar
  fechar de verdade, só quando tinha transmissão nativa ativa.
- [x] **flood de polling no backend**: 3 problemas juntos — (1) loop de ICE candidates do host rodava
  pra sempre mesmo depois de conectado (2 req/s por HORAS à toa); (2) o mesmo bug do lado do viewer
  (`useNativeStream.ts`); (3) poll de `/native/answer` (esperando o primeiro viewer) e de
  `/native/offer` do lado do viewer eram intervalo fixo de 500ms sem nunca parar enquanto ninguém
  conectava. Corrigido: loops de ICE agora param assim que a conexão fecha (`transportIsConnected()`
  no host, `pc.connectionState === "connected"` no viewer); polls de offer/answer ganharam backoff
  exponencial (1s → dobra → teto 5s host / 5s viewer) em vez de martelar fixo.
- [x] **contador de espectadores sempre "0" no LiveCard no modo nativo**: `useBroadcast.ts` fixava
  `viewerCount: 0` no `setInfo` inicial e nunca atualizava de novo nesse caminho (diferente do
  LiveKit, que tem callback de `numParticipants`). Ligado `onNativeTransportState` — "connected" vira
  1, resto vira 0 (V1 = no máximo 1 espectador mesmo).
- [x] **teste real no celular (rede local) "Load failed"**: `viewer/.env` não existia — Vite só lê
  `.env` da PRÓPRIA raiz (`viewer/`), não do `.env` da raiz do monorepo. `VITE_BACKEND_URL` nunca
  chegava no bundle, caía no fallback `http://localhost:4000` — no celular, "localhost" é o próprio
  celular, não a máquina host. Criado `viewer/.env` com o IP da LAN.

### Confirmado, mas adiado de propósito (decisão consciente)

- **Múltiplos espectadores simultâneos**: dá erro — segundo viewer rouba a única sessão do primeiro
  (renegocia, joga o 1º fora). Já era débito técnico CONHECIDO e documentado (Fase 4, "SFU próprio"),
  só confirmado em teste real agora. Fix de verdade = múltiplas sessões `TransportCore` (uma por
  viewer) + sinalização por viewer (não por sala) + mandar o mesmo frame codificado pra N sessões —
  trabalho grande, melhor fazer junto com a troca de sinalização REST→WebSocket (mesmo motivo: não
  vale redesenhar o modelo de sessão duas vezes).
- **Sinalização REST+polling vs WebSocket**: polling com backoff resolveu o flood por ora. WS é o
  fix "certo" de produção (já pendente documentado), mas adiado até fazer junto com o SFU acima —
  o modelo de sessão muda de qualquer jeito quando virar multi-viewer.

### Pendente, não testável ainda (precisa build de produção)

- **PC/celular em rede diferente do host (mesmo Wi-Fi, mas cabo→WiFi) trava em "conectando..." até
  timeout**: suspeita forte é Windows Firewall bloqueando UDP de entrada no processo Electron de dev
  (sem regra configurada) — mesma LAN não deveria precisar de STUN/TURN pra candidato "host" direto
  funcionar. Não dá pra confirmar/testar de forma conclusiva rodando em dev; fica pendente até
  existir um build de produção (assinado, com o app instalado de verdade, onde regra de firewall
  pode ser testada igual usuário final veria). TURN também continua fora do escopo por ora (mesma
  decisão de sempre, CLAUDE.md §Infraestrutura) — só relevante se o problema não for firewall.
- **Micro engasgadas residuais**: usuário reporta FPS estável tanto em compartilhamento de tela
  normal quanto em jogo, mas com "microengasgadas" ocasionais — possivelmente a mesma "aberração
  cromática periódica" já em aberto desde a sessão de 2026-08-24 (`docs/NATIVE_CAPTURE.md`, seção
  "Em aberto"), possivelmente outra coisa. Não é bloqueio (avaliado como baixo risco pelo usuário
  dado que FPS já tá estável) — fica pra investigar depois, junto com a causa raiz da aberração
  cromática já mapeada (suspeita de contenção de GPU no decode, testável só com dispositivo de
  decode separado).

## Sprint 24 — HEVC opt-in e Fase 4 completa (sinalização WS + SFU multi-espectador)

- [x] **HEVC opt-in com fallback automático em 3 camadas** (toggle "Usar HEVC (beta)", só com
  pipeline nativo): (1) `EncoderCore` cascateia NVENC HEVC → NVENC H.264 → software HEVC (Media
  Foundation, `MFTEnumEx`) → software H.264; (2) viewer roda `VideoDecoder.isConfigSupported()`
  ANTES de responder o offer (Chrome só decodifica HEVC com hardware do dispositivo, inconsistente)
  e reporta `decoderOk` na answer; (3) host reage sozinho, reiniciando o encoder em H.264 se
  necessário. **Bug real achado durante a implementação**: `<codecapi.h>` sozinho não declara
  `ICodecAPI` (só as GUIDs) — a interface de verdade é `<icodecapi.h>`, header separado; e usar os
  dois junto com `<mfidl.h>`/`<mftransform.h>` no mesmo arquivo quebra a compilação (`ICodecAPI`
  fica só forward-declarado via `<strmif.h>` puxado transitivamente) — resolvido isolando o uso de
  `ICodecAPI` num arquivo próprio (`CodecApiHelper.h/.cpp`). **Validado em produção pelo usuário**:
  100% funcional; bônus grande não esperado — com HEVC+NVENC juntos, a aberração cromática
  periódica (em aberto desde 24/08) sumiu quase por completo e o stuttering não foi mais sentido,
  confirmando a suspeita de contenção de GPU no decode por software do H.264 (ver
  `docs/NATIVE_CAPTURE.md`, seção "Em aberto").
- [x] **Sinalização REST+polling → WebSocket**: `backend/src/services/nativeWsRelay.ts` (novo,
  substitui `nativeSignaling.ts` removido) — relay puro, sem storage de offer/answer (elimina a
  classe de bug do polling: nada fica "velho" porque não existe onde ficar velho). Validado com
  script isolado (host+viewer, incluindo viewer conectando depois do host já ter mandado offer).
- [x] **Multi-espectador de verdade (SFU do projeto)**: `g_transportSessions` (mapa por
  `viewerId`) substituiu o `g_transport` singleton em `addon.cpp` — 1 sessão `TransportCore` por
  espectador, mesmo encode compartilhado, fan-out em C++ (`TransportSendVideoFrame` manda pro
  mapa inteiro de uma vez). Protocolo de sinalização evoluiu junto: cada espectador ganha um
  `viewerId` só dele (gerado no backend), host recebe `viewer-joined`/`viewer-left` e negocia uma
  sessão por espectador. Um espectador saindo (F5, fechou aba) só derruba a própria sessão — os
  outros continuam recebendo o stream sem interrupção, MUDANÇA GRANDE em relação ao V1 (qualquer
  desconexão matava a transmissão inteira pra todo mundo). Validado com script isolado simulando
  host+2 viewers simultâneos: cada um só vê o próprio offer, respostas roteadas certas, fechar um
  não afeta o outro. **Validado em produção pelo usuário**: 100% funcional, contador de
  espectadores do LiveCard refletindo corretamente via WS.
- **Limitação conhecida, aceita por ora**: encoder é compartilhado entre todos os espectadores (1
  encode só). Se HEVC tá ativo e um espectador NOVO não decodifica, só dá pra reverter o encoder
  pra H.264 globalmente se ainda não tiver ninguém conectado de verdade em HEVC — senão quebraria
  quem já funciona. Nesse caso o espectador novo fica sem vídeo. Corrigir de verdade precisaria de
  SVC ou encode duplicado — fora de escopo agora, documentado como trade-off consciente.
- **Pendente pra próxima sessão**: testar de verdade com múltiplos dispositivos reais assistindo
  ao mesmo tempo (validado com host+cliente(s) na mesma máquina; ainda não testado com hardware
  fisicamente separado); simulcast e latência adaptativa continuam de fora (Fase 4 do
  `docs/NATIVE_CAPTURE.md`); AV1 continua adiado (mesmo motivo de antes — disponibilidade de
  encoder inconsistente, precisa investigar antes).

## Sprint 25 — Congestion control (AIMD) + bug real de FPS

- [x] **Congestion control via `bufferedAmount()` do DataChannel** (sem REMB — resquício de RTP,
  não se aplica mais desde a troca pra DataChannel/SCTP): `TransportCore::GetBufferedAmount()` +
  `transportMaxBufferedAmount()` no addon (pior caso entre todas as sessões, já que o encode é
  compartilhado). AIMD no loop de 1s de `main/index.ts`: buffer alto → queda multiplicativa
  (×0.7, piso 500kbps); buffer baixo sustentado → sobe aditivo (+10%) até o teto configurado.
- [x] **Bug real corrigido no mesmo sprint (achado pelo usuário em teste real)**: FPS caiu de 60
  cravado pra 48-55 (HEVC+NVENC) mesmo em loopback local SEM congestionamento nenhum, assim que o
  congestion control foi ligado. Causa: `EncoderCore::SetBitrate` sempre forçava keyframe
  (`forceIDR=1`, herdado do uso original de troca de qualidade manual) — cada ajuste do AIMD
  injetava um keyframe (bem maior que frame normal) EXATAMENTE na hora que o buffer já tava alto,
  piorando o represamento em vez de aliviar, ciclo de queda-keyframe-represa-queda. Corrigido:
  `SetBitrate` ganhou parâmetro `forceKeyframe` (padrão `true`, preserva troca manual do usuário);
  AIMD passa `false`. Também endurecido o gatilho de queda pra exigir 2 ticks ALTOS seguidos (não
  reage a 1 pico isolado de rajada normal de encode) — só a subida já exigia 5 ticks baixos.
  Recompilado — usuário ainda vai revalidar que os 60fps cravados voltaram.

## Sprint 27 — AV1 opt-in (mesmo padrão de fallback do HEVC)

- [x] **AV1 como terceiro codec opt-in** (toggle "Usar AV1 (beta)" no `SettingsForm`, mutuamente
  exclusivo com "Usar HEVC (beta)") — reaproveita a MESMA cascata de 4 níveis que HEVC já usa
  (`EncoderCore::Initialize`): NVENC AV1 pedido → NVENC H.264 → software AV1 (Media Foundation,
  `MFVideoFormat_AV1` — SEM garantia de existir embutido no Windows, só se a máquina tiver MFT de
  terceiro registrado) → software H.264. `NV_ENC_CODEC_AV1_GUID` já existe no SDK vendorizado
  (13.1.15); hardware de verdade só em GPUs Ada Lovelace/RTX 40+ (CLAUDE.md §Codecs já avisava disso
  — motivo do adiamento original).
- [x] **Detecção de keyframe pro AV1 no `TransportCore`** — AV1 não usa NAL/start-code como
  H.264/HEVC (`ContainsKeyframeNal` não serve). Bitstream é uma sequência de OBUs (Open Bitstream
  Units) sem marcador fixo — implementado `ContainsKeyframeObu` andando OBU por OBU via leb128 (tamanho
  inline de cada um, `repeatSeqHdr=1` no encoder garante que o Sequence Header OBU só reaparece em
  keyframe, mesmo papel que repeatSPSPPS já cumpre pra H.264/HEVC). `outputAnnexBFormat=0` no NVENC
  (formato "low overhead", OBUs crus concatenados) — Annex B do AV1 é um container totalmente
  diferente (temporal/frame unit com leb128 no topo), não vale a complexidade e o WebCodecs do
  viewer não precisa disso mesmo.
- [x] **Viewer decodifica AV1** — `VideoDecoder.configure({codec: "av01.0.04M.08", ...})` (sem
  sub-objeto `{format:...}`, diferente de avc/hevc — WebCodecs só conhece o formato low-overhead pro
  AV1) + `isConfigSupported()` ANTES de responder o offer, mesmo protocolo de negociação
  (`decoderOk`) que HEVC já usa — generalizado no host (`ntActiveCodec !== "h264"`, antes só
  verificava `=== "hevc"`) pra cobrir os dois codecs com o mesmo código.
- [x] **Bug real achado e corrigido durante a implementação (não relacionado a AV1, bloqueava
  QUALQUER build)**: `addon.cpp`/`StreamWorker.cpp` incluíam `<windows.h>` sem `NOMINMAX` — as
  macros `min`/`max` que o header define quebravam `std::max()`/`std::min()` mais abaixo
  (`TransportMaxBufferedAmount`, Sprint 25; `StreamWorker`, código órfão) com erro de sintaxe
  C2589/C2059 do MSVC. Não pegava nas sessões anteriores porque aparentemente ninguém tinha rodado
  um rebuild limpo do zero desde que esse código foi escrito (só incremental, que não reprocessa
  headers já compilados). `#define NOMINMAX` adicionado ANTES de qualquer include em ambos os
  arquivos (definir só antes do `#include <windows.h>` direto não bastava no `StreamWorker.cpp` —
  os headers do projeto incluídos antes dele já puxam `windows.h` transitivamente via `d3d11.h`, e
  o include guard rejeita a segunda inclusão silenciosamente).
- [x] Validado: addon compila limpo (`node-gyp rebuild` direto + rebuild via `electron-builder`
  pro ABI certo do Electron), `tsc --noEmit` limpo em `desktop` e `viewer`, `npm run dist` gera
  instalador de produção sem erro.
- [ ] **Não testado com hardware real** (sem GPU RTX 40+ disponível nessa sessão pra confirmar
  NVENC AV1 de verdade — só compilação/negociação de codec validadas). Mesma categoria de pendente
  que HEVC teve inicialmente (Sprint 24 já validou HEVC em produção depois).

## Sprint 28 — Simulcast v1 (2 tiers, mesma resolução)

**Decisões de escopo consultadas com o usuário antes de implementar**: (1) 2 níveis fixos
("high"/"low"), não 3 — menor risco de estourar limite de sessões NVENC simultâneas numa GPU de
consumidor; (2) diferenciação só por bitrate/fps, MESMA resolução nos dois tiers — downscale de
resolução de verdade exigiria um componente D3D11 Video Processor novo (blit GPU), não testado
nesse projeto, risco maior numa área (GPU/decode) que já causou bug sério antes (aberração
cromática, crash de device-lost); (3) seleção de qualidade MANUAL pelo espectador (seletor no
player), não automática por medição de rede — fecha menos escopo de uma vez, sem depender de heurística de adaptação ainda não validada.

- [x] **Encoder duplo** — `EncoderCore` não mudou nada (reaproveitado como está pros dois tiers).
  `addon.cpp` ganhou `g_encoderLow` ao lado do `g_encoder` existente (renomeado conceitualmente pra
  "high"), com funções espelhadas (`initEncoderLow`/`destroyEncoderLow`/`encodeCurrentFrameLow`).
  Tier "low" roda com um `fps` bem mais baixo (`SIMULCAST_LOW_FPS=15`) — o pacing de grade fixa que
  o `EncoderCore` já tinha (Sprint 17/25) cuida sozinho do frame-skip, sem lógica nova nenhuma.
- [x] **Sessão por espectador ganhou TIER** — `g_transportSessions` (mapa por `viewerId`) trocou de
  `unique_ptr<TransportCore>` puro pra uma struct `ViewerSession{transport, tier}`. Todo espectador
  novo entra em "high" por padrão (`transportCreateSession(..., tier)`); troca depois em sessão viva
  via `transportSetViewerTier(viewerId, tier)` — NÃO recria a conexão WebRTC, só troca de qual
  encoder aquela sessão passa a receber frame, com keyframe forçado no tier novo pra sincronizar o
  decoder do espectador (mesmo raciocínio do `OnChannelOpen` que já existia).
- [x] **Fan-out por tier** — `TransportSendVideoFrame`/`TransportMaxBufferedAmount` ganharam
  parâmetro `tier`: o primeiro só manda pras sessões DAQUELE tier (antes do simulcast ia pra
  todas), o segundo só considera o buffer das sessões DAQUELE tier — necessário pro AIMD de cada
  tier reagir à rede dos SEUS espectadores, não à média/pior de todo mundo misturado.
- [x] **AIMD por tier** — `main/index.ts` trocou o estado global único (`ntCurrentBitrateBps` e
  companhia) por um `AimdState` independente por tier (`ntAimdHigh`/`ntAimdLow`), cada um com seu
  próprio teto (`bitrateBps` do usuário pro high, `SIMULCAST_LOW_BITRATE_BPS` fixo pro low) e
  streaks de subida/descida próprios — mesma lógica AIMD do Sprint 25 (decréscimo multiplicativo,
  recuperação aditiva, `forceKeyframe:false` no ajuste automático), só parametrizada.
- [x] **Loop de captura codifica os dois tiers a cada frame** — `encodeCurrentFrame()` (high) +
  `encodeCurrentFrameLow()` (low) chamados toda volta do `runNativeTransportLoop`, cada um manda
  pro `transportSendVideoFrame` do seu próprio tier. Dump de debug (investigação de aberração
  cromática, Sprint anterior) continua só no tier "high".
- [x] **Sinalização "set-quality"** — backend (`nativeWsRelay.ts`) não precisou de NENHUMA
  mudança (relay puro, já repassa qualquer JSON e estampa `viewerId` sozinho). Viewer manda
  `{type:"set-quality", tier}` quando o usuário troca no seletor; host reage no handler de
  mensagens WS já existente chamando `transportSetViewerTier`.
- [x] **UI do viewer** — `VideoPlayer.tsx` ganhou um botão de qualidade (⚡ alta / 🐢 baixa) na
  barra de controles, só aparece no caminho nativo (`quality`/`onQualityChange` opcionais,
  ausentes no caminho LiveKit). `useNativeStream.ts` expõe `quality`/`setQuality`.
- [x] **Bug real achado e corrigido durante a implementação (não relacionado ao simulcast em si)**:
  depois de editar `addon.cpp`, o link falhou com `LNK1103: depurando informação corrompida` mesmo
  recompilando o `.obj` afetado sozinho — o `.pdb` compartilhado (`vc143.pdb`, todos os `.cpp` do
  addon escrevem nele via `/Z7`) ficou com estado inconsistente entre objetos novos e antigos.
  Resolvido com rebuild limpo completo (apagar `build/Release/` inteiro) — recompilação
  incremental parcial não é confiável depois de uma interrupção de link anterior (arquivo `.node`
  travado pelo app aberto, ver pendência de firewall do Sprint 26).
- [x] Validado: `tsc --noEmit` limpo em desktop (main+web) e viewer, addon nativo compila+linka
  limpo do zero, `npm run dist` gera instalador de produção sem erro.
- [x] **Validado em produção pelo usuário**: 2 espectadores simultâneos, cada um num tier
  diferente ("high"/"low") — funcionou de primeira, fan-out por tier e troca de qualidade sem
  travar o vídeo de ninguém.

## Sprint 29 — Latência adaptativa (buffer de jitter no viewer nativo)

**Escopo consultado com o usuário**: entre "buffer adaptativo no viewer" e "bitrate reagindo a
RTT medido", escolhido o primeiro — o bitrate adaptativo (AIMD) já existe desde o Sprint 25;
o que faltava de verdade era o slider de "suavização" no player, que existe na UI mas era
**no-op no caminho nativo** (só funcionava no LiveKit via `RTCRtpReceiver.playoutDelayHint`,
que não existe no caminho DataChannel+WebCodecs).

- [x] **Buffer de jitter implementado do zero** (`viewer/src/hooks/useNativeStream.ts`) — sem
  RTP nesse caminho, não tem jitter buffer nativo do navegador pra reaproveitar. Âncora
  stream-time↔local-time no primeiro chunk recebido (`anchorLocalMs`/`anchorStreamUs`); todo chunk
  seguinte compara "quando deveria ter chegado" com "quando chegou de verdade" — a diferença é
  jitter de rede cru, suavizado com EWMA (mesmo peso `1/16` que RFC 3550 usa pra estimar jitter
  RTP, só aplicado sobre o timestamp de aplicação em vez de RTP timestamp).
- [x] **`decoder.output` agora agenda a escrita** (`setTimeout`) pro momento calculado
  (`ancora + tempo-de-stream-do-frame + delay-efetivo`) em vez de escrever no `writer` direto —
  isso que efetivamente segura o frame o tempo do buffer adaptativo.
- [x] **Slider vira PISO, não substituído** — `applyPlayoutDelay` (já existia, era no-op no
  nativo) agora atualiza um `userFloorMsRef`; o delay efetivo aplicado é
  `Math.max(pisoDoUsuário, autoDelayCalculado)` — o usuário pode pedir mais suavização manual, o
  automático ainda pode subir mais sozinho se a rede piorar.
- [x] **UI reaproveitada sem mudança nenhuma** — `stats.latencyMs` (rótulo "buffer" já existente
  no painel 📊 do `VideoPlayer`) agora reflete o delay efetivo real de verdade, em vez do `0`
  hardcoded que tinha antes.
- **Risco aceito conscientemente**: `PLAYOUT_DELAY_MAX_MS` (1000ms, valor pré-existente do
  caminho LiveKit) permite, em teoria, até ~60 `VideoFrame` decodificados simultâneos represados
  em 60fps no pico do buffer — mesma ordem de grandeza que o slider manual do LiveKit já permitia
  antes sem problema reportado; normalmente o valor calculado fica bem abaixo disso (jitter real
  de rede estável é de poucos ms), só chega perto do teto sob rede muito ruim.
- [x] Validado: `tsc -b` limpo no viewer, `npm run build` gera bundle sem erro. Não mexeu em nada
  do desktop/C++ (mudança 100% no viewer) — não precisou rebuild de addon nativo nem do `.exe`.
- [x] **Validado em produção pelo usuário**: buffer de jitter adaptativo funcionando.

## Sprint 30 — Remoção do StreamWorker (código morto)

**Decisão consultada com o usuário**: remover em vez de só documentar melhor — o simulcast
(Sprint 28, 2 encoders simultâneos) já tornaria reativar o StreamWorker mais trabalho do que
valeria (ele só modelava 1 encoder/1 sessão, precisaria reescrever pra suportar tier), e menos
código morto pra manter.

- [x] `native/capture-core/src/StreamWorker.cpp`/`.h` deletados — thread nativa própria pra
  captura+encode+envio, tentativa (documentada na sessão de 2026-08-24) de eliminar um stutter que
  na real era outro bug (`PacingHandler` invertido, já corrigido há muito). Nunca foi o caminho de
  produção: `StartStream()` sempre retornava `false` de propósito desde antes do multi-espectador.
- [x] Removido de `addon.cpp`: `g_worker`, `StartStream`/`StopStream`/`GetStreamStats` e seus
  exports, uso de `g_worker` em `TransportCloseAllSessions`. Removido de `main/index.ts`: os 3
  métodos mortos na interface `NativeCaptureAddon` (nunca eram chamados, só declarados). Removido
  de `binding.gyp`: entrada `src/StreamWorker.cpp`. Comentários que citavam StreamWorker como
  caminho ativo corrigidos pra refletir a realidade (loop roda em JS via `setImmediate`).
- [x] Validado: rebuild LIMPO do addon (obrigatório depois de deletar fonte — incremental não
  detecta arquivo removido do binding.gyp de forma confiável, mesmo aprendizado do Sprint 28)
  compila+linka sem erro, `tsc --noEmit` limpo, `npm run dist` gera instalador sem erro.
- [ ] Downscale de resolução de verdade (D3D11 Video Processor), seleção automática por medição de
  rede do espectador, e mais de 2 tiers continuam fora de escopo (decisão consciente, ver acima).

## Sprint 26 — Investigação firewall/rede diferente (PARADO, dor de cabeça, retomar depois)

- [x] **Bug real de build corrigido**: `electron-builder.yml` só empacotava `capture_core.node`,
  esquecendo as DLLs de runtime do transporte (`datachannel.dll`, `juice.dll`,
  `libcrypto-3-x64.dll`, `libssl-3-x64.dll`, `srtp2.dll`) — todo build de produção até agora tinha
  o pipeline nativo quebrado silenciosamente (caía sempre pro fallback). `files`/`asarUnpack`
  corrigidos, validado que os 6 arquivos ficam em `app.asar.unpacked/native/...` no `.exe` final.
- [x] **Descartado como causa**: firewall do Windows no host — já existia regra Allow
  (Inbound, Any protocol, Public profile) pra `Screen Share.exe`, confirmado via
  `Get-NetFirewallRule`. Sinalização WS (TCP 4000) do celular chega certinho no PC (conexões
  vistas via `Get-NetTCPConnection`), então também não é isolamento de rede/AP do roteador —
  pacote atravessa a rede sem problema.
- [x] **Achado real**: processo `Screen Share.exe` nunca abre socket UDP nenhum quando o segundo
  dispositivo tenta conectar — e nesse ponto o app fecha sozinho (sem crash nativo: sem dump em
  `Crashpad`, sem evento no Windows Event Viewer, sem stack no terminal). Aponta pra exceção JS não
  tratada no processo main (Node mata processo limpo por padrão, sem gerar rastro nenhum).
- [x] Adicionado `process.on("uncaughtException")` em `main/index.ts` — grava stack em
  `{userData}/uncaught-exception.log` antes de `app.exit(1)`, pra próxima reprodução mostrar o erro
  real (crashReporter/Crashpad só cobre crash nativo, não exceção JS).
- [ ] **PENDENTE — não reproduzido com o log novo ainda**: usuário decidiu pausar essa
  investigação por ora (fica pra depois, não é bloqueio imediato). Próximo passo quando retomar:
  reproduzir o crash com o build que já tem o handler novo, ler
  `{userData}/uncaught-exception.log` (userData real = ver `app.getPath("userData")`, variou entre
  `com.ocsscreen.app`/`OCS`/nome do `package.json` nessa sessão — checar qual path o app realmente
  usa) pra ver o stack trace de verdade.
