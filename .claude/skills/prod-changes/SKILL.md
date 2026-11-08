---
name: prod-changes
description: Avisar o usuário, antes de terminar a tarefa, sempre que uma mudança exigir algo em produção fora do código (variável de ambiente nova/alterada/removida, secret do GitHub Actions, serviço de infra, ordem de deploy) ou mudar quais versões do app desktop continuam funcionando. Mantém a tabela de versões estáveis/depreciadas/bloqueadas. Usar ao mexer em backend/src/config.ts, .env.example, docker-compose*.yml, infra/, .github/workflows, no contrato entre app e backend (rotas, campos, WebSocket), ou na versão mínima suportada.
---

# Mudanças que afetam produção

O usuário publica backend/viewer e configura produção à mão (EasyPanel + secrets do GitHub). Uma
variável faltando em produção quebra o serviço ou deixa ele inseguro em silêncio. Por isso:
**nada que exija ação fora do código pode ficar só no diff.** Tem que ir no relatório final, em
seção própria.

## Quando avisar

Rodar no fim de qualquer tarefa que tocou backend, infra, workflows ou o contrato app ↔ backend:

```sh
git diff HEAD --stat -- backend/src/config.ts '*.env.example' docker-compose*.yml infra .github/workflows
git diff HEAD -- backend/src/config.ts | grep -E '^[+-].*process\.env'
```

Avisar se aparecer qualquer um destes:

| Mudança | O que dizer ao usuário |
|---|---|
| Variável de ambiente **nova** | Nome, onde configurar (backend no EasyPanel / secret do Actions / `.env.production` do build), valor sugerido ou como gerar (`openssl rand -hex 32`), e o que acontece se faltar |
| Variável **renomeada ou removida** | Valor antigo continua lido? Até quando? O que remover do painel |
| Default **mudou** | Comportamento antes × depois quando a variável não está setada |
| Secret novo no Actions | Nome exato e onde pegar o valor (`gh secret set NOME`). Nunca pedir o valor no chat |
| Serviço/porta/infra nova | O que subir e em que ordem |
| Ordem de deploy importa | Ex.: "publicar backend antes da versão do app", com o motivo |

Formato no relatório final:

```
## Ação necessária em produção
- [backend] Nova env `MIN_APP_VERSION` (opcional). Sem ela: nenhuma versão é bloqueada.
- [ordem] Backend primeiro, depois a versão do app.
```

Sem nada disso na tarefa, não criar a seção. Sempre atualizar `.env.example` e
`backend/.env.example` junto com o `config.ts`, com comentário do que a variável faz.

Regras:
- Variável nova precisa ter default seguro que não quebre o boot de produção, **ou** o backend
  falha no boot com mensagem clara. Nunca um default que funciona mas deixa aberto (ex.: chave de dev).
- Nunca ler `.env` reais nem pedir valores de segredo no chat.

## Versões suportadas do app

Tabela é a fonte de verdade. Atualizar a cada release e a cada mudança de contrato. Se a mudança
quebra ou deprecia alguma versão, avisar o usuário **antes** de implementar e usar a skill `semver`
pra confirmar o nível da versão.

| Versão | Estado | Observação |
|---|---|---|
| 1.5.0 | Estável | Manda `hostName` opcional (opt-in) no `POST /rooms` pro aviso do Discord. Backend antigo ignora o campo. |
| 1.4.1 | Estável | Discord Rich Presence (local, IPC do Discord). Sem mudança de contrato com o backend. |
| 1.4.0 | Estável | Envia relatório de crash (nativo + JS) ao backend (`/crash`, `/crash/js`), com opção de desligar na bandeja. Requer backend com Postgres pra guardar; sem ele, descartado |
| 1.2.0 – 1.3.0 | Estável | Manda `hostAuth` (sala protegida por segredo do host). Mostra aviso/bloqueio pela `MIN_APP_VERSION` e avisa atualização também na Store |
| 1.1.0 – 1.1.1 | Estável (modo de transição) | Mandam `appVersion`. Salas sem segredo do host (qualquer um pode encerrar/assumir). Bloqueio aparece só como erro genérico ao criar sala |
| < 1.1.0 | Estável (legado, modo de transição) | Não mandam `appVersion`: qualquer `MIN_APP_VERSION` bloqueia essas. Mesma falta de proteção acima |

Corte do modo de transição: subir `MIN_APP_VERSION` para `1.2.0` **depois** que a 1.2.0 estiver
aprovada na Store e for maioria nos logs. Isso é corte de versões em uso (ver skill `semver`).

Estados:
- **Estável**: funciona com o backend atual sem restrição.
- **Depreciada**: funciona, mas recebe aviso de atualização e vai ser bloqueada. Anotar a data/versão prevista do corte.
- **Bloqueada**: abaixo da versão mínima, o backend recusa e o app pede atualização.

Para depreciar ou bloquear uma versão:
1. Avisar o usuário quais versões entram em cada estado e quantas ainda estão em uso (os logs
   `room created` do backend têm `appVersion`; pedir ao usuário, não acessar produção sozinho).
2. Garantir modo de transição: versões que não sabem mostrar o aviso não podem simplesmente
   quebrar sem mensagem, a menos que o usuário aceite isso explicitamente.
3. Mudar a tabela no mesmo commit da mudança.
