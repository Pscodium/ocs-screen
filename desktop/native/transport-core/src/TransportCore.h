#pragma once

#include <memory>
#include <string>
#include <functional>
#include <rtc/rtc.hpp>

// Camada baixa de WebRTC (Fase 4, ver docs/NATIVE_CAPTURE.md) via libdatachannel — ICE,
// DTLS-SRTP, RTP/RTCP. NÃO faz SFU nem sinalização própria (isso é responsabilidade de código
// acima desta classe, do lado do backend/main process) — aqui só existe UMA PeerConnection ponto
// a ponto, entre o host e UM espectador. Distribuir pra vários espectadores (SFU) significa criar
// uma instância de TransportCore por espectador conectado.
class TransportCore {
public:
    TransportCore();
    ~TransportCore();

    // `stunUrls` no formato "stun:host:port" (CLAUDE.md §Infraestrutura já prevê STUN/TURN).
    bool Initialize(const std::vector<std::string>& stunUrls);

    // Chamado quando o ICE termina de gatherar candidatos e o SDP local fica pronto pra ser
    // mandado pro espectador via sinalização (fora desta classe).
    void OnLocalDescription(std::function<void(const std::string& sdp, const std::string& type)> callback);
    void OnLocalCandidate(std::function<void(const std::string& candidate, const std::string& mid)> callback);
    void OnStateChange(std::function<void(const std::string& state)> callback);
    // PLI (Picture Loss Indication) — o espectador perdeu referência de decode (pacote
    // corrompido/perdido além do que NACK recupera) e está pedindo um keyframe novo AGORA, não no
    // próximo do GOP normal. Sem repassar isso pro encoder, o vídeo trava/corrompe visivelmente
    // até o próximo keyframe agendado (medido em teste: pipeline funcionando mas "travadona,
    // passando frames de tempos em tempos" — GOP de 2s sem resposta a PLI nenhuma).
    void OnPliRequest(std::function<void()> callback);

    // Cria a track de vídeo H.264 — precisa ser chamado ANTES de CreateOffer(). `bitrateBps`
    // alimenta o `PacingHandler` (ver TransportCore.cpp) — sem pacing, um frame codificado inteiro
    // (que pode ser bem grande, principalmente um keyframe) sai como uma rajada de vários pacotes
    // RTP de uma vez só, o que estoura buffer de rede/NIC e causa perda em cadeia (medido em
    // teste: vídeo "travadão", chegando só de vez em quando mesmo com PLI/keyframe funcionando).
    bool AddVideoTrack(int bitrateBps);

    // Inicia a negociação (host sempre oferece, espectador sempre responde — mais simples que
    // permitir os dois papéis, e o único caso de uso real aqui).
    bool CreateOffer();

    bool SetRemoteDescription(const std::string& sdp, const std::string& type);
    bool AddRemoteCandidate(const std::string& candidate, const std::string& mid);

    // Empacota (H.264 Annex-B → RTP, via packetizer da própria libdatachannel) e envia um frame já
    // codificado (saída do EncoderCore) pro espectador conectado.
    bool SendVideoFrame(const uint8_t* data, size_t size, uint32_t timestampRtp);

    bool IsConnected() const;

private:
    std::shared_ptr<rtc::PeerConnection> pc_;
    std::shared_ptr<rtc::Track> videoTrack_;
    std::shared_ptr<rtc::RtcpSrReporter> rtcpSrReporter_;
    // Guardado à parte (não fixado na construção do PliHandler) pra `OnPliRequest` poder ser
    // chamado antes OU depois de `AddVideoTrack` sem depender de ordem — o PliHandler sempre lê
    // isso na hora que um PLI chega de verdade, não na hora que é criado.
    std::function<void()> pliCallback_;
};
