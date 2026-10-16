#include "SoftwareEncoderCore.h"
#include <windows.h>
#include <mferror.h>
#include <d3d11_4.h> // ID3D11Multithread
#include <thread>
#include <algorithm>
#include <cstdio>
#include <cstdlib>

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
    pacer_.Reset(fps_);
    context_ = context;

    // `OCS_NO_HW_MFT=1` pula o hardware (testar o caminho de CPU numa máquina que tem hardware).
    const bool allowHardware = !getenv("OCS_NO_HW_MFT");
    if (allowHardware && TryInitialize(device, bitrateBps, codec, true)) {
        fprintf(stderr, "[SoftwareEncoderCore] usando MFT de HARDWARE (zero-copy).\n");
        return true;
    }
    if (TryInitialize(device, bitrateBps, codec, false)) {
        fprintf(stderr, "[SoftwareEncoderCore] usando encoder de CPU.\n");
        return true;
    }
    Destroy();
    return false;
}

void SoftwareEncoderCore::ReleaseTransform() {
    if (transform_) {
        transform_->ProcessMessage(MFT_MESSAGE_NOTIFY_END_OF_STREAM, 0);
        transform_->ProcessMessage(MFT_MESSAGE_NOTIFY_END_STREAMING, 0);
        if (hardware_) transform_->ProcessMessage(MFT_MESSAGE_SET_D3D_MANAGER, 0);
        transform_.Reset();
    }
    eventGen_.Reset();
    deviceManager_.Reset();
    for (int i = 0; i < kPoolSize; i++) {
        outputViews_[i].Reset();
        nv12Pool_[i].Reset();
    }
    inputView_.Reset();
    bgraCopy_.Reset();
    processor_.Reset();
    processorEnum_.Reset();
    videoContext_.Reset();
    videoDevice_.Reset();
    stagingTexture_.Reset();
    hardware_ = false;
}

namespace {
LUID AdapterLuidOf(ID3D11Device* device) {
    LUID luid{};
    ComPtr<IDXGIDevice> dxgiDevice;
    ComPtr<IDXGIAdapter> adapter;
    DXGI_ADAPTER_DESC desc{};
    if (SUCCEEDED(device->QueryInterface(IID_PPV_ARGS(&dxgiDevice))) && SUCCEEDED(dxgiDevice->GetAdapter(&adapter)) &&
        SUCCEEDED(adapter->GetDesc(&desc))) {
        luid = desc.AdapterLuid;
    }
    return luid;
}

// Cor sinalizada no stream (VUI) — mesma do NVENC (BT.709 limitado, ver EncoderCore.cpp): sem isso
// cada decoder chuta a matriz e BT.601 dá cor errada.
void SetBt709(IMFMediaType* type) {
    type->SetUINT32(MF_MT_VIDEO_PRIMARIES, MFVideoPrimaries_BT709);
    type->SetUINT32(MF_MT_TRANSFER_FUNCTION, MFVideoTransFunc_709);
    type->SetUINT32(MF_MT_YUV_MATRIX, MFVideoTransferMatrix_BT709);
    type->SetUINT32(MF_MT_VIDEO_NOMINAL_RANGE, MFNominalRange_16_235);
}
} // namespace

