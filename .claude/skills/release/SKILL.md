---
name: release
description: Publicar uma versão nova do app desktop no GitHub Releases (instalador .exe + auto-update) e na Microsoft Store (MSIX) de uma vez — changelog, bump de versão, tag e acompanhamento dos workflows. Usar SOMENTE quando o usuário pedir explicitamente pra publicar/lançar/subir uma versão ("publica", "solta a 1.0.15", "/release"). Nunca por iniciativa própria, nem como passo final de outra tarefa.
---

# Release do app desktop (GitHub + Microsoft Store)

Uma tag `vX.Y.Z` dispara os dois workflows em paralelo:

| Workflow | Faz | Segredos que usa |
| --- | --- | --- |
| [.github/workflows/github-release.yml](../../../.github/workflows/github-release.yml) | build NSIS → release `vX.Y.Z` com o texto da seção `## X.Y.Z` do CHANGELOG.md (é o que o modal de atualização mostra) | `GITHUB_TOKEN` automático + `VITE_BACKEND_URL` |
| [.github/workflows/store.yml](../../../.github/workflows/store.yml) | build MSIX → `msstore publish` → certificação | `MSSTORE_*` + `VITE_BACKEND_URL` |

O Claude **nunca** vê, pede, digita ou guarda valor de segredo. Tudo roda no GitHub Actions com Actions secrets.
Localmente só é preciso: `git` com push no repo e o `gh` logado pela própria pessoa.

## Regra de ouro

Só publica quando o usuário mandar publicar **nesta conversa**. "Pode publicar" de outra conversa não vale.
Antes do push da tag (passo 6) mostrar versão + changelog e esperar um "sim" — tag empurrada já começa a
subir pra Store e pro auto-update de todo mundo.

## Passos

### 1. Pré-checagem (parar e avisar se falhar)

```powershell
git status --porcelain            # vazio
git rev-parse --abbrev-ref HEAD   # master
git fetch origin; git status -sb  # sem "ahead"/"behind" divergente
gh auth status                    # logado (se faltar: pedir pro usuário rodar `winget install GitHub.cli` e `gh auth login`)
gh secret list --repo Pscodium/ocs-screen
```

`gh secret list` mostra só **nomes**. Precisam existir:
`VITE_BACKEND_URL`, `MSSTORE_IDENTITY_NAME`, `MSSTORE_PUBLISHER`, `MSSTORE_PUBLISHER_DISPLAY_NAME`,
`MSSTORE_PRODUCT_ID`, `MSSTORE_TENANT_ID`, `MSSTORE_CLIENT_ID`, `MSSTORE_CLIENT_SECRET`, `MSSTORE_SELLER_ID`.
Faltando algum → parar e passar pro usuário a seção "Credenciais" abaixo. Não tentar contornar.

Typecheck tem que passar: `cd desktop; npm run typecheck`.

### 2. Addon nativo (C++) — recompilar e commitar

O CI **não** compila C++: os dois workflows empacotam o `capture_core.node` + DLLs que estão
**commitados** em `desktop/native/capture-core/build/Release`. Se o C++ mudou e o binário commitado é
o antigo, a versão publicada sai com o addon velho (recurso novo some ou quebra em silêncio).

```powershell
$last = git describe --tags --abbrev=0
git diff --stat $last HEAD -- desktop/native/capture-core/src desktop/native/capture-core/binding.gyp
git status --porcelain desktop/native/capture-core
```

Se o primeiro comando listar algo, ou o segundo mostrar `src/` modificado:

1. Recompilar: `sh .claude/skills/native-e2e/scripts/build-addon.sh` → tem que terminar em `gyp info ok`
   com `0 Erro(s)`. Erro de compilação/link → parar e mostrar ao usuário.
2. Conferir que o `.node` é mais novo que todo fonte:
   `(Get-Item desktop/native/capture-core/build/Release/capture_core.node).LastWriteTime` ≥ o
   `LastWriteTime` mais recente em `desktop/native/capture-core/src`.
3. Validar o pipeline com a skill `native-e2e` (E2E curto, `e2e-run.js 15 60`): fps ~60, `stutters` ~0,
   latência p50 na casa dos 30ms. Pior que isso → parar e mostrar ao usuário.
4. Incluir `desktop/native/capture-core/build/Release` (o `.node`, DLLs e arquivos de build que o git já
   rastreia) no commit de release do passo 5, junto com o fonte.

### 3. Versão

Última: `git describe --tags --abbrev=0`. Sugerir semver pelo que mudou (correção → patch, recurso → minor)
— o usuário decide se quiser outra. Precisa ser maior que a última (a Store recusa repetida/menor).

### 4. Changelog

`git log <última-tag>..HEAD --oneline` + diffs relevantes → nova seção no topo do [CHANGELOG.md](../../../CHANGELOG.md):

```markdown
## X.Y.Z — AAAA-MM-DD

### Novidades / Melhorias / Correções / Observações
- **Frase curta do efeito pro usuário.** Uma ou duas linhas do que mudou na prática.
```

Português, voltado a quem usa o app (não a quem programa): sem nome de arquivo, função, hook ou commit.
Só seções com conteúdo. Ignorar mudanças só de backend/viewer/docs/infra que não alteram o app desktop.
O título tem que ser exatamente `## X.Y.Z` (o workflow procura por ele).

