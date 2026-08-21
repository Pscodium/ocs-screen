# Roadmap execução

Espelha fases do [`CLAUDE.md`](../CLAUDE.md). Marca progresso real.

## Fase 1 — MVP desktop (CONCLUÍDA)

- [x] Estrutura de pastas (desktop/viewer/backend/infra)
- [x] Backend Fastify: criação de sala, token LiveKit
- [x] Desktop Tauri+React: shell custom (fullscreen/minimize/drag), tela inicial, seleção de fonte, captura + publish LiveKit
- [x] Viewer web: entrar em sala, assistir stream
- [x] docker-compose LiveKit dev
- [x] Testar fluxo end-to-end com LiveKit real rodando (confirmado funcional pelo usuário)

## Fase 2 — Qualidade (EM ANDAMENTO)

- [x] Seleção resolução/FPS na UI (perfis centralizados)
- [x] Exibir resolução/FPS reais (`getSettings()`)
- [x] Controle de bitrate por perfil (`desktop/src/types/stream.ts#getMaxBitrate`)
- [x] Estatísticas de conexão (bitrate, latência, packet loss) — host e viewer
- [x] Reconexão automática (LiveKit cuida disso; UI mostra "Reconectando...")
- [x] Validar em rede real (deploy em VPS via EasyPanel, host/viewer em redes distintas — confirmado funcional pelo usuário)

## Fase 3 — Alta qualidade (EM ANDAMENTO)

- [x] 1440p/4K, 60fps profiles (já cobertos pelos perfis de resolução/bitrate)
- [x] Preferência de codec com detecção real de suporte (`desktop/src/services/codecs.ts`) + `backupCodec` automático (CLAUDE.md §Codecs: nunca assumir suporte)
- [x] Simulcast (host publica múltiplas camadas via `screenShareSimulcastLayers`)
- [x] Adaptação automática de qualidade (`adaptiveStream` + `dynacast` no viewer e host)
- [x] SVC real: `scalabilityMode: "L3T3_KEY"` explícito quando o codec detectado é VP9/AV1 (`desktop/src/services/livekit.ts`)
- [ ] Validar troca de camada simulcast em teste com múltiplos espectadores/banda limitada (precisa de teste controlado, não dá pra validar sem throttling de rede real)

## Fase 4 — Otimização desktop

- [ ] Captura nativa Rust (perf) — plano de investigação em [`docs/ARCHITECTURE.md`](./ARCHITECTURE.md#fase-4--captura-nativa-e-hardware-encoding-plano)
- [ ] Hardware encoding explícito (WebCodecs) — depende de medir se o encoder do browser já satura antes de migrar

## Fase 5 — Distribuição

- [x] Build `.exe` + instalador (tauri-bundler / NSIS) — config em `tauri.conf.json`, passo a passo em [`docs/DISTRIBUTION.md`](./DISTRIBUTION.md)
- [x] Ícones gerados (placeholder — trocar antes do release final)
- [x] Docker(files) + `docker-compose.prod.yml` pra deploy de backend/viewer/LiveKit em VPS (EasyPanel)
- [ ] Assinatura de código (precisa de certificado real)
- [ ] Auto-update (precisa decidir onde hospedar releases)
- [x] Deploy real testado em VPS (EasyPanel — backend/viewer/LiveKit em produção, TURN via UDP, confirmado funcional pelo usuário)

## Correções recentes

- Link de compartilhamento não copiava: faltava `desktop/src-tauri/capabilities/default.json` — Tauri v2 nega comandos de plugin sem permissão explícita.
- `viewerUrl` gerado pelo backend dependia de `CORS_ORIGIN` (quebrava com wildcard `*`) — agora usa `VIEWER_URL` dedicado.
- Janela ao vivo agora encolhe pra um widget compacto sempre-no-topo (`useWidgetWindow`), fora do caminho da tela sendo compartilhada, em vez de ocupar a janela inteira.
- Janela inicial aumentada (440×720) pra caber o formulário de qualidade sem cortar/scrollar.
- App desktop não fechava de fato ao clicar em fechar (processo ficava pendurado) — `lib.rs` agora força `app_handle().exit(0)` no `CloseRequested`.
- Env de build separada por modo: `desktop/.env` (dev) vs `desktop/.env.production` (build do `.exe`) — Vite escolhe sozinho.
- CORS do backend bloqueava requisições do app desktop (`Failed to fetch`): origem do app Tauri (`tauri://localhost` / `http://tauri.localhost`) não batia com `CORS_ORIGIN` (só liberava o domínio do viewer). Agora `backend/src/config.ts` sempre libera as origens do Tauri além do que vier em `CORS_ORIGIN`.
- Deploy prod: variável `BACKEND_URL` faltando no `.env` do EasyPanel quebrava o build do `viewer` (URL da API embutida em branco); `LIVEKIT_URL` estava em `ws://` sem TLS (mixed content bloqueado pelo navegador). Corrigido pra `wss://` + `BACKEND_URL` cadastrada.
- TURN sobre TLS (porta 5349) removido do `docker-compose.prod.yml` — exigia certificado que não tem como montar sem acesso a Files/Mounts no plano atual do EasyPanel. TURN via UDP puro continua ativo.
- Adicionado ícone na bandeja do Windows (`app.trayIcon` no `tauri.conf.json`, feature `tray-icon` no Cargo) — tooltip mostra status "ao vivo" e clique restaura a janela. Não remove a barra de compartilhamento do Chromium/WebView2 (UI de segurança do browser, só some com captura nativa — Fase 4).
- SVC real ativado: `scalabilityMode: "L3T3_KEY"` quando o codec detectado é VP9/AV1.
