#include "AudioCaptureCore.h"

#define NOMINMAX
#include <mmdeviceapi.h>
#include <audiopolicy.h>
#include <functiondiscoverykeys_devpkey.h>
#include <tlhelp32.h>
#include <propvarutil.h>
#include <wrl/client.h>
#include <wrl/implements.h>
#include <algorithm>
#include <cstdio>
#include <cstring>
#include <cwctype>
#include <unordered_map>
#include <utility>
#include <cmath>
#include <avrt.h>
#include "QpcClock.h"

using Microsoft::WRL::ComPtr;
using Microsoft::WRL::ClassicCom;
using Microsoft::WRL::RuntimeClassFlags;
using Microsoft::WRL::RuntimeClass;

namespace {

constexpr int kSampleRate = 48000;
constexpr int kChannels = 2;
// 10ms @ 48kHz (não os 20ms padrão do Opus) — o espectador sincroniza o vídeo com o áudio, então
// todo atraso do caminho do áudio vira atraso do vídeo também. Frame menor = 10ms a menos de
// espera pra fechar cada pacote, por ~10% a mais de bitrate de áudio (irrelevante perto do vídeo).
constexpr int64_t kSamplesPerOpusFrame = 480;
// Quanto o mixer espera antes de fechar um trecho da linha do tempo — tem que cobrir o atraso
// entre o áudio ser mixado pelo Windows e o pacote estar disponível no nosso poll (período do
// engine ~10ms + período do poll — medido com o poll no loop JS antigo: atraso máximo 17-28ms,
// ver `TakeMixStats`/log `audioLag` — era isso com o poll no loop JS; na thread própria, ~13-20ms).
// Pacote que chega DEPOIS disso perde o trecho que já foi
// fechado (vira um buraco curto, contado em `audioLate`) — por isso não dá pra ser muito apertado.
constexpr int64_t kMixLatencySamples = kSampleRate * 15 / 1000;
// Período da thread de áudio — o engine do Windows entrega pacotes a cada ~10ms; drenar a cada 5ms
// mantém o atraso de chegada perto disso (medido: `audioLag` máx ~7ms com a ativação de fontes fora desta thread) e a folga acima curta.
constexpr auto kWorkerPeriod = std::chrono::milliseconds(5);
// Pacote com timestamp mais de 2s à frente do que ainda não foi enviado = relógio absurdo, ignora.
constexpr int64_t kMaxAheadSamples = kSampleRate * 2;
constexpr auto kRefreshInterval = std::chrono::milliseconds(1000);

// Processos de sistema que nunca devem entrar como fonte: o próprio serviço de áudio/host de
// serviços (é aqui que efeitos de sistema e o "Escutar este dispositivo" do microfone costumam ser
// processados — retorno de microfone na transmissão) e PIDs especiais.
const wchar_t* const kSystemExes[] = {L"svchost.exe", L"audiodg.exe", L"system", L"registry", L"csrss.exe", L"wininit.exe", L"services.exe"};

std::wstring ToLower(std::wstring s) {
    std::transform(s.begin(), s.end(), s.begin(), [](wchar_t c) { return static_cast<wchar_t>(std::towlower(c)); });
    return s;
}

struct ProcEntry {
    DWORD parent = 0;
    std::wstring exeLower;
    std::wstring exe;
};
using ProcMap = std::unordered_map<DWORD, ProcEntry>;

ProcMap SnapshotProcesses() {
    ProcMap map;
    HANDLE snapshot = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
    if (snapshot == INVALID_HANDLE_VALUE) return map;
    PROCESSENTRY32W entry{};
    entry.dwSize = sizeof(entry);
    if (Process32FirstW(snapshot, &entry)) {
        do {
            map[entry.th32ProcessID] = {entry.th32ParentProcessID, ToLower(entry.szExeFile), entry.szExeFile};
        } while (Process32NextW(snapshot, &entry));
    }
    CloseHandle(snapshot);
    return map;
}

// `pid` == `ancestor` ou descende dele. Limite de profundidade: PID de pai morto pode ter sido
// reciclado por outro processo, o que pode formar um "ciclo" falso no grafo.
bool IsDescendantOrSelf(const ProcMap& map, DWORD pid, DWORD ancestor) {
    for (int depth = 0; depth < 64; depth++) {
        if (pid == ancestor) return true;
        auto it = map.find(pid);
        if (it == map.end()) return false;
        const DWORD parent = it->second.parent;
        if (parent == 0 || parent == pid) return false;
        pid = parent;
    }
    return false;
}

// Sobe a árvore enquanto o pai for o MESMO executável — raiz de um app multi-processo
// (Chromium/Electron: o áudio sai de um processo filho, mas INCLUDE da raiz pega todos).
DWORD SameExeRoot(const ProcMap& map, DWORD pid) {
    auto self = map.find(pid);
    if (self == map.end()) return pid;
    DWORD current = pid;
    for (int depth = 0; depth < 64; depth++) {
        auto it = map.find(current);
        if (it == map.end()) break;
        auto parent = map.find(it->second.parent);
        if (parent == map.end() || parent->first == current || parent->second.exeLower != self->second.exeLower) break;
        current = parent->first;
    }
    return current;
}

bool IsSystemProcess(const ProcMap& map, DWORD pid) {
    if (pid == 0 || pid == 4) return true;
    auto it = map.find(pid);
    if (it == map.end()) return true;
    for (const wchar_t* exe : kSystemExes) {
        if (it->second.exeLower == exe) return true;
    }
    return false;
}

struct SessionInfo {
    DWORD pid;
    bool active;
};

// Todas as sessões de áudio de todos os dispositivos de SAÍDA ativos — não só o padrão: com um
// proxy tipo NVIDIA Broadcast, o app de origem toca no dispositivo virtual do proxy.
std::vector<SessionInfo> EnumerateRenderSessions() {
    std::vector<SessionInfo> result;
    ComPtr<IMMDeviceEnumerator> enumerator;
    if (FAILED(CoCreateInstance(__uuidof(MMDeviceEnumerator), nullptr, CLSCTX_ALL, IID_PPV_ARGS(&enumerator)))) return result;
    ComPtr<IMMDeviceCollection> devices;
    if (FAILED(enumerator->EnumAudioEndpoints(eRender, DEVICE_STATE_ACTIVE, &devices))) return result;
    UINT deviceCount = 0;
    devices->GetCount(&deviceCount);
    for (UINT i = 0; i < deviceCount; i++) {
        ComPtr<IMMDevice> device;
        if (FAILED(devices->Item(i, &device))) continue;
        ComPtr<IAudioSessionManager2> manager;
        if (FAILED(device->Activate(__uuidof(IAudioSessionManager2), CLSCTX_ALL, nullptr, reinterpret_cast<void**>(manager.GetAddressOf())))) continue;
        ComPtr<IAudioSessionEnumerator> sessions;
        if (FAILED(manager->GetSessionEnumerator(&sessions))) continue;
        int sessionCount = 0;
        sessions->GetCount(&sessionCount);
        for (int j = 0; j < sessionCount; j++) {
            ComPtr<IAudioSessionControl> control;
            if (FAILED(sessions->GetSession(j, &control))) continue;
            ComPtr<IAudioSessionControl2> control2;
            if (FAILED(control.As(&control2))) continue;
            if (control2->IsSystemSoundsSession() == S_OK) continue;
            DWORD pid = 0;
            if (FAILED(control2->GetProcessId(&pid)) || pid == 0) continue;
            AudioSessionState state = AudioSessionStateInactive;
            control->GetState(&state);
            result.push_back({pid, state == AudioSessionStateActive});
        }
    }
    return result;
}

// Handler de conclusão da ativação assíncrona (`ActivateAudioInterfaceAsync` só existe em versão
// assíncrona) — esperado num evento logo em seguida. Precisa de `FtmBase` (marshaler livre de
// thread) — sem isso, mesma classe de bug `RO_E_MUST_BE_AGILE` já corrigida em
// WindowCaptureCore.cpp (o callback dispara numa thread MTA interna do Windows).
class ActivationCompletionHandler
    : public RuntimeClass<RuntimeClassFlags<ClassicCom>, IActivateAudioInterfaceCompletionHandler, Microsoft::WRL::FtmBase> {
public:
    explicit ActivationCompletionHandler(HANDLE doneEvent) : doneEvent_(doneEvent) {}

    HRESULT STDMETHODCALLTYPE ActivateCompleted(IActivateAudioInterfaceAsyncOperation* op) override {
        HRESULT hrActivate = E_FAIL;
        IUnknown* punkAudioInterface = nullptr;
        op->GetActivateResult(&hrActivate, &punkAudioInterface);
        if (SUCCEEDED(hrActivate) && punkAudioInterface) {
            punkAudioInterface->QueryInterface(IID_PPV_ARGS(&audioClient_));
        }
        if (punkAudioInterface) punkAudioInterface->Release();
        activateResult_ = hrActivate;
        SetEvent(doneEvent_);
        return S_OK;
    }

    HRESULT activateResult_ = E_FAIL;
    IAudioClient* audioClient_ = nullptr;

private:
    HANDLE doneEvent_;
};

} // namespace

