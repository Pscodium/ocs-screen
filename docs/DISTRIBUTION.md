# Distribuição (Fase 5)

## Deploy do backend/viewer/LiveKit (VPS via EasyPanel)

Três serviços via Docker, definidos em [`docker-compose.prod.yml`](../docker-compose.prod.yml):

- `livekit` — imagem oficial `livekit/livekit-server`. Sem mount de arquivo (nem todo plano do EasyPanel expõe uma aba Files/Mounts) — o `command` do serviço escreve `/tmp/livekit.yaml` dentro do container a partir de env vars, na hora que ele sobe.
- `backend` — build de `backend/Dockerfile` (Fastify).
- `viewer` — build de `viewer/Dockerfile` (Vite build servido por nginx, `viewer/nginx.conf` cuida do fallback de SPA pra `/s/:roomId`).

Passos:

1. Gerar chave/segredo reais do LiveKit (nunca reaproveitar `devkey`/`devsecret` do dev): `openssl rand -hex 16` (key) e `openssl rand -hex 32` (secret).
2. No EasyPanel, cadastrar como **variáveis de ambiente do app Compose** (não em arquivo — o compose lê do ambiente que o EasyPanel injeta): `VIEWER_URL`, `BACKEND_URL`, `LIVEKIT_URL` (sempre `wss://`), `LIVEKIT_API_KEY`, `LIVEKIT_API_SECRET`, `LIVEKIT_TURN_DOMAIN` (ver `.env.production.example` pro formato).
3. Registrar DNS (A/AAAA) de `LIVEKIT_TURN_DOMAIN` apontando pro IP da VPS — o TURN embutido do LiveKit depende disso pra TLS.
4. Subir o app apontando pro repo com `docker-compose.prod.yml` (ou 3 apps separados por serviço, se preferir isolar domínio/escala — o compose já separa build context por pasta).
5. Configurar domínios com TLS na UI do EasyPanel, mapeando cada um pra porta **interna** do container (o compose usa `expose`, não `ports`, pra tráfego HTTP — o EasyPanel roteia por dentro da rede dele):
   - `backend` → porta `4000`
   - `viewer` → porta `80`
   - `livekit` → porta `7880` (o domínio vira `wss://livekit.seudominio.com`, o EasyPanel cuida do upgrade WS)
6. As portas de mídia do `livekit` (`7881` TCP, `3478` UDP, `5349` TCP, `50000-50100` UDP) são protocolo cru — não passam pelo proxy do EasyPanel, então ficam publicadas direto no host (`ports:` no compose) e precisam estar liberadas no firewall da VPS. Sem isso, WebRTC não conecta atrás de NAT (mesmo erro "could not establish pc connection" visto em dev, mas agora por firewall em vez de config de IP local).
7. Depois de qualquer mudança nas env vars, fazer **rebuild/recriar** o app — o `viewer` embute `VITE_BACKEND_URL` no build (Vite não lê env em runtime), e o `command` do `livekit` só regenera o yaml quando o container reinicia.

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
