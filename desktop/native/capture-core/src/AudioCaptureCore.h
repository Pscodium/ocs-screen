#pragma once

#include <windows.h>
#include <mmdeviceapi.h>
#include <audioclient.h>
#include <audioclientactivationparams.h>
#include <atomic>
#include <chrono>
#include <condition_variable>
#include <functional>
#include <mutex>
#include <string>
#include <thread>
#include <vector>
#include <cstdint>
#include <opus.h>

// Captura de áudio pro pipeline nativo (DXGI/WGC→NVENC→libdatachannel, ver docs/NATIVE_CAPTURE.md).
//
// Arquitetura (revisão — "mixer por app"): em vez de UM loopback do sistema inteiro com UM processo
// excluído (`PROCESS_LOOPBACK_MODE_EXCLUDE_TARGET_PROCESS_TREE`, versão anterior), cria UMA captura
// `INCLUDE_TARGET_PROCESS_TREE` por app que está tocando áudio e mixa todas aqui, deixando de fora
// os apps da lista de exclusão. Motivo — o dilema estrutural documentado em docs/TASKS.md:
//   - EXCLUDE só aceita UM alvo: excluir Discord E NVIDIA Broadcast E o que gerar retorno de
//     microfone ao mesmo tempo era impossível.
//   - Com NVIDIA Broadcast (ou qualquer "proxy de áudio") como saída, o processo que renderiza no
//     dispositivo físico é o proxy, não o app de origem — excluir o proxy silenciava a transmissão
//     inteira, não excluir vazava a call. Incluindo por app de ORIGEM (jogo, navegador...), o
//     proxy simplesmente não entra (excluído), e a origem entra direto — sem depender de qual
//     dispositivo o proxy usa.
//
// Cuidado com árvore de processos: INCLUDE de uma raiz captura TODOS os descendentes dela — se a
// raiz for um "lançador" (explorer.exe, Steam...) e o Discord tiver sido aberto por ele, incluir a
// raiz vazaria a call. Por isso uma árvore só é incluída se NÃO contiver nenhum processo excluído
// (cai pro PID da sessão em si nesse caso), e isso é rechecado periodicamente (`RefreshSources`).
//
// Thread própria (prioridade MMCSS "Pro Audio"): drena/mixa/codifica a cada ~5ms e entrega cada
// pacote pelo callback (`SetPacketCallback`, o addon manda direto pro transporte) — antes isso
// rodava no loop JS do vídeo, que só volta a cada frame (~16ms) e trava junto em qualquer soluço da
// thread principal do Electron: o mixer precisava de uma folga grande (o espectador sincroniza o
// vídeo com o áudio, então essa folga virava latência do vídeo também) e soluço da thread JS virava
// buraco no áudio.
//
// Relógio: cada pacote do WASAPI vem com o instante QPC de captura — o mixer posiciona cada
// pacote numa linha do tempo única de amostras (48kHz) por esse instante, e cada pacote Opus sai
// com `ptsUs` no mesmo relógio QPC que o vídeo usa (`QpcClock.h`) — base da sincronia A/V no
// espectador.
struct EncodedAudioPacket {
    std::vector<uint8_t> data;
    // Instante QPC (µs, ver QpcClock.h) da primeira amostra do pacote.
    int64_t ptsUs = 0;
};

struct AudioAppInfo {
    std::wstring exeName;
    // Sessão de áudio ATIVA agora (tocando) em algum dispositivo de saída.
    bool active = false;
};

class AudioCaptureCore {
public:
    AudioCaptureCore();
    ~AudioCaptureCore();

    // Caminho de MONITOR — mixa todo app com sessão de áudio ativa, menos `excludedExeNames` (nome
    // do executável, sem diferenciar maiúscula) e o próprio processo do app (senão quem assiste a
    // própria transmissão pelo app desktop criaria eco). Apps que começam a tocar depois entram
    // sozinhos (ver `RefreshSources`, ~1x/s).
    bool InitializeForSystem(const std::vector<std::wstring>& excludedExeNames);

    // Caminho de JANELA (WGC) — só a árvore de processos dona do HWND (resolvida até a raiz do
    // mesmo executável — apps multi-processo tipo Chromium/Electron tocam áudio num processo
    // filho). Exclusões também valem aqui (árvore com processo excluído dentro cai pro PID da
    // janela em si).
    bool InitializeForWindow(HWND hwnd, const std::vector<std::wstring>& excludedExeNames);