AudioCaptureCore::AudioCaptureCore() {}

AudioCaptureCore::~AudioCaptureCore() {
    Shutdown();
}

// Apps multi-processo (Discord, qualquer coisa baseada em Electron/Chromium) rodam VÁRIOS
// processos com o MESMO executável — a raiz é o que tem pai de outro executável.
DWORD AudioCaptureCore::FindProcessIdByName(const wchar_t* exeName) {
    const ProcMap map = SnapshotProcesses();
    const std::wstring target = ToLower(exeName);
    DWORD first = 0;
    for (const auto& [pid, entry] : map) {
        if (entry.exeLower != target) continue;
        if (!first) first = pid;
        auto parent = map.find(entry.parent);
        if (parent == map.end() || parent->second.exeLower != target) return pid;
    }
    return first;
}

std::vector<AudioAppInfo> AudioCaptureCore::ListAudioApps() {
    // COM pode não estar inicializado na thread chamadora (IPC do main process) — ou já estar, com
    // outro apartment (RPC_E_CHANGED_MODE): WASAPI funciona nos dois, só não desinicializa o que não
    // inicializou.
    HRESULT coHr = CoInitializeEx(nullptr, COINIT_MULTITHREADED);
    const bool uninit = SUCCEEDED(coHr) && coHr != RPC_E_CHANGED_MODE;

    std::vector<AudioAppInfo> apps;
    const ProcMap map = SnapshotProcesses();
    const DWORD self = GetCurrentProcessId();
    for (const SessionInfo& session : EnumerateRenderSessions()) {
        if (IsSystemProcess(map, session.pid) || IsDescendantOrSelf(map, session.pid, self)) continue;
        auto it = map.find(session.pid);
        if (it == map.end()) continue;
        auto existing = std::find_if(apps.begin(), apps.end(), [&](const AudioAppInfo& a) { return ToLower(a.exeName) == it->second.exeLower; });
        if (existing != apps.end()) {
            existing->active = existing->active || session.active;
        } else {
            apps.push_back({it->second.exe, session.active});
        }
    }
    if (uninit) CoUninitialize();
    return apps;
}

