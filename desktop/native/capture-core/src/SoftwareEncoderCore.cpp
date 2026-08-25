#include "SoftwareEncoderCore.h"
#include <windows.h>
#include <mferror.h>
#include <thread>
#include <algorithm>

SoftwareEncoderCore::SoftwareEncoderCore() {}

SoftwareEncoderCore::~SoftwareEncoderCore() {
    Destroy();
}

bool SoftwareEncoderCore::Initialize(ID3D11Device* device, ID3D11DeviceContext* context, int width, int height, int fps, int bitrateBps, VideoCodecType codec) {
    if (!device || !context) return false;
    activeCodec_ = codec;

    // COM/MF podem já estar inicializados pelo resto do processo Electron — CoInitializeEx com
    // S_FALSE (já inicializado no mesmo modo) ainda precisa de CoUninitialize pareado; só
    // RPC_E_CHANGED_MODE (modo incompatível já setado por outra coisa) significa que ESSA chamada
    // não "pegou" e não deve ser desfeita depois.
    const HRESULT coHr = CoInitializeEx(nullptr, COINIT_MULTITHREADED);
    comInitializedByUs_ = SUCCEEDED(coHr);

    if (FAILED(MFStartup(MF_VERSION))) {
        if (comInitializedByUs_) { CoUninitialize(); comInitializedByUs_ = false; }
        return false;
    }
    mfStarted_ = true;

    width_ = width;
    height_ = height;
    fps_ = fps > 0 ? fps : 30;
    frameDuration100ns_ = 10'000'000LL / fps_;
    sampleTime_ = 0;
    nextEncodeTime_ = std::chrono::steady_clock::time_point{};

    // MFTEnumEx (não CLSID fixo) — deixa o Windows escolher o melhor MFT disponível pra
    // NV12→H264. `MFT_ENUM_FLAG_SORTANDFILTER` prioriza hardware quando existir (bônus: se a
    // máquina tiver encoder Intel QuickSync/AMD AMF exposto via Media Foundation, a gente ganha
    // hardware de graça aqui também, mesmo sem NVENC — não só o encoder 100% software da
    // Microsoft). Isso é o fallback de verdade pra "sem NVENC", não assume CPU sempre.
    // MFVideoFormat_AV1 existe desde o Windows 10 2004 (headers), mas o Windows NÃO garante um MFT
    // de encode AV1 embutido (ao contrário do H.264, que sempre tem) — `MFTEnumEx` abaixo
    // simplesmente não acha nada nesse caso (activateCount == 0) e o Initialize retorna false,
    // deixando a cascata de 4 níveis do EncoderCore cair pro software H.264 normalmente. Só ganha
    // AV1 por software de verdade se a máquina tiver um MFT de terceiro (Intel/AMD) registrado.
    const GUID outSubtype = codec == VideoCodecType::HEVC ? MFVideoFormat_HEVC
        : codec == VideoCodecType::AV1 ? MFVideoFormat_AV1
        : MFVideoFormat_H264;
    MFT_REGISTER_TYPE_INFO inType{ MFMediaType_Video, MFVideoFormat_NV12 };
    MFT_REGISTER_TYPE_INFO outType{ MFMediaType_Video, outSubtype };
    IMFActivate** activates = nullptr;
    UINT32 activateCount = 0;
    HRESULT hr = MFTEnumEx(
        MFT_CATEGORY_VIDEO_ENCODER,
        MFT_ENUM_FLAG_SYNCMFT | MFT_ENUM_FLAG_ASYNCMFT | MFT_ENUM_FLAG_LOCALMFT | MFT_ENUM_FLAG_SORTANDFILTER,
        &inType, &outType, &activates, &activateCount);

    if (FAILED(hr) || activateCount == 0) {
        if (activates) {
            for (UINT32 i = 0; i < activateCount; i++) activates[i]->Release();
            CoTaskMemFree(activates);
        }
        Destroy();
        return false;
    }

    hr = activates[0]->ActivateObject(IID_PPV_ARGS(&transform_));
    for (UINT32 i = 0; i < activateCount; i++) activates[i]->Release();
    CoTaskMemFree(activates);
    if (FAILED(hr) || !transform_) {
        Destroy();
        return false;
    }

    // Encoder H.264 embutido no Windows é ASSÍNCRONO desde o Win8 — precisa "destravar"
    // explicitamente antes de mandar mensagem/tipo nenhum, senão todo `ProcessMessage`/`SetInputType`
    // retorna MF_E_TRANSFORM_ASYNC_LOCKED.
    ComPtr<IMFAttributes> attrs;
    if (SUCCEEDED(transform_->GetAttributes(&attrs)) && attrs) {
        UINT32 isAsync = 0;
        attrs->GetUINT32(MF_TRANSFORM_ASYNC, &isAsync);
        if (isAsync) {
            attrs->SetUINT32(MF_TRANSFORM_ASYNC_UNLOCK, TRUE);
            transform_.As(&eventGen_); // só MFT assíncrono implementa IMFMediaEventGenerator
        }
    }

    // Tipo de SAÍDA primeiro (convenção dos encoders MF — várias implementações rejeitam
    // SetInputType antes de já saber o formato de saída alvo).
    ComPtr<IMFMediaType> mfOutType;
    MFCreateMediaType(&mfOutType);
    mfOutType->SetGUID(MF_MT_MAJOR_TYPE, MFMediaType_Video);
    mfOutType->SetGUID(MF_MT_SUBTYPE, outSubtype);
    mfOutType->SetUINT32(MF_MT_AVG_BITRATE, static_cast<UINT32>(bitrateBps));
    MFSetAttributeSize(mfOutType.Get(), MF_MT_FRAME_SIZE, width_, height_);
    MFSetAttributeRatio(mfOutType.Get(), MF_MT_FRAME_RATE, fps_, 1);
    MFSetAttributeRatio(mfOutType.Get(), MF_MT_PIXEL_ASPECT_RATIO, 1, 1);
    mfOutType->SetUINT32(MF_MT_INTERLACE_MODE, MFVideoInterlace_Progressive);
    if (codec == VideoCodecType::H264) {
        mfOutType->SetUINT32(MF_MT_MPEG2_PROFILE, 100); // eAVEncH264VProfile_High — mesmo profile que o NVENC já produz (ver EncoderCore.cpp)
    }
    // HEVC: deixa o MFT escolher o profile padrão dele (Main) — `MF_MT_MPEG2_PROFILE` usa a mesma
    // chave de atributo pros dois codecs, mas os valores do enum `eAVEncH264VProfile` não são
    // válidos pro perfil HEVC (`eAVEncH265VProfile`, valores diferentes) — melhor não setar do que
    // setar um valor de enum errado pro codec ativo.
    if (FAILED(transform_->SetOutputType(0, mfOutType.Get(), 0))) {
        Destroy();
        return false;
    }

    ComPtr<IMFMediaType> mfInType;
    MFCreateMediaType(&mfInType);
    mfInType->SetGUID(MF_MT_MAJOR_TYPE, MFMediaType_Video);
    mfInType->SetGUID(MF_MT_SUBTYPE, MFVideoFormat_NV12);
    MFSetAttributeSize(mfInType.Get(), MF_MT_FRAME_SIZE, width_, height_);
    MFSetAttributeRatio(mfInType.Get(), MF_MT_FRAME_RATE, fps_, 1);
    MFSetAttributeRatio(mfInType.Get(), MF_MT_PIXEL_ASPECT_RATIO, 1, 1);
    mfInType->SetUINT32(MF_MT_INTERLACE_MODE, MFVideoInterlace_Progressive);
    if (FAILED(transform_->SetInputType(0, mfInType.Get(), 0))) {
        Destroy();
        return false;
    }

    // CBR + baixa latência + GOP de 2s — mesmo espírito de configuração que o EncoderCore (NVENC)
    // usa (CLAUDE.md §Latência prioriza baixa latência sobre nitidez máxima). Best-effort: nem
    // todo MFT expõe ICodecAPI ou aceita todo parâmetro, falha aqui não é fatal.
    CodecApiHelper::SetRateControlCbr(transform_.Get());
    CodecApiHelper::SetMeanBitRate(transform_.Get(), static_cast<unsigned long>(bitrateBps));
    CodecApiHelper::SetLowLatency(transform_.Get());
    CodecApiHelper::SetGopSize(transform_.Get(), static_cast<unsigned long>(fps_ * 2));

    context_ = context;
    if (!CreateStagingTexture(width_, height_)) {
        Destroy();
        return false;
    }

    transform_->ProcessMessage(MFT_MESSAGE_NOTIFY_BEGIN_STREAMING, 0);
    transform_->ProcessMessage(MFT_MESSAGE_NOTIFY_START_OF_STREAM, 0);
    needsInput_ = true;

    return true;
}

