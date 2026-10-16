#include "TransportCore.h"
#include <chrono>
#include <sstream>
#include <cstring>
#include <cstdio>
#include <algorithm>

// Toda chamada à libdatachannel aqui tem `catch (...)` além do `catch (const std::exception&)` —
// bug real (crash do host com espectador sem suporte a HEVC/AV1): no fallback de codec o espectador
// recria a conexão e ainda manda candidatos ICE da conexão ANTIGA, que caem na sessão nova;
// `addRemoteCandidate` lança e o `catch (const std::exception&)` NÃO pegava (a exceção vem da
// datachannel.dll, que usa a CRT dinâmica, e o addon é compilado com CRT estática e
// `_HAS_EXCEPTIONS=0` pelo node-gyp — o tipo não casa) → exceção C++ não tratada (0xE06D7363)
// derrubando o app. Achado com dump do Crashpad + `catch (...)` com log por método.

namespace {
// Limites do controle de latência (ver comentário grande em TransportCore.h).
// Fila acima do RTT mínimo a partir da qual a sessão começa a descartar frames — alto o bastante
// pra um keyframe grande ou um soluço curto de Wi-Fi não disparar descarte, baixo o bastante pra
// latência nunca ficar visivelmente "atrás" (jogo/suporte remoto, CLAUDE.md §Latência).
constexpr double kDropExtraDelayMs = 150.0;
// Fila precisa escoar até aqui antes de pedir o keyframe de volta — histerese, senão o keyframe
// (grande) chegaria numa fila ainda cheia e já entraria descartado de novo.
constexpr double kResumeExtraDelayMs = 40.0;
// Fallback pra espectador sem ack (viewer antigo): só o que o libdatachannel enxerga na fila dele.
constexpr size_t kDropBufferedBytes = 1024 * 1024;
constexpr size_t kResumeBufferedBytes = 256 * 1024;
constexpr auto kKeyframeRequestInterval = std::chrono::milliseconds(500);
constexpr auto kMinRttWindow = std::chrono::seconds(5);
// Teto da fila de frames sem ack — se o espectador parar de mandar ack (aba em segundo plano com
// timers congelados, viewer antigo), não deixa a deque crescer pra sempre.
constexpr size_t kMaxInflight = 1024;
} // namespace

TransportCore::TransportCore() {}

TransportCore::~TransportCore() {
    // Callbacks capturam `this` — solta antes de fechar pra nenhum disparar (thread do
    // libdatachannel) depois que esse objeto já foi destruído. Destrutor não pode deixar exceção
    // escapar (ver comentário no topo sobre o `catch (...)`).
    try {
        if (videoChannel_) videoChannel_->resetCallbacks();
        if (audioChannel_) audioChannel_->resetCallbacks();
        if (pc_) pc_->close();
    } catch (...) {
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
    } catch (...) {
        fprintf(stderr, "[TransportCore] Initialize: exceção da libdatachannel (ignorada)\n");
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
        // Canal de volta do espectador: acks de frame recebido e pedido de keyframe (ver
        // TransportCore.h "Controle de latência"). Mensagem de texto não é usada nesse protocolo.
        videoChannel_->onMessage([this](rtc::binary data) { HandleVideoChannelMessage(data); }, [](rtc::string) {});

        fprintf(stderr, "[TransportCore] AddVideoChannel() ok\n");
        return true;
    } catch (const std::exception& e) {
        fprintf(stderr, "[TransportCore] AddVideoChannel() lançou: %s\n", e.what());
        videoChannel_.reset();
        return false;
    } catch (...) {
        fprintf(stderr, "[TransportCore] AddVideoChannel: exceção da libdatachannel (ignorada)\n");
        videoChannel_.reset();
        return false;
    }
}

