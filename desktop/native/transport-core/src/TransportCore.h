#pragma once

#include <memory>
#include <string>
#include <functional>
#include <atomic>
#include <chrono>
#include <deque>
#include <mutex>
#include <rtc/rtc.hpp>
#include "VideoCodecType.h"

// Camada baixa de WebRTC (Fase 4, ver docs/NATIVE_CAPTURE.md) via libdatachannel — ICE,
// DTLS-SRTP/SCTP. NÃO faz SFU nem sinalização própria (isso é responsabilidade de código acima
// desta classe, do lado do backend/main process) — aqui só existe UMA PeerConnection ponto a
// ponto, entre o host e UM espectador. Distribuir pra vários espectadores (SFU) significa criar
// uma instância de TransportCore por espectador conectado.
//
// Vídeo vai por DATACHANNEL (SCTP confiável), NÃO por RTP media track — decisão revisada depois
// de achar um bug real na `PacingHandler` do libdatachannel v0.23.2 vendorizado (condição
// invertida em `schedule()`, trava ~1 a cada 2 frames enviados, indetectável de fora da lib — ver
// histórico de TransportCore.cpp). Referência: projeto SlipStream (mesma stack — libdatachannel +
// NVENC + WebCodecs no cliente) usa exatamente esse caminho, evitando a camada RTP/RTCP inteira
// (packetizer, pacing, NACK, PLI) — SCTP já garante entrega em ordem sem pacote perdido, o cliente
// decodifica os chunks H.264 crus direto com `VideoDecoder` (WebCodecs), sem jitter buffer de RTP
// no meio. Efeito colateral bom: elimina a classe inteira de bug que a gente caçou hoje.
class TransportCore {
public:
    TransportCore();
    ~TransportCore();

    // `stunUrls` no formato "stun:host:port" (CLAUDE.md §Infraestrutura já prevê STUN/TURN).
    // `codec` precisa bater com o que o EncoderCore realmente ativou (`GetActiveCodec()`) — usado
    // só pra saber como detectar keyframe no bitstream em `SendVideoFrame` (NAL de 1 byte tipo 5
    // no H.264 vs cabeçalho de 2 bytes com tipo IRAP 16-23 no HEVC).
    bool Initialize(const std::vector<std::string>& stunUrls, VideoCodecType codec = VideoCodecType::H264);

    // Chamado quando o ICE termina de gatherar candidatos e o SDP local fica pronto pra ser
    // mandado pro espectador via sinalização (fora desta classe).
    void OnLocalDescription(std::function<void(const std::string& sdp, const std::string& type)> callback);
    void OnLocalCandidate(std::function<void(const std::string& candidate, const std::string& mid)> callback);
    void OnStateChange(std::function<void(const std::string& state)> callback);
    // Disparado quando o DataChannel de vídeo abre de verdade (handshake SCTP completo) — usado
    // pra forçar um keyframe no primeiro frame enviado (WebCodecs exige que o PRIMEIRO chunk
    // decodificado seja tipo "key"; sem isso, se o canal abrir no meio de um GOP, o primeiro chunk
    // que chega pode ser um P-frame e o decoder rejeita).
    void OnChannelOpen(std::function<void()> callback);

    // Cria o canal de dados "video" — precisa ser chamado ANTES de CreateOffer().
    bool AddVideoChannel();

    // Canal de dados "audio" (Opus), mesmo raciocínio do de vídeo — SCTP confiável/ordenado,
    // sem RTP/jitter buffer nativo. Opcional: só existe se o áudio nativo estiver ativo (ver
    // main/index.ts) — sessão continua funcionando só com vídeo se isso nunca for chamado.
    bool AddAudioChannel();

    // Inicia a negociação (host sempre oferece, espectador sempre responde — mais simples que
    // permitir os dois papéis, e o único caso de uso real aqui).
    bool CreateOffer();

    bool SetRemoteDescription(const std::string& sdp, const std::string& type);
    bool AddRemoteCandidate(const std::string& candidate, const std::string& mid);

    // Manda um frame H.264 Annex-B (saída do EncoderCore) já com um cabeçalho pequeno na frente
    // (tipo + timestamp) pro cliente reconstruir o `EncodedVideoChunk` do WebCodecs — ver
    // TransportCore.cpp. Detecta sozinho se é keyframe (procura NAL tipo 5 no bitstream).
    //
    // Retorna `false` também quando o frame foi DESCARTADO de propósito por congestionamento (ver
    // "Controle de latência" abaixo) — não é erro, é o mecanismo que impede a latência de crescer
    // sem limite num canal confiável.
    bool SendVideoFrame(const uint8_t* data, size_t size, uint64_t timestampUs);

