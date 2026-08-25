#pragma once

#include <d3d11.h>
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

using Microsoft::WRL::ComPtr;

// Fallback de encoder H.264 por SOFTWARE, via Media Foundation (`CLSID_CMSH264EncoderMFT`,
// descoberto por `MFTEnumEx` em vez de hardcoded — funciona em qualquer Windows 10/11 sem
// dependência externa nenhuma, built-in do SO). Usado quando `EncoderCore` não consegue
// inicializar o NVENC (GPU não-NVIDIA, driver desatualizado, ou sem GPU dedicada nenhuma) — ver
// docs/NATIVE_CAPTURE.md Fase 3 "Fallback de encoder por software".
//
// Diferente do caminho NVENC (zero-copy GPU→GPU), esse caminho PRECISA de readback pra CPU — o
// encoder de software da Microsoft só aceita entrada em memória do sistema (NV12), não texturas
// D3D11 diretamente. Mantém staging texture própria (BGRA) + conversão BGRA→NV12 manual em CPU.
// Mais lento que NVENC, mas é o fallback — sem GPU compatível, não tem caminho zero-copy possível
// de qualquer forma.
//
// A Microsoft H264 Encoder MFT é ASSÍNCRONA (precisa de `MF_TRANSFORM_ASYNC_UNLOCK` + bombear
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

    bool IsInitialized() const { return transform_ != nullptr; }
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
    std::chrono::steady_clock::time_point nextEncodeTime_{};
    LONGLONG frameDuration100ns_ = 0; // duração de 1 frame em unidades de 100ns (MF usa isso pra timestamp/duration)
    LONGLONG sampleTime_ = 0;
    std::vector<uint8_t> nv12Scratch_; // reaproveitado frame a frame, evita realocar todo quadro

    bool CreateStagingTexture(int width, int height);
    void BgraToNv12(const uint8_t* bgra, uint32_t rowPitch, uint8_t* nv12);
    // Drena qualquer evento já disponível (NÃO bloqueia) — chamado antes de ProcessInput (pra
    // saber se o MFT já pediu mais entrada) e depois (pra coletar output pronto).
    void PumpEvents(std::vector<std::vector<uint8_t>>& outPackets);
    void DrainOutput(std::vector<std::vector<uint8_t>>& outPackets);
};
