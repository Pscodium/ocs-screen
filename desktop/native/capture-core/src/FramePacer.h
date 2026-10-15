#pragma once

#include <chrono>

// Pacing de grade fixa compartilhado pelos dois encoders (NVENC e Media Foundation) — decide se
// um frame capturado AGORA deve ser codificado ou pulado pra manter o fps alvo.
//
// Bug real corrigido (medido com harness isolado: monitor entregando ~64 frames/s, alvo 60, só
// ~50 codificados): a versão antiga exigia `now >= nextEncodeTime_` ESTRITO. Com a fonte e a grade
// no mesmo ritmo (60Hz capturado, 60fps alvo), qualquer frame que chegasse 0.1ms ANTES do ponto da
// grade (jitter normal de scheduler/compositor) era descartado e o próximo só vinha 16.7ms depois
// — ~1 em cada 6 frames jogado fora de forma irregular, que é exatamente "engasgo" visível mesmo
// com fps médio alto. Agora aceita até `kEarlyTolerance` do intervalo adiantado. A grade continua
// FIXA (soma o intervalo, não reancora no "agora"), então a tolerância não faz o fps médio subir
// acima do alvo — só deixa de punir jitter.
class FramePacer {
public:
    void Reset(int fps) {
        interval_ = std::chrono::duration_cast<std::chrono::steady_clock::duration>(
            std::chrono::duration<double>(1.0 / (fps > 0 ? fps : 30)));
        next_ = {};
    }

    // true = codifica esse frame (e avança a grade); false = pula.
    bool ShouldEncode(std::chrono::steady_clock::time_point now) {
        if (next_.time_since_epoch().count() == 0) {
            next_ = now + interval_;
            return true;
        }
        if (now + interval_ / kEarlyToleranceDivisor < next_) return false;

        if (now - next_ > interval_) {
            // Ficou muito pra trás da grade (stall, tela parada sem frame novo) — reancora em vez de
            // tentar compensar com uma rajada de frames aceitos em sequência.
            next_ = now + interval_;
        } else {
            next_ += interval_;
        }
        return true;
    }

private:
    // 1/4 do intervalo (~4ms a 60fps) — grande o bastante pra absorver jitter de entrega, pequeno o
    // bastante pra que uma fonte em taxa MAIOR que o alvo (monitor 120/144Hz) ainda pule os frames
    // intermediários em vez de aceitar dois seguidos.
    static constexpr int kEarlyToleranceDivisor = 4;
    std::chrono::steady_clock::duration interval_{};
    std::chrono::steady_clock::time_point next_{};
};
