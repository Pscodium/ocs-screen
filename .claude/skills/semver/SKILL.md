---
name: semver
description: Decidir o número correto da próxima versão do app desktop (major, minor ou patch) a partir do que mudou desde a última tag. Usar SEMPRE que for sugerir, citar ou planejar uma versão ("vai na 1.2.0", "isso é patch?"), antes do bump no passo de versão da skill `release`, e ao planejar uma mudança que quebra compatibilidade com apps já instalados.
---

# Versionamento (semver) do ScreenShare

Formato `MAJOR.MINOR.PATCH`. A versão descreve o **app desktop** (é o que o usuário instala e o que
a Store e o auto-update comparam). Backend e viewer web são publicados continuamente e não têm
versão própria, mas uma mudança neles conta aqui quando muda o contrato com o app instalado.

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
- **Mudança só de backend/viewer/infra/docs não gera versão** do app. Só entra no cálculo se o
  app instalado precisar mudar junto.
- **Subir a versão mínima suportada** (skill `prod-changes`) que bloqueia versões ainda em uso é
  MAJOR. Bloquear só versões que já foram marcadas como depreciadas numa versão anterior, com aviso,
  pode ser MINOR, mas avisar o usuário que é um corte.
- Na dúvida entre dois níveis, **mostrar a classificação de cada mudança ao usuário e perguntar**.
  Nunca escolher o mais alto "por garantia".
- Ao subir MINOR, PATCH volta a 0 (`1.1.1` → `1.2.0`). Ao subir MAJOR, MINOR e PATCH voltam a 0.
- A versão nova precisa ser maior que a última tag (a Store recusa versão repetida ou menor) e
  nunca reaproveitar uma tag já publicada.

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
