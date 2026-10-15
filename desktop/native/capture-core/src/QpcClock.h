#pragma once

#include <windows.h>
#include <cstdint>

// Relógio ÚNICO (QueryPerformanceCounter, microssegundos) pros timestamps de vídeo E áudio do
// pipeline nativo. O WASAPI já entrega o instante QPC de captura de cada pacote de áudio
// (`IAudioCaptureClient::GetBuffer`, em unidades de 100ns) — usando o mesmo relógio pro vídeo, o
// espectador consegue sincronizar as duas faixas pelo timestamp sem nenhuma suposição de latência.
inline int64_t QpcNowUs() {
    static const LARGE_INTEGER freq = [] {
        LARGE_INTEGER f;
        QueryPerformanceFrequency(&f);
        return f;
    }();
    LARGE_INTEGER now;
    QueryPerformanceCounter(&now);
    return static_cast<int64_t>((now.QuadPart / freq.QuadPart) * 1000000LL +
                                (now.QuadPart % freq.QuadPart) * 1000000LL / freq.QuadPart);
}