bool SoftwareEncoderCore::CreateStagingTexture(int width, int height) {
    ComPtr<ID3D11Device> device;
    context_->GetDevice(&device);
    if (!device) return false;

    D3D11_TEXTURE2D_DESC desc{};
    desc.Width = static_cast<UINT>(width);
    desc.Height = static_cast<UINT>(height);
    desc.MipLevels = 1;
    desc.ArraySize = 1;
    desc.Format = DXGI_FORMAT_B8G8R8A8_UNORM;
    desc.SampleDesc.Count = 1;
    desc.Usage = D3D11_USAGE_STAGING;
    desc.CPUAccessFlags = D3D11_CPU_ACCESS_READ;

    ComPtr<ID3D11Texture2D> tex;
    if (FAILED(device->CreateTexture2D(&desc, nullptr, &tex))) return false;
    stagingTexture_ = tex;
    return true;
}

void SoftwareEncoderCore::PumpEvents(std::vector<std::vector<uint8_t>>& outPackets) {
    if (!eventGen_) return;
    for (;;) {
        ComPtr<IMFMediaEvent> event;
        HRESULT hr = eventGen_->GetEvent(MF_EVENT_FLAG_NO_WAIT, &event);
        if (FAILED(hr) || !event) return; // fila vazia (MF_E_NO_EVENTS_AVAILABLE) é o caso normal

        MediaEventType type = MEUnknown;
        event->GetType(&type);
        if (type == METransformNeedInput) {
            needsInput_ = true;
        } else if (type == METransformHaveOutput) {
            DrainOutput(outPackets);
        }
        // Outros tipos (METransformDrainComplete, etc.) ignorados de propósito — não usados aqui.
    }
}

