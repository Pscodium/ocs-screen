#include "StreamWorker.h"
#include "CaptureCore.h"
#include "EncoderCore.h"
#include "TransportCore.h"
#include <algorithm>
#include <chrono>
#include <windows.h>
#include <avrt.h>
#include <fstream>
#include <cstdlib>

StreamWorker::~StreamWorker() {
    Stop();
}

bool StreamWorker::Start(CaptureCore* core, EncoderCore* encoder, TransportCore* transport, int monitorIndex, int targetFps) {
    if (running_.load()) return false;
    core_ = core;
    encoder_ = encoder;
    transport_ = transport;
    running_.store(true);
    ended_.store(false);
    thread_ = std::thread(&StreamWorker::Run, this, monitorIndex, targetFps);
    return true;
}

void StreamWorker::Stop() {
    running_.store(false);
    if (thread_.joinable()) thread_.join();
}

StreamWorkerStats StreamWorker::ConsumeStats() {
    StreamWorkerStats s;
    s.acquired = acquired_.exchange(0, std::memory_order_relaxed);
    s.timeouts = timeouts_.exchange(0, std::memory_order_relaxed);
    s.encodedPackets = encodedPackets_.exchange(0, std::memory_order_relaxed);
    s.emptyEncodeCalls = emptyEncodeCalls_.exchange(0, std::memory_order_relaxed);
    s.sendOk = sendOk_.exchange(0, std::memory_order_relaxed);
    s.sendFail = sendFail_.exchange(0, std::memory_order_relaxed);
    s.bytes = bytes_.exchange(0, std::memory_order_relaxed);
    return s;
}

// Roda inteiramente nesta thread — captura (`AcquireFrameGpuOnly`, sem readback CPU), encode
// (NVENC, GPU→GPU a partir da textura composta) e envio (RTP via TransportCore) são chamadas C++
// diretas, sem N-API/JS no meio. `AcquireNextFrame` (dentro de AcquireFrameGpuOnly) já bloqueia
// até `timeoutMs` esperando frame novo — não precisa de sleep manual entre iterações.
void StreamWorker::Run(int monitorIndex, int targetFps) {
    // MMCSS "Capture" — prioridade de agendamento de CPU mais alta sob contenção (mesma técnica
    // já usada em addon.cpp::Initialize, mas essa registrava a thread MAIN do Electron, que
    // rodava o loop antigo). Essa thread (StreamWorker) é uma thread NOVA, própria — sem
    // registrar ela aqui, o loop de captura/encode/envio roda em prioridade normal, competindo
    // por CPU com todo o resto do sistema sem vantagem nenhuma (medido em produção: travadinha
    // idêntica com conteúdo caro (scroll) ou baratíssimo (só cursor se movendo), independente de
    // bitrate/GPU — aponta pra agendamento de thread, não custo de conteúdo). Falha em silêncio
    // se não suportado.
    DWORD taskIndex = 0;
    HANDLE mmcssHandle = AvSetMmThreadCharacteristicsW(L"Capture", &taskIndex);
    if (mmcssHandle) {
        AvSetMmThreadPriority(mmcssHandle, AVRT_PRIORITY_CRITICAL);
    }

    const uint32_t timeoutMs = static_cast<uint32_t>(std::max(1, 1000 / std::max(1, targetFps)));
    // Relógio de parede (90kHz, padrão RTP pra vídeo), NÃO um passo fixo por frame adquirido —
    // com a captura rodando livre numa thread própria (sem o teto artificial que o loop em JS
    // tinha antes), a cadência real fica bem irregular (de ~0 a 700+ frames/s, ver logs de
    // produção): um passo fixo por frame "declara" mais tempo decorrido do que o real numa rajada
    // e menos numa pausa, dessincronizando o timestamp RTP do relógio real — o jitter buffer do
    // lado do espectador usa esse timestamp pra decidir QUANDO apresentar cada frame, então esse
    // descompasso vira travada mesmo com os pacotes chegando certinho (medido: baixar bitrate
    // pra tentar aliviar contenção de GPU piorou o freeze, não melhorou — descartando GPU como
    // causa principal e apontando pra isso).
    const auto startTime = std::chrono::steady_clock::now();

    // DEBUG temporário — grava o bitstream H.264 cru (mesma sequência de bytes que vai pro
    // TransportCore) num arquivo, pra validar com ffprobe/ffplay FORA do WebRTC inteiro. PLI
    // subindo sem packetsLost/nackCount no espectador aponta pra frame às vezes saindo
    // corrompido do encoder, não problema de rede/timing — isso isola encode de transporte.
    const char* tempDir = std::getenv("TEMP");
    std::ofstream dumpFile(
        (tempDir ? std::string(tempDir) : std::string(".")) + "\\native-transport-debug.h264",
        std::ios::binary | std::ios::trunc);

    while (running_.load(std::memory_order_relaxed)) {
        AcquireResult result = core_->AcquireFrameGpuOnly(timeoutMs);

        if (result == AcquireResult::Timeout) {
            timeouts_.fetch_add(1, std::memory_order_relaxed);
            continue;
        }
        if (result == AcquireResult::AccessLost) {
            core_->Stop();
            if (!core_->Start(monitorIndex)) {
                ended_.store(true);
                running_.store(false);
                break;
            }
            continue;
        }
        if (result == AcquireResult::DeviceLost) {
            // Device D3D11 morreu de vez (TDR) — recuperar de verdade exigiria recriar todo o
            // pipeline (fora de escopo por ora). Para com segurança em vez de continuar chamando
            // EncodeFrame/SendVideoFrame num device morto (caminho provável de crash sem log).
            ended_.store(true);
            running_.store(false);
            break;
        }
        if (result != AcquireResult::Ok) {
            continue; // erro transitório (Map falhou etc.) — tenta de novo no próximo loop
        }

        acquired_.fetch_add(1, std::memory_order_relaxed);
        auto packets = encoder_->EncodeFrame(core_->GetComposeTexture());
        if (packets.empty()) {
            emptyEncodeCalls_.fetch_add(1, std::memory_order_relaxed);
        }

        // Microssegundos reais decorridos desde o início do stream — vídeo vai por DataChannel
        // agora (ver TransportCore.h), não mais RTP, então não precisa de unidade de clock 90kHz.
        const auto elapsedUs = static_cast<uint64_t>(
            std::chrono::duration_cast<std::chrono::microseconds>(std::chrono::steady_clock::now() - startTime).count());

        for (auto& packet : packets) {
            encodedPackets_.fetch_add(1, std::memory_order_relaxed);
            bytes_.fetch_add(packet.size(), std::memory_order_relaxed);
            if (dumpFile.is_open()) {
                dumpFile.write(reinterpret_cast<const char*>(packet.data()), static_cast<std::streamsize>(packet.size()));
            }
            bool ok = transport_->SendVideoFrame(packet.data(), packet.size(), elapsedUs);
            if (ok) {
                sendOk_.fetch_add(1, std::memory_order_relaxed);
            } else {
                sendFail_.fetch_add(1, std::memory_order_relaxed);
            }
        }
    }

    if (mmcssHandle) {
        AvRevertMmThreadCharacteristics(mmcssHandle);
    }
}
