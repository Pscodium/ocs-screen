# Screen Share

Alternativa mínima ao compartilhamento de tela do Discord: sem calls, sem canais, sem servidores — só transmissão de tela em tempo real via WebRTC/LiveKit.

Especificação completa em [`CLAUDE.md`](./CLAUDE.md). Contexto de arquitetura e progresso em [`docs/`](./docs). Deploy em VPS/EasyPanel: [`docs/DISTRIBUTION.md`](./docs/DISTRIBUTION.md).

## Estrutura

- `desktop/` — app Windows (Electron + React), usado por quem transmite
- `viewer/` — web app (React), usado por quem assiste (sem instalação)
- `backend/` — API Fastify: salas + tokens LiveKit
- `infra/` — LiveKit dev via docker-compose

## Rodando localmente

Pré-requisitos: Node 20+, Docker.

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

## Publicando uma nova versão (auto-update)

O app desktop já tem auto-update embutido (`electron-updater`), usando os **Releases do
repositório no GitHub** (`Pscodium/ocs-screen`, configurado em `desktop/electron-builder.yml`)
como fonte. Ao abrir, o app confere se existe uma versão mais nova publicada e mostra um modal
com o changelog (a descrição do release) — o usuário escolhe atualizar agora ou depois.

Pra publicar uma nova versão:

1. Suba a versão em `desktop/package.json` (`"version"`), seguindo semver (ex.: `0.2.0`).
2. Gere um [Personal Access Token do GitHub](https://github.com/settings/tokens) com escopo
   `repo` (precisa poder criar release e subir asset).
3. Rode o build com publish, com o token disponível na env:

   ```bash
   cd desktop
   GH_TOKEN=ghp_xxx npm run dist:publish
   ```

   No PowerShell: `$env:GH_TOKEN = "ghp_xxx"; npm run dist:publish`.

4. Isso builda o instalador e sobe os artefatos (`.exe`, `latest.yml`, bloco de diff) como um
   **release em rascunho** no GitHub — o electron-builder não publica direto de propósito, pra dar
   chance de revisar/editar a descrição antes.
5. Abra o release em rascunho no GitHub, escreva o changelog na descrição (é exatamente o texto
   que aparece no modal de atualização do app) e clique em **Publish release**.
6. A partir daí, qualquer instalação mais antiga do app detecta a versão nova automaticamente na
   próxima abertura.

Sem `GH_TOKEN`, `npm run dist:publish` falha ao tentar publicar — para builds locais sem publicar,
use `npm run dist` normalmente.
