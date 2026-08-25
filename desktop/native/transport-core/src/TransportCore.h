#pragma once

#include <memory>
#include <string>
#include <functional>
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

    // Inicia a negociação (host sempre oferece, espectador sempre responde — mais simples que
    // permitir os dois papéis, e o único caso de uso real aqui).
    bool CreateOffer();

    bool SetRemoteDescription(const std::string& sdp, const std::string& type);
    bool AddRemoteCandidate(const std::string& candidate, const std::string& mid);

    // Manda um frame H.264 Annex-B (saída do EncoderCore) já com um cabeçalho pequeno na frente
    // (tipo + timestamp) pro cliente reconstruir o `EncodedVideoChunk` do WebCodecs — ver
    // TransportCore.cpp. Detecta sozinho se é keyframe (procura NAL tipo 5 no bitstream).
    bool SendVideoFrame(const uint8_t* data, size_t size, uint64_t timestampUs);

    bool IsConnected() const;

    // Bytes ainda represados no buffer de envio SCTP desse canal, esperando a rede escoar — sinal
    // de congestionamento (ver docs/NATIVE_CAPTURE.md Fase 4 "Congestion control"): sem RTP/REMB
    // nesse caminho (vídeo vai por DataChannel, não media track — ver comentário no topo da
    // classe), `bufferedAmount()` do próprio SCTP é o substituto natural. Cresce = rede não tá
    // escoando os frames na velocidade que o encoder produz.
    size_t GetBufferedAmount() const;

private:
    std::shared_ptr<rtc::PeerConnection> pc_;
    std::shared_ptr<rtc::DataChannel> videoChannel_;
    std::function<void()> channelOpenCallback_;
    VideoCodecType codec_ = VideoCodecType::H264;
};
