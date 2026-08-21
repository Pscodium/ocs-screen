# Distribuição (Fase 5)

## Deploy do backend/viewer/LiveKit (VPS via EasyPanel)

Três serviços via Docker, definidos em [`docker-compose.prod.yml`](../docker-compose.prod.yml):

- `livekit` — imagem oficial `livekit/livekit-server`, configurada por `infra/livekit/livekit.prod.yaml` (não versionado).
- `backend` — build de `backend/Dockerfile` (Fastify).
- `viewer` — build de `viewer/Dockerfile` (Vite build servido por nginx, `viewer/nginx.conf` cuida do fallback de SPA pra `/s/:roomId`).

Passos:

1. Copiar `infra/livekit/livekit.prod.yaml.example` → `infra/livekit/livekit.prod.yaml`, preencher domínio TURN e gerar chave/segredo reais (nunca reaproveitar `devkey`/`devsecret` do dev).
2. Copiar `.env.production.example` → `.env.production` (ou configurar as mesmas variáveis direto na UI do EasyPanel), preenchendo `VIEWER_URL`, `BACKEND_URL`, `LIVEKIT_URL` (sempre `wss://`, nunca `ws://`, em produção) e as chaves do LiveKit.
3. No EasyPanel: criar o app apontando pro repo com `docker-compose.prod.yml`, ou criar 3 apps separados (um por serviço) se preferir isolar domínio/escala de cada um — o compose já separa build context por pasta.
4. Configurar domínios com TLS em cada serviço exposto (`backend`, `viewer`, `livekit` — incluindo a porta TURN TLS 5349). O EasyPanel geralmente já resolve certificado via Let's Encrypt no proxy reverso dele.
5. Abrir/mapear as portas UDP do LiveKit (`50000-50100`, `3478`) no firewall da VPS — sem isso, WebRTC não conecta atrás de NAT (mesmo erro "could not establish pc connection" visto em dev, mas agora por causa de firewall em vez de config de IP local).

### Por que TURN é obrigatório aqui (diferente do dev local)

Em dev, host e viewer estão na mesma máquina/rede — STUN/local resolve. Em produção, espectadores estão em redes com NAT restritivo (4G, Wi-Fi corporativo) que bloqueiam conexão direta P2P/UDP; sem TURN configurado, a conexão simplesmente falha silenciosamente ou trava em "conectando". O LiveKit tem TURN embutido (`turn.enabled: true` no yaml) — não precisa hospedar `coturn` separado.

## Build de produção (app desktop)

```bash
cd desktop
npm run tauri build
```

Gera `.exe` standalone + instalador NSIS em `desktop/src-tauri/target/release/bundle/nsis/`.

Config em [`desktop/src-tauri/tauri.conf.json`](../desktop/src-tauri/tauri.conf.json):

- `bundle.windows.nsis.installMode: currentUser` — instala sem exigir admin.
- `languages: ["PortugueseBR"]` — instalador em pt-BR, sem seletor de idioma (atalho de start menu já é criado por padrão pelo NSIS bundler do Tauri).

## Ícones

Já gerados em `desktop/src-tauri/icons/` a partir de um placeholder. Para trocar pelo ícone final:

```bash
cd desktop && npx tauri icon caminho/para/logo.png
```

## Assinatura de código (pendente)

Sem assinatura, Windows SmartScreen alerta o usuário no primeiro uso. Passos quando houver certificado:

1. Obter certificado de assinatura de código (EV recomendado para reputação imediata no SmartScreen).
2. Configurar `bundle.windows.certificateThumbprint` (ou variáveis `TAURI_SIGNING_PRIVATE_KEY*` para o updater) no `tauri.conf.json` / CI.
3. Assinar via `signtool` — o Tauri bundler faz isso automaticamente se o certificado estiver instalado no keystore do Windows durante o build.

## Auto-update (pendente)

Não implementado ainda — requer:

1. Adicionar `@tauri-apps/plugin-updater` (frontend) e `tauri-plugin-updater` (Rust) às dependências.
2. Gerar par de chaves de assinatura: `npx tauri signer generate`.
3. Configurar `plugins.updater` no `tauri.conf.json` com a chave pública e a URL do manifest de releases.
4. Hospedar o manifest (`latest.json`) e os artefatos assinados em algum storage (ex.: GitHub Releases).

Fica de fora do MVP para não acoplar a um provedor de hospedagem antes de decidir onde o app será distribuído.

## ARM64

Fora do escopo inicial (CLAUDE.md: "futuramente ARM64 se necessário"). Quando necessário, adicionar `aarch64-pc-windows-msvc` como target adicional no CI de build.
