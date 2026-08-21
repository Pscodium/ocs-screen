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
- [ ] Validar em rede real com perda/latência simulada

## Fase 3 — Alta qualidade (EM ANDAMENTO)

- [x] 1440p/4K, 60fps profiles (já cobertos pelos perfis de resolução/bitrate)
- [x] Preferência de codec com detecção real de suporte (`desktop/src/services/codecs.ts`) + `backupCodec` automático (CLAUDE.md §Codecs: nunca assumir suporte)
- [x] Simulcast (host publica múltiplas camadas via `screenShareSimulcastLayers`)
- [x] Adaptação automática de qualidade (`adaptiveStream` + `dynacast` no viewer e host)
- [ ] SVC real (scalabilityMode) — hoje via LiveKit default quando codec é VP9/AV1, não configurado explicitamente
- [ ] Validar troca de camada simulcast em teste com múltiplos espectadores/banda limitada

## Fase 4 — Otimização desktop

- [ ] Captura nativa Rust (perf) — plano de investigação em [`docs/ARCHITECTURE.md`](./ARCHITECTURE.md#fase-4--captura-nativa-e-hardware-encoding-plano)
- [ ] Hardware encoding explícito (WebCodecs) — depende de medir se o encoder do browser já satura antes de migrar

## Fase 5 — Distribuição

- [x] Build `.exe` + instalador (tauri-bundler / NSIS) — config em `tauri.conf.json`, passo a passo em [`docs/DISTRIBUTION.md`](./DISTRIBUTION.md)
- [x] Ícones gerados (placeholder — trocar antes do release final)
- [x] Docker(files) + `docker-compose.prod.yml` pra deploy de backend/viewer/LiveKit em VPS (EasyPanel)
- [ ] Assinatura de código (precisa de certificado real)
- [ ] Auto-update (precisa decidir onde hospedar releases)
- [ ] Deploy real testado em VPS (validar TURN/TLS end-to-end fora de localhost)

## Correções recentes

- Link de compartilhamento não copiava: faltava `desktop/src-tauri/capabilities/default.json` — Tauri v2 nega comandos de plugin sem permissão explícita.
- `viewerUrl` gerado pelo backend dependia de `CORS_ORIGIN` (quebrava com wildcard `*`) — agora usa `VIEWER_URL` dedicado.
- Janela ao vivo agora encolhe pra um widget compacto sempre-no-topo (`useWidgetWindow`), fora do caminho da tela sendo compartilhada, em vez de ocupar a janela inteira.
- Janela inicial aumentada (440×720) pra caber o formulário de qualidade sem cortar/scrollar.
