#include "AudioCaptureCore.h"

#define NOMINMAX
#include <mmdeviceapi.h>
#include <functiondiscoverykeys_devpkey.h>
#include <tlhelp32.h>
#include <propvarutil.h>
#include <wrl/client.h>
#include <wrl/implements.h>
#include <cstdio>
#include <cstring>
#include <vector>
#include <utility>
#include <cmath>

using Microsoft::WRL::ComPtr;
using Microsoft::WRL::ClassicCom;
using Microsoft::WRL::RuntimeClassFlags;
using Microsoft::WRL::RuntimeClass;

namespace {

// Handler de conclusão da ativação assíncrona (`ActivateAudioInterfaceAsync` só existe em versão
// assíncrona, mesmo pra loopback de processo síncrono na prática — chamado 1x na inicialização,
// então esperar num evento aqui não trava nada em produção, mesmo padrão usado pelo Initialize()
// de outras partes do addon). Precisa de `FtmBase` (marshaler livre de thread) — sem isso, mesma
// classe de bug `RO_E_MUST_BE_AGILE` já corrigida em WindowCaptureCore.cpp (o callback dispara
// numa thread MTA interna do Windows, não na thread que chamou `ActivateAudioInterfaceAsync`).
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

// Apps multi-processo (Discord, qualquer coisa baseada em Electron/Chromium — mesma arquitetura
// desse próprio app) rodam VÁRIOS processos com o MESMO nome de executável (main + renderers + GPU
// process etc.). `PROCESS_LOOPBACK_MODE_EXCLUDE_TARGET_PROCESS_TREE` só cobre a árvore a partir do
// PID passado pra baixo (descendentes) — se `TargetProcessId` fosse um processo filho qualquer (ex.:
// um renderer) em vez da RAIZ da árvore, processos irmãos (outro renderer emitindo áudio) ficariam
// FORA da exclusão. Por isso não basta achar "o primeiro PID com esse nome": precisa achar, entre
// TODOS os processos com esse nome, aquele cujo PAI não é (ou não existe mais / não é o mesmo
// nome) — esse é a raiz real da árvore, garantindo que a exclusão cubra todo mundo.
DWORD AudioCaptureCore::FindProcessIdByName(const wchar_t* exeName) {
    HANDLE snapshot = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
    if (snapshot == INVALID_HANDLE_VALUE) return 0;

    struct Entry { DWORD pid; DWORD parentPid; };
    std::vector<Entry> matches;
    std::vector<std::pair<DWORD, DWORD>> allPidParent; // pid -> parentPid, de TODOS os processos

    PROCESSENTRY32W entry{};
    entry.dwSize = sizeof(entry);
    if (Process32FirstW(snapshot, &entry)) {
        do {
            allPidParent.emplace_back(entry.th32ProcessID, entry.th32ParentProcessID);
            if (_wcsicmp(entry.szExeFile, exeName) == 0) {
                matches.push_back({entry.th32ProcessID, entry.th32ParentProcessID});
            }
        } while (Process32NextW(snapshot, &entry));
    }
    CloseHandle(snapshot);

    if (matches.empty()) return 0;

    // Raiz = processo cujo pai NÃO está no próprio conjunto de matches (pai é outro app, ou já
    // morreu/PID reciclado — de qualquer forma, não é outro processo da mesma árvore).
    for (const auto& m : matches) {
        bool parentIsAlsoMatch = false;
        for (const auto& other : matches) {
            if (other.pid == m.parentPid) {
                parentIsAlsoMatch = true;
                break;
            }
        }
        if (!parentIsAlsoMatch) return m.pid;
    }
    // Não deveria acontecer (grafo de processos não tem ciclo), mas por segurança: primeiro match.
    return matches.front().pid;
}

// Acha o nome do executável dono de um PID (`GetWindowThreadProcessId` já dá o PID a partir do
// HWND — ver `InitializeForWindow`). Usado só pra reaproveitar `FindProcessIdByName` (achar a RAIZ
// da árvore) sem duplicar aquela lógica de subida de árvore de processos.
static std::wstring GetExeNameForPid(DWORD pid) {
    HANDLE process = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, FALSE, pid);
    if (!process) return L"";

    wchar_t buffer[MAX_PATH];
    DWORD size = MAX_PATH;
    std::wstring name;
    if (QueryFullProcessImageNameW(process, 0, buffer, &size)) {
        std::wstring full(buffer, size);
        size_t pos = full.find_last_of(L"\\/");
        name = pos == std::wstring::npos ? full : full.substr(pos + 1);
    }
    CloseHandle(process);
    return name;
}

