# Insights — eficiência de encoder/codec (rumo a qualidade tipo Discord)

> **Status:** itens 2 (parcial) e 7 implementados e confirmados nos dois clientes. Item 1 foi
> implementado, testado em produção e **revertido** por padrão — piorou stutter/frame drop real em
> jogos de movimento rápido (ver nota no próprio item); virou toggle opt-in ("Melhorar texto" nas
> configurações). `degradationPreference` trocado de `"balanced"` pra `"maintain-framerate"` como
> correção direta desse mesmo teste. `BITS_PER_PIXEL` subiu de `0.1` pra `0.15` depois de um
> segundo teste real mostrar QP 30-40 com encoder de hardware confirmado — teto de bitrate baixo
> demais pro hardware disponível (ver item 5). Itens 12, 13, 15 implementados; item 14 parcial
> (`framesDropped` ficou de fora, disponibilidade cross-browser não validada). Itens 3, 4, 6, 8, 9
> seguem como levantamento, não implementados.

Levantamento sem código, baseado no que já está implementado (`desktop/src/renderer/src/services/{codecs,livekit}.ts`) e no que falta pra chegar perto da experiência de "Go Live" do Discord. Cada insight diz o estado atual, o porquê do gap, e a direção — sem prescrever implementação.

## 1. 🟡 `contentHint` — revertido como padrão, virou opt-in ("Melhorar texto")

**Revertido do padrão, disponível como toggle.** A hipótese original era correta pra conteúdo estático (texto/UI),
mas incompleta: `contentHint = "detail"` diz pro encoder priorizar nitidez de borda sobre fluidez
de movimento **incondicionalmente** — inclusive quando o conteúdo é um jogo em movimento rápido
(Rocket League, testado em produção). Com o teto de bitrate fixo, isso faz o encoder ou estourar
QP (blocking) ou dropar frame pra tentar manter detalhe numa cena que já não tem "detalhe estático"
nenhum pra manter — exatamente o stutter/queda de FPS que apareceu no teste, num PC/jogo que
sempre rodou bem via Discord. `CLAUDE.md` já lista jogos como caso de uso prioritário, com peso
igual ou maior que nitidez de texto — um hint que otimiza só pro segundo caso é uma troca ruim pro
produto como um todo. Sem `contentHint`, o Chromium usa a heurística própria dele pra tracks de
`display-capture`, que não penaliza tanto conteúdo em movimento.

**Atualização:** virou um toggle "Melhorar texto" nas configurações (`StreamSettings.sharpText`,
desligado por padrão) — o usuário liga manualmente quando sabe que vai compartilhar código/documento
parado, e desliga pra jogo. Não é detecção automática de conteúdo (isso exigiria analisar taxa de
mudança de pixels entre frames em tempo real, fora de escopo por ora) — é uma escolha explícita,
mesmo modelo mental do "melhorar leitura de texto" do Discord.

## 2. 🟡 A escolha de codec é estática — nunca reage ao que realmente aconteceu

**Parcial:** o `encoderImplementation` agora vira um aviso visível (⚠️ CPU) nas estatísticas ao
vivo quando detecta software encoder — mas ainda não readapta a escolha de codec dinamicamente,
só avisa. Reescolher codec em pleno vivo exigiria renegociar a publicação, fora de escopo por ora.

`detectBestVideoCodec()` decide uma vez, no início, com base só em `RTCRtpSender.getCapabilities()` — que informa negociabilidade, não presença de hardware. O próprio código já documenta essa limitação (comentário em `codecs.ts`) e por isso prioriza H.264. Mas o dado que *de fato* prova hardware ou software já está sendo coletado (`encoderImplementation` em `readPublishStats`) e hoje só é exibido nas estatísticas — nunca usado pra decidir nada. Um insight natural: se depois de alguns segundos de transmissão o `encoderImplementation` reportado for claramente software (`"libvpx"`, `"libaom"`, `"openh264"` em vez de `"ExternalEncoder"`/nomes de vendor), isso é sinal de que o codec "preferencial" saiu caro em CPU sem o app saber — daria pra, no mínimo, avisar o usuário ("transmitindo por software, pode pesar a CPU") em vez de fingir que está tudo ótimo.

