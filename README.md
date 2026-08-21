# ScreenShare

Alternativa mínima ao compartilhamento de tela do Discord: sem calls, sem canais, sem servidores — só transmissão de tela em tempo real via WebRTC/LiveKit.

Especificação completa em [`CLAUDE.md`](./CLAUDE.md). Contexto de arquitetura e progresso em [`docs/`](./docs). Deploy em VPS/EasyPanel: [`docs/DISTRIBUTION.md`](./docs/DISTRIBUTION.md).

## Estrutura

- `desktop/` — app Windows (Tauri + React), usado por quem transmite
- `viewer/` — web app (React), usado por quem assiste (sem instalação)
- `backend/` — API Fastify: salas + tokens LiveKit
- `infra/` — LiveKit dev via docker-compose

## Rodando localmente

Pré-requisitos: Node 20+, Rust stable + toolchain do [Tauri v2](https://v2.tauri.app/start/prerequisites/), Docker.

```bash
cp .env.example .env

# 1. LiveKit (dev)
docker compose up -d

# 2. Backend
cd backend && npm install && npm run dev

# 3. Viewer (outro terminal)
cd viewer && npm install && npm run dev

# 4. Desktop (outro terminal)
cd desktop && npm install && npm run tauri dev
```

Fluxo: abrir o app desktop → "Compartilhar tela" → copiar link → abrir link no navegador (viewer).

## Ícones do app desktop

`desktop/src-tauri/tauri.conf.json` referencia ícones em `desktop/src-tauri/icons/` que ainda não existem neste repo. Antes do primeiro build, gere-os a partir de um PNG fonte:

```bash
cd desktop && npx tauri icon caminho/para/logo.png
```

## Build de produção (.exe)

```bash
cd desktop && npm run tauri build
```
