# Screen Share

Alternativa mínima ao compartilhamento de tela do Discord: sem calls, sem canais, sem servidores — só transmissão de tela em tempo real via WebRTC/LiveKit.

Especificação completa em [`CLAUDE.md`](./CLAUDE.md). Contexto de arquitetura e progresso em [`docs/`](./docs). Deploy em VPS/EasyPanel: [`docs/DISTRIBUTION.md`](./docs/DISTRIBUTION.md).

## Estrutura

- `desktop/` — app Windows (Electron + React), usado por quem transmite
- `viewer/` — web app (React), usado por quem assiste (sem instalação)
- `backend/` — API Fastify: salas + tokens LiveKit
- `infra/` — LiveKit dev via docker-compose

## Rodando localmente

Pré-requisitos: Node 20+, Docker — lista completa (Build Tools C++, vcpkg, GPU) em [`docs/REQUIREMENTS.md`](./docs/REQUIREMENTS.md).

```bash
cp .env.example .env

# 1. LiveKit (dev)
docker compose up -d

# 2. Backend
cd backend && npm install && npm run dev

# 3. Viewer (outro terminal)
cd viewer && npm install && npm run dev

# 4. Desktop (outro terminal)
cd desktop && npm install && npm run dev
```

Fluxo: abrir o app desktop → "Compartilhar tela" → escolher tela/janela no seletor do próprio app → copiar link → abrir link no navegador (viewer).

## Build de produção (.exe)

```bash
cd desktop && npm run dist
```

Gera o instalador NSIS em `desktop/dist/`.

## Publicando uma nova versão

O app desktop é publicado em dois canais: **GitHub Releases** (instalador NSIS com auto-update
via `electron-updater`) e **Microsoft Store** (MSIX, enviado automaticamente por tag `vX.Y.Z`
via GitHub Actions). Visão geral em [docs/RELEASE.md](docs/RELEASE.md); tutoriais separados:

- [Publicar no GitHub Releases](docs/RELEASE-GITHUB.md)
- [Publicar na Microsoft Store](docs/RELEASE-MSSTORE.md)