bool SoftwareEncoderCore::TryInitialize(ID3D11Device* device, int bitrateBps, VideoCodecType codec, bool hardware) {
    ReleaseTransform();
    hardware_ = hardware;

    // MFVideoFormat_AV1 existe desde o Windows 10 2004 (headers), mas o Windows NÃO garante um MFT
    // de encode AV1 embutido (ao contrário do H.264, que sempre tem) — `MFTEnumEx` abaixo
    // simplesmente não acha nada nesse caso e retorna false, deixando a cascata do EncoderCore cair
    // pro H.264. HEVC idem (por hardware costuma existir; por CPU, não).
    const GUID outSubtype = codec == VideoCodecType::HEVC ? MFVideoFormat_HEVC
        : codec == VideoCodecType::AV1 ? MFVideoFormat_AV1
        : MFVideoFormat_H264;
    MFT_REGISTER_TYPE_INFO inType{ MFMediaType_Video, MFVideoFormat_NV12 };
    MFT_REGISTER_TYPE_INFO outType{ MFMediaType_Video, outSubtype };
    IMFActivate** activates = nullptr;
    UINT32 activateCount = 0;
    const UINT32 flags = hardware ? (MFT_ENUM_FLAG_HARDWARE | MFT_ENUM_FLAG_SORTANDFILTER)
                                  : (MFT_ENUM_FLAG_SYNCMFT | MFT_ENUM_FLAG_ASYNCMFT | MFT_ENUM_FLAG_LOCALMFT | MFT_ENUM_FLAG_SORTANDFILTER);
    HRESULT hr = MFTEnumEx(MFT_CATEGORY_VIDEO_ENCODER, flags, &inType, &outType, &activates, &activateCount);
    if (FAILED(hr) || activateCount == 0) {
        if (activates) CoTaskMemFree(activates);
        return false;
    }

    // Hardware: só o MFT do MESMO adaptador do device de captura — o de outra GPU (ex.: NVIDIA num
    // notebook com a tela na iGPU) não aceita textura deste device.
    const LUID deviceLuid = AdapterLuidOf(device);
    for (UINT32 i = 0; i < activateCount && !transform_; i++) {
        if (hardware) {
            LUID mftLuid{};
            UINT32 size = 0;
            if (SUCCEEDED(activates[i]->GetBlob(MFT_ENUM_ADAPTER_LUID, reinterpret_cast<UINT8*>(&mftLuid), sizeof(mftLuid), &size)) &&
                (mftLuid.LowPart != deviceLuid.LowPart || mftLuid.HighPart != deviceLuid.HighPart)) {
                continue;
            }
        }
        if (SUCCEEDED(activates[i]->ActivateObject(IID_PPV_ARGS(&transform_))) && transform_) {
            WCHAR name[256] = {};
            UINT32 len = 0;
            if (SUCCEEDED(activates[i]->GetString(MFT_FRIENDLY_NAME_Attribute, name, 256, &len))) {
                fprintf(stderr, "[SoftwareEncoderCore] MFT: %ls\n", name);
            }
        }
    }
    for (UINT32 i = 0; i < activateCount; i++) activates[i]->Release();
    CoTaskMemFree(activates);
    if (!transform_) return false;

    // Encoders MF são ASSÍNCRONOS desde o Win8 (os de hardware, sempre) — precisa "destravar"
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
        attrs->SetUINT32(MF_LOW_LATENCY, TRUE);
    }
    if (hardware && !eventGen_) return false;

    if (hardware) {
        // O MFT usa o device de outras threads — sem proteção multithread o contexto imediato
        // (compartilhado com a captura) teria estado corrompido.
        ComPtr<ID3D11Multithread> mt;
        if (SUCCEEDED(device->QueryInterface(IID_PPV_ARGS(&mt)))) mt->SetMultithreadProtected(TRUE);
        if (FAILED(MFCreateDXGIDeviceManager(&resetToken_, &deviceManager_)) || FAILED(deviceManager_->ResetDevice(device, resetToken_))) return false;
        if (FAILED(transform_->ProcessMessage(MFT_MESSAGE_SET_D3D_MANAGER, reinterpret_cast<ULONG_PTR>(deviceManager_.Get())))) return false;
        if (!SetupVideoProcessor(device)) return false;
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
    SetBt709(mfOutType.Get());
    if (codec == VideoCodecType::H264) {
        mfOutType->SetUINT32(MF_MT_MPEG2_PROFILE, 100); // eAVEncH264VProfile_High — mesmo profile que o NVENC já produz (ver EncoderCore.cpp)
    }
    // HEVC: deixa o MFT escolher o profile padrão dele (Main) — `MF_MT_MPEG2_PROFILE` usa a mesma
    // chave de atributo pros dois codecs, mas os valores do enum `eAVEncH264VProfile` não são
    // válidos pro perfil HEVC (`eAVEncH265VProfile`, valores diferentes) — melhor não setar do que
    // setar um valor de enum errado pro codec ativo.
    if (FAILED(transform_->SetOutputType(0, mfOutType.Get(), 0))) return false;

    ComPtr<IMFMediaType> mfInType;
    MFCreateMediaType(&mfInType);
    mfInType->SetGUID(MF_MT_MAJOR_TYPE, MFMediaType_Video);
    mfInType->SetGUID(MF_MT_SUBTYPE, MFVideoFormat_NV12);
    MFSetAttributeSize(mfInType.Get(), MF_MT_FRAME_SIZE, width_, height_);
    MFSetAttributeRatio(mfInType.Get(), MF_MT_FRAME_RATE, fps_, 1);
    MFSetAttributeRatio(mfInType.Get(), MF_MT_PIXEL_ASPECT_RATIO, 1, 1);
    mfInType->SetUINT32(MF_MT_INTERLACE_MODE, MFVideoInterlace_Progressive);
    SetBt709(mfInType.Get());
    if (FAILED(transform_->SetInputType(0, mfInType.Get(), 0))) return false;

    // CBR + baixa latência + sem B-frame + GOP de 2s — mesmo espírito do EncoderCore (NVENC)
    // (CLAUDE.md §Latência). Best-effort: nem todo MFT expõe ICodecAPI ou aceita todo parâmetro.
    CodecApiHelper::SetRateControlCbr(transform_.Get());
    CodecApiHelper::SetMeanBitRate(transform_.Get(), static_cast<unsigned long>(bitrateBps));
    CodecApiHelper::SetLowLatency(transform_.Get());
    CodecApiHelper::SetNoBFrames(transform_.Get());
    CodecApiHelper::SetGopSize(transform_.Get(), static_cast<unsigned long>(fps_ * 2));

    if (!hardware && !CreateStagingTexture(width_, height_)) return false;

    if (FAILED(transform_->ProcessMessage(MFT_MESSAGE_NOTIFY_BEGIN_STREAMING, 0))) return false;
    if (FAILED(transform_->ProcessMessage(MFT_MESSAGE_NOTIFY_START_OF_STREAM, 0))) return false;
    needsInput_ = !eventGen_; // assíncrono: espera o 1º METransformNeedInput
    return true;
}

