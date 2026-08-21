# Projeto: Aplicação desktop de compartilhamento de tela

## Objetivo

Criar uma aplicação desktop dedicada exclusivamente ao compartilhamento de tela em tempo real.

O produto deve ser uma alternativa extremamente simples ao compartilhamento de tela do Discord, sem chamadas de voz, mensagens, servidores, canais ou outras funcionalidades de comunicação.

O objetivo principal é:

> Uma pessoa abre o aplicativo no Windows, compartilha sua tela e outras pessoas assistem à transmissão em tempo real através de um link.

O aplicativo principal deve ser compilado como um executável Windows `.exe`.

O usuário que transmite deve instalar e executar o aplicativo desktop.

Os espectadores não devem ser obrigados a instalar o aplicativo. Preferencialmente, devem conseguir assistir à transmissão diretamente pelo navegador através de um link.

## Plataforma principal

A primeira plataforma oficial será:

* Windows 10/11
* Aplicação desktop distribuída como `.exe`

A arquitetura deve ser preparada para futuramente suportar:

* Windows
* Linux
* macOS

A tecnologia escolhida para o aplicativo desktop é:

* Tauri
* Rust
* React
* TypeScript

O frontend será responsável pela interface e pela maior parte da lógica de aplicação.

O Rust/Tauri será utilizado quando for necessário acesso a recursos nativos do sistema operacional, especialmente captura de tela, janelas, monitores, integração com GPU e outras funcionalidades que não sejam adequadamente atendidas pelo navegador.

## Experiência esperada

O fluxo principal deve ser extremamente simples.

### Host

O usuário instala:

```text
ScreenShare.exe
```

Abre o aplicativo e encontra:

```text
┌──────────────────────────────────┐
│                                  │
│          ScreenShare             │
│                                  │
│      Compartilhe sua tela        │
│                                  │
│      [ Compartilhar tela ]       │
│                                  │
└──────────────────────────────────┘
```

Ao clicar em compartilhar:

```text
┌──────────────────────────────────┐
│       Compartilhar tela          │
│                                  │
│ Monitor                          │
│ ○ Monitor 1                      │
│ ○ Monitor 2                      │
│                                  │
│ Janela                           │
│ ○ Chrome                         │
│ ○ VS Code                        │
│ ○ Jogo                           │
│                                  │
│ Qualidade                        │
│ [ Automática ▼ ]                 │
│                                  │
│ FPS                              │
│ [ 60 FPS ▼ ]                     │
│                                  │
│        [ Iniciar ]               │
└──────────────────────────────────┘
```

Após iniciar:

```text
Sua transmissão está ativa.

Link para compartilhar:

https://app.com/s/AbC123

[ Copiar link ]

Espectadores: 2

[ Encerrar transmissão ]
```

## Espectador

O espectador recebe o link:

```text
https://app.com/s/AbC123
```

Pode abrir no navegador.

Não deve ser necessário instalar o aplicativo para assistir.

Exemplo:

```text
┌───────────────────────────────────────────┐
│                                           │
│                                           │
│             TRANSMISSÃO                   │
│                                           │
│                                           │
└───────────────────────────────────────────┘

3840 × 2160 • 60 FPS

[ Tela cheia ] [ Qualidade ]
```

## Arquitetura

Utilizar WebRTC como tecnologia principal para transmissão de vídeo.

Não transmitir frames manualmente utilizando:

* WebSocket
* HTTP
* JPEG
* PNG
* Base64
* polling

WebSocket/HTTP pode ser utilizado para comunicação de controle quando necessário.

Para distribuição para múltiplos espectadores, utilizar arquitetura baseada em SFU.

A tecnologia preferencial para SFU é LiveKit.

Arquitetura:

```text
                    WINDOWS HOST
                         │
                         │
                 ScreenShare.exe
                         │
                    Tauri + Rust
                         │
                    React + TS
                         │
                    WebRTC
                         │
                         ▼
                  ┌─────────────┐
                  │   LiveKit   │
                  │     SFU     │
                  └──────┬──────┘
                         │
             ┌───────────┼───────────┐
             ▼           ▼           ▼
         Browser      Browser      Browser
         Viewer       Viewer       Viewer
```

## Stack

### Desktop

* Tauri
* Rust
* React
* TypeScript
* Vite

O resultado do build deve ser um aplicativo Windows distribuível como `.exe`.

Dependendo da configuração de distribuição, também pode ser gerado um instalador Windows.

O projeto deve ser preparado para gerar builds de produção.

## Backend

Utilizar:

* Node.js
* TypeScript
* Fastify
* LiveKit Server SDK

Responsabilidades:

* criação de salas
* geração de tokens
* autenticação
* autorização
* gerenciamento de sessões
* comunicação com LiveKit
* informações básicas da transmissão

O backend não deve processar os frames da transmissão.

