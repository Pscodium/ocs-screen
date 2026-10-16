#pragma once

#include <d3d11_1.h>
#include <mfapi.h>
#include <mfidl.h>
#include <mftransform.h>
#include <wrl/client.h>
#include <atomic>
#include <chrono>
#include <cstdint>
#include <vector>

#include "CodecApiHelper.h" // não usa <codecapi.h> direto aqui — ver comentário no próprio header
#include "VideoCodecType.h"
#include "FramePacer.h"

using Microsoft::WRL::ComPtr;

// Fallback de encoder quando o NVENC não inicializa (GPU não-NVIDIA, driver desatualizado,
// notebook híbrido com a tela ligada na iGPU), via Media Foundation — ver docs/NATIVE_CAPTURE.md
// Fase 3 "Fallback de encoder por software". Duas tentativas, nessa ordem:
//
// 1) MFT de HARDWARE (Intel Quick Sync, AMD AMF, NVIDIA via MF...) do MESMO adaptador do device de
//    captura (`MFT_ENUM_ADAPTER_LUID`) — zero-copy: textura BGRA → NV12 na GPU
//    (`ID3D11VideoProcessor`, BT.709 limitado) → `IMFDXGIDeviceManager` → encoder. Num notebook
//    Optimus a tela fica na iGPU, o device de captura também, e o NVENC (na dGPU) não aceita
//    textura de outro adaptador — esse caminho usa o encoder da própria iGPU.
// 2) Encoder de SOFTWARE da Microsoft (`MFTEnumEx` sem flag de hardware só lista os de CPU): readback
//    da textura pra CPU + BGRA→NV12 manual. Pesado, mas funciona em qualquer Windows.
//
// Os encoders MF de H.264 são ASSÍNCRONOS (precisam de `MF_TRANSFORM_ASYNC_UNLOCK` + bombear
// eventos `METransformNeedInput`/`METransformHaveOutput` via `IMFMediaEventGenerator`, não dá pra
// só chamar `ProcessInput`/`ProcessOutput` direto como um MFT síncrono).
class SoftwareEncoderCore {
public:
    SoftwareEncoderCore();
    ~SoftwareEncoderCore();

    // `device`/`context` só são usados pra criar a staging texture de readback (mesmo device do
    // CaptureCore, pra poder receber a textura já composta via CopyResource sem misturar devices).
    bool Initialize(ID3D11Device* device, ID3D11DeviceContext* context, int width, int height, int fps, int bitrateBps, VideoCodecType codec);
    void Destroy();

    // Mesmo pacing de grade fixa que o EncoderCore (NVENC) usa — ver comentário lá. Faz o
    // readback BGRA→CPU, converte pra NV12, alimenta o MFT e drena qualquer pacote H.264 já
    // pronto (Annex-B, mesmo formato que o caminho NVENC produz).
    std::vector<std::vector<uint8_t>> EncodeFrame(ID3D11Texture2D* frame);
    std::vector<std::vector<uint8_t>> Flush();

    // `forceKeyframe` (padrão true) — ver comentário no EncoderCore.h (mesmo raciocínio: AIMD de
    // congestionamento passa `false` pra não injetar keyframe grande bem na hora que já tá represado).
    bool SetBitrate(int bitrateBps, bool forceKeyframe = true);
    void ForceKeyframe() { forceKeyframe_.store(true, std::memory_order_relaxed); }
    bool KeyframePending() const { return forceKeyframe_.load(std::memory_order_relaxed); }

    bool IsInitialized() const { return transform_ != nullptr; }
    // true = MFT de hardware (caminho 1 acima); false = encoder de CPU.
    bool IsHardware() const { return hardware_; }
    VideoCodecType GetActiveCodec() const { return activeCodec_; }

private:
    VideoCodecType activeCodec_ = VideoCodecType::H264;
    ComPtr<IMFTransform> transform_;
    ComPtr<IMFMediaEventGenerator> eventGen_;
    ComPtr<ID3D11DeviceContext> context_;
    ComPtr<ID3D11Texture2D> stagingTexture_;

    int width_ = 0;
    int height_ = 0;
    int fps_ = 30;
    bool mfStarted_ = false;
    bool comInitializedByUs_ = false;
    bool needsInput_ = false;
    std::atomic<bool> forceKeyframe_{false};
    FramePacer pacer_; // ver FramePacer.h
    LONGLONG frameDuration100ns_ = 0; // duração de 1 frame em unidades de 100ns (MF usa isso pra timestamp/duration)
    LONGLONG sampleTime_ = 0;
    std::vector<uint8_t> nv12Scratch_; // reaproveitado frame a frame, evita realocar todo quadro

    // Caminho de hardware (zero-copy) — ver comentário da classe.
    bool hardware_ = false;
    UINT resetToken_ = 0;
    ComPtr<IMFDXGIDeviceManager> deviceManager_;
    ComPtr<ID3D11VideoDevice> videoDevice_;
    ComPtr<ID3D11VideoContext> videoContext_;
    ComPtr<ID3D11VideoProcessorEnumerator> processorEnum_;
    ComPtr<ID3D11VideoProcessor> processor_;
    ComPtr<ID3D11Texture2D> bgraCopy_; // cópia da textura de captura com bind de vídeo
    ComPtr<ID3D11VideoProcessorInputView> inputView_;
    // O MFT segura a superfície de entrada até terminar o encode — anel pra não sobrescrever uma
    // que ainda está na fila dele.
    static constexpr int kPoolSize = 4;
    ComPtr<ID3D11Texture2D> nv12Pool_[kPoolSize];
    ComPtr<ID3D11VideoProcessorOutputView> outputViews_[kPoolSize];
    int poolIndex_ = 0;

    bool TryInitialize(ID3D11Device* device, int bitrateBps, VideoCodecType codec, bool hardware);
    bool SetupVideoProcessor(ID3D11Device* device);
    void ReleaseTransform();
    bool SubmitSample(IMFSample* sample, std::vector<std::vector<uint8_t>>& packets);

    bool CreateStagingTexture(int width, int height);
    void BgraToNv12(const uint8_t* bgra, uint32_t rowPitch, uint8_t* nv12);
    // Drena qualquer evento já disponível (NÃO bloqueia) — chamado antes de ProcessInput (pra
    // saber se o MFT já pediu mais entrada) e depois (pra coletar output pronto).
    void PumpEvents(std::vector<std::vector<uint8_t>>& outPackets);
    void DrainOutput(std::vector<std::vector<uint8_t>>& outPackets);
};
