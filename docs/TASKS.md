# Roadmap execução

## Sprint 1 — Mudanças sistemicas
- [x] app tauri não fecha ao clicar no botão de fechar, aliás, não funciona nem minimizar ou maximizar — faltavam permissões `core:window:allow-close/minimize/maximize/unmaximize/toggle-maximize` no capabilities (só tínhamos `core:default`, que não inclui essas)
- [x] falta o recurso de compartilhar tela com audio — checkbox "Compartilhar áudio do sistema" no desktop e no viewer, publica track de áudio (`Track.Source.ScreenShareAudio`) junto do vídeo
- [x] o viewer poderia também criar as transmissões, seria interessante não depender só do app desktop para compartilhar tela — viewer ganhou fluxo completo de criar sala (captura, publish, link, stats, encerrar), espelhando a lógica do desktop

## Sprint 2 — Mudanças visuais
- [x] deixar o app desktop/web mais apresentável — logo mark (`Logo.tsx`, gradiente) em ambos, tipografia/hierarquia refeita, sombras e transições em botões/cards, select customizado (seta própria, focus ring), titlebar do desktop com logo pequeno
- [x] criar uma tela legal no app web para criação de screen shares também — `home-card` com sombra/borda, glow radial de fundo, layout tipo landing em vez de formulário solto
- [x] deixar com mais cara de profissional ambas as aplicações visuais — tokens `--accent-2` pra gradiente/links, cards com elevação (`box-shadow`) em vez de fundo plano, `live-card` também virou card com borda/sombra no viewer

## Sprint 3 — Mudanças de reprodução/performance


## Sprint 4 — Pequenas melhorias


## Correções recentes

- `desktop/src-tauri/capabilities/default.json`: adicionadas permissões de fechar/minimizar/maximizar (bug real, botões clicavam mas o invoke era negado silenciosamente).
- `viewer` agora tem `types/stream.ts`, `services/{capture,codecs,backend,publish}.ts`, `hooks/useBroadcast.ts`, `components/{SettingsForm,LiveCard}.tsx` — mesma lógica de publish do desktop, adaptada pra web (clipboard via `navigator.clipboard`, sem widget/tray/janela nativa).
- Áudio: sempre pedido no `getDisplayMedia({audio: true})` (desktop e viewer) — tirado o checkbox, já que o navegador exige confirmação separada (switch no próprio diálogo) de qualquer forma, então não tem custo pedir por padrão. Só funciona de fato ao compartilhar "Tela inteira" na maioria dos navegadores/SO.
- Indicador de áudio nos dois lados: host mostra "🔊 áudio" quando a track foi entregue de verdade; viewer mostra controle de volume (popover estilo Discord, hover revela slider) só quando a track de áudio chega, senão mostra "sem áudio" — nunca finge que tem som quando não tem.
- Player do viewer começa mudo por padrão (`muted` direto no `<video>`, não via effect) — autoplay com som é bloqueado pelo navegador sem gesto do usuário; antes disso o ícone mostrava 🔊 mas não tocava nada até mexer em algo, parecia bug.
- POC de captura nativa (Fase A: pipeline `MediaStreamTrackProcessor`→`Generator`; Fase B: `Windows.Graphics.Capture` via Rust) foi **revertida por completo** — Fase A funcionou, Fase B tirava a barra do Chromium mas travava o app inteiro (decode síncrono de frame grande na thread da UI). Registro do que foi tentado e por que ficou em `docs/POC-NATIVE-CAPTURE.md` (arquivado, código não existe mais no repo).