O vídeo deve permanecer no pipeline WebRTC/LiveKit.

## Infraestrutura

Utilizar:

* LiveKit
* STUN
* TURN
* PostgreSQL quando persistência for necessária
* Redis quando necessário para escalabilidade

O backend e o LiveKit devem ser separados conceitualmente.

## Captura de tela

O aplicativo desktop deve permitir:

* capturar monitor inteiro
* capturar janela específica
* capturar uma fonte específica
* futuramente capturar jogos de maneira otimizada

A implementação deve priorizar APIs nativas quando elas oferecerem melhor performance do que `getDisplayMedia()`.

No modo web, espectadores não precisam utilizar captura de tela.

## Qualidade

A aplicação deve ser projetada desde o início para suportar:

* 720p
* 1080p
* 1440p
* 2160p 4K

E:

* 30 FPS
* 60 FPS

Perfis esperados:

```text
720p30
1080p30
1080p60
1440p60
2160p30
2160p60
```

A resolução e o FPS efetivos dependem do hardware, encoder, sistema operacional, navegador, rede e infraestrutura.

O aplicativo nunca deve assumir que 4K60 está disponível.

## Seleção de qualidade

O host deve conseguir selecionar:

### Resolução

* Automática
* 720p
* 1080p
* 1440p
* 2160p

### FPS

* Automático
* 30 FPS
* 60 FPS

### Qualidade

* Automática
* Baixa
* Média
* Alta
* Máxima

A arquitetura deve permitir adicionar posteriormente controles avançados.

## Bitrate

O sistema deve permitir controle de bitrate.

O bitrate deve considerar:

* resolução
* FPS
* codec
* largura de banda
* congestionamento
* qualidade desejada
* capacidade do encoder

O sistema deve ser preparado para bitrate adaptativo.

Não utilizar valores rígidos espalhados pelo código.

Os perfis de transmissão devem ser centralizados e configuráveis.

## Codecs

A aplicação deve ser preparada para codecs modernos.

Prioridade:

1. AV1
2. VP9
3. H.264
4. VP8

O sistema deve detectar suporte do hardware e software.

Caso o codec preferencial não esteja disponível, deve utilizar fallback automaticamente.

O aplicativo deve priorizar hardware encoding quando disponível.

Especialmente para:

* 1080p60
* 1440p60
* 4K30
* 4K60

O objetivo é evitar consumo excessivo de CPU.

## GPU e hardware encoding

Como o aplicativo principal será desktop, deve ser projetado para aproveitar hardware disponível.

Quando possível, utilizar:

* NVIDIA NVENC
* AMD hardware encoder
* Intel Quick Sync
* outros encoders disponíveis no sistema

Não assumir que uma GPU específica estará presente.

Deve existir fallback para software encoding quando necessário.

## Simulcast / SVC

A arquitetura deve permitir utilização de simulcast ou SVC.

O objetivo é permitir que diferentes espectadores recebam qualidades diferentes.

Exemplo:

```text
                    HOST
                     │
              ┌──────┴──────┐
              │             │
            720p          1080p
              │             │
              └──────┬──────┘
                     ▼
                   SFU
                /    |    \
               /     |     \
          Viewer A Viewer B Viewer C
           720p     1080p    1080p
```

## Latência

A aplicação deve priorizar baixa latência.

O objetivo é que a transmissão seja adequada para:

* jogos
* demonstração de software
* suporte remoto
* apresentações
* assistir alguém utilizando o computador

Evitar arquiteturas baseadas em streaming tradicional com grande buffer.

WebRTC deve ser utilizado justamente para manter a latência baixa.

## Estatísticas

O host e/ou espectador devem futuramente poder visualizar:

* resolução atual
* FPS atual
* bitrate
* codec
* latência
* perda de pacotes
* jitter
* frames perdidos
* estado da conexão

Exemplo:

```text
3840 × 2160
60 FPS
AV1
24.5 Mbps
48 ms
0.1% packet loss
```

Isso será especialmente importante para diagnosticar problemas de transmissão.

## Salas

Cada transmissão possuirá uma sala única.

Exemplo:

```text
https://app.com/s/AbC123
```

A sala deverá possuir:

* ID único
* host
* espectadores
* estado
* configurações
* token de acesso

As salas devem ser temporárias por padrão.

Não criar servidores permanentes ou comunidades.

Quando a transmissão terminar, a sala pode ser destruída.

## Segurança

Implementar:

* IDs de sala criptograficamente seguros
* tokens temporários
* autenticação do host
* autorização de espectadores
* expiração de tokens
* rate limiting
* validação das entradas
* proteção das APIs

Nunca expor:

* LiveKit API secret
* credenciais privadas
* tokens administrativos

no frontend ou no aplicativo de maneira insegura.

## Interface

A interface deve ser minimalista.

O aplicativo não deve tentar imitar toda a interface do Discord.

A experiência principal deve ser:

