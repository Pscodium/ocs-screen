#include "EncoderCore.h"
#include <stdexcept>
#include <wrl/client.h>

using Microsoft::WRL::ComPtr;

EncoderCore::EncoderCore() {}

void EncoderCore::ForceKeyframe() {
    if (software_) {
        software_->ForceKeyframe();
        return;
    }
    forceKeyframe_.store(true, std::memory_order_relaxed);
}

EncoderCore::~EncoderCore() {
    Destroy();
}

bool EncoderCore::Initialize(ID3D11Device* device, int width, int height, int fps, int bitrateBps, VideoCodecType codec) {
    if (!device) return false;

    // Cascata de 4 níveis: NVENC no codec pedido → NVENC H.264 (só se pediu HEVC e a GPU/driver
    // não suporta) → software no codec pedido → software H.264. `activeCodec_` reflete o que
    // REALMENTE ficou de pé em cada tentativa — o chamador (main process) lê `GetActiveCodec()`
    // depois pra saber o que negociar com o transporte/viewer, nunca assume que o pedido foi
    // atendido.
    activeCodec_ = codec;
    if (InitializeNvenc(device, width, height, fps, bitrateBps, codec)) return true;

    if (codec != VideoCodecType::H264) {
        fprintf(stderr, "[EncoderCore] NVENC não suporta o codec pedido (HEVC) — tentando NVENC H.264 antes de cair pro software.\n");
        activeCodec_ = VideoCodecType::H264;
        if (InitializeNvenc(device, width, height, fps, bitrateBps, VideoCodecType::H264)) return true;
    }

    // NVENC indisponível (GPU não-NVIDIA, driver desatualizado, ou sem GPU dedicada) — fallback
    // pro encoder via Media Foundation (`SoftwareEncoderCore`, ver docs/NATIVE_CAPTURE.md Fase 3
    // "Fallback de encoder por software"). Mais pesado em CPU que NVENC (readback GPU→CPU +
    // conversão BGRA→NV12 manual), mas funciona em qualquer Windows sem depender de hardware
    // NVIDIA — melhor que a transmissão simplesmente não funcionar.
    fprintf(stderr, "[EncoderCore] NVENC indisponível — caindo pro fallback de software (Media Foundation).\n");
    encoder_.reset();

    ComPtr<ID3D11DeviceContext> ctx;
    device->GetImmediateContext(ctx.GetAddressOf());

    activeCodec_ = codec;
    software_ = std::make_unique<SoftwareEncoderCore>();
    if (software_->Initialize(device, ctx.Get(), width, height, fps, bitrateBps, codec)) return true;

    if (codec != VideoCodecType::H264) {
        fprintf(stderr, "[EncoderCore] MFT de HEVC indisponível nessa máquina — caindo pro software H.264.\n");
        activeCodec_ = VideoCodecType::H264;
        if (software_->Initialize(device, ctx.Get(), width, height, fps, bitrateBps, VideoCodecType::H264)) return true;
    }

    fprintf(stderr, "[EncoderCore] fallback de software também falhou — nenhum encoder H.264 disponível.\n");
    software_.reset();
    return false;
}

