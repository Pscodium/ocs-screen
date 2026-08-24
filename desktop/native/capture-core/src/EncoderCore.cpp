#include "EncoderCore.h"
#include <stdexcept>
#include <wrl/client.h>

using Microsoft::WRL::ComPtr;

EncoderCore::EncoderCore() {}

EncoderCore::~EncoderCore() {
    Destroy();
}

bool EncoderCore::Initialize(ID3D11Device* device, int width, int height, int fps, int bitrateBps) {
    if (!device) return false;

    try {
        // ARGB (BGRA na memória, mesmo layout que o CaptureCore já produz) — evita converter pra
        // NV12 antes de encodar. NVENC aceita ARGB direto, só custa um pouco mais de banda de
        // memória interna que NV12 (não temos motivo pra otimizar isso agora).
        encoder_ = std::make_unique<NvEncoderD3D11>(device, static_cast<uint32_t>(width), static_cast<uint32_t>(height), NV_ENC_BUFFER_FORMAT_ARGB);

        initializeParams_ = { NV_ENC_INITIALIZE_PARAMS_VER };
        encodeConfig_ = { NV_ENC_CONFIG_VER };
        initializeParams_.encodeConfig = &encodeConfig_;

        // P4 (qualidade/velocidade equilibrada) + LOW_LATENCY — CLAUDE.md prioriza baixa latência
        // pra jogos/suporte remoto sobre nitidez máxima; P4 já é rápido o bastante pra manter
        // tempo real em qualquer GPU NVENC recente.
        encoder_->CreateDefaultEncoderParams(&initializeParams_, NV_ENC_CODEC_H264_GUID, NV_ENC_PRESET_P4_GUID, NV_ENC_TUNING_INFO_LOW_LATENCY);

        initializeParams_.encodeWidth = static_cast<uint32_t>(width);
        initializeParams_.encodeHeight = static_cast<uint32_t>(height);
        initializeParams_.darWidth = static_cast<uint32_t>(width);
        initializeParams_.darHeight = static_cast<uint32_t>(height);
        initializeParams_.frameRateNum = static_cast<uint32_t>(fps);
        initializeParams_.frameRateDen = 1;

        // CBR (bitrate constante) — mesmo espírito de `getMaxBitrate()` em types/stream.ts, valor
        // vem de fora (centralizado lá), não hardcoded aqui.
        encodeConfig_.rcParams.rateControlMode = NV_ENC_PARAMS_RC_CBR;
        encodeConfig_.rcParams.averageBitRate = static_cast<uint32_t>(bitrateBps);
        encodeConfig_.rcParams.maxBitRate = static_cast<uint32_t>(bitrateBps);
        // Sem B-frames — cada B-frame depende de um frame FUTURO, o que obriga o encoder a
        // segurar frames antes de devolver, direto contra baixa latência (CLAUDE.md §Latência).
        encodeConfig_.frameIntervalP = 1;
        // Keyframe a cada 2s — recuperação rápida de perda de pacote sem gerar keyframe (caro,
        // gera pico de bitrate) toda hora.
        encodeConfig_.gopLength = static_cast<uint32_t>(fps) * 2;
        encodeConfig_.encodeCodecConfig.h264Config.idrPeriod = encodeConfig_.gopLength;
        // Annex-B (start code 0x00000001 antes de cada NAL) — formato que dá pra escrever direto
        // num arquivo .h264 puro ou empacotar em RTP sem reprocessar.
        encodeConfig_.encodeCodecConfig.h264Config.repeatSPSPPS = 1;

        encoder_->CreateEncoder(&initializeParams_);

        ComPtr<ID3D11DeviceContext> ctx;
        device->GetImmediateContext(ctx.GetAddressOf());
        context_ = ctx.Detach();

        fps_ = fps;
        lastEncodeTime_ = std::chrono::steady_clock::time_point{};

        return true;
    } catch (const std::exception& e) {
        // Fica no stderr de propósito (não engolido em silêncio) — a mensagem do NVENC costuma
        // ser específica e acionável (ex.: "driver desatualizado, atualize"), diferente da maioria
        // dos outros erros deste addon que falham graciosamente sem detalhe.
        fprintf(stderr, "[EncoderCore] Initialize falhou: %s\n", e.what());
        encoder_.reset();
        return false;
    }
}