// Canal separado do de vídeo — o cliente distingue os dois pelo `label()` do DataChannel
// (`"video"`/`"audio"`) no `ondatachannel`, ver useNativeStream.ts. Opcional: só chamado quando
// o áudio nativo está habilitado (`main/index.ts`), sessão de vídeo puro nunca chama isso.
bool TransportCore::AddAudioChannel() {
    if (!pc_) return false;

    try {
        audioChannel_ = pc_->createDataChannel("audio");
        fprintf(stderr, "[TransportCore] AddAudioChannel() ok\n");
        return true;
    } catch (const std::exception& e) {
        fprintf(stderr, "[TransportCore] AddAudioChannel() lançou: %s\n", e.what());
        audioChannel_.reset();
        return false;
    } catch (...) {
        fprintf(stderr, "[TransportCore] AddAudioChannel: exceção da libdatachannel (ignorada)\n");
        audioChannel_.reset();
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
    } catch (...) {
        fprintf(stderr, "[TransportCore] CreateOffer: exceção da libdatachannel (ignorada)\n");
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
    } catch (...) {
        fprintf(stderr, "[TransportCore] SetRemoteDescription: exceção da libdatachannel (ignorada)\n");
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
    } catch (...) {
        fprintf(stderr, "[TransportCore] AddRemoteCandidate: exceção da libdatachannel (ignorada)\n");
        return false;
    }
}

// Procura um NAL unit de keyframe no bitstream Annex-B — reconhece start code de 3 ou 4 bytes
// (0x000001 ou 0x00000001). O cliente (WebCodecs `VideoDecoder`) precisa saber se cada chunk é
// "key" ou "delta" pra decodificar certo (e o PRIMEIRO chunk que ele recebe TEM que ser "key").
// `isHevc` muda como o tipo de NAL é lido: H.264 tem cabeçalho de NAL de 1 byte (tipo nos 5 bits
// baixos, IDR = tipo 5); HEVC tem cabeçalho de 2 bytes (tipo nos bits 1-6 do PRIMEIRO byte, faixa
// IRAP/keyframe = tipos 16 a 23 — BLA/IDR/CRA e reservados IRAP).
// AV1 não usa NAL/start-codes como H.264/HEVC — o bitstream é uma sequência de OBUs (Open
// Bitstream Units) concatenados direto ("low overhead format", `outputAnnexBFormat=0` em
// EncoderCore.cpp). Cada OBU tem um header de 1-2 bytes seguido de um tamanho leb128 — precisa
// andar OBU por OBU pra saber onde cada um termina (não dá pra procurar um marcador fixo tipo o
// start-code do H.264). `repeatSeqHdr=1` (EncoderCore.cpp) garante que o Sequence Header (tipo 1)
// só aparece de novo em cada keyframe — a mesma lógica que repeatSPSPPS já usa pra H.264/HEVC.
static bool ReadObuLeb128(const uint8_t* data, size_t size, size_t pos, uint64_t& value, size_t& bytesRead) {
    value = 0;
    bytesRead = 0;
    for (int i = 0; i < 8; i++) {
        if (pos + i >= size) return false;
        const uint8_t b = data[pos + i];
        value |= static_cast<uint64_t>(b & 0x7F) << (i * 7);
        bytesRead++;
        if ((b & 0x80) == 0) return true;
    }
    return false; // leb128 mal formado/truncado — desiste, mais seguro que ler lixo
}

static bool ContainsKeyframeObu(const uint8_t* data, size_t size) {
    size_t pos = 0;
    while (pos < size) {
        const uint8_t header = data[pos];
        if ((header & 0x80) != 0) return false; // forbidden_bit deveria ser sempre 0 — bitstream inesperado, desiste
        const uint8_t obuType = (header >> 3) & 0x0F;
        const bool hasExtension = (header >> 2) & 0x01;
        const bool hasSizeField = (header >> 1) & 0x01;

        size_t headerLen = 1 + (hasExtension ? 1 : 0);
        if (pos + headerLen > size) return false;

        if (obuType == 1 /* OBU_SEQUENCE_HEADER */) return true;

        if (!hasSizeField) return false; // sem tamanho inline não dá pra pular pro próximo OBU com segurança
        uint64_t obuSize = 0;
        size_t leb128Len = 0;
        if (!ReadObuLeb128(data, size, pos + headerLen, obuSize, leb128Len)) return false;

        pos += headerLen + leb128Len + static_cast<size_t>(obuSize);
    }
    return false;
}

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

