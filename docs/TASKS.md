# Roadmap execução

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


## Correções recentes

- `desktop/src-tauri/capabilities/default.json`: adicionadas permissões de fechar/minimizar/maximizar (bug real, botões clicavam mas o invoke era negado silenciosamente).
- `viewer` agora tem `types/stream.ts`, `services/{capture,codecs,backend,publish}.ts`, `hooks/useBroadcast.ts`, `components/{SettingsForm,LiveCard}.tsx` — mesma lógica de publish do desktop, adaptada pra web (clipboard via `navigator.clipboard`, sem widget/tray/janela nativa).
- Áudio: sempre pedido no `getDisplayMedia({audio: true})` (desktop e viewer) — tirado o checkbox, já que o navegador exige confirmação separada (switch no próprio diálogo) de qualquer forma, então não tem custo pedir por padrão. Só funciona de fato ao compartilhar "Tela inteira" na maioria dos navegadores/SO.
- Indicador de áudio nos dois lados: host mostra "🔊 áudio" quando a track foi entregue de verdade; viewer mostra controle de volume (popover estilo Discord, hover revela slider) só quando a track de áudio chega, senão mostra "sem áudio" — nunca finge que tem som quando não tem.
- Player do viewer começa mudo por padrão (`muted` direto no `<video>`, não via effect) — autoplay com som é bloqueado pelo navegador sem gesto do usuário; antes disso o ícone mostrava 🔊 mas não tocava nada até mexer em algo, parecia bug.
- POC de captura nativa (Fase A: pipeline `MediaStreamTrackProcessor`→`Generator`; Fase B: `Windows.Graphics.Capture` via Rust) foi **revertida por completo** — Fase A funcionou, Fase B tirava a barra do Chromium mas travava o app inteiro (decode síncrono de frame grande na thread da UI). Registro do que foi tentado e por que ficou em `docs/POC-NATIVE-CAPTURE.md` (arquivado, código não existe mais no repo).