## 3. AV1 por hardware já existe em GPUs recentes — a prioridade fixa H.264 > VP9 > AV1 vai ficar desatualizada

A troca pra H.264-first foi correta pro parque de hardware médio de 2024, mas encoders AV1 por hardware já vêm de série em RTX 40-series (NVENC), Arc da Intel, e as APUs/GPUs mais novas da AMD. Prioridade de codec fixa no código é exatamente o tipo de "valor rígido espalhado" que o próprio `CLAUDE.md` pede pra evitar — o ideal a médio prazo é essa ladder ser reavaliada periodicamente (não por versão de app, por hardware real), já que AV1 entrega ~30% menos bitrate pro mesmo SSIM quando o encoder é de hardware. Hoje isso é fixo em array; o gap é não ter nenhum sinal de "esse PC tem AV1 de hardware real" pra subir a prioridade dinamicamente.

## 4. ✅ Simulcast de 3 camadas é caro pro host — Discord evita isso de propósito

**Confirmado empiricamente e corrigido.** Teste real (Rocket League, desktop→Edge): FPS entregue caía com o tempo (oscilando 20-55fps) mesmo com as 3 camadas confirmadas em hardware (`MediaFoundationVideoEncodeAccelerator`) — sem cair pra software, sem indício de rede (LiveKit local/loopback nesse teste). A explicação que sobra é a GPU não sustentando 3 sessões de encode simultâneas *enquanto também renderiza o jogo* por tempo prolongado. `pickSimulcastLayers()` reduzido de 2 camadas extras (3 encodes) pra 1 camada extra (2 encodes) nos dois clientes — troca deliberada de diversidade de qualidade entre espectadores por estabilidade de FPS pro host.

O código atual usava simulcast completo (`screenShareSimulcastLayers`, até 3 camadas simultâneas pra 4K) — cada camada é um encode independente rodando ao mesmo tempo na CPU/GPU do host. Isso é ótimo pra qualidade heterogênea entre espectadores, mas é o tipo de custo que cresce com a resolução de captura, não com o número de espectadores reais. O "Go Live" do Discord historicamente evita simulcast multi-camada pra screen share justamente por isso: prefere um único encode adaptativo (resolução/bitrate ajustados dinamicamente pela pior condição de rede entre os espectadores conectados) a manter 2-3 encodes permanentes. Vale considerar: simulcast só faz sentido quando o host tem hardware encoder de sobra (NVENC aguenta múltiplas sessões de encode sem dividir custo com o resto do sistema); em CPU pura, 3 camadas competem pelos mesmos núcleos que processam captura+rede.

## 5. 🟡 Bitrate por pixel é um proxy grosseiro — conteúdo de tela não é uniforme

**Ajuste parcial:** `BITS_PER_PIXEL` subiu de `0.1` pra `0.15` depois de um teste real mostrar QP
médio de 30-40 num jogo de movimento rápido a 10-15 Mbps, com encoder de hardware confirmado (sem
aviso de CPU) — sinal claro de que o teto de bitrate estava deixando o encoder "faminto" mesmo
tendo hardware de sobra pra codificar em bitrate mais alto. Isso ataca o sintoma (teto geral baixo
demais) mas não resolve a causa descrita abaixo (teto não varia por complexidade de cena) — só
empurra o teto pra cima globalmente, incluindo pra conteúdo estático que não precisava do aumento.