bool AudioCaptureCore::EnsureComInitialized() {
    // COM pode já estar inicializado pelo resto do processo Electron (ou não, se chamado via
    // ELECTRON_RUN_AS_NODE/script isolado) — mesmo padrão de SoftwareEncoderCore.cpp:
    // RPC_E_CHANGED_MODE (já inicializado com apartment diferente) não é erro fatal aqui, WASAPI
    // funciona em qualquer um dos dois modos.
    HRESULT coHr = CoInitializeEx(nullptr, COINIT_MULTITHREADED);
    comInitializedHere_ = SUCCEEDED(coHr) && coHr != RPC_E_CHANGED_MODE;
    return SUCCEEDED(coHr) || coHr == RPC_E_CHANGED_MODE;
}

bool AudioCaptureCore::Initialize(DWORD excludeProcessId) {
    Shutdown();
    EnsureComInitialized();

    bool ok = excludeProcessId != 0
        ? InitializeProcessLoopback(excludeProcessId, PROCESS_LOOPBACK_MODE_EXCLUDE_TARGET_PROCESS_TREE)
        : InitializeDeviceLoopback();
    if (!ok) {
        Shutdown();
        return false;
    }

    if (!CreateEncoder()) {
        Shutdown();
        return false;
    }

    pcmBuffer_.clear();
    return true;
}

// Caminho de JANELA — INCLUDE em vez de EXCLUDE: só o áudio da árvore de processos dona da janela
// compartilhada sai na transmissão, todo o resto do sistema (Discord incluído) fica de fora sem
// precisar de exclusão nenhuma. `GetWindowThreadProcessId` dá o PID dono do HWND; esse PID pode
// ser só um processo FILHO (ex.: o renderer de um app Electron/Chromium multi-processo) — resolve
// o nome do executável dele e reaproveita `FindProcessIdByName` (mesma lógica de achar a RAIZ da
// árvore) em vez de assumir que o PID da janela já é a raiz.
bool AudioCaptureCore::InitializeForWindow(HWND hwnd) {
    Shutdown();
    EnsureComInitialized();

    DWORD windowPid = 0;
    GetWindowThreadProcessId(hwnd, &windowPid);
    if (windowPid == 0) {
        Shutdown();
        return false;
    }

    std::wstring exeName = GetExeNameForPid(windowPid);
    DWORD rootPid = exeName.empty() ? 0 : FindProcessIdByName(exeName.c_str());
    if (rootPid == 0) rootPid = windowPid; // não achou pelo nome — usa o PID da janela mesmo

    if (!InitializeProcessLoopback(rootPid, PROCESS_LOOPBACK_MODE_INCLUDE_TARGET_PROCESS_TREE)) {
        Shutdown();
        return false;
    }

    if (!CreateEncoder()) {
        Shutdown();
        return false;
    }

    pcmBuffer_.clear();
    return true;
}

// Loopback de PROCESSO (Win10 2004+) — `VIRTUAL_AUDIO_DEVICE_PROCESS_LOOPBACK` é um "dispositivo"
// sintético que não existe no mixer normal, só serve pra essa ativação especial. `mode` decide se
// é EXCLUDE (compartilhamento de MONITOR — exclui 1 app, resto do sistema todo entra) ou INCLUDE
// (compartilhamento de JANELA — só a árvore daquele app entra, resto do sistema fica de fora).
bool AudioCaptureCore::InitializeProcessLoopback(DWORD targetProcessId, PROCESS_LOOPBACK_MODE mode) {
    AUDIOCLIENT_ACTIVATION_PARAMS params{};
    params.ActivationType = AUDIOCLIENT_ACTIVATION_TYPE_PROCESS_LOOPBACK;
    params.ProcessLoopbackParams.TargetProcessId = targetProcessId;
    params.ProcessLoopbackParams.ProcessLoopbackMode = mode;

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
        fprintf(stderr, "[AudioCaptureCore] ativação de process-loopback falhou: 0x%08lx\n",
                (unsigned long)handler->activateResult_);
        return false;
    }

    audioClient_ = handler->audioClient_;

    format_.wFormatTag = WAVE_FORMAT_IEEE_FLOAT;
    format_.nChannels = 2;
    format_.nSamplesPerSec = 48000;
    format_.wBitsPerSample = 32;
    format_.nBlockAlign = (format_.nChannels * format_.wBitsPerSample) / 8;
    format_.nAvgBytesPerSec = format_.nSamplesPerSec * format_.nBlockAlign;
    format_.cbSize = 0;

    // `AUDCLNT_STREAMFLAGS_LOOPBACK` é obrigatório mesmo pro dispositivo virtual de
    // process-loopback (não é implícito pelo nome do device) — confirmado pela amostra oficial da
    // Microsoft (`ApplicationLoopback`). Sem `EVENTCALLBACK`: polling simples a partir do loop JS
    // existente (mesmo estilo do resto do addon, sem thread nativa própria).
    hr = audioClient_->Initialize(
        AUDCLNT_SHAREMODE_SHARED, AUDCLNT_STREAMFLAGS_LOOPBACK, 2000000 /* 200ms */, 0, &format_, nullptr);
    if (FAILED(hr)) {
        fprintf(stderr, "[AudioCaptureCore] IAudioClient::Initialize (process loopback) falhou: 0x%08lx\n", (unsigned long)hr);
        return false;
    }

    hr = audioClient_->GetService(IID_PPV_ARGS(&captureClient_));
    if (FAILED(hr)) return false;

    hr = audioClient_->Start();
    return SUCCEEDED(hr);
}

