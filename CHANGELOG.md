# Changelog

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