`getMaxBitrate()` calcula bitrate como `width * height * fps * BITS_PER_PIXEL`, um número fixo por frame independente do que está na tela. Isso funciona como teto de segurança, mas conteúdo real de screen share varia MUITO: uma apresentação de slides estáticos precisa de uma fração do bitrate que um jogo em movimento constante precisa, na mesma resolução. O WebRTC padrão já roda GCC (Google Congestion Control) por baixo, que adapta o bitrate real dentro do teto configurado conforme a rede — mas ele não sabe distinguir "tela parada, dá pra cair bitrate e ainda ficar nítido" de "tela em movimento, precisa do teto inteiro". Esse tipo de adaptação por *conteúdo* (não só por rede) é o que engines mais sofisticados como o do Discord costumam ter via VBR com controle de "complexidade de cena" no próprio encoder — fora do alcance de configuração exposta pelo WebRTC padrão, mas algo a manter em mente como teto do que dá pra otimizar sem sair de cima do LiveKit/WebRTC (que é uma restrição arquitetural explícita do projeto).

## 6. Keyframe interval nunca é ajustado — tela estática não precisa de keyframes frequentes

O GOP (intervalo entre keyframes) padrão do WebRTC é pensado pra vídeo de câmera com movimento constante. Screen share de conteúdo majoritariamente estático (código, documentos, apresentações) se beneficia de manter frames-chave mais espaçados — cada keyframe custa MUITO mais bits que um frame delta, e conteúdo parado gera deltas quase vazios de qualquer forma. O trade-off é replay/entrada de novo espectador (que precisa esperar o próximo keyframe ou pedir um via PLI, que o LiveKit já trata automaticamente) — mas para conteúdo majoritariamente parado, isso é uma troca favorável que hoje não é sequer considerada.

## 11. ✅ `degradationPreference: "balanced"` ainda deixava o encoder cair frame em jogos

**Corrigido pra `"maintain-framerate"`**, nos dois clientes, direto por causa do mesmo teste real
que revelou o problema do item 1. `"balanced"` deixa o encoder decidir dinamicamente entre resolução
e fluidez — na prática, ainda permitia queda de frame em cena de movimento rápido (Rocket League).
`"maintain-framerate"` nunca cai de FPS: reduz resolução primeiro se precisar economizar bits. Isso
bate direto com o que `CLAUDE.md` já definia como prioridade (jogos/suporte remoto precisam de
fluidez constante mais do que resolução máxima) — a config anterior não refletia isso de verdade.

## 7. ✅ Áudio (Opus) está no padrão do LiveKit — sem tuning específico pra screen share com música/jogo

**Implementado:** `audioPreset: AudioPresets.musicHighQualityStereo`, `dtx: false`, `red: true`,
`forceStereo: true` no publish de áudio, nos dois clientes.

`publishTrack` do áudio (`Track.Source.ScreenShareAudio`) não passava nenhuma opção de codec — ficava no default do Opus configurado pelo LiveKit (que já era `music`, não `speech` — mais correto do que o levantamento original supôs, mas ainda não o preset de maior qualidade). Pra áudio de sistema (jogos, música, notificação) em vez de voz, existe o modo "music"/full-band do Opus com bitrate mais alto e sem otimizações de voz (VAD, DTX agressivo) que cortam nuance de áudio não-vocal. O Discord distingue esse caso explicitamente. Hoje o projeto trata áudio de tela como "ligou ou não", sem diferenciar o tipo de conteúdo sonoro — não há coleta de dado nenhuma hoje que distinga os dois casos, então esse é mais um insight de "o que perguntar" do que "o que configurar".

## 8. Resolução de captura native, mas escala de simulcast é sempre por altura de captura — não pela tela do espectador real

`pickSimulcastLayers()` decide as camadas com base na altura capturada, nunca com base em quem está realmente assistindo. LiveKit já faz adaptive stream (reduz a camada entregue conforme o tamanho real do `<video>` no navegador do espectador — implementado em `adaptiveStream: true` nos hooks de viewer), então isso já está coberto do lado de quem assiste. O gap é do lado do host: hoje não há nenhum sinal de volta tipo "nenhum espectador está pedindo a camada de 1440p, pausa esse encode" além do que o `dynacast: true` já faz automaticamente — o que é bom, mas vale confirmar (via stats) que o dynacast está realmente pausando camadas ociosas na prática, não só na teoria.

