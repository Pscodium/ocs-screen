# Changelog

## 1.5.2 — 2026-11-09

### Correções
- **Transmissão em placas AMD, de novo.** A correção da 1.5.1 não bastou: em algumas placas AMD o espectador ainda via só o primeiro quadro. O app agora conversa com o encoder da placa do jeito que ela espera.
- **Recuperação automática que funciona de verdade.** Se o encoder da placa de vídeo parar de entregar imagem, o app troca sozinho pro encoder por CPU em poucos segundos, em vez de ficar tentando a placa travada. A transmissão continua, só um pouco mais pesada pro computador.

## 1.5.1 — 2026-11-09

### Correções
- **Transmissão travada em placas AMD (e Intel).** Em alguns PCs com placa de vídeo AMD, o espectador via só o primeiro quadro e depois a imagem congelava, com o aviso "reiniciando o encoder". O encoder de vídeo da placa agora recebe os quadros direito e a transmissão segue normal.

## 1.5.0 — 2026-11-08

### Novidades
- **Seu nome no aviso do Discord.** Nova seção "Configuração" com um apelido e a opção "Mostrar meu nome no aviso do Discord" (desligada por padrão). Ligada, a mensagem que o bot manda pros inscritos diz quem começou a transmissão. O botão "Usar do Discord" preenche o apelido com o nome da sua conta do Discord aberta no PC.

## 1.4.1 — 2026-11-08

### Novidades
- **Sua transmissão aparece no Discord.** Enquanto você transmite, seu perfil mostra "Jogando OCS Screen · Transmitindo tela", quantas pessoas estão assistindo e um botão "Assistir transmissão" que abre o link pra quem clicar. Funciona com o Discord desktop aberto no mesmo PC.

## 1.4.0 — 2026-11-08

### Novidades
- **Relatórios de erro automáticos.** Se o app fechar por um erro, ele envia um relatório técnico
  pra gente identificar e corrigir o problema mais rápido. Dá pra desligar a qualquer momento no
  menu do ícone da bandeja, em "Enviar relatórios de erro".

## 1.3.0 — 2026-11-07

### Novidades
- **Menu da bandeja completo.** Com a transmissão no ar, o ícone da bandeja mostra quantas pessoas
  estão assistindo e permite copiar o link, voltar ao card ou encerrar a transmissão sem abrir o app.
- **Minimizar manda pra bandeja.** Minimizar o card da transmissão esconde o app na bandeja e a
  transmissão continua; um aviso mostra onde ele foi parar.
- **Seu nome do Windows como nome da sala.** Uma opção ao lado de "Nome da sala" usa o nome do seu
  perfil do Windows no link. Fica desligada até você ligar, e o app lembra a escolha.

### Melhorias
- **Logo na bandeja.** O ícone do app voltou a aparecer na bandeja do Windows.
- **Versão visível.** A versão instalada aparece ao lado do nome do app, no topo da janela.

## 1.2.0 — 2026-11-07

### Novidades
- **Aviso de atualização também na Microsoft Store.** Quem instalou pela Store agora é avisado
  quando sai versão nova, com a lista de mudanças e um botão que abre a Store pra atualizar.
- **Atualização obrigatória.** Quando uma versão antiga deixar de ser suportada, o app avisa e
  pede pra atualizar antes de transmitir, em vez de falhar sem explicação.

### Melhorias
- **Janela de atualização maior.** A lista de novidades ficou mais fácil de ler e mostra de qual
  versão pra qual você está atualizando.

### Correções
- **Sua transmissão ficou mais protegida.** Só quem criou a sala consegue encerrá-la ou transmitir
  nela; antes, outra pessoa com o link podia derrubar ou assumir a transmissão.
- **Links abertos pelo app vão sempre pro navegador.** O app não abre mais outros tipos de link
  que poderiam iniciar programas do computador.

## 1.1.1 — 2026-11-06

### Correções
- **Botão "Assistir" voltou pra dentro do card.** Na aba "Ao vivo agora", o botão podia ficar
  cortado pra fora do card quando a transmissão tinha várias informações; agora quebra a linha.

## 1.1.0 — 2026-11-05

