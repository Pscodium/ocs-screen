#include "TransportCore.h"
#include <chrono>
#include <sstream>
#include <cstring>
#include <cstdio>

TransportCore::TransportCore() {}

TransportCore::~TransportCore() {
    if (pc_) {
        pc_->close();
    }
}

bool TransportCore::Initialize(const std::vector<std::string>& stunUrls, VideoCodecType codec) {
    codec_ = codec;
    try {
        rtc::Configuration config;
        for (const auto& url : stunUrls) {
            config.iceServers.emplace_back(url);
        }
        // Default do libdatachannel é 256KB — keyframe H.264 de tela cheia passa perto disso
        // (~200-230KB medido) e frames complexos podem estourar. Mensagem SCTP acima do limite
        // negociado é TRUNCADA silenciosamente na reassemblagem (não rejeitada com erro — ver
        // src/impl/sctptransport.cpp:519-522 do libdatachannel vendorizado), o que decodifica
        // como corrupção visual (blocos de cor errada) sem nenhum log de falha em lugar nenhum —
        // medido em produção. 4MB é folga generosa pra nunca chegar perto disso.
        config.maxMessageSize = 4 * 1024 * 1024;

        pc_ = std::make_shared<rtc::PeerConnection>(config);
        return true;
    } catch (const std::exception&) {
        pc_.reset();
        return false;
    }
}

void TransportCore::OnLocalDescription(std::function<void(const std::string&, const std::string&)> callback) {
    fprintf(stderr, "[TransportCore] OnLocalDescription registrado (pc_=%p)\n", (void*)pc_.get());
    if (!pc_) return;
    pc_->onLocalDescription([callback](rtc::Description description) {
        fprintf(stderr, "[TransportCore] pc_->onLocalDescription DISPAROU\n");
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

void TransportCore::OnChannelOpen(std::function<void()> callback) {
    channelOpenCallback_ = std::move(callback);
}

// Vídeo por DATACHANNEL, não RTP track — ver nota grande em TransportCore.h sobre o bug do
// PacingHandler que motivou essa troca. SCTP (a lib usa por baixo) já é confiável e ordenado por
// padrão, então nem precisamos configurar `rtc::Reliability` nenhum — chega tudo, na ordem certa,
// sem NACK/PLI/jitter buffer de RTP no meio.
bool TransportCore::AddVideoChannel() {
    if (!pc_) return false;

    try {
        videoChannel_ = pc_->createDataChannel("video");

        videoChannel_->onOpen([this]() {
            fprintf(stderr, "[TransportCore] videoChannel_ ABRIU\n");
            if (channelOpenCallback_) channelOpenCallback_();
        });

        fprintf(stderr, "[TransportCore] AddVideoChannel() ok\n");
        return true;
    } catch (const std::exception& e) {
        fprintf(stderr, "[TransportCore] AddVideoChannel() lançou: %s\n", e.what());
        videoChannel_.reset();
        return false;
    }
}

bool TransportCore::CreateOffer() {
    if (!pc_) return false;
    try {
        pc_->setLocalDescription();
        fprintf(stderr, "[TransportCore] setLocalDescription() retornou sem exceção\n");
        return true;
    } catch (const std::exception& e) {
        fprintf(stderr, "[TransportCore] setLocalDescription() lançou: %s\n", e.what());
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

// Procura um NAL unit de keyframe no bitstream Annex-B — reconhece start code de 3 ou 4 bytes
// (0x000001 ou 0x00000001). O cliente (WebCodecs `VideoDecoder`) precisa saber se cada chunk é
// "key" ou "delta" pra decodificar certo (e o PRIMEIRO chunk que ele recebe TEM que ser "key").
// `isHevc` muda como o tipo de NAL é lido: H.264 tem cabeçalho de NAL de 1 byte (tipo nos 5 bits
// baixos, IDR = tipo 5); HEVC tem cabeçalho de 2 bytes (tipo nos bits 1-6 do PRIMEIRO byte, faixa
// IRAP/keyframe = tipos 16 a 23 — BLA/IDR/CRA e reservados IRAP).
static bool ContainsKeyframeNal(const uint8_t* data, size_t size, bool isHevc) {
    for (size_t i = 0; i + 3 < size; i++) {
        if (data[i] != 0 || data[i + 1] != 0) continue;

        size_t nalStart;
        if (data[i + 2] == 1) {
            nalStart = i + 3;
        } else if (data[i + 2] == 0 && i + 3 < size && data[i + 3] == 1) {
            nalStart = i + 4;
        } else {
            continue;
        }
        if (nalStart >= size) continue;

        if (isHevc) {
            const uint8_t nalType = (data[nalStart] >> 1) & 0x3F;
            if (nalType >= 16 && nalType <= 23) return true;
        } else {
            if ((data[nalStart] & 0x1F) == 5) return true;
        }
    }
    return false;
}

// Formato do frame no DataChannel: [1 byte: 0=key/1=delta][8 bytes: timestamp µs, little-endian]
// [payload: H.264 Annex-B cru]. Pequeno o bastante pra não pesar, o suficiente pra reconstruir o
// `EncodedVideoChunk` do WebCodecs do outro lado sem precisar inspecionar o bitstream no cliente.
bool TransportCore::SendVideoFrame(const uint8_t* data, size_t size, uint64_t timestampUs) {
    if (!videoChannel_ || !videoChannel_->isOpen()) return false;

    try {
        const bool isKeyframe = ContainsKeyframeNal(data, size, codec_ == VideoCodecType::HEVC);

        rtc::binary message(9 + size);
        message[0] = static_cast<std::byte>(isKeyframe ? 0 : 1);
        std::memcpy(message.data() + 1, &timestampUs, 8);
        std::memcpy(message.data() + 9, data, size);

        videoChannel_->send(message);
        return true;
    } catch (const std::exception&) {
        return false;
    }
}

bool TransportCore::IsConnected() const {
    return pc_ && pc_->state() == rtc::PeerConnection::State::Connected;
}

size_t TransportCore::GetBufferedAmount() const {
    if (!videoChannel_) return 0;
    try {
        return videoChannel_->bufferedAmount();
    } catch (const std::exception&) {
        return 0;
    }
}
