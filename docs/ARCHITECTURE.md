# Arquitetura — contexto para implementação

Referência normativa: [`CLAUDE.md`](../CLAUDE.md). Este doc traduz aquilo em decisões técnicas concretas p/ Fase 1 (MVP).

## Componentes

```
screen-share/
├── desktop/     Electron + React + TS — app Windows .exe, host transmite
├── viewer/      React + TS (Vite) — web, espectador assiste via browser
├── backend/     Node + Fastify + TS — signaling: salas, tokens LiveKit
└── infra/       docker-compose (LiveKit + Redis dev)
```

## Fluxo Fase 1

1. Host abre `ScreenShare.exe` (Electron).
2. Clica "Compartilhar tela" → seletor próprio do app lista telas/janelas (via `desktopCapturer`, processo principal do Electron — não passa pelo diálogo/permissão do navegador).
3. Desktop app chama `POST /rooms` no backend → recebe `roomId` + `hostToken` (LiveKit JWT).
4. Desktop conecta ao LiveKit (`livekit-client`) publica track de tela.
5. Backend devolve link `https://<viewer>/s/{roomId}`.
6. Host copia link, compartilha.
7. Espectador abre link no `viewer` (browser) → `GET /rooms/:id/token` → recebe token viewer (subscribe-only) → conecta LiveKit → assiste.
8. Host clica "Encerrar" → desconecta do LiveKit room → `DELETE /rooms/:id` opcional (sala se autodestrói quando vazia).

## Por que LiveKit resolve tudo

SFU, signaling, NAT traversal (STUN/TURN), reconexão, simulcast — delegados ao LiveKit. Backend só emite tokens e mantém metadata leve de sala (em memória no MVP; Redis quando precisar escalar horizontalmente).

## Separação de responsabilidades (código)

- `desktop/src/renderer/src/services/livekit.ts` — conexão/publish, isolado da UI.
- `desktop/src/renderer/src/services/capture.ts` — `desktopCapturer` via IPC + `getUserMedia` com `chromeMediaSourceId`, leitura de `getSettings()`.
- `desktop/src/main/` — só o que exige nativo (janela frameless, bandeja, `desktopCapturer.getSources()`, clipboard).
- `desktop/src/preload/` — ponte `contextBridge` entre main e renderer (`window.screenshare.*`).
- `viewer/src/services/livekit.ts` — conexão/subscribe, isolado da UI.
- `backend/src/routes/rooms.ts` — criação de sala, geração de token.
- `backend/src/services/livekit.ts` — wrapper do LiveKit Server SDK.

## Captura nativa — decisão tomada (Electron + desktopCapturer)

Uma tentativa anterior de captura nativa via Rust (`windows-rs` + `Windows.Graphics.Capture`, mantendo o app em Tauri) conseguiu tirar a barra de compartilhamento do Chromium, mas travava o app inteiro — decodificar o frame (megabytes) de forma síncrona na thread da UI saturava o processo. Registro completo em `docs/POC-NATIVE-CAPTURE.md` (arquivado).

A solução que ficou foi trocar o shell inteiro pra Electron e usar `desktopCapturer` (API estável do Electron, é o que Discord/Slack/Teams usam) — o `MediaStream` resultante ainda entra no `publishTrack()` do LiveKit normalmente, **sem mudar nada do transporte/encoding**. Só a captura mudou de API; o resto da pilha (WebRTC via LiveKit, hardware encoding decidido pelo browser embutido) continua igual.

## Não fazer no MVP

- Sem PostgreSQL (sala é efêmera, em memória).
- Sem Redis (single instância no MVP; arquitetura não impede adicionar depois).
- Sem simulcast/SVC ainda (Fase 3).
- Sem seleção de codec manual (deixa LiveKit negociar; prioridade de codec fica em config futura).
