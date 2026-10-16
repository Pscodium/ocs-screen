#include "EncoderCore.h"
#include <stdexcept>
#include <wrl/client.h>
#include <windows.h>

using Microsoft::WRL::ComPtr;

// `nvEncodeAPI64.dll` é DELAY-LOADED (binding.gyp) — sem isso o addon inteiro nem carregava em PC
// sem driver NVIDIA (AMD/Intel), derrubando o pipeline nativo todo pro LiveKit. Falha de
// delay-load é exceção SEH (não C++, o `catch` do InitializeNvenc não pega), então checa ANTES da
// primeira chamada NVENC se a DLL existe. Resultado cacheado: a DLL fica carregada (refcount), o
// delay-load resolve pelo módulo já carregado.
static bool IsNvencRuntimeAvailable() {
    static const bool available = LoadLibraryExW(L"nvEncodeAPI64.dll", nullptr, LOAD_LIBRARY_SEARCH_SYSTEM32) != nullptr;
    return available;
}

EncoderCore::EncoderCore() {}

void EncoderCore::ForceKeyframe() {
    if (software_) {
        software_->ForceKeyframe();
        return;
    }
    forceKeyframe_.store(true, std::memory_order_relaxed);
}

bool EncoderCore::KeyframePending() const {
    if (software_) return software_->KeyframePending();
    return forceKeyframe_.load(std::memory_order_relaxed);
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
    if (!IsNvencRuntimeAvailable()) {
        fprintf(stderr, "[EncoderCore] nvEncodeAPI64.dll ausente (sem driver NVIDIA) — pulando NVENC.\n");
        return false;
    }
    try {
        // ARGB (BGRA na memória, mesmo layout que o CaptureCore já produz) — evita converter pra
        // NV12 antes de encodar. NVENC aceita ARGB direto, só custa um pouco mais de banda de
        // memória interna que NV12 (não temos motivo pra otimizar isso agora).
        //
        // `nExtraOutputDelay = 0` — o padrão do wrapper da NVIDIA é 3: `EncodeFrame()` só devolve o
        // pacote do frame N depois de receber o frame N+3 (pipelining pra throughput, pensado pra
        // transcodificação de arquivo). Num stream ao vivo isso era um bug sério, medido com harness
        // isolado (1º pacote só saía na 4ª chamada aceita): +3 frames de latência fixa (50ms@60fps,
        // 100ms@30fps, 200ms no tier low@15fps), vídeo atrasado em relação ao áudio pelo mesmo tanto
        // (áudio não passa por esse atraso — dessincronia que o viewer não tinha como corrigir), e
        // com a tela PARADA (DXGI só entrega frame quando algo muda) os últimos 3 frames ficavam
        // presos no encoder até a tela mudar de novo — digitar/mover algo aparecia "aos trancos".
        // Com 0, cada chamada devolve o pacote do próprio frame (o lock do bitstream espera o encode
        // terminar, ~1-3ms de GPU — custo bem menor que os 3 frames de espera).
        encoder_ = std::make_unique<NvEncoderD3D11>(device, static_cast<uint32_t>(width), static_cast<uint32_t>(height), NV_ENC_BUFFER_FORMAT_ARGB, 0);

        initializeParams_ = { NV_ENC_INITIALIZE_PARAMS_VER };
        encodeConfig_ = { NV_ENC_CONFIG_VER };
        initializeParams_.encodeConfig = &encodeConfig_;

        const GUID codecGuid = codec == VideoCodecType::HEVC ? NV_ENC_CODEC_HEVC_GUID
            : codec == VideoCodecType::AV1 ? NV_ENC_CODEC_AV1_GUID
            : NV_ENC_CODEC_H264_GUID;

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
        // GOP INFINITO — keyframe só sob demanda (`ForceKeyframe`: espectador novo, troca de tier,
        // decoder do espectador pedindo recuperação, frames descartados por congestionamento).
        // Antes era IDR fixo a cada 2s, pensado pra "recuperar de perda de pacote" — mas o vídeo
        // vai por DataChannel SCTP confiável/ordenado, não existe perda de pacote pra recuperar.
        // E o IDR periódico era a causa mais provável da "aberração cromática de tempos em tempos
        // com stuttering": em CBR com VBV curto (3 frames), um IDR (~3x maior que um P-frame
        // medido no harness) tem que caber no mesmo orçamento — o rate control derruba a
        // qualidade bruscamente nesse frame (croma é o primeiro a sofrer: blocos de cor borrada) e
        // ela vai se recompondo nos P-frames seguintes; e o pico de bytes chega atrasado no
        // espectador (engasgo). A cada 2s, exatamente o padrão relatado. Bate também com HEVC ter
        // "quase eliminado" o artefato (comprime IDR bem melhor no mesmo orçamento).
        encodeConfig_.gopLength = NVENC_INFINITE_GOPLENGTH;
        // VUI — dois problemas reais achados inspecionando o SPS (`ffmpeg -bsf:v trace_headers`):
        // 1) `bitstream_restriction_flag = 0`: sem `max_num_reorder_frames`/`max_dec_frame_buffering`
        //    no SPS, o decoder do espectador não tem como saber que não existe B-frame e segura
        //    frames no DPB "pra reordenar" antes de entregar — medido no E2E (Chrome/WebCodecs,
        //    mesmo com `optimizeForLatency`): ~67ms (4 frames@60fps) entre o chunk chegar e o frame
        //    sair do decoder. Com a flag, o NVENC escreve reorder=0 e o decoder entrega na hora.
        // 2) Cor não sinalizada (`video_signal_type_present_flag = 0`): o NVENC converte ARGB→YUV
        //    em BT.709 limitado (medido: PSNR do decode com BT.709 33.4dB vs 29.2dB com BT.601), mas
        //    sem isso no stream cada decoder chuta a matriz — BT.601 dá cor errada (vermelho/azul
        //    deslocados, a "aberração cromática" mais visível em texto/UI colorida).
        auto configureVui = [](NV_ENC_CONFIG_H264_VUI_PARAMETERS& vui) {
            vui.bitstreamRestrictionFlag = 1;
            vui.videoSignalTypePresentFlag = 1;
            vui.videoFormat = NV_ENC_VUI_VIDEO_FORMAT_UNSPECIFIED;
            vui.videoFullRangeFlag = 0;
            vui.colourDescriptionPresentFlag = 1;
            vui.colourPrimaries = NV_ENC_VUI_COLOR_PRIMARIES_BT709;
            vui.transferCharacteristics = NV_ENC_VUI_TRANSFER_CHARACTERISTIC_BT709;
            vui.colourMatrix = NV_ENC_VUI_MATRIX_COEFFS_BT709;
        };
        if (codec == VideoCodecType::HEVC) {
            configureVui(encodeConfig_.encodeCodecConfig.hevcConfig.hevcVUIParameters);
            encodeConfig_.encodeCodecConfig.hevcConfig.idrPeriod = encodeConfig_.gopLength;
            // Annex-B com VPS/SPS/PPS repetidos em cada keyframe — mesmo raciocínio do H.264
            // (repeatSPSPPS) logo abaixo, campo espelhado na struct de config do HEVC.
            encodeConfig_.encodeCodecConfig.hevcConfig.repeatSPSPPS = 1;
        } else if (codec == VideoCodecType::AV1) {
            encodeConfig_.encodeCodecConfig.av1Config.idrPeriod = encodeConfig_.gopLength;
            // `repeatSeqHdr` é o equivalente AV1 de repeatSPSPPS — Sequence Header só sai de novo
            // em cada keyframe. TransportCore::ContainsKeyframeObu (ver TransportCore.cpp) detecta
            // keyframe procurando esse OBU no bitstream — sem isso, a detecção de keyframe do
            // transporte (usada pra saber se atende PLI/decisão de recuperação) fica cega.
            encodeConfig_.encodeCodecConfig.av1Config.repeatSeqHdr = 1;
            // Deixa em 0 (formato "low overhead", OBUs concatenados direto) — Annex B do AV1 é uma
            // estrutura de container totalmente diferente (temporal unit/frame unit com tamanho
            // leb128 prefixado), TransportCore não sabe parsear isso e o WebCodecs do lado do
            // viewer também não precisa: `EncodedVideoChunk` só quer os OBUs crus.
            encodeConfig_.encodeCodecConfig.av1Config.outputAnnexBFormat = 0;
        } else {
            configureVui(encodeConfig_.encodeCodecConfig.h264Config.h264VUIParameters);
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
        pacer_.Reset(fps);

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

    // Chamado mais rápido que o fps configurado (monitor de alta taxa) — pula esse frame sem tocar
    // no NVENC (nem GetNextInputFrame nem CopyResource), pra manter o ritmo real batendo com o que o
    // NVENC assume internamente pro cálculo de bitrate CBR. Ver FramePacer.h.
    if (!pacer_.ShouldEncode(std::chrono::steady_clock::now())) return packets;

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