bool EncoderCore::InitializeNvenc(ID3D11Device* device, int width, int height, int fps, int bitrateBps, VideoCodecType codec) {
    try {
        // ARGB (BGRA na memória, mesmo layout que o CaptureCore já produz) — evita converter pra
        // NV12 antes de encodar. NVENC aceita ARGB direto, só custa um pouco mais de banda de
        // memória interna que NV12 (não temos motivo pra otimizar isso agora).
        encoder_ = std::make_unique<NvEncoderD3D11>(device, static_cast<uint32_t>(width), static_cast<uint32_t>(height), NV_ENC_BUFFER_FORMAT_ARGB);

        initializeParams_ = { NV_ENC_INITIALIZE_PARAMS_VER };
        encodeConfig_ = { NV_ENC_CONFIG_VER };
        initializeParams_.encodeConfig = &encodeConfig_;

        const GUID codecGuid = codec == VideoCodecType::HEVC ? NV_ENC_CODEC_HEVC_GUID : NV_ENC_CODEC_H264_GUID;

        // P4 (qualidade/velocidade equilibrada) + LOW_LATENCY — CLAUDE.md prioriza baixa latência
        // pra jogos/suporte remoto sobre nitidez máxima; P4 já é rápido o bastante pra manter
        // tempo real em qualquer GPU NVENC recente.
        encoder_->CreateDefaultEncoderParams(&initializeParams_, codecGuid, NV_ENC_PRESET_P4_GUID, NV_ENC_TUNING_INFO_LOW_LATENCY);

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
        // VBV (Video Buffering Verifier) — sem isso, CBR só controla a MÉDIA ao longo do GOP, não
        // o tamanho de CADA frame. Motivo original de ter isso (ver histórico): P-frames de
        // 100KB+ estourando o pacer RTP — MAS o pacer (PacingHandler) já foi removido de vez (bug
        // real na lib, ver TransportCore.h) e o vídeo vai por DataChannel/SCTP confiável, que não
        // liga pro tamanho de cada frame individual. Ou seja, o motivo que justificava um VBV
        // ULTRA apertado (~1 frame de orçamento) não existe mais — e um VBV tão curto força o
        // rate controller a jogar qualidade fora bruscamente em cena complexa (texto/código tem
        // muito detalhe) pra caber no orçamento, o que é o próprio "frame mal renderizado"/
        // aberração visual periódica medida em produção. 3 frames de orçamento ainda é bem curto
        // pra latência (CLAUDE.md §Latência) mas dá folga real pro rate controller não colapsar
        // qualidade tão bruscamente.
        encodeConfig_.rcParams.vbvBufferSize =
            (static_cast<uint32_t>(bitrateBps) / static_cast<uint32_t>(fps > 0 ? fps : 30)) * 3;
        encodeConfig_.rcParams.vbvInitialDelay = encodeConfig_.rcParams.vbvBufferSize;
        // Sem B-frames — cada B-frame depende de um frame FUTURO, o que obriga o encoder a
        // segurar frames antes de devolver, direto contra baixa latência (CLAUDE.md §Latência).
        encodeConfig_.frameIntervalP = 1;
        // Keyframe a cada 2s — recuperação rápida de perda de pacote sem gerar keyframe (caro,
        // gera pico de bitrate) toda hora.
        encodeConfig_.gopLength = static_cast<uint32_t>(fps) * 2;
        if (codec == VideoCodecType::HEVC) {
            encodeConfig_.encodeCodecConfig.hevcConfig.idrPeriod = encodeConfig_.gopLength;
            // Annex-B com VPS/SPS/PPS repetidos em cada keyframe — mesmo raciocínio do H.264
            // (repeatSPSPPS) logo abaixo, campo espelhado na struct de config do HEVC.
            encodeConfig_.encodeCodecConfig.hevcConfig.repeatSPSPPS = 1;
        } else {
            encodeConfig_.encodeCodecConfig.h264Config.idrPeriod = encodeConfig_.gopLength;
            // Annex-B (start code 0x00000001 antes de cada NAL) — formato que dá pra escrever direto
            // num arquivo .h264 puro ou empacotar em RTP sem reprocessar.
            encodeConfig_.encodeCodecConfig.h264Config.repeatSPSPPS = 1;
        }

        encoder_->CreateEncoder(&initializeParams_);

        ComPtr<ID3D11DeviceContext> ctx;
        device->GetImmediateContext(ctx.GetAddressOf());
        context_ = ctx.Detach();

        fps_ = fps;
        nextEncodeTime_ = std::chrono::steady_clock::time_point{};

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
    if (software_) {
        software_->Destroy();
        software_.reset();
    }
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
    // Fallback de software pacia e converte formato sozinho — delega direto, sem duplicar a
    // lógica de pacing/grade fixa daqui (que é específica do caminho NVENC zero-copy).
    if (software_) return software_->EncodeFrame(frame);

    std::vector<std::vector<uint8_t>> packets;
    if (!encoder_ || !context_ || !frame) return packets;

    const auto now = std::chrono::steady_clock::now();
    // Duração em ponto flutuante (não `milliseconds(1000/fps)`, que truncava 60fps pra 16ms em
    // vez de 16.667ms real — erro pequeno mas sistemático) convertida pro tick nativo do
    // steady_clock.
    const auto interval = std::chrono::duration_cast<std::chrono::steady_clock::duration>(
        std::chrono::duration<double>(1.0 / (fps_ > 0 ? fps_ : 30)));

    if (nextEncodeTime_.time_since_epoch().count() != 0 && now < nextEncodeTime_) {
        // Chamado rápido demais pro fps configurado — pula esse frame sem tocar no NVENC (nem
        // GetNextInputFrame nem CopyResource), pra manter o pacing real batendo com o que o NVENC
        // assume internamente pro cálculo de bitrate CBR.
        return packets;
    }

    if (nextEncodeTime_.time_since_epoch().count() == 0 || now - nextEncodeTime_ > interval) {
        // Primeira chamada, ou ficamos muito atrás da grade (stall grande) — resincroniza em vez
        // de tentar recuperar o atraso de uma vez (isso geraria uma rajada de frames aceitos em
        // sequência).
        nextEncodeTime_ = now + interval;
    } else {
        // Soma o intervalo à grade FIXA, não reinicia contando do "agora" — um frame individual
        // aceito um pouco atrasado não desloca o relógio inteiro pra frente permanentemente
        // (isso era o que causava jitter acumulado, medido em produção como "micro engasgadas"
        // mesmo com fps médio bom).
        nextEncodeTime_ += interval;
    }

    // TUDO que toca o NVENC/D3D11 daqui pra baixo entra no try — `GetNextInputFrame()` e
    // `CopyResource()` estavam FORA do try antes, sem proteção nenhuma. Sob contenção pesada de
    // GPU (jogo 3D + nosso encode disputando), o wrapper `NvEncoderD3D11` pode lançar exceção
    // logo em `GetNextInputFrame()` (pool de buffer de entrada esgotado/em estado ruim) — sem
    // captura ali, essa exceção escapava sem ser pega e derrubava o processo inteiro (medido em
    // produção: crash sob carga de jogo pesado, sem log nenhum antes — pilha do dump mostra
    // exatamente `EncoderCore`↔`nvEncodeAPI64.dll` na hora do crash).
    try {
        const NvEncInputFrame* inputFrame = encoder_->GetNextInputFrame();
        ID3D11Texture2D* encoderTexture = reinterpret_cast<ID3D11Texture2D*>(inputFrame->inputPtr);
        // GPU→GPU, mesmo device — não passa pela CPU. `frame` é a textura já composta (com
        // cursor) que o CaptureCore mantém viva por chamada de AcquireFrame.
        context_->CopyResource(encoderTexture, frame);

        std::vector<NvEncOutputFrame> vPacket;

        if (forceKeyframe_.exchange(false, std::memory_order_relaxed)) {
            NV_ENC_PIC_PARAMS picParams = { NV_ENC_PIC_PARAMS_VER };
            picParams.encodePicFlags = NV_ENC_PIC_FLAG_FORCEIDR;
            encoder_->EncodeFrame(vPacket, &picParams);
        } else {
            encoder_->EncodeFrame(vPacket);
        }

        packets.reserve(vPacket.size());
        for (auto& p : vPacket) {
            packets.push_back(std::move(p.frame));
        }
    } catch (const std::exception& e) {
        fprintf(stderr, "[EncoderCore] EncodeFrame falhou sob contenção/erro: %s\n", e.what());
        packets.clear();
    }

    return packets;
}

bool EncoderCore::SetBitrate(int bitrateBps, bool forceKeyframe) {
    if (software_) return software_->SetBitrate(bitrateBps, forceKeyframe);
    if (!encoder_) return false;

    encodeConfig_.rcParams.averageBitRate = static_cast<uint32_t>(bitrateBps);
    encodeConfig_.rcParams.maxBitRate = static_cast<uint32_t>(bitrateBps);

    NV_ENC_RECONFIGURE_PARAMS reconfigureParams = { NV_ENC_RECONFIGURE_PARAMS_VER };
    reconfigureParams.reInitEncodeParams = initializeParams_;
    // forceIDR — ver comentário no header sobre por que isso é opcional agora (bug real: AIMD
    // forçando keyframe a cada ajuste piorava congestionamento em vez de aliviar).
    reconfigureParams.forceIDR = forceKeyframe ? 1 : 0;

    try {
        return encoder_->Reconfigure(&reconfigureParams);
    } catch (const std::exception&) {
        return false;
    }
}

std::vector<std::vector<uint8_t>> EncoderCore::Flush() {
    if (software_) return software_->Flush();

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