bool AudioCaptureCore::InitializeForSystem(const std::vector<std::wstring>& excludedExeNames) {
    Shutdown();
    systemMode_ = true;
    windowHwnd_ = nullptr;
    return Start(excludedExeNames);
}

bool AudioCaptureCore::InitializeForWindow(HWND hwnd, const std::vector<std::wstring>& excludedExeNames) {
    Shutdown();
    systemMode_ = false;
    windowHwnd_ = hwnd;
    return Start(excludedExeNames);
}

// Sobe a thread e espera ela terminar a 1ª varredura de fontes (o chamador quer saber se deu certo
// e o que está sendo capturado — e no caminho de janela, sem fonte = sem áudio).
bool AudioCaptureCore::Start(const std::vector<std::wstring>& excludedExeNames) {
    excludedLower_.clear();
    for (const auto& name : excludedExeNames) excludedLower_.push_back(ToLower(name));
    targets_.clear();
    lastRefresh_ = {};
    {
        std::lock_guard<std::mutex> lock(mutex_);
        pendingAdd_.clear();
        pendingRemove_.clear();
        initDone_ = false;
        initOk_ = false;
        excludedChanged_ = false;
    }
    stop_ = false;
    worker_ = std::thread([this] { WorkerMain(); });
    std::unique_lock<std::mutex> lock(mutex_);
    initCv_.wait_for(lock, std::chrono::seconds(10), [this] { return initDone_; });
    const bool ok = initDone_ && initOk_;
    lock.unlock();
    if (!ok) Shutdown();
    return ok;
}