    // Controle de latência (bug real: SCTP é confiável/ordenado, então quando a rede do espectador
    // não escoa o bitrate, NADA é perdido — tudo enfileira, e a latência cresce sem limite. Pior: com
    // `maxMessageSize` de 4MB, o libdatachannel sobe o SO_SNDBUF do usrsctp pra 4MB também, e esse
    // buffer interno NÃO aparece no `bufferedAmount()` — até ~4s de vídeo represado invisível pro
    // AIMD antigo). Agora o espectador confirma (ack) cada frame recebido pelo próprio canal de
    // vídeo (`[8 bytes: timestamp]`); com isso o host mede a idade do frame mais antigo ainda não
    // confirmado — RTT + fila de verdade, independente de onde a fila está. Passou do limite →
    // descarta frames novos dessa sessão até a fila escoar e então pede um keyframe pra ela voltar
    // limpa (descartar P-frame quebraria a referência do decoder). Espectador antigo sem ack: cai
    // pro `bufferedAmount()` como antes.
    //
    // O espectador também pode pedir keyframe explicitamente (`[1 byte: 'K']`, decoder reiniciado
    // depois de erro) — com GOP infinito (EncoderCore.cpp) não existe mais IDR periódico pra se
    // recuperar sozinho.
    //
    // `true` = essa sessão precisa de um keyframe do encoder do tier dela agora (consome o pedido).
    // Rate-limited por sessão — espectador com problema não força IDR em loop pra todo o tier.
    bool ConsumeKeyframeRequest();

    // Atraso extra da fila (ms) acima do RTT mínimo observado — 0 sem feedback de ack ainda.
    // Sinal de congestionamento pro AIMD (main/index.ts), bem mais direto que `bufferedAmount()`.
    double GetQueueDelayMs();

    // Frames descartados por congestionamento desde a última chamada (zera ao ler).
    uint32_t TakeDroppedFrames();

    // Manda um pacote Opus cru (10ms, 48kHz) — formato no canal: [8 bytes: timestamp µs][payload
    // Opus cru]. Sem byte de tipo key/delta (Opus não tem GOP/keyframe como vídeo, todo pacote se
    // decodifica sozinho a partir do próximo, só perde qualidade momentânea se um pacote se perder
    // — mas SCTP já garante entrega, então isso nem chega a importar na prática).
    bool SendAudioFrame(const uint8_t* data, size_t size, uint64_t timestampUs);

    bool IsConnected() const;

    // Bytes ainda represados no buffer de envio SCTP desse canal, esperando a rede escoar — sinal
    // de congestionamento (ver docs/NATIVE_CAPTURE.md Fase 4 "Congestion control"): sem RTP/REMB
    // nesse caminho (vídeo vai por DataChannel, não media track — ver comentário no topo da
    // classe), `bufferedAmount()` do próprio SCTP é o substituto natural. Cresce = rede não tá
    // escoando os frames na velocidade que o encoder produz.
    size_t GetBufferedAmount() const;

private:
    struct InflightFrame {
        uint64_t timestampUs;
        std::chrono::steady_clock::time_point sentAt;
    };

    void HandleVideoChannelMessage(const rtc::binary& data);
    // Idade do frame mais antigo ainda sem ack menos o RTT mínimo — chamar com `feedbackMutex_`.
    double ExtraDelayMsLocked(std::chrono::steady_clock::time_point now) const;

    std::shared_ptr<rtc::PeerConnection> pc_;
    std::shared_ptr<rtc::DataChannel> videoChannel_;
    std::shared_ptr<rtc::DataChannel> audioChannel_;
    std::function<void()> channelOpenCallback_;
    VideoCodecType codec_ = VideoCodecType::H264;

    // Feedback de ack — escrito pela thread do libdatachannel (onMessage), lido pela thread JS.
    std::mutex feedbackMutex_;
    std::deque<InflightFrame> inflight_;
    bool feedbackSeen_ = false;
    // RTT mínimo em janela deslizante de 2 períodos (mínimo de `minRttPrev`/`minRttCur`) — segue
    // mudança de rota pra cima sem ficar preso pra sempre num mínimo antigo.
    double minRttCurMs_ = 1e9;
    double minRttPrevMs_ = 1e9;
    std::chrono::steady_clock::time_point minRttWindowStart_{};

    std::atomic<bool> viewerKeyframeRequest_{false};
    // Só a thread JS (SendVideoFrame/ConsumeKeyframeRequest) toca nesses.
    // Começa `true`: nenhuma sessão recebe P-frame antes do primeiro keyframe (o decoder do
    // espectador rejeitaria de qualquer jeito).
    bool waitingKeyframe_ = true;
    bool pendingKeyframeRequest_ = false;
    std::chrono::steady_clock::time_point lastKeyframeRequestAt_{};
    uint32_t droppedFrames_ = 0;
};