## 9. Chroma subsampling 4:2:0 borra texto fino — limite conhecido, sem solução simples dentro de WebRTC padrão

Praticamente todo pipeline de hardware encoder consumido via WebRTC usa 4:2:0 (metade da resolução de cor em ambos os eixos). Pra vídeo de câmera isso é imperceptível; pra texto antialiased (a situação mais comum em screen share de código/terminal), a perda de resolução de crominância gera "sangramento" de cor nas bordas de caractere. Corrigir isso exigiria 4:4:4 (sem subsampling), que a maioria dos encoders de hardware de consumo não expõe via WebRTC de qualquer forma — é uma limitação de plataforma, não do código do projeto, mas vale documentar como teto de qualidade conhecido (o motivo de código continuar "levemente borrado" mesmo em bitrate alto).

## 10. ✅ Nenhuma telemetria de QP (quantization parameter) — hoje só se vê bitrate, não "o quanto o encoder está sofrendo"

**Implementado:** `avgQp` calculado a partir de `qpSum`/`framesEncoded` (delta desde a última
leitura, não média vitalícia) em `readPublishStats`, exibido como `QP N` nas estatísticas ao vivo
quando o browser expõe esses campos.

Bitrate alto não garante qualidade alta — se o encoder está comprimindo uma cena complexa, o mesmo bitrate pode sair com blocking visível (QP alto) ou limpo (QP baixo), dependendo da complexidade da cena. `getStats()` do WebRTC expõe `qpSum`/frames em alguns browsers, que dá pra usar pra calcular QP médio e detectar "essa transmissão está com blocking mesmo dentro do teto de bitrate configurado" — sinal que hoje simplesmente não existe na UI de estatísticas (`live-stats` mostra só bitrate/perda/codec). Seria o dado que faltava pra confirmar (ou refutar) empiricamente cada uma das hipóteses acima, em vez de ajustar às cegas.

## 12. ✅ `encoderImplementation` só era checado na camada "primária" — as camadas menores do simulcast podem estar em software sem ninguém saber

**Implementado:** `hasSoftwareLayer` em `PublishStats` checa `encoderImplementation` de todas as camadas do simulcast (`videoStats.some(...)`), não só a primária — o aviso de CPU agora dispara mesmo quando é só uma camada menor que caiu em software.

O fix de estatísticas (ver histórico) passou a escolher a camada de **maior resolução** entre as 3 do simulcast pra representar QP/bitrate/codec/encoder. Isso é certo pra mostrar "a qualidade que a maioria vê", mas esconde um cenário real: GPUs de consumo (NVIDIA não-Quadro, principalmente) historicamente limitam sessões de encode de hardware simultâneas (3 no driver padrão, sem patch). Publicar 3 camadas simulcast ao mesmo tempo é literalmente pedir 3 sessões de encode — se esse limite for atingido, o LiveKit/Chromium pode silenciosamente jogar uma ou duas camadas menores pra software, mesmo com a camada base em hardware. O aviso de CPU atual nunca veria isso, porque só olha a camada base. Vale expor (mesmo que só em log/estatística avançada) o `encoderImplementation` de **cada** camada, não só da primária.

## 13. ✅ Sem fallback (agora ação do usuário) quando o encoder de hardware fica sobrecarregado

**Implementado:** botão "⚡ Otimizar codec" nas estatísticas ao vivo, visível só quando o codec ativo é AV1 ou VP9 (os pesados) E está em software. Chama `switchToH264()` (`livekit.ts`/`publish.ts`), que despublica e republica a mesma `MediaStreamTrack` com `videoCodec: "h264"` forçado — sempre acionado pelo usuário, nunca sozinho.