// BGRA (captura) → NV12 na GPU, BT.709 limitado. Cópia própria da textura de captura porque a
// view de entrada do video processor exige bind que a textura da captura não necessariamente tem.
bool SoftwareEncoderCore::SetupVideoProcessor(ID3D11Device* device) {
    if (FAILED(device->QueryInterface(IID_PPV_ARGS(&videoDevice_)))) return false;
    if (FAILED(context_.As(&videoContext_))) return false;

    D3D11_VIDEO_PROCESSOR_CONTENT_DESC content{};
    content.InputFrameFormat = D3D11_VIDEO_FRAME_FORMAT_PROGRESSIVE;
    content.InputWidth = width_;
    content.InputHeight = height_;
    content.OutputWidth = width_;
    content.OutputHeight = height_;
    content.InputFrameRate = {static_cast<UINT>(fps_), 1};
    content.OutputFrameRate = {static_cast<UINT>(fps_), 1};
    content.Usage = D3D11_VIDEO_USAGE_OPTIMAL_SPEED;
    if (FAILED(videoDevice_->CreateVideoProcessorEnumerator(&content, &processorEnum_))) return false;
    if (FAILED(videoDevice_->CreateVideoProcessor(processorEnum_.Get(), 0, &processor_))) return false;

    D3D11_TEXTURE2D_DESC desc{};
    desc.Width = width_;
    desc.Height = height_;
    desc.MipLevels = 1;
    desc.ArraySize = 1;
    desc.Format = DXGI_FORMAT_B8G8R8A8_UNORM;
    desc.SampleDesc.Count = 1;
    desc.Usage = D3D11_USAGE_DEFAULT;
    desc.BindFlags = D3D11_BIND_RENDER_TARGET | D3D11_BIND_SHADER_RESOURCE;
    if (FAILED(device->CreateTexture2D(&desc, nullptr, &bgraCopy_))) return false;
    D3D11_VIDEO_PROCESSOR_INPUT_VIEW_DESC inDesc{};
    inDesc.ViewDimension = D3D11_VPIV_DIMENSION_TEXTURE2D;
    if (FAILED(videoDevice_->CreateVideoProcessorInputView(bgraCopy_.Get(), processorEnum_.Get(), &inDesc, &inputView_))) return false;

    desc.Format = DXGI_FORMAT_NV12;
    for (int i = 0; i < kPoolSize; i++) {
        desc.BindFlags = D3D11_BIND_RENDER_TARGET | D3D11_BIND_VIDEO_ENCODER;
        if (FAILED(device->CreateTexture2D(&desc, nullptr, &nv12Pool_[i]))) {
            desc.BindFlags = D3D11_BIND_RENDER_TARGET; // driver sem BIND_VIDEO_ENCODER pra NV12
            if (FAILED(device->CreateTexture2D(&desc, nullptr, &nv12Pool_[i]))) return false;
        }
        D3D11_VIDEO_PROCESSOR_OUTPUT_VIEW_DESC outDesc{};
        outDesc.ViewDimension = D3D11_VPOV_DIMENSION_TEXTURE2D;
        if (FAILED(videoDevice_->CreateVideoProcessorOutputView(nv12Pool_[i].Get(), processorEnum_.Get(), &outDesc, &outputViews_[i]))) return false;
    }

    ComPtr<ID3D11VideoContext1> videoContext1;
    if (SUCCEEDED(videoContext_.As(&videoContext1))) {
        videoContext1->VideoProcessorSetStreamColorSpace1(processor_.Get(), 0, DXGI_COLOR_SPACE_RGB_FULL_G22_NONE_P709);
        videoContext1->VideoProcessorSetOutputColorSpace1(processor_.Get(), DXGI_COLOR_SPACE_YCBCR_STUDIO_G22_LEFT_P709);
    } else {
        D3D11_VIDEO_PROCESSOR_COLOR_SPACE in{};
        in.RGB_Range = 0; // full
        videoContext_->VideoProcessorSetStreamColorSpace(processor_.Get(), 0, &in);
        D3D11_VIDEO_PROCESSOR_COLOR_SPACE out{};
        out.YCbCr_Matrix = 1; // BT.709
        out.Nominal_Range = D3D11_VIDEO_PROCESSOR_NOMINAL_RANGE_16_235;
        videoContext_->VideoProcessorSetOutputColorSpace(processor_.Get(), &out);
    }
    videoContext_->VideoProcessorSetStreamFrameFormat(processor_.Get(), 0, D3D11_VIDEO_FRAME_FORMAT_PROGRESSIVE);
    videoContext_->VideoProcessorSetStreamAutoProcessingMode(processor_.Get(), 0, FALSE);
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
    if (!pacer_.ShouldEncode(std::chrono::steady_clock::now())) return packets;

    PumpEvents(packets); // drena output pronto + atualiza needsInput_ (MFT assíncrono)
    if (eventGen_ && !needsInput_) return packets; // MFT ainda processando o frame anterior — pula esse, mesmo espírito do skip de pacing do NVENC

    try {
        ComPtr<IMFSample> sample;
        MFCreateSample(&sample);
        ComPtr<IMFMediaBuffer> buffer;

        if (hardware_) {
            // Zero-copy: BGRA → NV12 na GPU, e a própria textura NV12 vai pro encoder.
            context_->CopyResource(bgraCopy_.Get(), frame);
            const int slot = poolIndex_;
            poolIndex_ = (poolIndex_ + 1) % kPoolSize;
            D3D11_VIDEO_PROCESSOR_STREAM stream{};
            stream.Enable = TRUE;
            stream.pInputSurface = inputView_.Get();
            if (FAILED(videoContext_->VideoProcessorBlt(processor_.Get(), outputViews_[slot].Get(), 0, 1, &stream))) return packets;
            if (FAILED(MFCreateDXGISurfaceBuffer(__uuidof(ID3D11Texture2D), nv12Pool_[slot].Get(), 0, FALSE, &buffer))) return packets;
            ComPtr<IMF2DBuffer> buffer2d;
            DWORD length = 0;
            if (SUCCEEDED(buffer.As(&buffer2d)) && SUCCEEDED(buffer2d->GetContiguousLength(&length))) buffer->SetCurrentLength(length);
        } else {
            context_->CopyResource(stagingTexture_.Get(), frame);
            D3D11_MAPPED_SUBRESOURCE mapped{};
            if (FAILED(context_->Map(stagingTexture_.Get(), 0, D3D11_MAP_READ, 0, &mapped))) return packets;

            const size_t nv12Size = static_cast<size_t>(width_) * height_ * 3 / 2;
            if (nv12Scratch_.size() != nv12Size) nv12Scratch_.resize(nv12Size);
            BgraToNv12(static_cast<const uint8_t*>(mapped.pData), mapped.RowPitch, nv12Scratch_.data());
            context_->Unmap(stagingTexture_.Get(), 0);

            MFCreateMemoryBuffer(static_cast<DWORD>(nv12Size), &buffer);
            BYTE* dst = nullptr;
            buffer->Lock(&dst, nullptr, nullptr);
            memcpy(dst, nv12Scratch_.data(), nv12Size);
            buffer->Unlock();
            buffer->SetCurrentLength(static_cast<DWORD>(nv12Size));
        }
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
            if (!eventGen_) {
                DrainOutput(packets); // MFT síncrono (raro): output pode já estar pronto na hora
            } else if (hardware_) {
                // Espera o pacote DESTE frame (encode de hardware leva poucos ms) em vez de só
                // pegá-lo na próxima chamada — senão todo frame sairia 1 frame atrasado (e com a
                // tela parada, preso até a tela mudar). Teto de 1 intervalo de frame.
                const auto deadline = std::chrono::steady_clock::now() + std::chrono::microseconds(frameDuration100ns_ / 10);
                // `sleep_for` no Windows dorme no mínimo 1 tick do timer (até 15.6ms) — medido: 14.5ms
                // por frame só de espera. Timer de alta resolução dorme os 0.5ms pedidos.
                static thread_local HANDLE timer = CreateWaitableTimerExW(nullptr, nullptr, CREATE_WAITABLE_TIMER_HIGH_RESOLUTION, TIMER_ALL_ACCESS);
                while (packets.empty() && std::chrono::steady_clock::now() < deadline) {
                    LARGE_INTEGER due{};
                    due.QuadPart = -5000; // 0.5ms, relativo, em 100ns
                    if (timer && SetWaitableTimer(timer, &due, 0, nullptr, nullptr, FALSE)) WaitForSingleObject(timer, 5);
                    else std::this_thread::yield();
                    PumpEvents(packets);
                }
            }
        }
        // MF_E_NOTACCEPTING: MFT ainda não terminou o anterior — frame descartado de propósito,
        // próximo tick tenta de novo (mesma filosofia do skip de pacing do NVENC).
    } catch (...) {
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

// BT.709 limitado (16-235), mesma matriz sinalizada no stream (`SetBt709`) e usada pelo NVENC —
// antes eram coeficientes BT.601 sem nada sinalizado no stream: cada decoder chutava a matriz e a cor
// saía deslocada.
void SoftwareEncoderCore::BgraToNv12(const uint8_t* bgra, uint32_t rowPitch, uint8_t* nv12) {
    uint8_t* yPlane = nv12;
    uint8_t* uvPlane = nv12 + static_cast<size_t>(width_) * height_;

    for (int y = 0; y < height_; y++) {
        const uint8_t* row = bgra + static_cast<size_t>(y) * rowPitch;
        uint8_t* yRow = yPlane + static_cast<size_t>(y) * width_;
        for (int x = 0; x < width_; x++) {
            const uint8_t* px = row + static_cast<size_t>(x) * 4;
            const int b = px[0], g = px[1], r = px[2];
            yRow[x] = static_cast<uint8_t>(((47 * r + 157 * g + 16 * b + 128) >> 8) + 16);
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
            uvRow[x] = static_cast<uint8_t>(((-26 * r - 87 * g + 112 * b + 128) >> 8) + 128);
            uvRow[x + 1] = static_cast<uint8_t>(((112 * r - 102 * g - 10 * b + 128) >> 8) + 128);
        }
    }
}

void SoftwareEncoderCore::Destroy() {
    ReleaseTransform();
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