void AudioCaptureCore::WorkerMain() {
    // MTA própria da thread — os IAudioClient de process loopback são criados E usados só aqui.
    const HRESULT coHr = CoInitializeEx(nullptr, COINIT_MULTITHREADED);
    DWORD taskIndex = 0;
    HANDLE mmcss = AvSetMmThreadCharacteristicsW(L"Pro Audio", &taskIndex);

    bool ok = CreateEncoder();
    if (ok) {
        RefreshSources(true);
        ApplyPendingSources();
        // Depois das ativações iniciais (que bloqueiam) — senão o mixer já começaria atrasado.
        epochUs_ = QpcNowUs();
        ok = systemMode_ || !sources_.empty();
    }
    {
        std::lock_guard<std::mutex> lock(mutex_);
        initOk_ = ok;
        initDone_ = true;
        capturedNames_.clear();
        for (const auto& source : sources_) capturedNames_.push_back(source.exeName);
    }
    initCv_.notify_all();

    if (ok) refresher_ = std::thread([this] { RefreshMain(); });
    while (ok && !stop_) {
        ApplyPendingSources();
        for (auto& source : sources_) DrainSource(source);
        EncodeReadyFrames();
        std::this_thread::sleep_for(kWorkerPeriod);
    }
    if (refresher_.joinable()) refresher_.join(); // `stop_` já setado — sai em até ~100ms

    ApplyPendingSources(); // solta o que a de refresh ativou e ninguém aplicou
    for (auto& source : sources_) ReleaseSource(source);
    sources_.clear();
    if (encoder_) {
        opus_encoder_destroy(encoder_);
        encoder_ = nullptr;
    }
    mix_.clear();
    mixBaseSample_ = 0;
    if (mmcss) AvRevertMmThreadCharacteristics(mmcss);
    if (SUCCEEDED(coHr)) CoUninitialize();
}

void AudioCaptureCore::RefreshMain() {
    const HRESULT coHr = CoInitializeEx(nullptr, COINIT_MULTITHREADED);
    auto last = std::chrono::steady_clock::now();
    while (!stop_) {
        std::this_thread::sleep_for(std::chrono::milliseconds(100));
        bool force = false;
        {
            std::lock_guard<std::mutex> lock(mutex_);
            if (excludedChanged_) {
                excludedLower_ = pendingExcludedLower_;
                excludedChanged_ = false;
                force = true;
            }
        }
        const auto now = std::chrono::steady_clock::now();
        if (force || now - last >= kRefreshInterval) {
            last = now;
            RefreshSources(true);
        }
    }
    if (SUCCEEDED(coHr)) CoUninitialize();
}

void AudioCaptureCore::ApplyPendingSources() {
    std::vector<Source> add;
    std::vector<DWORD> remove;
    {
        std::lock_guard<std::mutex> lock(mutex_);
        add.swap(pendingAdd_);
        remove.swap(pendingRemove_);
    }
    for (DWORD pid : remove) {
        for (size_t i = sources_.size(); i-- > 0;) {
            if (sources_[i].targetPid != pid) continue;
            ReleaseSource(sources_[i]);
            sources_.erase(sources_.begin() + i);
        }
    }
    for (auto& source : add) sources_.push_back(source);
}

void AudioCaptureCore::SetExcludedExeNames(const std::vector<std::wstring>& excludedExeNames) {
    std::lock_guard<std::mutex> lock(mutex_);
    pendingExcludedLower_.clear();
    for (const auto& name : excludedExeNames) pendingExcludedLower_.push_back(ToLower(name));
    excludedChanged_ = true;
}

