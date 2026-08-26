#pragma once

#include <d3d11.h>
#include <memory>
#include <vector>
#include <cstdint>
#include <chrono>
#include <atomic>
#include "../vendor/nvenc/NvEncoderD3D11.h"
#include "SoftwareEncoderCore.h"
#include "VideoCodecType.h" // achado via include_dirs (binding.gyp já lista ../transport-core/src)

// Encoder H.264 via NVENC (NVIDIA Video Codec SDK, vendorizado em vendor/nvenc/ — ver
// docs/NATIVE_CAPTURE.md Fase 3). Usa o wrapper oficial `NvEncoderD3D11` da NVIDIA em vez de
// chamar a API NVENC crua diretamente — é uma API C cheia de structs versionados manualmente
// (cada um com campo `version` específico da versão do SDK), reimplementar isso à mão do zero
// seria puro risco de bug sutil sem ganho nenhum.
//
// Roda no MESMO ID3D11Device do CaptureCore (não cria device próprio) — frame capturado
// (composeTexture_, já com cursor desenhado) é copiado direto (GPU→GPU, `CopyResource`) pro
// buffer de entrada que o NVENC aloca, sem passar pela CPU. Isso é o zero-copy real que o
// caminho atual (WebCodecs `VideoFrame` via bytes crus) não tem.
class EncoderCore {
public:
    EncoderCore();
    ~EncoderCore();

    // `device` não é possuído por essa classe — precisa ser o mesmo device do CaptureCore, vivo
    // durante toda a vida do encoder. `codec` é o PEDIDO, não garantia — cascata de fallback de 4
    // níveis (NVENC no codec pedido → NVENC H.264 → software no codec pedido → software H.264),
    // ver .cpp. `GetActiveCodec()` diz o que realmente ficou de pé.
    bool Initialize(ID3D11Device* device, int width, int height, int fps, int bitrateBps, VideoCodecType codec);
    void Destroy();

    // Copia `frame` (textura no MESMO device) pro buffer de entrada do NVENC e codifica. Cada
    // elemento do retorno é um pacote H.264 Annex-B (com start code 0x00000001) — pronto pra
    // gravar em arquivo .h264 puro ou (mais pra frente) empacotar em RTP.
    //
    // Faz pacing pro fps configurado (`fps` passado em `Initialize`) — se chamado mais rápido que
    // isso (ex.: monitor de alta taxa de atualização entregando frame mais rápido que o alvo),
    // retorna vazio sem chamar o NVENC. NVENC assume taxa de quadros CONSTANTE (é o que
    // `frameRateNum`/`frameRateDen` configuram) pra calcular o bitrate do modo CBR — alimentar
    // frames num ritmo mais rápido que isso faz o bitrate de saída real divergir bastante do alvo
    // configurado (medido em teste: SDK 13.1.15 + monitor de alta taxa, ver docs/TASKS.md Sprint 19).
    std::vector<std::vector<uint8_t>> EncodeFrame(ID3D11Texture2D* frame);

    // Pacotes ainda represados no encoder (B-frames/lookahead) — chamar antes de Destroy() pra
    // não perder frames já entregues ao NVENC mas ainda não devolvidos.
    std::vector<std::vector<uint8_t>> Flush();

    // Troca o bitrate em sessão SEM recriar o encoder (sem esse método, mudar de qualidade
    // exigiria destruir e reinicializar toda a sessão NVENC, o que gera um soluço visível). Usa a
    // API `Reconfigure` da base `NvEncoder` — suportada nativamente pelo NVENC pra esse caso.
    //
    // `forceKeyframe` (padrão true) — força um IDR na troca pra sincronizar o espectador limpo
    // com o rate control novo. Passar `false` pro ajuste AUTOMÁTICO de congestionamento (AIMD, ver
    // main/index.ts): forçar keyframe (bem maior que um delta frame) EXATAMENTE no momento em que
    // já tá represado piora a fila em vez de aliviar — bug real medido em produção (FPS caiu de 60
    // cravado pra 48-55 depois de ligar o congestion control, mesmo em loopback local sem
    // congestionamento real: cada ajuste forçava keyframe, que enchia o buffer de novo, que
    // disparava outro ajuste — ciclo). Trocas de bitrate pedidas pelo USUÁRIO (mudar qualidade nas
    // configurações) continuam com o padrão `true`.
    bool SetBitrate(int bitrateBps, bool forceKeyframe = true);