void SoftwareEncoderCore::DrainOutput(std::vector<std::vector<uint8_t>>& outPackets) {
    if (!transform_) return;

    for (;;) {
        MFT_OUTPUT_STREAM_INFO streamInfo{};
        transform_->GetOutputStreamInfo(0, &streamInfo);

        const bool weProvideSample = !(streamInfo.dwFlags & MFT_OUTPUT_STREAM_PROVIDES_SAMPLES);
        ComPtr<IMFSample> providedSample;
        MFT_OUTPUT_DATA_BUFFER outputBuffer{};
        if (weProvideSample) {
            MFCreateSample(&providedSample);
            ComPtr<IMFMediaBuffer> buf;
            const DWORD bufSize = streamInfo.cbSize > 0 ? streamInfo.cbSize : (1u << 20);
            MFCreateMemoryBuffer(bufSize, &buf);
            providedSample->AddBuffer(buf.Get());
            outputBuffer.pSample = providedSample.Get();
        }

        DWORD status = 0;
        const HRESULT hr = transform_->ProcessOutput(0, 1, &outputBuffer, &status);
        if (outputBuffer.pEvents) {
            outputBuffer.pEvents->Release();
            outputBuffer.pEvents = nullptr;
        }

        if (hr == MF_E_TRANSFORM_NEED_MORE_INPUT) return;
        if (FAILED(hr)) return; // stream-change ou outro erro raro — não é caminho crítico, desiste dessa rodada

        IMFSample* sample = weProvideSample ? providedSample.Get() : outputBuffer.pSample;
        if (sample) {
            ComPtr<IMFMediaBuffer> contig;
            if (SUCCEEDED(sample->ConvertToContiguousBuffer(&contig)) && contig) {
                BYTE* data = nullptr;
                DWORD len = 0;
                if (SUCCEEDED(contig->Lock(&data, nullptr, &len))) {
                    outPackets.emplace_back(data, data + len);
                    contig->Unlock();
                }
            }
        }
        if (!weProvideSample && outputBuffer.pSample) {
            outputBuffer.pSample->Release(); // MFT alocou e devolveu a posse pra gente (fora do ComPtr)
        }
    }
}