void AudioCaptureCore::SetPacketCallback(PacketCallback callback) {
    std::lock_guard<std::mutex> lock(mutex_);
    callback_ = std::move(callback);
    queue_.clear();
}

std::vector<EncodedAudioPacket> AudioCaptureCore::PollEncodedPackets() {
    std::lock_guard<std::mutex> lock(mutex_);
    std::vector<EncodedAudioPacket> packets;
    packets.swap(queue_);
    return packets;
}

float AudioCaptureCore::LastRms() {
    std::lock_guard<std::mutex> lock(mutex_);
    return lastRms_;
}

bool AudioCaptureCore::IsExcludedExe(const std::wstring& exeLower) const {
    return std::find(excludedLower_.begin(), excludedLower_.end(), exeLower) != excludedLower_.end();
}

std::vector<std::wstring> AudioCaptureCore::CapturedExeNames() {
    std::lock_guard<std::mutex> lock(mutex_);
    return capturedNames_;
}

// Process loopback (Win10 2004+) — `VIRTUAL_AUDIO_DEVICE_PROCESS_LOOPBACK` é um "dispositivo"
// sintético, só serve pra essa ativação especial. INCLUDE = só a árvore de `targetPid`.
bool AudioCaptureCore::ActivateSource(DWORD targetPid, const std::wstring& exeName, Source& out) {
    AUDIOCLIENT_ACTIVATION_PARAMS params{};
    params.ActivationType = AUDIOCLIENT_ACTIVATION_TYPE_PROCESS_LOOPBACK;
    params.ProcessLoopbackParams.TargetProcessId = targetPid;
    params.ProcessLoopbackParams.ProcessLoopbackMode = PROCESS_LOOPBACK_MODE_INCLUDE_TARGET_PROCESS_TREE;

    PROPVARIANT propvariant{};
    propvariant.vt = VT_BLOB;
    propvariant.blob.cbSize = sizeof(params);
    propvariant.blob.pBlobData = reinterpret_cast<BYTE*>(&params);

    HANDLE doneEvent = CreateEventW(nullptr, FALSE, FALSE, nullptr);
    if (!doneEvent) return false;

    auto handler = Microsoft::WRL::Make<ActivationCompletionHandler>(doneEvent);
    IActivateAudioInterfaceAsyncOperation* asyncOp = nullptr;
    HRESULT hr = ActivateAudioInterfaceAsync(
        VIRTUAL_AUDIO_DEVICE_PROCESS_LOOPBACK, __uuidof(IAudioClient), &propvariant, handler.Get(), &asyncOp);
    if (asyncOp) asyncOp->Release();
    if (FAILED(hr)) {
        CloseHandle(doneEvent);
        fprintf(stderr, "[AudioCaptureCore] ActivateAudioInterfaceAsync falhou: 0x%08lx\n", (unsigned long)hr);
        return false;
    }
    WaitForSingleObject(doneEvent, 5000);
    CloseHandle(doneEvent);
    if (FAILED(handler->activateResult_) || !handler->audioClient_) {
        fprintf(stderr, "[AudioCaptureCore] ativação de process-loopback (pid %lu) falhou: 0x%08lx\n",
                (unsigned long)targetPid, (unsigned long)handler->activateResult_);
        if (handler->audioClient_) handler->audioClient_->Release();
        return false;
    }

    Source source;
    source.targetPid = targetPid;
    source.exeName = exeName;
    source.client = handler->audioClient_;

    // O dispositivo virtual de process loopback converte pra qualquer formato pedido — float32
    // estéreo 48kHz é exatamente o que o mixer/Opus usam, sem conversão nossa.
    WAVEFORMATEX format{};
    format.wFormatTag = WAVE_FORMAT_IEEE_FLOAT;
    format.nChannels = kChannels;
    format.nSamplesPerSec = kSampleRate;
    format.wBitsPerSample = 32;
    format.nBlockAlign = (format.nChannels * format.wBitsPerSample) / 8;
    format.nAvgBytesPerSec = format.nSamplesPerSec * format.nBlockAlign;

    // `AUDCLNT_STREAMFLAGS_LOOPBACK` é obrigatório mesmo pro dispositivo virtual (amostra oficial
    // `ApplicationLoopback` da Microsoft). Sem EVENTCALLBACK: polling a partir do loop JS.
    hr = source.client->Initialize(AUDCLNT_SHAREMODE_SHARED, AUDCLNT_STREAMFLAGS_LOOPBACK, 2000000 /* 200ms */, 0, &format, nullptr);
    if (SUCCEEDED(hr)) hr = source.client->GetService(IID_PPV_ARGS(&source.capture));
    if (SUCCEEDED(hr)) hr = source.client->Start();
    if (FAILED(hr)) {
        fprintf(stderr, "[AudioCaptureCore] inicialização da fonte (pid %lu) falhou: 0x%08lx\n", (unsigned long)targetPid, (unsigned long)hr);
        ReleaseSource(source);
        return false;
    }
    fprintf(stderr, "[AudioCaptureCore] fonte de áudio adicionada: %ls (pid %lu)\n", exeName.c_str(), (unsigned long)targetPid);
    out = source;
    return true;
}