// Caminho normal (sem exclusão) — loopback do dispositivo de renderização PADRÃO inteiro, mesma
// técnica que o `chromeMediaSource:"desktop"` do caminho LiveKit já usa, só que direto via WASAPI
// em vez de passar pelo Chromium. Serve de fallback se a API de process-loopback não existir
// (Windows < 10 2004) ou se o usuário não pedir nenhuma exclusão.
bool AudioCaptureCore::InitializeDeviceLoopback() {
    ComPtr<IMMDeviceEnumerator> enumerator;
    HRESULT hr = CoCreateInstance(__uuidof(MMDeviceEnumerator), nullptr, CLSCTX_ALL, IID_PPV_ARGS(&enumerator));
    if (FAILED(hr)) {
        fprintf(stderr, "[AudioCaptureCore] CoCreateInstance(MMDeviceEnumerator) falhou: 0x%08lx\n", (unsigned long)hr);
        return false;
    }

    ComPtr<IMMDevice> device;
    hr = enumerator->GetDefaultAudioEndpoint(eRender, eConsole, &device);
    if (FAILED(hr)) {
        fprintf(stderr, "[AudioCaptureCore] GetDefaultAudioEndpoint falhou: 0x%08lx\n", (unsigned long)hr);
        return false;
    }

    hr = device->Activate(__uuidof(IAudioClient), CLSCTX_ALL, nullptr, reinterpret_cast<void**>(&audioClient_));
    if (FAILED(hr)) {
        fprintf(stderr, "[AudioCaptureCore] IMMDevice::Activate falhou: 0x%08lx\n", (unsigned long)hr);
        return false;
    }

    WAVEFORMATEX* mixFormat = nullptr;
    hr = audioClient_->GetMixFormat(&mixFormat);
    if (FAILED(hr) || !mixFormat) {
        fprintf(stderr, "[AudioCaptureCore] GetMixFormat falhou: 0x%08lx\n", (unsigned long)hr);
        return false;
    }
    // `GetMixFormat` quase sempre retorna um `WAVEFORMATEXTENSIBLE` (maior que `WAVEFORMATEX`,
    // `cbSize` aponta pros bytes extras de extensão/subformat) — atribuir `*mixFormat` direto num
    // `WAVEFORMATEX format_` truncava a struct nesses bytes extras só que MANTINHA o `cbSize`
    // antigo (22), então `Initialize` lia lixo depois do fim do buffer alocado e falhava com
    // `E_INVALIDARG` (0x80070057). Passa o ponteiro ORIGINAL (tamanho completo) pro `Initialize`,
    // só extrai os campos escalares que o resto da classe (`CreateEncoder`) realmente precisa.
    hr = audioClient_->Initialize(AUDCLNT_SHAREMODE_SHARED, AUDCLNT_STREAMFLAGS_LOOPBACK, 2000000, 0, mixFormat, nullptr);
    format_ = *mixFormat;
    format_.cbSize = 0;
    CoTaskMemFree(mixFormat);
    if (FAILED(hr)) {
        fprintf(stderr, "[AudioCaptureCore] IAudioClient::Initialize (device loopback) falhou: 0x%08lx (rate=%lu ch=%u bits=%u)\n",
                (unsigned long)hr, (unsigned long)format_.nSamplesPerSec, format_.nChannels, format_.wBitsPerSample);
        return false;
    }

    hr = audioClient_->GetService(IID_PPV_ARGS(&captureClient_));
    if (FAILED(hr)) {
        fprintf(stderr, "[AudioCaptureCore] GetService(IAudioCaptureClient) falhou: 0x%08lx\n", (unsigned long)hr);
        return false;
    }

    hr = audioClient_->Start();
    if (FAILED(hr)) {
        fprintf(stderr, "[AudioCaptureCore] IAudioClient::Start falhou: 0x%08lx\n", (unsigned long)hr);
        return false;
    }
    return true;
}

