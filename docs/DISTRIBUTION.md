# Distribuição (Fase 5)

## Deploy do backend/viewer/LiveKit (VPS via EasyPanel)

Três serviços via Docker, definidos em [`docker-compose.prod.yml`](../docker-compose.prod.yml):

- `livekit` — imagem oficial `livekit/livekit-server`. Sem mount de arquivo (nem todo plano do EasyPanel expõe uma aba Files/Mounts) — o `command` do serviço escreve `/tmp/livekit.yaml` dentro do container a partir de env vars, na hora que ele sobe.
- `backend` — build de `backend/Dockerfile` (Fastify).
- `viewer` — build de `viewer/Dockerfile` (Vite build servido por nginx, `viewer/nginx.conf` cuida do fallback de SPA pra `/s/:roomId`).

Passos:

1. Gerar chave/segredo reais do LiveKit (nunca reaproveitar `devkey`/`devsecret` do dev): `openssl rand -hex 16` (key) e `openssl rand -hex 32` (secret).
2. No EasyPanel, cadastrar como **variáveis de ambiente do app Compose** (não em arquivo — o compose lê do ambiente que o EasyPanel injeta): `VIEWER_URL`, `BACKEND_URL`, `LIVEKIT_URL` (sempre `wss://`), `LIVEKIT_API_KEY`, `LIVEKIT_API_SECRET`, `LIVEKIT_TURN_DOMAIN` (ver `.env.production.example` pro formato).
3. Registrar DNS (A/AAAA) de `LIVEKIT_TURN_DOMAIN` apontando pro IP da VPS — usado como `domain` do TURN mesmo sem TLS (LiveKit exige o campo).
4. Subir o app apontando pro repo com `docker-compose.prod.yml` (ou 3 apps separados por serviço, se preferir isolar domínio/escala — o compose já separa build context por pasta).
5. Configurar domínios com TLS na UI do EasyPanel, mapeando cada um pra porta **interna** do container (o compose usa `expose`, não `ports`, pra tráfego HTTP — o EasyPanel roteia por dentro da rede dele):
   - `backend` → porta `4000`
   - `viewer` → porta `80`
   - `livekit` → porta `7880` (o domínio vira `wss://livekit.seudominio.com`, o EasyPanel cuida do upgrade WS)
6. As portas de mídia do `livekit` (`7881` TCP, `3478` UDP, `50000-50100` UDP) são protocolo cru — não passam pelo proxy do EasyPanel, então ficam publicadas direto no host (`ports:` no compose) e precisam estar liberadas no firewall da VPS. Sem isso, WebRTC não conecta atrás de NAT (mesmo erro "could not establish pc connection" visto em dev, mas agora por firewall em vez de config de IP local).
7. Depois de qualquer mudança nas env vars, fazer **rebuild/recriar** o app — o `viewer` embute `VITE_BACKEND_URL` no build (Vite não lê env em runtime), e o `command` do `livekit` só regenera o yaml quando o container reinicia.

### Por que TURN é obrigatório aqui (diferente do dev local)

Em dev, host e viewer estão na mesma máquina/rede — STUN/local resolve. Em produção, espectadores estão em redes com NAT restritivo (4G, Wi-Fi corporativo) que bloqueiam conexão direta P2P/UDP; sem TURN configurado, a conexão simplesmente falha silenciosamente ou trava em "conectando". O LiveKit tem TURN embutido (`turn.enabled: true` no yaml) — não precisa hospedar `coturn` separado.

**TURN sobre TLS (porta 5349) está desativado** — exigiria montar um certificado (`cert_file`/`key_file`) dentro do container, e não temos como fazer mount de arquivo no plano atual do EasyPanel. Fica só TURN via UDP puro (porta 3478), que cobre a grande maioria dos casos de NAT restritivo. TURN-TLS só é necessário pra redes que bloqueiam absolutamente tudo exceto tráfego HTTPS na porta 443 — cenário raro (algumas redes corporativas bem travadas). Se precisar disso no futuro: gerar certificado Let's Encrypt via ACME e reintroduzir `tls_port`/`cert_file`/`key_file` no `command` do serviço `livekit`.

## Build de produção (app desktop)

```bash
cd desktop
npm run dist
```

Gera o instalador NSIS em `desktop/dist/`. Config em [`desktop/electron-builder.yml`](../desktop/electron-builder.yml):

- `nsis.perMachine: false` — instala sem exigir admin.
- `nsis.createDesktopShortcut` / `createStartMenuShortcut` — atalhos automáticos.

`desktop/.env.production` precisa ter `VITE_BACKEND_URL` apontando pro backend real antes do build — Vite embute isso no bundle, não lê em runtime.

## Ícones

Em `desktop/build/` (`icon.ico`, `icon.icns`, `icon.png`). Pra trocar, gera um novo `.ico`/`.icns`/`.png` a partir do logo final e substitui os arquivos.

## Assinatura de código (pendente)

Sem assinatura, Windows SmartScreen alerta o usuário no primeiro uso. Passos quando houver certificado:

1. Obter certificado de assinatura de código (EV recomendado para reputação imediata no SmartScreen).
2. Configurar `win.certificateFile`/`win.certificatePassword` (ou variáveis `CSC_LINK`/`CSC_KEY_PASSWORD`) no `electron-builder.yml` / CI.
3. `electron-builder` assina automaticamente via `signtool` durante o build se o certificado estiver configurado.

## Auto-update (pendente)

Não implementado ainda — requer:

1. Adicionar `electron-updater` às dependências.
2. Configurar `publish` no `electron-builder.yml` apontando pro provedor de releases (ex.: GitHub Releases).
3. Chamar `autoUpdater.checkForUpdatesAndNotify()` no processo principal.

Fica de fora do MVP para não acoplar a um provedor de hospedagem antes de decidir onde o app será distribuído.

## ARM64

Fora do escopo inicial (CLAUDE.md: "futuramente ARM64 se necessário"). Quando necessário, adicionar `aarch64-pc-windows-msvc` como target adicional no CI de build.