Hoje, se o codec "preferencial" cai pra software (detectado via `encoderImplementation`), o app só avisa (⚠️ CPU) — não faz nada a respeito. Um patamar acima do aviso passivo: quando o software-encoder detectado for um dos pesados (`libaom`=AV1 ou `libvpx`=VP9, ambos MUITO mais caros em CPU que software H.264), oferecer (não forçar) uma ação de "trocar pra H.264 agora" que despublica e republica a mesma track já com `videoCodec: "h264"` forçado. Republicar já é um caminho testado no projeto (é basicamente o que `swapVideoTrack`/`swapAudioTrack` fazem pra troca de fonte) — a diferença aqui é trocar codec, não fonte. Vale como ação explícita do usuário (um botão "Otimizar codec" quando o aviso de CPU aparecer), não automático, porque troca de codec em pleno vivo causa um soluço visual pros espectadores (recomposição de tracks), e decisão automática silenciosa tira controle do usuário sobre quando aceitar esse custo.

## 14. 🟡 Sem telemetria de frame drop nem de "tempo de encode por frame" — QP não conta a história toda

**Parcial:** implementado `qualityLimitationReason` ("cpu"/"bandwidth"/"other"/"none", direto do Chromium — mais confiável que inferir pelo QP) e `avgEncodeMs` (tempo médio de encode por frame, indicador antecedente), ambos no tooltip do aviso de CPU. `framesDropped` **não** foi implementado — o campo é mais recente na spec de stats (`RTCVideoSourceStats`) e a disponibilidade cross-browser não foi validada; ficou de fora pra não adicionar um campo que talvez nunca reporte valor.

QP alto indica compressão agressiva, mas não indica frame **perdido** — são sintomas diferentes de "meu PC não aguenta". `outbound-rtp` também expõe `framesSent`/`totalEncodeTime` (tempo total gasto codificando) e o `RTCVideoSourceStats` associado expõe `framesDropped` (frames descartados antes mesmo de tentar codificar, tipicamente por saturação de CPU/fila de encode). Dois indicadores baratos de coletar que hoje não existem:
- `totalEncodeTime / framesEncoded` = tempo médio de encode por frame — comparado ao orçamento de frame (`1000 / fps` ms), avisa que o encoder tá "correndo contra o relógio" *antes* de frames começarem a cair de verdade (indicador antecedente, não reativo como o QP).
- `framesDropped` — confirma queda de frame real, direto na fonte, sem precisar inferir pelo FPS reportado no viewer (que já mistura causas de rede com causas de encode).

Isso teria ajudado a diagnosticar o caso do Rocket League com mais precisão (saber se era CPU/GPU saturada vs. rede vs. QP puro) em vez de inferir pelas descrições do usuário.

## 15. ✅ `detectBestVideoCodec()` cacheava a escolha pra sempre, mesmo entre transmissões diferentes

`cachedCodec` é uma variável de módulo (`let cachedCodec: VideoCodec | null = null`) — sobrevive entre múltiplas chamadas de `startBroadcast()` na mesma sessão do app (ex.: encerrar e começar uma nova transmissão, ou trocar de fonte). Isso é uma otimização razoável (evita rechecar `getCapabilities()` toda vez), mas significa que se o **primeiro** encoder escolhido na sessão acabou em software por qualquer motivo transitório (outro app segurando a GPU no momento, por exemplo), toda transmissão seguinte nessa mesma sessão do app herda essa escolha "ruim" sem re-tentar — mesmo que o motivo original já tenha passado. Resetar o cache ao final de cada transmissão (`disconnect()`) garantiria que cada nova sessão de live reavalia do zero.

---

**Resumo de prioridade de esforço vs impacto** (opinião, não prescrição):

1. `contentHint = "detail"` — mudança trivial, sem risco, ganho perceptível imediato em nitidez de texto.
2. Expor QP médio nas estatísticas — trivial de coletar, vira a base de dados pra validar tudo o resto.
3. Reavaliar a ladder de codec com dado real de `encoderImplementation` em vez de só uma vez no início.
4. Repensar simulcast fixo de 3 camadas vs encode único adaptativo, se o custo de CPU em host mais fraco virar reclamação recorrente.
5. Keyframe interval e tuning de Opus "music mode" — ganho real, mas dependem de quanto controle o LiveKit SDK expõe (precisa validar antes de assumir viável).