### Novidades
- **Recuperação automática quando o vídeo trava.** Se alguém entra na sua transmissão e o vídeo
  não chega até a pessoa porque o encoder da placa de vídeo parou de responder, o app tenta sozinho:
  reinicia o encoder, troca pro encoder alternativo da placa e, em último caso, usa o processador.
  Na maioria dos casos a transmissão volta sem você precisar encerrar.
- **Aviso no painel ao vivo.** Quando um espectador está conectado mas sem receber vídeo, o painel
  mostra um aviso amarelo explicando o que está acontecendo (e o que fazer, se não resolver sozinho).
- **Origem nas transmissões ao vivo.** A aba "Ao vivo agora" mostra se cada transmissão vem do
  app ou do navegador.

### Melhorias
- **Espectadores reconectam sozinhos.** Se a sua conexão cair e voltar, quem está assistindo
  continua na transmissão sem precisar recarregar a página.
- **Mensagem de erro mais clara pra quem assiste.** Quando o vídeo não chega por um problema do
  lado de quem transmite, o espectador vê isso, em vez de achar que o navegador dele não é suportado.
- **Diagnóstico de falhas.** Quando uma transmissão falha, o app envia um relatório técnico curto
  (sem nenhum conteúdo da tela) que ajuda a encontrar a causa de problemas que só acontecem com
  algumas pessoas.

## 1.0.15 — 2026-11-01

### Novidades
- **App redesenhado, abre direto no compartilhamento.** Acabou a tela inicial: o app já abre com as
  configurações de qualidade e sala de um lado e as telas/janelas do outro — um clique e a
  transmissão começa. Visual igual ao do site.
- **Aba "Ao vivo agora".** As transmissões públicas aparecem em cards com quem está ao vivo, há
  quanto tempo, resolução/FPS e número de espectadores. Clicar abre a transmissão numa janela do app.
- **Preview da sua transmissão.** O botão de olho no painel ao vivo mostra uma miniatura do que está
  saindo, sem pesar na transmissão. "Ampliar" abre em tela maior, do jeito que o espectador vê.
- **Painel ao vivo com mais informações.** Tempo no ar, espectadores, resolução, FPS, bitrate e
  codec sempre visíveis, além de avisos de sala com senha/privada e de áudio ligado.

### Melhorias
- **Seletor de telas mais leve.** As miniaturas carregam mais rápido e o app não fica atualizando
  nada em segundo plano quando você está em outra aba ou com ele minimizado.

### Correções
- **Transmissão podia cair pro modo compatível ao iniciar** se a lista de telas estivesse
  atualizando bem na hora do clique. Agora a lista pausa enquanto a transmissão começa.

### Observações
- A partir desta versão o app também está na **Microsoft Store** com o nome **OCS Screen**.

## 1.0.13 — 2026-10-17

### Melhorias
- **Espectadores sem suporte a HEVC/AV1 não derrubam mais os outros.** Antes, quando entrava
  alguém que não conseguia decodificar o codec da transmissão, todo mundo reconectava e a live
  inteira caía pra H.264. Agora só esse espectador recebe uma versão em H.264, e quem já estava
  assistindo continua no codec original, sem interrupção.
- **A transmissão sobrevive a um reinício do driver de vídeo.** Quando a GPU reinicia por
  sobrecarga (comum jogando algo pesado), o app reconecta a captura sozinho em poucos segundos,
  em vez de encerrar a live. Os espectadores continuam conectados. Durante a reconexão aparece um
  aviso no painel da transmissão.
- **Qualidade volta mais rápido depois de oscilação de rede.** Depois de uma queda de conexão, a
  qualidade sobe de volta ao máximo em cerca de 15 segundos (antes levava uns 45).

### Correções
- **PC mais fraco caía pra 15 FPS quando outro espectador entrava.** Um notebook simples que
  assistia a 60 FPS sozinho passava pra qualidade baixa assim que um PC mais forte abria a mesma
  live, e ficava preso nela. Agora a qualidade só baixa depois de problema contínuo de alguns
  segundos, e volta pra alta sozinha quando a conexão estabiliza.

### Observações
- Se a GPU reiniciar e o app não conseguir reconectar em cerca de 10 segundos, a transmissão
  ainda é encerrada, como antes.
- Se a GPU não suportar mais um encoder simultâneo, o app volta ao comportamento antigo:
  a transmissão inteira passa pra H.264.