void AudioCaptureCore::ReleaseSource(Source& source) {
    if (source.client) source.client->Stop();
    if (source.capture) source.capture->Release();
    if (source.client) source.client->Release();
    source.capture = nullptr;
    source.client = nullptr;
}

void AudioCaptureCore::RefreshSources(bool force) {
    const auto now = std::chrono::steady_clock::now();
    if (!force && now - lastRefresh_ < kRefreshInterval) return;
    lastRefresh_ = now;
    std::vector<Source> added;
    std::vector<DWORD> removed;

    const ProcMap map = SnapshotProcesses();
    const DWORD self = GetCurrentProcessId();
    // Processo "excluído" = executável na lista OU parte da árvore do próprio app (eco).
    auto isExcluded = [&](DWORD pid) {
        auto it = map.find(pid);
        return (it != map.end() && IsExcludedExe(it->second.exeLower)) || IsDescendantOrSelf(map, pid, self);
    };
    auto treeContainsExcluded = [&](DWORD root) {
        for (const auto& [pid, entry] : map) {
            if (isExcluded(pid) && IsDescendantOrSelf(map, pid, root)) return true;
        }
        return false;
    };
    // Raiz do mesmo executável quando seguro; senão só o próprio PID; 0 = nem isso é seguro.
    auto safeTarget = [&](DWORD pid) -> DWORD {
        const DWORD root = SameExeRoot(map, pid);
        if (!treeContainsExcluded(root)) return root;
        if (!treeContainsExcluded(pid)) return pid;
        return 0;
    };

    // Remove fontes cujo processo morreu, que passaram a ser excluídas, ou cuja árvore ganhou um
    // processo excluído (ex.: Discord aberto a partir de um app que já estava incluído).
    for (size_t i = targets_.size(); i-- > 0;) {
        const DWORD target = targets_[i].pid;
        if (!map.count(target) || isExcluded(target) || treeContainsExcluded(target)) {
            fprintf(stderr, "[AudioCaptureCore] fonte de áudio removida: %ls (pid %lu)\n", targets_[i].exeName.c_str(), (unsigned long)target);
            removed.push_back(target);
            targets_.erase(targets_.begin() + i);
        }
    }

    auto addTargetFor = [&](DWORD pid) {
        if (IsSystemProcess(map, pid) || isExcluded(pid)) return;
        for (const auto& t : targets_) {
            if (IsDescendantOrSelf(map, pid, t.pid)) return; // já coberto por uma árvore incluída
        }
        const DWORD target = safeTarget(pid);
        if (!target) return;
        // Fonte já existente DENTRO da árvore nova seria capturada duas vezes (som dobrado).
        for (size_t i = targets_.size(); i-- > 0;) {
            if (IsDescendantOrSelf(map, targets_[i].pid, target)) {
                removed.push_back(targets_[i].pid);
                targets_.erase(targets_.begin() + i);
            }
        }
        auto it = map.find(target);
        const std::wstring exe = it != map.end() ? it->second.exe : L"?";
        Source source;
        if (ActivateSource(target, exe, source)) {
            added.push_back(source);
            targets_.push_back({target, exe});
        }
    };

    if (systemMode_) {
        for (const SessionInfo& session : EnumerateRenderSessions()) {
            if (session.active) addTargetFor(session.pid);
        }
    } else if (targets_.empty() && windowHwnd_) {
        DWORD windowPid = 0;
        GetWindowThreadProcessId(windowHwnd_, &windowPid);
        if (windowPid) addTargetFor(windowPid);
    }

    std::lock_guard<std::mutex> lock(mutex_);
    for (auto& source : added) pendingAdd_.push_back(source);
    for (DWORD pid : removed) pendingRemove_.push_back(pid);
    capturedNames_.clear();
    for (const auto& t : targets_) capturedNames_.push_back(t.exeName);
}

