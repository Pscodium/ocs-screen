#pragma once

#include <algorithm>
#include <chrono>

// Pacing compartilhado pelos dois encoders (NVENC e Media Foundation) — decide se um frame
// capturado AGORA deve ser codificado ou pulado pra manter o fps alvo (NVENC assume taxa constante
// pro cálculo de bitrate CBR; fonte mais rápida que o alvo, ex. monitor 165Hz, precisa ser podada).
//
// Token bucket: crédito acumula no ritmo do fps alvo (teto `kMaxTokens`), cada frame aceito gasta 1.
// Histórico de bugs reais que isso resolve:
// - Grade fixa estrita (`now >= próximo ponto`): fonte e alvo no mesmo ritmo, frame chegando 0.1ms
//   antes do ponto = descartado — ~1 em 6 jogado fora (medido: 64 capturados/s, só ~50 codificados).
// - Grade com tolerância de 1/4 de intervalo: ainda descartava frame ÚNICO de fonte irregular — jogo
//   a 60fps capturado por WGC chega com espaçamento tipo 10ms/23ms (quantizado pela composição do
//   DWM); o de 10ms era podado e o seguinte só vinha 23ms depois (medido: 56 entregues/s, 52
//   codificados). Com crédito acumulado, uma fonte que está ABAIXO do alvo nunca perde frame; uma
//   acima do alvo continua limitada à média do alvo.
class FramePacer {
public:
    void Reset(int fps) {
        fps_ = fps > 0 ? fps : 30;
        tokens_ = kMaxTokens;
        last_ = {};
    }

    // true = codifica esse frame (gasta crédito); false = pula.
    bool ShouldEncode(std::chrono::steady_clock::time_point now) {
        if (last_.time_since_epoch().count() != 0) {
            const double elapsedS = std::chrono::duration<double>(now - last_).count();
            tokens_ = std::min(kMaxTokens, tokens_ + elapsedS * fps_);
        }
        last_ = now;
        if (tokens_ < 1.0) return false;
        tokens_ -= 1.0;
        return true;
    }

private:
    // Teto do crédito: 2 frames — absorve jitter de entrega da fonte sem deixar uma rajada longa
    // passar depois de tela parada (no máximo 2 frames colados).
    static constexpr double kMaxTokens = 2.0;
    int fps_ = 30;
    double tokens_ = kMaxTokens;
    std::chrono::steady_clock::time_point last_{};
};