```text
Abrir aplicativo
       ↓
Compartilhar tela
       ↓
Selecionar qualidade
       ↓
Gerar link
       ↓
Copiar link
       ↓
Transmitir
```

## Estrutura do projeto

A estrutura inicial deve ser:

```text
screen-share/
│
├── desktop/
│   ├── src/
│   │   ├── components/
│   │   ├── pages/
│   │   ├── hooks/
│   │   ├── services/
│   │   ├── types/
│   │   └── main.tsx
│   │
│   ├── src-tauri/
│   │   ├── src/
│   │   ├── Cargo.toml
│   │   └── tauri.conf.json
│   │
│   └── package.json
│
├── viewer/
│   ├── src/
│   │   ├── components/
│   │   ├── pages/
│   │   ├── hooks/
│   │   ├── services/
│   │   └── main.tsx
│   │
│   └── package.json
│
├── backend/
│   ├── src/
│   │   ├── routes/
│   │   ├── services/
│   │   ├── types/
│   │   ├── utils/
│   │   ├── config.ts
│   │   └── server.ts
│   │
│   └── package.json
│
├── infra/
│   ├── livekit/
│   └── docker/
│
├── .env.example
├── docker-compose.yml
└── README.md
```

## Separação entre Desktop e Viewer

O projeto deve possuir dois clientes.

### Desktop

Aplicativo Windows:

```text
ScreenShare.exe
```

Responsável por:

* captura da tela
* seleção de monitor
* seleção de janela
* configuração de resolução
* configuração de FPS
* encoder
* transmissão
* criação da sala
* gerenciamento do host

### Viewer

Aplicação web.

Responsável por:

* entrar em uma sala
* receber o stream WebRTC
* reproduzir o vídeo
* tela cheia
* seleção de qualidade
* estatísticas

O espectador não precisa instalar o aplicativo desktop.

## Fases de desenvolvimento

### Fase 1 — MVP desktop

Implementar:

* Tauri
* React
* TypeScript
* Rust
* backend Node
* LiveKit
* criação de sala
* geração de token
* captura de tela
* transmissão
* link da sala
* viewer web
* encerramento da transmissão

Objetivo:

> abrir o `.exe`, compartilhar a tela e assistir através de um navegador.

### Fase 2 — Qualidade

Implementar:

* 1080p
* 30 FPS
* 60 FPS
* seleção de resolução
* seleção de FPS
* estatísticas
* reconexão
* controle de bitrate

### Fase 3 — Alta qualidade

Implementar:

* 1440p
* 4K
* 4K60
* AV1
* VP9
* H.264
* hardware encoding
* simulcast/SVC
* adaptação automática

### Fase 4 — Otimização desktop

Investigar e implementar:

* captura nativa otimizada
* captura de jogos
* captura de janela otimizada
* integração com GPU
* hardware encoders
* redução de uso de CPU
* redução de latência
* otimizações específicas para Windows

### Fase 5 — Distribuição

Preparar:

* build `.exe`
* instalador Windows
* atualização automática
* assinatura do aplicativo
* builds de produção
* versões Windows x64
* futuramente ARM64 se necessário

## Princípios de desenvolvimento

Utilizar TypeScript strict.

Evitar `any`.

Manter separação clara entre:

* UI
* lógica de transmissão
* comunicação com backend
* LiveKit
* captura
* configurações
* estatísticas

O Rust deve ser utilizado para funcionalidades realmente nativas.

Não mover lógica desnecessariamente para Rust apenas por utilizar Tauri.

O projeto deve evitar complexidade prematura.

Implementar primeiro o caminho mínimo funcional e posteriormente adicionar recursos avançados.

## Regra importante sobre WebRTC

Não implementar um SFU próprio.

Não implementar manualmente:

* congestion control
* retransmission
* NAT traversal
* simulcast
* gerenciamento de peers
* signaling complexo
* adaptação de bitrate

Quando possível, utilizar LiveKit e as APIs WebRTC existentes.

O objetivo do projeto é construir um produto de compartilhamento de tela, não reinventar a infraestrutura WebRTC.

## Resultado final esperado

O produto final deve ser um aplicativo Windows `.exe` que permita:

1. Abrir o aplicativo.
2. Selecionar o monitor ou janela.
3. Escolher resolução.
4. Escolher FPS.
5. Iniciar a transmissão.
6. Receber um link.
7. Compartilhar o link.
8. Permitir que outras pessoas assistam pelo navegador.
9. Transmitir com baixa latência.
10. Suportar Full HD, 1440p e 4K.
11. Suportar 30 e 60 FPS.
12. Utilizar codecs modernos.
13. Aproveitar hardware encoding quando possível.
14. Adaptar a qualidade conforme as condições da conexão.

A experiência deve ser simples:

> **Abrir `.exe` → compartilhar tela → copiar link → transmitir.**