std::vector<std::vector<uint8_t>> SoftwareEncoderCore::EncodeFrame(ID3D11Texture2D* frame) {
    std::vector<std::vector<uint8_t>> packets;
    if (!transform_ || !context_ || !frame) return packets;

    // Mesmo pacing de grade fixa que o EncoderCore (NVENC) usa — ver comentário lá (evita jitter
    // acumulado por recalcular "agora" a cada frame aceito).
    const auto now = std::chrono::steady_clock::now();
    const auto interval = std::chrono::duration_cast<std::chrono::steady_clock::duration>(
        std::chrono::duration<double>(1.0 / (fps_ > 0 ? fps_ : 30)));
    if (nextEncodeTime_.time_since_epoch().count() != 0 && now < nextEncodeTime_) return packets;
    if (nextEncodeTime_.time_since_epoch().count() == 0 || now - nextEncodeTime_ > interval) {
        nextEncodeTime_ = now + interval;
    } else {
        nextEncodeTime_ += interval;
    }

    PumpEvents(packets); // drena output pronto + atualiza needsInput_ (MFT assíncrono)
    if (eventGen_ && !needsInput_) return packets; // MFT ainda processando o frame anterior — pula esse, mesmo espírito do skip de pacing do NVENC

    try {
        context_->CopyResource(stagingTexture_.Get(), frame);
        D3D11_MAPPED_SUBRESOURCE mapped{};
        if (FAILED(context_->Map(stagingTexture_.Get(), 0, D3D11_MAP_READ, 0, &mapped))) return packets;

        const size_t nv12Size = static_cast<size_t>(width_) * height_ * 3 / 2;
        if (nv12Scratch_.size() != nv12Size) nv12Scratch_.resize(nv12Size);
        BgraToNv12(static_cast<const uint8_t*>(mapped.pData), mapped.RowPitch, nv12Scratch_.data());
        context_->Unmap(stagingTexture_.Get(), 0);

        ComPtr<IMFSample> sample;
        MFCreateSample(&sample);
        ComPtr<IMFMediaBuffer> buffer;
        MFCreateMemoryBuffer(static_cast<DWORD>(nv12Size), &buffer);
        BYTE* dst = nullptr;
        buffer->Lock(&dst, nullptr, nullptr);
        memcpy(dst, nv12Scratch_.data(), nv12Size);
        buffer->Unlock();
        buffer->SetCurrentLength(static_cast<DWORD>(nv12Size));
        sample->AddBuffer(buffer.Get());
        sample->SetSampleTime(sampleTime_);
        sample->SetSampleDuration(frameDuration100ns_);
        sampleTime_ += frameDuration100ns_;

        if (forceKeyframe_.exchange(false, std::memory_order_relaxed)) {
            CodecApiHelper::ForceKeyframe(transform_.Get());
        }

        const HRESULT hr = transform_->ProcessInput(0, sample.Get(), 0);
        if (SUCCEEDED(hr)) {
            needsInput_ = false;
            if (!eventGen_) DrainOutput(packets); // MFT síncrono (raro): output pode já estar pronto na hora
        }
        // MF_E_NOTACCEPTING: MFT ainda não terminou o anterior — frame descartado de propósito,
        // próximo tick tenta de novo (mesma filosofia do skip de pacing do NVENC).
    } catch (const std::exception&) {
        // Defensivo — mesmo raciocínio do EncoderCore (NVENC): sob contenção pesada, não deixar
        // uma exceção aqui derrubar o processo inteiro sem log.
    }

    return packets;
}