### 5. Bump + commit

```powershell
cd desktop; npm version X.Y.Z --no-git-tag-version; cd ..
git add CHANGELOG.md desktop/package.json desktop/package-lock.json desktop/native/capture-core   # addon só se mudou (passo 2)
git commit -m "chore(release): vX.Y.Z"
```

### 6. Confirmar e publicar

Mostrar ao usuário: versão, changelog, e "isso envia pra certificação da Store e libera o auto-update".
Com o "sim":

```powershell
git push origin master
git tag vX.Y.Z
git push origin vX.Y.Z
```

### 7. Acompanhar

```powershell
gh run list --repo Pscodium/ocs-screen --limit 4
gh run watch <id> --repo Pscodium/ocs-screen --exit-status
```

Os dois runs (GitHub Release ~10 min, Microsoft Store ~10 min + certificação de horas a 3 dias úteis).
Conferir: `gh release view vX.Y.Z --repo Pscodium/ocs-screen` tem `.exe`, `latest.yml` e `.blockmap`.

Relatar: links dos runs, link do release, e que a Store está "Em certificação" (o e-mail da conta avisa).

## Se falhar

| Falha | O que fazer |
| --- | --- |
| `CHANGELOG.md não tem a seção` | Seção com título errado. Corrigir, commitar, apagar e recriar a tag (`git push origin :refs/tags/vX.Y.Z`) — só se nenhum dos dois jobs chegou a publicar |
| GitHub Release falhou depois do upload | Release ficou rascunho. Re-rodar o job (`gh run rerun <id> --failed`) |
| Store: `Version must be higher` / submissão pendente | Outra submissão em certificação. Esperar ou excluir o rascunho no Partner Center, depois `gh run rerun` |
| Store: 401/403 | `MSSTORE_CLIENT_SECRET` expirou → usuário gera chave nova (ver Credenciais) |
| Store: `Could not retrieve your application` | App do Entra sem acesso ao produto: o diretório dele precisa estar associado ao Partner Center (Tenants) e o app adicionado em Gerenciamento de usuários → Aplicativos do Microsoft Entra como Gerente. Conta pessoal (hotmail) não associa — usar uma conta corporativa `admin@<dominio>.onmicrosoft.com` com Administrador Global criada no mesmo diretório |
| Envio automático da Store indisponível | O workflow sobe o `.appx` como artefato `store-package` antes do envio: `gh run download <id> -n store-package` e o usuário sobe à mão em Partner Center → Pacotes |
| Um canal publicou e o outro não | Não criar tag nova. Corrigir e re-rodar só o job que falhou (`workflow_dispatch` com a mesma versão) |

Nunca: `--force` em tag já publicada no Store/Release, editar workflow pra imprimir segredo, rodar
`publish-store.ps1` local com segredos colados no chat.

## Credenciais (o que o usuário configura, uma vez)

Projeto open source: **nenhum segredo vai pro repositório, pro chat ou pra arquivo local commitável**.
Tudo fica em *GitHub → Settings → Secrets and variables → Actions → Repository secrets*, que:
não aparece em log (o Actions mascara), não é entregue a workflows de PR vindos de fork, e só quem tem
acesso de admin ao repo vê/edita.

O usuário cadastra cada um digitando o valor no próprio terminal (o valor não passa pelo Claude):

```powershell
gh secret set MSSTORE_CLIENT_SECRET --repo Pscodium/ocs-screen   # pede o valor no prompt
```

ou pela interface web. Lista completa:

| Secret | Onde pegar | Sensível? |
| --- | --- | --- |
| `VITE_BACKEND_URL` | URL pública do backend de produção | Não (vai embutida no app), mas fica como secret pra não fixar no repo |
| `MSSTORE_IDENTITY_NAME` | Partner Center → produto → Identidade do produto → `Package/Identity/Name` | Não |
| `MSSTORE_PUBLISHER` | idem → `Package/Identity/Publisher` (`CN=...`) | Não |
| `MSSTORE_PUBLISHER_DISPLAY_NAME` | idem → `PublisherDisplayName` | Não |
| `MSSTORE_PRODUCT_ID` | idem → Store ID (`9N...`) | Não |
| `MSSTORE_SELLER_ID` | Partner Center → Configurações da conta → Informações legais/Seller ID | Baixa |
| `MSSTORE_TENANT_ID` | Partner Center → Gerenciamento de usuários → Aplicativos do Microsoft Entra | Baixa |
| `MSSTORE_CLIENT_ID` | idem (ID do aplicativo Entra, papel **Gerente**) | Baixa |
| `MSSTORE_CLIENT_SECRET` | idem → "Adicionar nova chave" (aparece uma vez, expira) | **Alta** — dá poder de publicar o app |

GitHub não precisa de token pessoal: o workflow usa o `GITHUB_TOKEN` temporário que o Actions cria por run.

Boas práticas extras (opcionais, recomendar uma vez):
- Proteger tags `v*` (Settings → Rules → Tag rulesets) pra só o dono criar.
- Anotar a data de expiração do `MSSTORE_CLIENT_SECRET` e trocar antes.
- Se um segredo vazar: revogar a chave no Partner Center primeiro, depois `gh secret set` com a nova.