    // Força o PRÓXIMO frame codificado a ser um IDR (keyframe) mesmo fora do GOP normal — usado
    // quando o transporte reporta um PLI (Picture Loss Indication) do espectador: o decoder do
    // lado dele perdeu referência (pacote corrompido/perdido além do que o NACK conseguiu
    // recuperar) e só volta a decodificar corretamente a partir de um keyframe novo. Sem isso, o
    // vídeo trava/corrompe até o próximo keyframe do GOP normal (a cada `fps*2` frames = ~2s).
    //
    // Chamado a partir da thread interna do libdatachannel (callback de PLI, ligado direto em
    // C++ no transporte nativo — ver addon.cpp) enquanto `EncodeFrame()` roda em OUTRA thread
    // (StreamWorker) — por isso atômico, não é mais só uma chamada JS single-thread como antes.
    void ForceKeyframe();

    bool IsInitialized() const { return encoder_ != nullptr || software_ != nullptr; }

    // Verdadeiro quando caiu pro fallback de software (NVENC indisponível — GPU não-NVIDIA,
    // driver desatualizado, ou sem GPU dedicada). Exposto pro host avisar o usuário/HUD de dev
    // (encode por software é bem mais pesado em CPU que NVENC, vale saber que caiu nesse caminho).
    bool IsUsingSoftwareFallback() const { return software_ != nullptr; }

    // Codec que realmente ficou ativo (pode ter degradado do pedido — ex.: pediu HEVC, GPU/driver
    // não suporta, caiu pra H.264). O host PRECISA saber isso antes de criar a sessão de
    // transporte (TransportCore também precisa saber o codec pra detectar keyframe certo).
    VideoCodecType GetActiveCodec() const { return activeCodec_; }

private:
    std::unique_ptr<NvEncoderD3D11> encoder_;
    // Fallback quando NVENC não inicializa (ver docs/NATIVE_CAPTURE.md Fase 3 "Fallback de
    // encoder por software") — Media Foundation, funciona em qualquer Windows sem GPU NVIDIA.
    std::unique_ptr<SoftwareEncoderCore> software_;
    ID3D11DeviceContext* context_ = nullptr; // referência emprestada do device (AddRef via GetImmediateContext), não é dona do device em si.
    int fps_ = 30;
    // Grade FIXA de agendamento (não "última vez aceita") — soma o intervalo alvo a cada frame
    // aceito, não relê o relógio a cada vez. Um frame individual atrasado (overhead pontual) não
    // desloca o relógio inteiro pra frente permanentemente, autocorrige sozinho no próximo tick.
    // Antes (baseado em `now - lastEncodeTime_` recalculado a cada aceite) acumulava jitter real
    // medido em produção ("micro engasgadas" mesmo com fps médio bom).
    std::chrono::steady_clock::time_point nextEncodeTime_{};
    std::atomic<bool> forceKeyframe_{false};
    // Guardados (não só locais em Initialize) pra SetBitrate() poder reusar/mutar em Reconfigure()
    // sem precisar reconstruir os parâmetros do zero.
    NV_ENC_INITIALIZE_PARAMS initializeParams_ = { NV_ENC_INITIALIZE_PARAMS_VER };
    NV_ENC_CONFIG encodeConfig_ = { NV_ENC_CONFIG_VER };
    VideoCodecType activeCodec_ = VideoCodecType::H264;

    bool InitializeNvenc(ID3D11Device* device, int width, int height, int fps, int bitrateBps, VideoCodecType codec);
};