// Formato do frame no DataChannel: [1 byte: 0=key/1=delta, | 0x80 = continua no próximo pedaço]
// [8 bytes: timestamp µs, little-endian]
// [payload: H.264 Annex-B cru]. Pequeno o bastante pra não pesar, o suficiente pra reconstruir o
// `EncodedVideoChunk` do WebCodecs do outro lado sem precisar inspecionar o bitstream no cliente.
bool TransportCore::SendVideoFrame(const uint8_t* data, size_t size, uint64_t timestampUs) {
    // Mesma checagem extra de `SendAudioFrame` (ver comentário lá) — vídeo não apareceu na pilha
    // do crash real analisado, mas é o MESMO padrão `isOpen()`-então-`send()`, só não foi pego
    // ainda (canal de áudio só fica reliably ativo no caminho de janela, ver docs/TASKS.md — vídeo
    // roda igual nos dois caminhos, então o mesmo risco existe, só não observado/relatado ainda).
    if (!pc_ || pc_->state() != rtc::PeerConnection::State::Connected) return false;
    if (!videoChannel_ || !videoChannel_->isOpen()) return false;

    try {
        const bool isKeyframe = codec_ == VideoCodecType::AV1
            ? ContainsKeyframeObu(data, size)
            : ContainsKeyframeNal(data, size, codec_ == VideoCodecType::HEVC);

        const auto now = std::chrono::steady_clock::now();
        bool hasFeedback = false;
        bool congested = false;
        bool drained = true;
        {
            std::lock_guard<std::mutex> lock(feedbackMutex_);
            hasFeedback = feedbackSeen_;
            if (hasFeedback) {
                const double extra = ExtraDelayMsLocked(now);
                congested = extra > kDropExtraDelayMs;
                drained = extra < kResumeExtraDelayMs;
            }
        }
        if (!hasFeedback) {
            const size_t buffered = videoChannel_->bufferedAmount();
            congested = buffered > kDropBufferedBytes;
            drained = buffered < kResumeBufferedBytes;
        }

        if (congested || (waitingKeyframe_ && !isKeyframe)) {
            // Descarta. Depois de descartar qualquer frame, o próximo que essa sessão recebe TEM
            // que ser keyframe (P-frame seguinte referencia o que foi jogado fora).
            waitingKeyframe_ = true;
            // Só descarte POR CONGESTIONAMENTO conta pro AIMD — esperar o primeiro keyframe de uma
            // sessão nova (ou depois de um pedido do decoder) não é sinal de rede ruim.
            if (congested) droppedFrames_++;
            if (drained && now - lastKeyframeRequestAt_ >= kKeyframeRequestInterval) {
                pendingKeyframeRequest_ = true;
                lastKeyframeRequestAt_ = now;
            }
            return false;
        }
        waitingKeyframe_ = false;

        // Frame maior que o `max-message-size` do espectador (Chrome anuncia 256KB) vai em
        // pedaços: `send()` acima do limite LANÇA e o frame some — bug medido com keyframe de
        // ~276KB do encoder Media Foundation (e qualquer keyframe grande em 1440p/4K pelo NVENC):
        // keyframe perdido = espectador decodificando P-frames sem referência. Cada pedaço leva o
        // mesmo cabeçalho; bit 0x80 no 1º byte = "tem mais pedaço deste frame" (SCTP ordenado,
        // então os pedaços chegam em sequência).
        const size_t maxMessage = std::max<size_t>(videoChannel_->maxMessageSize(), 1024);
        const size_t chunkPayload = maxMessage - 9;
        size_t offset = 0;
        do {
            const size_t part = std::min(chunkPayload, size - offset);
            const bool more = offset + part < size;
            rtc::binary message(9 + part);
            message[0] = static_cast<std::byte>((isKeyframe ? 0 : 1) | (more ? 0x80 : 0));
            std::memcpy(message.data() + 1, &timestampUs, 8);
            std::memcpy(message.data() + 9, data + offset, part);
            videoChannel_->send(message);
            offset += part;
        } while (offset < size);

        std::lock_guard<std::mutex> lock(feedbackMutex_);
        inflight_.push_back({timestampUs, now});
        if (inflight_.size() > kMaxInflight) inflight_.pop_front();
        return true;
    } catch (const std::exception&) {
        return false;
    } catch (...) {
        fprintf(stderr, "[TransportCore] SendVideoFrame: exceção da libdatachannel (ignorada)\n");
        return false;
    }
}