int64_t AudioCaptureCore::SampleAtUs(int64_t us) const {
    const int64_t delta = us - epochUs_;
    return delta >= 0 ? (delta * kSampleRate) / 1000000 : -((-delta * kSampleRate) / 1000000);
}

void AudioCaptureCore::MixInto(int64_t startSample, const float* data, uint32_t frames, bool silent) {
    const int64_t endSample = startSample + frames;
    if (startSample < mixBaseSample_) mixStats_.lateSamples += std::min<int64_t>(frames, mixBaseSample_ - startSample);
    if (endSample <= mixBaseSample_) return; // trecho já fechado e enviado — chegou tarde demais
    const int64_t relEnd = endSample - mixBaseSample_;
    if (relEnd > kMaxAheadSamples) return;
    const size_t needed = static_cast<size_t>(relEnd) * kChannels;
    if (mix_.size() < needed) mix_.resize(needed, 0.f);
    if (silent || !data) return;
    const int64_t skip = std::max<int64_t>(0, mixBaseSample_ - startSample);
    for (int64_t i = skip; i < frames; i++) {
        const size_t dst = static_cast<size_t>(startSample + i - mixBaseSample_) * kChannels;
        mix_[dst] += data[i * kChannels];
        mix_[dst + 1] += data[i * kChannels + 1];
    }
}

void AudioCaptureCore::DrainSource(Source& source) {
    if (!source.capture) return;
    UINT32 packetLength = 0;
    while (SUCCEEDED(source.capture->GetNextPacketSize(&packetLength)) && packetLength > 0) {
        BYTE* data = nullptr;
        UINT32 frames = 0;
        DWORD flags = 0;
        UINT64 devicePosition = 0;
        UINT64 qpcPosition = 0; // unidades de 100ns
        if (FAILED(source.capture->GetBuffer(&data, &frames, &flags, &devicePosition, &qpcPosition))) break;

        const int64_t nowUs = QpcNowUs();
        const int64_t durationUs = static_cast<int64_t>(frames) * 1000000 / kSampleRate;
        int64_t packetUs = qpcPosition ? static_cast<int64_t>(qpcPosition / 10) : nowUs - durationUs;
        // Timestamp fora de qualquer faixa plausível — estima pelo "agora" em vez de jogar o pacote
        // num ponto absurdo da linha do tempo.
        if (packetUs > nowUs + 100000 || packetUs < nowUs - 2000000) packetUs = nowUs - durationUs;

        mixStats_.maxArrivalLagMs = std::max(mixStats_.maxArrivalLagMs, (nowUs - (packetUs + durationUs)) / 1000.0);

        int64_t start = SampleAtUs(packetUs);
        if (source.hasNext && !(flags & AUDCLNT_BUFFERFLAGS_DATA_DISCONTINUITY) && std::llabs(start - source.nextSample) <= 96) {
            start = source.nextSample;
        }
        MixInto(start, reinterpret_cast<const float*>(data), frames, (flags & AUDCLNT_BUFFERFLAGS_SILENT) != 0);
        source.nextSample = start + frames;
        source.hasNext = true;

        source.capture->ReleaseBuffer(frames);
    }
}

AudioCaptureCore::MixStats AudioCaptureCore::TakeMixStats() {
    std::lock_guard<std::mutex> lock(mutex_);
    MixStats stats = sharedMixStats_;
    sharedMixStats_ = {};
    return stats;
}