void EncoderCore::Destroy() {
    if (encoder_) {
        try {
            std::vector<NvEncOutputFrame> flush;
            encoder_->EndEncode(flush);
        } catch (...) {
            // Já estamos derrubando o encoder — não há mais nada útil a fazer com um erro aqui.
        }
        try {
            encoder_->DestroyEncoder();
        } catch (...) {
        }
        encoder_.reset();
    }
    if (context_) {
        context_->Release();
        context_ = nullptr;
    }
}

std::vector<std::vector<uint8_t>> EncoderCore::EncodeFrame(ID3D11Texture2D* frame) {
    std::vector<std::vector<uint8_t>> packets;
    if (!encoder_ || !context_ || !frame) return packets;

    const auto now = std::chrono::steady_clock::now();
    const auto minInterval = std::chrono::milliseconds(1000 / (fps_ > 0 ? fps_ : 30));
    if (lastEncodeTime_.time_since_epoch().count() != 0 && (now - lastEncodeTime_) < minInterval) {
        // Chamado rápido demais pro fps configurado — pula esse frame sem tocar no NVENC (nem
        // GetNextInputFrame nem CopyResource), pra manter o pacing real batendo com o que o NVENC
        // assume internamente pro cálculo de bitrate CBR.
        return packets;
    }
    lastEncodeTime_ = now;

    const NvEncInputFrame* inputFrame = encoder_->GetNextInputFrame();
    ID3D11Texture2D* encoderTexture = reinterpret_cast<ID3D11Texture2D*>(inputFrame->inputPtr);
    // GPU→GPU, mesmo device — não passa pela CPU. `frame` é a textura já composta (com cursor)
    // que o CaptureCore mantém viva por chamada de AcquireFrame.
    context_->CopyResource(encoderTexture, frame);

    try {
        std::vector<NvEncOutputFrame> vPacket;

        if (forceKeyframe_) {
            NV_ENC_PIC_PARAMS picParams = { NV_ENC_PIC_PARAMS_VER };
            picParams.encodePicFlags = NV_ENC_PIC_FLAG_FORCEIDR;
            encoder_->EncodeFrame(vPacket, &picParams);
            forceKeyframe_ = false;
        } else {
            encoder_->EncodeFrame(vPacket);
        }

        packets.reserve(vPacket.size());
        for (auto& p : vPacket) {
            packets.push_back(std::move(p.frame));
        }
    } catch (const std::exception&) {
        packets.clear();
    }

    return packets;
}

bool EncoderCore::SetBitrate(int bitrateBps) {
    if (!encoder_) return false;

    encodeConfig_.rcParams.averageBitRate = static_cast<uint32_t>(bitrateBps);
    encodeConfig_.rcParams.maxBitRate = static_cast<uint32_t>(bitrateBps);

    NV_ENC_RECONFIGURE_PARAMS reconfigureParams = { NV_ENC_RECONFIGURE_PARAMS_VER };
    reconfigureParams.reInitEncodeParams = initializeParams_;
    // forceIDR — o espectador só decodifica corretamente a partir de um keyframe; sem isso, o
    // primeiro frame codificado com o bitrate novo ainda referenciaria frames anteriores num
    // contexto de rate control diferente, e a troca não fica limpa visualmente.
    reconfigureParams.forceIDR = 1;

    try {
        return encoder_->Reconfigure(&reconfigureParams);
    } catch (const std::exception&) {
        return false;
    }
}

std::vector<std::vector<uint8_t>> EncoderCore::Flush() {
    std::vector<std::vector<uint8_t>> packets;
    if (!encoder_) return packets;

    try {
        std::vector<NvEncOutputFrame> vPacket;
        encoder_->EndEncode(vPacket);
        packets.reserve(vPacket.size());
        for (auto& p : vPacket) {
            packets.push_back(std::move(p.frame));
        }
    } catch (const std::exception&) {
        packets.clear();
    }

    return packets;
}