// `[8 bytes: timestamp µs]` = ack do frame com esse timestamp (o espectador manda 1 por frame
// recebido, em ordem — SCTP ordenado); `[1 byte: 'K']` = pedido de keyframe.
void TransportCore::HandleVideoChannelMessage(const rtc::binary& data) {
    if (data.size() == 1 && static_cast<char>(data[0]) == 'K') {
        viewerKeyframeRequest_.store(true);
        return;
    }
    if (data.size() != 8) return;
    uint64_t ackedTs = 0;
    std::memcpy(&ackedTs, data.data(), 8);

    const auto now = std::chrono::steady_clock::now();
    std::lock_guard<std::mutex> lock(feedbackMutex_);
    feedbackSeen_ = true;
    std::chrono::steady_clock::time_point ackedSentAt{};
    bool matched = false;
    while (!inflight_.empty() && inflight_.front().timestampUs <= ackedTs) {
        if (inflight_.front().timestampUs == ackedTs) {
            ackedSentAt = inflight_.front().sentAt;
            matched = true;
        }
        inflight_.pop_front();
    }
    if (!matched) return;

    const double rttMs = std::chrono::duration<double, std::milli>(now - ackedSentAt).count();
    if (minRttWindowStart_.time_since_epoch().count() == 0) minRttWindowStart_ = now;
    if (now - minRttWindowStart_ > kMinRttWindow) {
        minRttPrevMs_ = minRttCurMs_;
        minRttCurMs_ = 1e9;
        minRttWindowStart_ = now;
    }
    minRttCurMs_ = std::min(minRttCurMs_, rttMs);
}

double TransportCore::ExtraDelayMsLocked(std::chrono::steady_clock::time_point now) const {
    if (inflight_.empty()) return 0.0;
    const double ageMs = std::chrono::duration<double, std::milli>(now - inflight_.front().sentAt).count();
    const double minRtt = std::min(minRttCurMs_, minRttPrevMs_);
    return std::max(0.0, ageMs - (minRtt < 1e8 ? minRtt : 0.0));
}

bool TransportCore::ConsumeKeyframeRequest() {
    const auto now = std::chrono::steady_clock::now();
    if (pendingKeyframeRequest_) {
        pendingKeyframeRequest_ = false;
        return true;
    }
    // Pedido do espectador fica guardado (não é perdido) até sair da janela de rate-limit.
    if (viewerKeyframeRequest_.load() && now - lastKeyframeRequestAt_ >= kKeyframeRequestInterval) {
        viewerKeyframeRequest_.store(false);
        lastKeyframeRequestAt_ = now;
        return true;
    }
    return false;
}

double TransportCore::GetQueueDelayMs() {
    std::lock_guard<std::mutex> lock(feedbackMutex_);
    if (!feedbackSeen_) return 0.0;
    return ExtraDelayMsLocked(std::chrono::steady_clock::now());
}

uint32_t TransportCore::TakeDroppedFrames() {
    const uint32_t n = droppedFrames_;
    droppedFrames_ = 0;
    return n;
}

// Formato no DataChannel: [8 bytes: timestamp µs, little-endian][payload: pacote Opus cru].
bool TransportCore::SendAudioFrame(const uint8_t* data, size_t size, uint64_t timestampUs) {
    // `pc_->state()` além do `isOpen()` do canal — bug real achado via dump de crash (KERNELBASE,
    // mesma classe do bug de `g_encoder` já corrigido): sessão cuja conexão já falhou/fechou
    // internamente no libdatachannel (detectado pela THREAD INTERNA dele — ICE/DTLS, reconexão
    // abrupta do lado do espectador tipo F5 repetido) mas cujo `OnStateChange` (que dispara
    // `transportCloseSession` do lado JS) ainda não foi processado pelo event loop do Node —
    // `TransportSendAudioFrame` continua chamando `send()` nessa janela porque só filtra por
    // `IsConnected()` estritamente igual, mas cada checagem aqui é feita num instante levemente
    // diferente do que a checagem externa (`addon.cpp`), estreitando (não elimina 100%, libdatachannel
    // não documenta as garantias internas) a janela de corrida entre "isOpen() ainda true" e o
    // estado real da conexão internamente já em transição.
    if (!pc_ || pc_->state() != rtc::PeerConnection::State::Connected) return false;
    if (!audioChannel_ || !audioChannel_->isOpen()) return false;

    try {
        rtc::binary message(8 + size);
        std::memcpy(message.data(), &timestampUs, 8);
        std::memcpy(message.data() + 8, data, size);
        audioChannel_->send(message);
        return true;
    } catch (const std::exception&) {
        return false;
    } catch (...) {
        fprintf(stderr, "[TransportCore] SendAudioFrame: exceção da libdatachannel (ignorada)\n");
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
    } catch (...) {
        fprintf(stderr, "[TransportCore] GetBufferedAmount: exceção da libdatachannel (ignorada)\n");
        return 0;
    }
}