std::vector<std::vector<uint8_t>> SoftwareEncoderCore::Flush() {
    std::vector<std::vector<uint8_t>> packets;
    if (!transform_) return packets;

    transform_->ProcessMessage(MFT_MESSAGE_COMMAND_DRAIN, 0);
    // Best-effort, tempo curto — só roda ao encerrar a transmissão, não é caminho de latência.
    for (int i = 0; i < 50 && packets.empty(); i++) {
        PumpEvents(packets);
        DrainOutput(packets);
        if (packets.empty()) std::this_thread::sleep_for(std::chrono::milliseconds(10));
    }
    return packets;
}

bool SoftwareEncoderCore::SetBitrate(int bitrateBps, bool forceKeyframe) {
    const bool ok = CodecApiHelper::SetMeanBitRate(transform_.Get(), static_cast<unsigned long>(bitrateBps));
    if (ok && forceKeyframe) CodecApiHelper::ForceKeyframe(transform_.Get());
    return ok;
}

void SoftwareEncoderCore::BgraToNv12(const uint8_t* bgra, uint32_t rowPitch, uint8_t* nv12) {
    uint8_t* yPlane = nv12;
    uint8_t* uvPlane = nv12 + static_cast<size_t>(width_) * height_;

    for (int y = 0; y < height_; y++) {
        const uint8_t* row = bgra + static_cast<size_t>(y) * rowPitch;
        uint8_t* yRow = yPlane + static_cast<size_t>(y) * width_;
        for (int x = 0; x < width_; x++) {
            const uint8_t* px = row + static_cast<size_t>(x) * 4;
            const int b = px[0], g = px[1], r = px[2];
            yRow[x] = static_cast<uint8_t>(((66 * r + 129 * g + 25 * b + 128) >> 8) + 16);
        }
    }

    // Chroma 4:2:0 por amostragem direta (pixel superior-esquerdo de cada bloco 2x2), não média
    // completa — mais barato em CPU, qualidade suficiente pra conteúdo de tela/jogo (não é vídeo
    // de câmera com ruído fino onde a média de verdade compensaria o custo extra).
    for (int y = 0; y < height_; y += 2) {
        const uint8_t* row = bgra + static_cast<size_t>(y) * rowPitch;
        uint8_t* uvRow = uvPlane + static_cast<size_t>(y / 2) * width_;
        for (int x = 0; x < width_; x += 2) {
            const uint8_t* px = row + static_cast<size_t>(x) * 4;
            const int b = px[0], g = px[1], r = px[2];
            uvRow[x] = static_cast<uint8_t>(((-38 * r - 74 * g + 112 * b + 128) >> 8) + 128);
            uvRow[x + 1] = static_cast<uint8_t>(((112 * r - 94 * g - 18 * b + 128) >> 8) + 128);
        }
    }
}

void SoftwareEncoderCore::Destroy() {
    if (transform_) {
        transform_->ProcessMessage(MFT_MESSAGE_NOTIFY_END_OF_STREAM, 0);
        transform_->ProcessMessage(MFT_MESSAGE_NOTIFY_END_STREAMING, 0);
        transform_.Reset();
    }
    eventGen_.Reset();
    stagingTexture_.Reset();
    context_.Reset();
    if (mfStarted_) {
        MFShutdown();
        mfStarted_ = false;
    }
    if (comInitializedByUs_) {
        CoUninitialize();
        comInitializedByUs_ = false;
    }
}