bool AudioCaptureCore::CreateEncoder() {
    int error = 0;
    encoder_ = opus_encoder_create(kSampleRate, kChannels, OPUS_APPLICATION_AUDIO, &error);
    if (error != OPUS_OK || !encoder_) {
        encoder_ = nullptr;
        return false;
    }
    // Áudio de sistema pode ser qualquer coisa (jogo, música, voz) — mais que o preset "voip".
    opus_encoder_ctl(encoder_, OPUS_SET_BITRATE(64000 * kChannels));
    return true;
}

void AudioCaptureCore::EncodeReadyFrames() {
    const int64_t readyUntil = SampleAtUs(QpcNowUs()) - kMixLatencySamples;
    // Thread parada por muito tempo (suspensão, debugger) — pula pra perto do "agora" em vez de
    // despejar segundos de silêncio de uma vez.
    if (readyUntil - mixBaseSample_ > kSampleRate) {
        const int64_t newBase = readyUntil - kSamplesPerOpusFrame * 5;
        const size_t dropValues = static_cast<size_t>(newBase - mixBaseSample_) * kChannels;
        if (mix_.size() > dropValues) mix_.erase(mix_.begin(), mix_.begin() + dropValues);
        else mix_.clear();
        mixBaseSample_ = newBase;
    }

    const size_t frameValues = static_cast<size_t>(kSamplesPerOpusFrame) * kChannels;
    unsigned char opusOut[4000]; // teto seguro pro maior pacote Opus possível
    std::vector<EncodedAudioPacket> ready;
    while (mixBaseSample_ + kSamplesPerOpusFrame <= readyUntil) {
        if (mix_.size() < frameValues) mix_.resize(frameValues, 0.f);
        // Soma de várias fontes pode passar de [-1, 1] — corta em vez de deixar o Opus distorcer.
        for (size_t i = 0; i < frameValues; i++) {
            mix_[i] = std::clamp(mix_[i], -1.f, 1.f);
            rmsSumSquares_ += static_cast<double>(mix_[i]) * mix_[i];
        }
        rmsSampleCount_ += frameValues;
        const int encodedBytes = opus_encode_float(encoder_, mix_.data(), static_cast<int>(kSamplesPerOpusFrame), opusOut, sizeof(opusOut));
        if (encodedBytes > 0) {
            EncodedAudioPacket packet;
            packet.data.assign(opusOut, opusOut + encodedBytes);
            packet.ptsUs = epochUs_ + (mixBaseSample_ * 1000000) / kSampleRate;
            ready.push_back(std::move(packet));
        }
        mix_.erase(mix_.begin(), mix_.begin() + frameValues);
        mixBaseSample_ += kSamplesPerOpusFrame;
    }

    PacketCallback callback;
    {
        std::lock_guard<std::mutex> lock(mutex_);
        sharedMixStats_.maxArrivalLagMs = std::max(sharedMixStats_.maxArrivalLagMs, mixStats_.maxArrivalLagMs);
        sharedMixStats_.lateSamples += mixStats_.lateSamples;
        mixStats_ = {};
        // RMS por janela de ~100ms (não por pacote) — o log de 1s lê o valor mais recente.
        if (rmsSampleCount_ >= static_cast<size_t>(kSampleRate / 10) * kChannels) {
            lastRms_ = static_cast<float>(std::sqrt(rmsSumSquares_ / rmsSampleCount_));
            rmsSumSquares_ = 0.0;
            rmsSampleCount_ = 0;
        }
        callback = callback_;
        if (!callback) {
            for (auto& packet : ready) queue_.push_back(std::move(packet));
            // Ninguém lendo (sem callback e sem poll) — não deixa crescer pra sempre.
            if (queue_.size() > 500) queue_.erase(queue_.begin(), queue_.begin() + (queue_.size() - 500));
            return;
        }
    }
    for (const auto& packet : ready) callback(packet);
}

void AudioCaptureCore::Shutdown() {
    stop_ = true;
    if (worker_.joinable()) worker_.join();
    std::lock_guard<std::mutex> lock(mutex_);
    queue_.clear();
    capturedNames_.clear();
    callback_ = nullptr;
}