    // Troca a lista de exclusão AO VIVO — fontes que passaram a ser excluídas saem na hora, as que
    // deixaram de ser entram no próximo refresh.
    void SetExcludedExeNames(const std::vector<std::wstring>& excludedExeNames);

    void Shutdown();

    // Pacotes Opus de 10ms, saída CONTÍNUA (silêncio quando nada toca — o espectador mantém o relógio
    // de áudio estável em vez de ver buracos). Cada frame só sai quando a linha do tempo dele já
    // ficou `kMixLatency` pra trás do "agora", dando tempo de todas as fontes entregarem os pacotes
    // daquele trecho. Com callback definido, cada pacote vai pra ele NA THREAD DE ÁUDIO assim que
    // fica pronto; sem callback, acumula pra `PollEncodedPackets` (harness/diagnóstico).
    using PacketCallback = std::function<void(const EncodedAudioPacket&)>;
    void SetPacketCallback(PacketCallback callback);
    std::vector<EncodedAudioPacket> PollEncodedPackets();

    // Amplitude média (RMS) do que foi mixado desde a última leitura — diagnóstico (log do loop).
    float LastRms();

    // Diagnóstico do mixer desde a última chamada (zera ao ler): maior atraso entre o FIM de um
    // pacote capturado e o momento em que ele foi drenado (o que `kMixLatency` precisa cobrir), e
    // amostras descartadas por chegarem depois do trecho já ter sido enviado (buraco no áudio).
    struct MixStats {
        double maxArrivalLagMs = 0;
        int64_t lateSamples = 0;
    };
    MixStats TakeMixStats();

    // Executáveis sendo capturados agora (diagnóstico/log).
    std::vector<std::wstring> CapturedExeNames();

    // Raiz da árvore de processos com esse nome de executável (ex.: L"Discord.exe").
    static DWORD FindProcessIdByName(const wchar_t* exeName);

    // Apps com sessão de áudio em algum dispositivo de saída ativo (pra UI de "silenciar app"),
    // sem o próprio processo e sem processos de sistema.
    static std::vector<AudioAppInfo> ListAudioApps();

private:
    struct Source {
        DWORD targetPid = 0;
        std::wstring exeName;
        IAudioClient* client = nullptr;
        IAudioCaptureClient* capture = nullptr;
        // Próxima amostra esperada (linha do tempo do mixer) — pacotes consecutivos da mesma fonte
        // ficam colados mesmo com arredondamento do QPC (evita estalo de 1 amostra de buraco).
        int64_t nextSample = 0;
        bool hasNext = false;
    };

    bool Start(const std::vector<std::wstring>& excludedExeNames);
    void WorkerMain();
    // Tudo abaixo (até `mixStats_`) só é tocado pela thread de áudio.
    bool AddSource(DWORD targetPid, const std::wstring& exeName);
    void ReleaseSource(Source& source);
    void RefreshSources(bool force);
    void DrainSource(Source& source);
    void MixInto(int64_t startSample, const float* data, uint32_t frames, bool silent);
    void EncodeReadyFrames();
    int64_t SampleAtUs(int64_t us) const;
    bool CreateEncoder();
    bool IsExcludedExe(const std::wstring& exeLower) const;

    bool systemMode_ = false;
    HWND windowHwnd_ = nullptr;
    std::vector<std::wstring> excludedLower_;
    std::vector<Source> sources_;
    std::chrono::steady_clock::time_point lastRefresh_{};

    OpusEncoder* encoder_ = nullptr;
    // Linha do tempo do mixer: amostra 0 = `epochUs_` (QPC µs). `mix_` (estéreo intercalado) cobre
    // as amostras a partir de `mixBaseSample_` — tudo antes disso já foi codificado e enviado.
    int64_t epochUs_ = 0;
    int64_t mixBaseSample_ = 0;
    std::vector<float> mix_;
    double rmsSumSquares_ = 0.0;
    size_t rmsSampleCount_ = 0;
    MixStats mixStats_;

    // Compartilhado thread de áudio ↔ thread JS — sempre com `mutex_`.
    std::mutex mutex_;
    std::condition_variable initCv_;
    bool initDone_ = false;
    bool initOk_ = false;
    bool excludedChanged_ = false;
    std::vector<std::wstring> pendingExcludedLower_;
    std::vector<std::wstring> capturedNames_;
    std::vector<EncodedAudioPacket> queue_;
    PacketCallback callback_;
    float lastRms_ = 0.f;
    MixStats sharedMixStats_;

    std::thread worker_;
    std::atomic<bool> stop_{false};
};