bool AudioCaptureCore::CreateEncoder() {
    // Opus só aceita 8/12/16/24/48kHz — o mix format do Windows quase sempre já é 48kHz (padrão
    // moderno), mas não validamos/reamostramos aqui: se vier diferente, a inicialização abaixo
    // falha e a captura é abortada por inteiro (sem áudio) em vez de tocar velocidade errada em
    // silêncio. Reamostragem fica pra se algum hardware real precisar (não visto ainda).
    if (format_.nSamplesPerSec != 48000) {
        fprintf(stderr, "[AudioCaptureCore] sample rate %lu não suportado (só 48000 por ora)\n",
                (unsigned long)format_.nSamplesPerSec);
        return false;
    }
    int channels = format_.nChannels >= 2 ? 2 : 1;
    int error = 0;
    encoder_ = opus_encoder_create(48000, channels, OPUS_APPLICATION_AUDIO, &error);
    if (error != OPUS_OK || !encoder_) {
        encoder_ = nullptr;
        return false;
    }
    // Bitrate de voz+música misto (áudio de sistema pode ser qualquer coisa — jogo, música,
    // notificação), não só voz — mais alto que o preset "voip" padrão do Opus.
    opus_encoder_ctl(encoder_, OPUS_SET_BITRATE(64000 * channels));
    samplesPerChannelPerFrame_ = 960; // 20ms @ 48kHz, tamanho de frame Opus padrão
    return true;
}

std::vector<std::vector<uint8_t>> AudioCaptureCore::PollEncodedPackets() {
    std::vector<std::vector<uint8_t>> packets;
    if (!captureClient_ || !encoder_) return packets;

    const int channels = format_.nChannels >= 2 ? 2 : 1;

    UINT32 packetLength = 0;
    while (SUCCEEDED(captureClient_->GetNextPacketSize(&packetLength)) && packetLength > 0) {
        BYTE* data = nullptr;
        UINT32 framesAvailable = 0;
        DWORD flags = 0;
        HRESULT hr = captureClient_->GetBuffer(&data, &framesAvailable, &flags, nullptr, nullptr);
        if (FAILED(hr)) break;

        size_t prevSize = pcmBuffer_.size();
        pcmBuffer_.resize(prevSize + static_cast<size_t>(framesAvailable) * channels);
        if (flags & AUDCLNT_BUFFERFLAGS_SILENT) {
            std::memset(pcmBuffer_.data() + prevSize, 0, framesAvailable * channels * sizeof(float));
        } else {
            std::memcpy(pcmBuffer_.data() + prevSize, data, static_cast<size_t>(framesAvailable) * channels * sizeof(float));
        }

        captureClient_->ReleaseBuffer(framesAvailable);
    }

    // RMS de diagnóstico sobre o que chegou NESSA chamada (antes de consumir pro encode) — dá pra
    // comparar "com exclusão" vs "sem exclusão" enquanto uma fonte de áudio conhecida toca, pra
    // confirmar de verdade se PROCESS_LOOPBACK_MODE_EXCLUDE_TARGET_PROCESS_TREE tá filtrando o
    // processo certo (em vez de assumir pelo retorno `ok:true`, que só confirma que a API aceitou
    // os parâmetros, não que o filtro funciona na prática).
    if (!pcmBuffer_.empty()) {
        double sumSquares = 0.0;
        for (float sample : pcmBuffer_) sumSquares += static_cast<double>(sample) * sample;
        lastRms_ = static_cast<float>(std::sqrt(sumSquares / pcmBuffer_.size()));
    } else {
        lastRms_ = 0.f;
    }

    const size_t frameSamples = samplesPerChannelPerFrame_ * channels;
    std::vector<unsigned char> opusOut(4000); // teto seguro pro maior pacote Opus possível
    while (pcmBuffer_.size() >= frameSamples) {
        int encodedBytes = opus_encode_float(
            encoder_, pcmBuffer_.data(), static_cast<int>(samplesPerChannelPerFrame_), opusOut.data(),
            static_cast<opus_int32>(opusOut.size()));
        if (encodedBytes > 0) {
            packets.emplace_back(opusOut.begin(), opusOut.begin() + encodedBytes);
        }
        pcmBuffer_.erase(pcmBuffer_.begin(), pcmBuffer_.begin() + frameSamples);
    }

    return packets;
}

void AudioCaptureCore::Shutdown() {
    if (audioClient_) {
        audioClient_->Stop();
        audioClient_->Release();
        audioClient_ = nullptr;
    }
    if (captureClient_) {
        captureClient_->Release();
        captureClient_ = nullptr;
    }
    if (encoder_) {
        opus_encoder_destroy(encoder_);
        encoder_ = nullptr;
    }
    pcmBuffer_.clear();
    if (comInitializedHere_) {
        CoUninitialize();
        comInitializedHere_ = false;
    }
}
