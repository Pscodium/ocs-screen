# Changelog

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
