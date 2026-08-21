# Arquitetura — contexto para implementação

Referência normativa: [`CLAUDE.md`](../CLAUDE.md). Este doc traduz aquilo em decisões técnicas concretas p/ Fase 1 (MVP).

## Componentes

```
screen-share/
├── desktop/     Tauri (Rust) + React + TS — app Windows .exe, host transmite
├── viewer/      React + TS (Vite) — web, espectador assiste via browser
├── backend/     Node + Fastify + TS — signaling: salas, tokens LiveKit
└── infra/       docker-compose (LiveKit + Redis dev)
```

## Fluxo Fase 1

1. Host abre `ScreenShare.exe` (Tauri).
2. Clica "Compartilhar tela" → Tauri lista monitores/janelas (via `getDisplayMedia` no MVP; API nativa Rust fica p/ Fase 4).
3. Desktop app chama `POST /rooms` no backend → recebe `roomId` + `hostToken` (LiveKit JWT).
4. Desktop conecta ao LiveKit (`livekit-client`) publica track de tela.
5. Backend devolve link `https://<viewer>/s/{roomId}`.
6. Host copia link, compartilha.
7. Espectador abre link no `viewer` (browser) → `GET /rooms/:id/token` → recebe token viewer (subscribe-only) → conecta LiveKit → assiste.
8. Host clica "Encerrar" → desconecta do LiveKit room → `DELETE /rooms/:id` opcional (sala se autodestrói quando vazia).

## Por que LiveKit resolve tudo

SFU, signaling, NAT traversal (STUN/TURN), reconexão, simulcast — delegados ao LiveKit. Backend só emite tokens e mantém metadata leve de sala (em memória no MVP; Redis quando precisar escalar horizontalmente).

## Separação de responsabilidades (código)

- `desktop/src/services/livekit.ts` — conexão/publish, isolado da UI.
- `desktop/src/services/capture.ts` — `getDisplayMedia`, leitura de `getSettings()`.
- `desktop/src-tauri/` — só o que exige nativo (janela custom: fullscreen/minimize/drag; futuramente captura nativa).
- `viewer/src/services/livekit.ts` — conexão/subscribe, isolado da UI.
- `backend/src/routes/rooms.ts` — criação de sala, geração de token.
- `backend/src/services/livekit.ts` — wrapper do LiveKit Server SDK.

## Fase 4 — captura nativa e hardware encoding (plano)

Ainda não implementado — depende de testes em hardware real, então fica documentado antes de codar às cegas.

Hoje a captura usa `getDisplayMedia()` no Chromium embutido do WebView2, que no Windows já usa Desktop Duplication API (DXGI) internamente e permite ao Chromium escolher hardware encoder (H.264 via Media Foundation) quando o SO/GPU suportam — ou seja, uma parte do ganho de "hardware encoding" do CLAUDE.md já vem de graça pelo browser engine.

Onde captura nativa Rust justificaria a complexidade:

1. **Captura de janela específica sem o picker do SO** — hoje `getDisplayMedia` sempre abre o diálogo nativo do Windows; para pular direto para uma janela pré-selecionada seria necessário `windows-rs` + `Windows.Graphics.Capture` (WGC) e alimentar os frames manualmente via `MediaStreamTrackGenerator`/inserção de frames no pipeline WebRTC.
2. **Captura de jogos em exclusive fullscreen** — WGC lida melhor que Desktop Duplication com jogos DX12/Vulkan em alguns cenários; validar caso a caso.
3. **Controle explícito de encoder (NVENC/QuickSync/AMF)** — exigiria sair do pipeline `getUserMedia`/`RTCPeerConnection` padrão do browser e usar WebCodecs (`VideoEncoder`) com `codedWidth`/hardwareAcceleration: "prefer-hardware", inserindo os `EncodedVideoChunk` manualmente via `RTCRtpScriptTransform`/insertable streams no LiveKit client.

Antes de investir nisso: medir se o encoder de software do browser já satura CPU nos perfis 1440p60/4K30 em hardware de teste real. Só migrar para pipeline custom se os números mostrarem necessidade — CLAUDE.md pede para não reinventar o que o browser/LiveKit já resolve bem.

## Não fazer no MVP

- Sem PostgreSQL (sala é efêmera, em memória).
- Sem Redis (single instância no MVP; arquitetura não impede adicionar depois).
- Sem simulcast/SVC ainda (Fase 3).
- Sem seleção de codec manual (deixa LiveKit negociar; prioridade de codec fica em config futura).
