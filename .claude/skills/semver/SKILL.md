---
name: semver
description: Decidir o número correto da próxima versão do app desktop e do viewer web (major, minor ou patch). Usar SEMPRE que for sugerir, citar ou planejar uma versão ("vai na 1.2.0", "isso é patch?"), antes do bump no passo de versão da skill `release`, ao planejar uma mudança que quebra compatibilidade com apps já instalados, e em TODA alteração em viewer/ (o viewer sobe versão no mesmo commit da mudança).
---

# Versionamento (semver) do ScreenShare

Formato `MAJOR.MINOR.PATCH`. Duas versões independentes:

- **App desktop** (`desktop/package.json`): o que o usuário instala e o que a Store e o auto-update
  comparam. Sobe só na skill `release`.
- **Viewer web** (`viewer/package.json`): aparece ao lado do título da home e vai pro backend como
  `appVersion` (aparece no aviso do Discord como `web X.Y.Z`). Ver seção "Viewer web" abaixo.

Backend não tem versão própria. Mudança no backend ou no viewer conta pra versão do **desktop** só
quando muda o contrato com o app instalado.

## Como decidir

Listar o que mudou: `git log $(git describe --tags --abbrev=0)..HEAD --oneline` e os diffs. Classificar
**cada** mudança e usar o nível mais alto encontrado:

| Nível | Quando | Exemplos neste projeto |
|---|---|---|
| **MAJOR** (`2.0.0`) | Quebra quem não atualizar, ou muda o produto de forma que exige ação do usuário | Backend passa a recusar apps antigos (versão mínima sobe e corta versões em uso); formato de link de sala muda e links antigos param; remove um recurso que as pessoas usam; exige reinstalar/reconfigurar |
| **MINOR** (`1.2.0`) | Recurso novo ou comportamento novo **visível**, compatível com tudo que já existe | Tela/aviso/botão novo; opção nova de qualidade; novo modo de transmissão; recurso novo que o backend passa a suportar com modo de transição pra apps antigos |
| **PATCH** (`1.1.2`) | Só correção ou ajuste interno, sem recurso novo | Bug corrigido; correção de segurança que não muda o uso; layout/estilo melhorado de algo que já existia; desempenho; texto; dependência atualizada |

Regras que resolvem os casos de dúvida:

- **Correção de segurança sozinha é PATCH**, mesmo sendo importante. Vira MINOR só se vier junto
  com recurso novo; vira MAJOR só se cortar apps antigos.
- **Melhorar a aparência de uma tela existente é PATCH.** Criar uma tela nova é MINOR.
- **Mudança só de backend/viewer/infra/docs não gera versão do desktop** (viewer sobe a própria, ver abaixo). Só entra no cálculo se o
  app instalado precisar mudar junto.
- **Subir a versão mínima suportada** (skill `prod-changes`) que bloqueia versões ainda em uso é
  MAJOR. Bloquear só versões que já foram marcadas como depreciadas numa versão anterior, com aviso,
  pode ser MINOR, mas avisar o usuário que é um corte.
- Na dúvida entre dois níveis, **mostrar a classificação de cada mudança ao usuário e perguntar**.
  Nunca escolher o mais alto "por garantia".
- Ao subir MINOR, PATCH volta a 0 (`1.1.1` → `1.2.0`). Ao subir MAJOR, MINOR e PATCH voltam a 0.
- A versão nova precisa ser maior que a última tag (a Store recusa versão repetida ou menor) e
  nunca reaproveitar uma tag já publicada.

## Viewer web

**Toda alteração em `viewer/`** (código, estilo, texto) sobe a versão do viewer **no mesmo commit**,
sem esperar release — o viewer é publicado continuamente, e a versão serve pra saber qual build está
no ar e qual build quem transmite pelo navegador está usando.

```powershell
cd viewer; npm version X.Y.Z --no-git-tag-version; cd ..
git add viewer/package.json viewer/package-lock.json
```

- Mesma tabela de níveis acima, aplicada ao viewer: recurso/tela/opção nova visível → MINOR;
  correção, estilo, texto, desempenho → PATCH; quebra links/salas existentes ou exige ação → MAJOR.
- Base é a versão atual em `viewer/package.json` (o viewer não tem tag). Várias mudanças num commit
  só sobem uma vez, pelo maior nível.
- Mudança só em testes/scripts de E2E dentro de `viewer/` que não muda o build não sobe versão.
- Versão do viewer é independente da do desktop — não precisam bater.
- Avisar o usuário no fim da tarefa: `Viewer: 0.1.0 → 0.2.0 (MINOR) — <motivo>`.

## Como apresentar

Sempre que sugerir uma versão, mostrar a justificativa curta:

```
Última: v1.1.1 → Sugerida: v1.2.0 (MINOR)
- Aviso de atualização obrigatória → recurso novo → MINOR
- Segredo do host / rate limit → correção de segurança → PATCH
- Modal de atualização maior → ajuste visual → PATCH
Maior nível: MINOR.
```

Se o plano de uma tarefa mudar de nível no meio (ex.: começou só com correções e ganhou um recurso),
avisar o usuário que a versão prevista mudou.
