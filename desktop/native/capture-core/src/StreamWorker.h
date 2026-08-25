#pragma once

#include <atomic>
#include <cstdint>
#include <thread>

class CaptureCore;
class EncoderCore;
class TransportCore;

struct StreamWorkerStats {
    uint32_t acquired = 0;
    uint32_t timeouts = 0;
    uint32_t encodedPackets = 0;
    uint32_t emptyEncodeCalls = 0;
    uint32_t sendOk = 0;
    uint32_t sendFail = 0;
    uint64_t bytes = 0;
};

// Loop de captura+encode+envio (Fase 4, ver docs/NATIVE_CAPTURE.md) rodando numa thread nativa
// PRÓPRIA — nunca toca a thread JS/main do Electron. Antes disso, o loop rodava via `setImmediate`
// em JS, cruzando N-API pra cada chamada (acquireFrame/encodeCurrentFrame/sendVideoFrame); sob
// carga real (tela em movimento, frames maiores) isso serializava com o resto do processo main e
// derrubava a cadência do próprio loop (medido em produção: taxa de iteração caindo de ~165/s pra
// ~50/s durante scroll contínuo). Aqui captura, encode e envio são chamadas C++ diretas, sem
// round-trip nenhum por N-API — só os contadores de stats (atômicos) e a callback de PLI cruzam
// pra fora, e mesmo assim sem passar por JS no caminho quente (PLI liga direto no
// `EncoderCore::ForceKeyframe()` em C++, ver Start()).
class StreamWorker {
public:
    ~StreamWorker();

    // Não é dono de nenhum dos três ponteiros — CaptureCore/EncoderCore/TransportCore continuam
    // vivos e geridos por quem chama (addon.cpp), só precisam sobreviver por toda a vida da thread.
    bool Start(CaptureCore* core, EncoderCore* encoder, TransportCore* transport, int monitorIndex, int targetFps);
    void Stop();
    bool IsRunning() const { return running_.load(std::memory_order_relaxed); }
    // true quando a thread se encerrou sozinha por erro irrecuperável (ex.: AccessLost e o
    // restart falhou) — quem chama detecta isso via polling (mesmo espírito de "native-capture:stats"
    // já existente) e avisa o renderer.
    bool HasEnded() const { return ended_.load(std::memory_order_relaxed); }

    // Lê e ZERA os contadores (mesmo padrão do polling de stats já usado em `main/index.ts` pro
    // caminho de captura antigo — 1x/segundo, chamado do lado JS).
    StreamWorkerStats ConsumeStats();

private:
    void Run(int monitorIndex, int targetFps);

    std::thread thread_;
    std::atomic<bool> running_{false};
    std::atomic<bool> ended_{false};

    CaptureCore* core_ = nullptr;
    EncoderCore* encoder_ = nullptr;
    TransportCore* transport_ = nullptr;

    std::atomic<uint32_t> acquired_{0};
    std::atomic<uint32_t> timeouts_{0};
    std::atomic<uint32_t> encodedPackets_{0};
    std::atomic<uint32_t> emptyEncodeCalls_{0};
    std::atomic<uint32_t> sendOk_{0};
    std::atomic<uint32_t> sendFail_{0};
    std::atomic<uint64_t> bytes_{0};
};
