#include "TransportCore.h"
#include <chrono>
#include <sstream>

TransportCore::TransportCore() {}

TransportCore::~TransportCore() {
    if (pc_) {
        pc_->close();
    }
}

bool TransportCore::Initialize(const std::vector<std::string>& stunUrls) {
    try {
        rtc::Configuration config;
        for (const auto& url : stunUrls) {
            config.iceServers.emplace_back(url);
        }

        pc_ = std::make_shared<rtc::PeerConnection>(config);
        return true;
    } catch (const std::exception&) {
        pc_.reset();
        return false;
    }
}

void TransportCore::OnLocalDescription(std::function<void(const std::string&, const std::string&)> callback) {
    if (!pc_) return;
    pc_->onLocalDescription([callback](rtc::Description description) {
        callback(std::string(description), description.typeString());
    });
}

void TransportCore::OnLocalCandidate(std::function<void(const std::string&, const std::string&)> callback) {
    if (!pc_) return;
    pc_->onLocalCandidate([callback](rtc::Candidate candidate) {
        callback(std::string(candidate), candidate.mid());
    });
}

void TransportCore::OnStateChange(std::function<void(const std::string&)> callback) {
    if (!pc_) return;
    pc_->onStateChange([callback](rtc::PeerConnection::State state) {
        // libdatachannel expõe `operator<<` pro enum de estado, não um `enum_name` embutido —
        // reusa isso via ostringstream em vez de fazer um switch manual que teria que ser mantido
        // sincronizado com o enum toda vez que ele mudar.
        std::ostringstream oss;
        oss << state;
        callback(oss.str());
    });
}

void TransportCore::OnPliRequest(std::function<void()> callback) {
    pliCallback_ = std::move(callback);
}

bool TransportCore::AddVideoTrack(int bitrateBps) {
    if (!pc_) return false;

    try {
        // Payload type 96 (dynâmico, faixa 96-127) — H.264 não tem número fixo na spec RTP/AVP,
        // sempre negociado via SDP (a=rtpmap). SSRC fixo (não 0) porque o packetizer/RTCP
        // precisam de um identificador de stream válido desde o início.
        const rtc::SSRC ssrc = 42;
        rtc::Description::Video media("video", rtc::Description::Direction::SendOnly);
        media.addH264Codec(96);
        media.addSSRC(ssrc, "video-send");

        videoTrack_ = pc_->addTrack(media);

        auto rtpConfig = std::make_shared<rtc::RtpPacketizationConfig>(
            ssrc, "video-send", 96, rtc::H264RtpPacketizer::ClockRate);
        auto packetizer = std::make_shared<rtc::H264RtpPacketizer>(
            rtc::NalUnit::Separator::LongStartSequence, rtpConfig);

        // Manda um pedacinho a cada 5ms em vez do frame inteiro de uma vez — suaviza a rajada de
        // pacotes RTP pro ritmo real do bitrate configurado, igual todo encoder de vídeo por rede
        // de verdade faz (é literalmente o que "buffer de vídeo"/pacing em qualquer player faz do
        // lado de recebimento; aqui é o lado de ENVIO que precisa disso).
        auto pacing = std::make_shared<rtc::PacingHandler>(static_cast<double>(bitrateBps), std::chrono::milliseconds(5));
        packetizer->addToChain(pacing);

        rtcpSrReporter_ = std::make_shared<rtc::RtcpSrReporter>(rtpConfig);
        packetizer->addToChain(rtcpSrReporter_);

        auto nackResponder = std::make_shared<rtc::RtcpNackResponder>();
        packetizer->addToChain(nackResponder);

        auto pliHandler = std::make_shared<rtc::PliHandler>([this]() {
            if (pliCallback_) pliCallback_();
        });
        packetizer->addToChain(pliHandler);

        videoTrack_->setMediaHandler(packetizer);

        return true;
    } catch (const std::exception&) {
        videoTrack_.reset();
        rtcpSrReporter_.reset();
        return false;
    }
}

bool TransportCore::CreateOffer() {
    if (!pc_) return false;
    try {
        pc_->setLocalDescription();
        return true;
    } catch (const std::exception&) {
        return false;
    }
}

bool TransportCore::SetRemoteDescription(const std::string& sdp, const std::string& type) {
    if (!pc_) return false;
    try {
        pc_->setRemoteDescription(rtc::Description(sdp, type));
        return true;
    } catch (const std::exception&) {
        return false;
    }
}

bool TransportCore::AddRemoteCandidate(const std::string& candidate, const std::string& mid) {
    if (!pc_) return false;
    try {
        pc_->addRemoteCandidate(rtc::Candidate(candidate, mid));
        return true;
    } catch (const std::exception&) {
        return false;
    }
}

bool TransportCore::SendVideoFrame(const uint8_t* data, size_t size, uint32_t timestampRtp) {
    if (!videoTrack_ || !videoTrack_->isOpen()) return false;

    try {
        // O NAL cru (Annex-B, com start code) já é o formato que o `H264RtpPacketizer` espera —
        // ele mesmo separa por NAL unit e fatia (FU-A) o que passar do MTU. Timestamp em unidades
        // de clock RTP (90kHz pra vídeo), não em ms — quem chama (EncoderCore/loop de captura)
        // precisa converter.
        rtc::binary sample(reinterpret_cast<const std::byte*>(data), reinterpret_cast<const std::byte*>(data) + size);
        videoTrack_->send(sample);
        return true;
    } catch (const std::exception&) {
        return false;
    }
}

bool TransportCore::IsConnected() const {
    return pc_ && pc_->state() == rtc::PeerConnection::State::Connected;
}
