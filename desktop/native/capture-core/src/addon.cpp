#include <napi.h>
#include <algorithm>
#include <memory>
#include <string>
#include <tuple>
#include <unordered_map>
#include <mutex>
// NOMINMAX — sem isso, windows.h define macros `min`/`max` que quebram `std::max` mais abaixo
// (TransportMaxBufferedAmount) com erro de sintaxe C2589/C2059 (o pré-processador expande
// `std::max(...)` literalmente pra `std::(...)` antes do compilador ver o template).
#define NOMINMAX
#include <windows.h>
#include <avrt.h>
#include <shellapi.h>
#include "CaptureCore.h"
#include "WindowCaptureCore.h"
#include "EncoderCore.h"
#include "TransportCore.h"
#include "VideoCodecType.h"
#include "AudioCaptureCore.h"
#include "QpcClock.h"

// "h264"/"hevc"/"av1" (case-sensitive, vem sempre de string literal do lado JS) — qualquer coisa
// que não seja "hevc"/"av1" cai em H.264, o padrão seguro.
static VideoCodecType ParseCodec(const std::string& s) {
    if (s == "hevc") return VideoCodecType::HEVC;
    if (s == "av1") return VideoCodecType::AV1;
    return VideoCodecType::H264;
}
static const char* CodecToString(VideoCodecType codec) {
    if (codec == VideoCodecType::HEVC) return "hevc";
    if (codec == VideoCodecType::AV1) return "av1";
    return "h264";
}

// Captura é única (não tem sentido capturar a mesma tela duas vezes). Encoder virou DOIS — Sprint
// 27/simulcast: `g_encoder` ("high", qualidade pedida pelo usuário) e `g_encoderLow` ("low", perfil
// fixo mais baixo de bitrate/fps, MESMA resolução — ver docs/NATIVE_CAPTURE.md Fase 4 "Simulcast").
// Decisão consciente de escopo: nível "low" NÃO faz downscale de resolução (exigiria um blit de
// D3D11 Video Processor novo, não testado nesse projeto) — só bitrate/fps mais baixos, reaproveita
// o `EncoderCore` inteiro sem nenhuma mudança nele (o pacing por fps que ele já tem cuida sozinho
// do frame-skip do tier low, só inicializando com um `fps` menor).
//
// O transporte é 1 sessão `TransportCore` POR ESPECTADOR (`g_transportSessions`, chave = viewerId)
// — é o "SFU" desse projeto. Cada sessão agora carrega também qual TIER ela quer receber
// (`ViewerSession::tier`, "high" por padrão) — `TransportSendVideoFrame` recebe o tier de origem do
// frame e só manda fan-out pras sessões daquele tier (não pra todas mais, diferente de antes do
// simulcast).
struct ViewerSession {
    std::unique_ptr<TransportCore> transport;
    std::string tier = "high";
    // Identifica ESTA sessão entre recriações com o mesmo `viewerId` (fallback de codec fecha a
    // sessão HEVC/AV1 e cria outra H.264 pro mesmo espectador). Bug real: o evento "closed" da
    // sessão velha chegava no JS (assíncrono, via TSFN) DEPOIS da nova existir, e o handler de
    // estado fechava por `viewerId` — derrubando a sessão nova; o espectador ficava em
    // "conectando" pra sempre. Eventos de geração antiga agora são descartados antes de chegar no JS.
    uint64_t generation = 0;
};

static uint64_t g_nextSessionGeneration = 1;

// Chamar na thread JS (callback de TSFN) — a sessão desse `viewerId` ainda é a mesma que gerou o
// evento?
static bool IsCurrentSession(const std::string& viewerId, uint64_t generation);

static std::unique_ptr<CaptureCore> g_core;
// Backend WGC (janela) — alternativa ao `g_core` (DXGI, monitor). Nunca os dois ativos ao mesmo
// tempo (uma transmissão captura monitor OU janela); `g_usingWindow` decide qual dos dois
// `InitEncoder`/`EncodeCurrentFrame`/`AcquireFrameGpuOnly` devem usar, via os helpers
// `Active*()` logo abaixo — ver docs/NATIVE_CAPTURE.md §Backend Abstrato.
static std::unique_ptr<WindowCaptureCore> g_windowCore;
static bool g_usingWindow = false;
// Detecta resize da janela entre um `AcquireFrameGpuOnly` e outro (ver comentário no branch de
// janela dessa função) — 0 = "sessão nova, sem baseline ainda" (evita falso-positivo no 1º frame).
static int g_lastWindowWidth = 0;
static int g_lastWindowHeight = 0;

static ID3D11Device* ActiveDevice() {
    return g_usingWindow ? (g_windowCore ? g_windowCore->GetDevice() : nullptr) : (g_core ? g_core->GetDevice() : nullptr);
}
static ID3D11Texture2D* ActiveComposeTexture() {
    return g_usingWindow ? (g_windowCore ? g_windowCore->GetComposeTexture() : nullptr) : (g_core ? g_core->GetComposeTexture() : nullptr);
}
static int ActiveWidth() {
    return g_usingWindow ? (g_windowCore ? g_windowCore->GetWidth() : 0) : (g_core ? g_core->GetWidth() : 0);
}
static int ActiveHeight() {
    return g_usingWindow ? (g_windowCore ? g_windowCore->GetHeight() : 0) : (g_core ? g_core->GetHeight() : 0);
}

// Protege `g_encoder`/`g_encoderLow` — **bug real de concorrência achado via dump de crash real**
// (KERNELBASE.dll, sem exceção JS/uncaughtException nenhuma, sem log — ver docs/TASKS.md). Causa:
// `TransportCore::OnChannelOpen` (registrado em `TransportCreateSession` abaixo) é chamado pela
// thread INTERNA do libdatachannel (SCTP/DTLS worker), NÃO pela thread do Node — e lê
// `g_encoder`/`g_encoderLow` (via `EncoderForTier`) SEM passar por `ThreadSafeFunction` nenhum
// (diferente de `OnLocalDescription`/`OnLocalCandidate`/`OnStateChange`, que já usam
// `NonBlockingCall` de propósito por causa disso mesmo — ver comentário perto dos `g_on*Tsfn`).
// Enquanto isso, `destroyEncoder()`/`initEncoder()` (chamados pela thread do Node, ex.: fallback
// HEVC→H.264 quando um espectador não decodifica) fazem `g_encoder.reset()`/reatribuição — se um
// canal de OUTRA sessão abrir na thread do libdatachannel bem nesse instante, a leitura de
// `g_encoder` e a liberação de memória colidem (use-after-free/dado corrompido), derrubando o
// processo inteiro sem nenhum rastro em JS. Todo acesso a esses dois ponteiros (leitura OU
// escrita) precisa segurar esse mutex primeiro.
static std::mutex g_encoderMutex;
static std::unique_ptr<EncoderCore> g_encoder;
static std::unique_ptr<EncoderCore> g_encoderLow;
static std::unordered_map<std::string, ViewerSession> g_transportSessions;
// Protege `g_transportSessions` — o áudio é enviado direto da thread de áudio nativa
// (AudioCaptureCore, ver `StartAudioForwarding`), não mais do loop JS, então o mapa passou a ser
// lido por duas threads. TODA função que toca no mapa trava isso. Ordem de lock quando precisar dos
// dois: este ANTES de `g_encoderMutex` (`TransportSendVideoFrame` → `ForceKeyframeForTierLocked`).
static std::mutex g_sessionsMutex;
// Origem (QPC µs) dos timestamps de áudio enviados — o mesmo `startUs` que o loop JS usa pro vídeo.
static int64_t g_audioStreamStartUs = 0;
static HANDLE g_mmcssHandle = nullptr;

// Áudio (ver AudioCaptureCore.h) — único, compartilhado por TODOS os espectadores (não tem tier
// "low"/"high" pra áudio, diferente do vídeo/simulcast: bitrate de áudio é baixo o bastante pra
// não valer a complexidade de codificar duas vezes).
static std::unique_ptr<AudioCaptureCore> g_audioCore;

// `g_encoder` (high) ou `g_encoderLow` (low) — usado nos vários pontos que precisam resolver "o
// encoder desse tier" sem duplicar o if/else toda vez. CHAMAR SÓ com `g_encoderMutex` já
// segurado (ver comentário grande em `g_encoderMutex`) — não tranca sozinho porque quem já tem o
// lock (ex.: `ForceKeyframeForTierLocked`) não pode travar de novo (mutex não é recursivo).
static EncoderCore* EncoderForTier(const std::string& tier) {
    return tier == "low" ? g_encoderLow.get() : g_encoder.get();
}

// Único jeito seguro de forçar keyframe num tier — usado tanto pela thread do Node
// (`TransportSetViewerTier`) quanto pela thread INTERNA do libdatachannel (`OnChannelOpen`, ver
// `TransportCreateSession`). Tranca o mesmo mutex que `InitEncoder`/`DestroyEncoder` usam, então
// nunca roda no meio de uma troca de encoder.
static void ForceKeyframeForTierLocked(const std::string& tier) {
    std::lock_guard<std::mutex> lock(g_encoderMutex);
    EncoderCore* enc = EncoderForTier(tier);
    if (enc) enc->ForceKeyframe();
}

// Callbacks de sinalização são registrados UMA VEZ (não por sessão) — cada sessão nova (criada em
// `TransportCreateSession`) liga seus próprios eventos C++ (`OnLocalDescription`/etc.) nesses
// mesmos `ThreadSafeFunction` globais, sempre passando o `viewerId` como primeiro argumento pro
// JS saber de qual espectador é a mensagem. Registrar ANTES de criar qualquer sessão (mesma
// ordem que já era exigida no V1 singleton).
static Napi::ThreadSafeFunction g_onLocalDescriptionTsfn;
static Napi::ThreadSafeFunction g_onLocalCandidateTsfn;
static Napi::ThreadSafeFunction g_onStateChangeTsfn;
static bool g_onLocalDescriptionSet = false;
static bool g_onLocalCandidateSet = false;
static bool g_onStateChangeSet = false;

// Relógio QPC compartilhado com o áudio (ver QpcClock.h) — `timestampUs` de vídeo E áudio saem
// dele. Antes os dois usavam `Date.now()` do instante em que o loop JS ENVIAVA o pacote — áudio
// represado no buffer WASAPI e vídeo atrasado no encoder ganhavam o mesmo carimbo de "agora", e a
// diferença real entre eles virava dessincronia que o espectador não tinha como corrigir.
Napi::Value NowUs(const Napi::CallbackInfo& info) {
    return Napi::Number::New(info.Env(), static_cast<double>(QpcNowUs()));
}

// Prioridade de escalonamento de GPU do PROCESSO inteiro (não só de um device, diferente de
// `SetGPUThreadPriority`) — `D3DKMTSetProcessSchedulingPriorityClass` (gdi32, sem header público no
// SDK de user-mode, por isso via GetProcAddress). Valores: 0 idle, 1 abaixo do normal, 2 normal,
// 3 acima do normal, 4 alta, 5 tempo real (exige admin). Retorna o NTSTATUS (0 = ok).
static long SetProcessGpuPriorityClass(int priorityClass) {
    using Fn = LONG(APIENTRY*)(HANDLE, int);
    static Fn fn = reinterpret_cast<Fn>(GetProcAddress(GetModuleHandleW(L"gdi32.dll"), "D3DKMTSetProcessSchedulingPriorityClass"));
    if (!fn) return -1;
    return fn(GetCurrentProcess(), priorityClass);
}

// Diagnóstico/ajuste: `info[0]` = classe de prioridade de GPU do processo (ver acima).
Napi::Value SetGpuPriorityClass(const Napi::CallbackInfo& info) {
    if (info.Length() < 1 || !info[0].IsNumber()) return Napi::Number::New(info.Env(), -1);
    return Napi::Number::New(info.Env(), static_cast<double>(SetProcessGpuPriorityClass(info[0].As<Napi::Number>().Int32Value())));
}

Napi::Value Initialize(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    g_core = std::make_unique<CaptureCore>();
    bool ok = g_core->Initialize();

    // Registra a thread que chama isso (a main thread do Electron) na classe MMCSS "Capture" —
    // dá prioridade de agendamento de CPU mais alta sob contenção. Falha em silêncio se não
    // suportado (`g_mmcssHandle` continua nulo, sem efeito colateral). O loop de transporte nativo
    // roda na main thread do Electron via `setImmediate` (ver runNativeTransportLoop em
    // main/index.ts — uma tentativa de thread nativa própria, StreamWorker, foi removida por não
    // ser o caminho ativo, ver docs/NATIVE_CAPTURE.md), então isso beneficia os dois caminhos.
    if (ok && !g_mmcssHandle) {
        DWORD taskIndex = 0;
        g_mmcssHandle = AvSetMmThreadCharacteristicsW(L"Capture", &taskIndex);
    }

    // Prioridade de GPU "tempo real" pro processo main (onde vivem os devices de captura/NVENC — o
    // processo de GPU do Chromium é outro e não é afetado). Bug real medido com o gamesim saturando
    // a GPU (jogo GPU-bound a ~33fps, carga dividida em 64 draws como jogo de verdade): na prioridade
    // normal o escalonador da GPU deixava a cópia captura→NVENC esperando atrás do jogo — encode
    // levando 180ms (p50) a 1.2s, captura a ~4fps. "Alta" (4) não mudou nada; "tempo real" (5):
    // encode 1.7ms, captura pegando TODOS os frames do jogo, e o fps do jogo idêntico (nosso
    // trabalho de GPU por frame é minúsculo — uma cópia e o NVENC, que é motor separado). Mesmo
    // recurso que o OBS usa pra não engasgar em jogo GPU-bound. Funcionou sem admin (Win11, conta
    // comum); se o sistema recusar, cai pra "alta".
    if (ok) {
        const long status = SetProcessGpuPriorityClass(5);
        if (status != 0) SetProcessGpuPriorityClass(4);
        fprintf(stderr, "[capture-core] prioridade de GPU do processo: %s\n", status == 0 ? "tempo real" : "alta (tempo real recusado)");
    }

    return Napi::Boolean::New(env, ok);
}

Napi::Value ListMonitors(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    Napi::Array result = Napi::Array::New(env);
    if (!g_core) return result;

    auto monitors = g_core->ListMonitors();
    result = Napi::Array::New(env, monitors.size());
    for (size_t i = 0; i < monitors.size(); i++) {
        Napi::Object obj = Napi::Object::New(env);
        obj.Set("index", monitors[i].index);
        obj.Set("x", monitors[i].x);
        obj.Set("y", monitors[i].y);
        obj.Set("width", monitors[i].width);
        obj.Set("height", monitors[i].height);
        result.Set(i, obj);
    }
    return result;
}

Napi::Value Start(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    if (!g_core || info.Length() < 1 || !info[0].IsNumber()) {
        return Napi::Boolean::New(env, false);
    }
    int monitorIndex = info[0].As<Napi::Number>().Int32Value();
    g_usingWindow = false;
    return Napi::Boolean::New(env, g_core->Start(monitorIndex));
}

// `info[0]` = HWND, passado como número (o lado JS extrai o handle do id do desktopCapturer, ver
// main/index.ts). Backend WGC (Windows.Graphics.Capture) — diferente do DXGI (`Start`, monitor
// inteiro), esse consegue isolar UMA janela específica. Cria o `WindowCaptureCore` sob demanda
// (só precisa existir quando alguém realmente pede captura de janela).
Napi::Value StartWindow(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    if (info.Length() < 1 || !info[0].IsNumber()) {
        return Napi::Boolean::New(env, false);
    }
    HWND hwnd = reinterpret_cast<HWND>(static_cast<uintptr_t>(info[0].As<Napi::Number>().Int64Value()));

    if (!g_windowCore) {
        g_windowCore = std::make_unique<WindowCaptureCore>();
        if (!g_windowCore->Initialize()) {
            g_windowCore.reset();
            return Napi::Boolean::New(env, false);
        }
    }
    g_usingWindow = true;
    bool ok = g_windowCore->Start(hwnd);
    if (!ok) g_usingWindow = false;
    g_lastWindowWidth = 0;
    g_lastWindowHeight = 0;
    return Napi::Boolean::New(env, ok);
}

Napi::Value Stop(const Napi::CallbackInfo& info) {
    if (g_core) g_core->Stop();
    if (g_windowCore) g_windowCore->Stop();
    return info.Env().Undefined();
}

// timeoutMs baixo (chamado a partir de um polling loop em JS, não deve travar o processo main
// por muito tempo por chamada — ver ponte no main process). Só usado pelo caminho antigo (raw
// frame → LiveKit); o transporte nativo usa `AcquireFrameGpuOnly` (sem readback CPU).
Napi::Value AcquireFrame(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    if (!g_core) return env.Null();

    uint32_t timeoutMs = 0;
    if (info.Length() > 0 && info[0].IsNumber()) {
        timeoutMs = info[0].As<Napi::Number>().Uint32Value();
    }

    FrameData frame;
    AcquireResult result = g_core->AcquireFrame(frame, timeoutMs);

    if (result == AcquireResult::Timeout) {
        return env.Null();
    }
    if (result == AcquireResult::AccessLost) {
        Napi::Object obj = Napi::Object::New(env);
        obj.Set("accessLost", true);
        return obj;
    }
    if (result == AcquireResult::DeviceLost) {
        Napi::Object obj = Napi::Object::New(env);
        obj.Set("deviceLost", true);
        return obj;
    }
    if (result != AcquireResult::Ok) {
        return env.Null();
    }

    Napi::Buffer<uint8_t> buffer = Napi::Buffer<uint8_t>::Copy(env, frame.pixels.data(), frame.pixels.size());
    Napi::Object obj = Napi::Object::New(env);
    obj.Set("width", frame.width);
    obj.Set("height", frame.height);
    obj.Set("buffer", buffer);
    return obj;
}

// Mesma captura, SEM o readback GPU→CPU (Map+memcpy de um frame inteiro, ~8MB em 1080p) — pro
// loop do transporte nativo, que só precisa da textura já composta (via encodeCurrentFrame logo
// em seguida) pro NVENC ler direto da GPU. Esse readback era puro desperdício aqui e comia
// orçamento de frame real (medido em produção: alvo 60fps entregando só ~50, 120fps só ~70-80,
// monitor sendo 120Hz+ então não é teto de hardware — era esse custo por chamada).
Napi::Value AcquireFrameGpuOnly(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();

    uint32_t timeoutMs = 0;
    if (info.Length() > 0 && info[0].IsNumber()) {
        timeoutMs = info[0].As<Napi::Number>().Uint32Value();
    }

    if (g_usingWindow) {
        if (!g_windowCore) return env.Null();
        WindowAcquireResult result = g_windowCore->AcquireFrameGpuOnly(timeoutMs);
        if (result == WindowAcquireResult::Timeout) return env.Null();
        if (result == WindowAcquireResult::ItemClosed) {
            // Janela fechada/processo morreu — não tem "recuperar sozinho" possível (a janela não
            // existe mais), diferente do `accessLost` do DXGI. Quem chama (main/index.ts) trata
            // igual a `deviceLost` (para a transmissão com aviso), só com mensagem diferente.
            Napi::Object obj = Napi::Object::New(env);
            obj.Set("windowClosed", true);
            return obj;
        }
        if (result != WindowAcquireResult::Ok) return env.Null();

        // Janela redimensionou (`WindowCaptureCore` já recriou o frame pool sozinho — ver
        // WindowCaptureCore.cpp) — avisa o JS pra reiniciar o(s) encoder(es) com o tamanho novo.
        // Bug real reportado pelo usuário: sem isso, o NVENC continuava recebendo textura do
        // tamanho ANTIGO (CopyResource com tamanhos diferentes falha em silêncio) e a transmissão
        // travava num frame congelado. `g_lastWindowWidth/Height` começam em 0 (reset em
        // StartWindow/Stop) pra não disparar falso-positivo no primeiro frame de uma sessão nova.
        int w = ActiveWidth();
        int h = ActiveHeight();
        bool resized = g_lastWindowWidth != 0 && (w != g_lastWindowWidth || h != g_lastWindowHeight);
        g_lastWindowWidth = w;
        g_lastWindowHeight = h;

        Napi::Object obj = Napi::Object::New(env);
        obj.Set("ok", true);
        if (resized) {
            obj.Set("resized", true);
            obj.Set("width", w);
            obj.Set("height", h);
        }
        return obj;
    }

    if (!g_core) return env.Null();

    AcquireResult result = g_core->AcquireFrameGpuOnly(timeoutMs);

    if (result == AcquireResult::Timeout) {
        return env.Null();
    }
    if (result == AcquireResult::AccessLost) {
        Napi::Object obj = Napi::Object::New(env);
        obj.Set("accessLost", true);
        return obj;
    }
    if (result == AcquireResult::DeviceLost) {
        Napi::Object obj = Napi::Object::New(env);
        obj.Set("deviceLost", true);
        return obj;
    }
    if (result != AcquireResult::Ok) {
        return env.Null();
    }

    // Sem width/height/buffer — quem chama já sabe as dimensões (a textura composta é lida
    // direto por `encodeCurrentFrame()`, não por esse retorno). `ok: true` só confirma que tem
    // frame novo pra codificar.
    Napi::Object obj = Napi::Object::New(env);
    obj.Set("ok", true);
    return obj;
}

// Encoder NVENC (Fase 3) — `initEncoder`/`encodeCurrentFrame` chamados a cada frame pelo loop em
// JS (`runNativeTransportLoop`, main/index.ts).
// `info[2]` (opcional) = "h264"/"hevc", o codec PEDIDO — cai pro padrão "h264" se omitido. O que
// realmente fica ativo pode ser diferente (cascata de fallback em EncoderCore::Initialize) — ver
// `IsUsingSoftwareEncoder`/`GetActiveCodec` pra saber o resultado real depois de chamar isso.
Napi::Value InitEncoder(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    if (!ActiveDevice() || info.Length() < 2 || !info[0].IsNumber() || !info[1].IsNumber()) {
        return Napi::Boolean::New(env, false);
    }
    int fps = info[0].As<Napi::Number>().Int32Value();
    int bitrateBps = info[1].As<Napi::Number>().Int32Value();
    VideoCodecType codec = (info.Length() > 2 && info[2].IsString())
        ? ParseCodec(info[2].As<Napi::String>().Utf8Value())
        : VideoCodecType::H264;

    std::lock_guard<std::mutex> lock(g_encoderMutex);
    g_encoder = std::make_unique<EncoderCore>();
    bool ok = g_encoder->Initialize(ActiveDevice(), ActiveWidth(), ActiveHeight(), fps, bitrateBps, codec);
    if (!ok) g_encoder.reset();
    return Napi::Boolean::New(env, ok);
}

// Encoder do tier "low" (Sprint 27/simulcast) — MESMA resolução do "high" (`g_core->GetWidth/Height`,
// sem downscale), só `fps`/`bitrateBps` diferentes (fps mais baixo aqui já faz o `EncoderCore`
// pular frame sozinho via pacing, não precisa de lógica nova). `codec` TEM que ser o mesmo do
// encoder "high" ativo (não faz sentido negociar HEVC/AV1 separado por tier) — quem chama
// (main/index.ts) sempre passa `getActiveCodec()` do high aqui.
Napi::Value InitEncoderLow(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    if (!ActiveDevice() || info.Length() < 2 || !info[0].IsNumber() || !info[1].IsNumber()) {
        return Napi::Boolean::New(env, false);
    }
    int fps = info[0].As<Napi::Number>().Int32Value();
    int bitrateBps = info[1].As<Napi::Number>().Int32Value();
    VideoCodecType codec = (info.Length() > 2 && info[2].IsString())
        ? ParseCodec(info[2].As<Napi::String>().Utf8Value())
        : VideoCodecType::H264;

    std::lock_guard<std::mutex> lock(g_encoderMutex);
    g_encoderLow = std::make_unique<EncoderCore>();
    bool ok = g_encoderLow->Initialize(ActiveDevice(), ActiveWidth(), ActiveHeight(), fps, bitrateBps, codec);
    if (!ok) g_encoderLow.reset();
    return Napi::Boolean::New(env, ok);
}

Napi::Value GetActiveCodec(const Napi::CallbackInfo& info) {
    std::lock_guard<std::mutex> lock(g_encoderMutex);
    return Napi::String::New(info.Env(), CodecToString(g_encoder ? g_encoder->GetActiveCodec() : VideoCodecType::H264));
}

// Exposto pro host avisar o usuário/HUD de dev quando caiu pro fallback de software (Media
// Foundation) por NVENC não estar disponível — bem mais pesado em CPU, vale saber que caiu nesse
// caminho (ver docs/NATIVE_CAPTURE.md Fase 3 "Fallback de encoder por software").
Napi::Value IsUsingSoftwareEncoder(const Napi::CallbackInfo& info) {
    std::lock_guard<std::mutex> lock(g_encoderMutex);
    return Napi::Boolean::New(info.Env(), g_encoder && g_encoder->IsUsingSoftwareFallback());
}

// Fallback via MFT de hardware (Quick Sync/AMF...) em vez de CPU — ver SoftwareEncoderCore.h.
Napi::Value IsUsingHardwareMft(const Napi::CallbackInfo& info) {
    std::lock_guard<std::mutex> lock(g_encoderMutex);
    return Napi::Boolean::New(info.Env(), g_encoder && g_encoder->IsUsingHardwareMft());
}

// Por que o NVENC não ficou de pé: "none" | "no-driver" | "driver-too-old" | "other" | "disabled".
Napi::Value GetNvencFailure(const Napi::CallbackInfo& info) {
    std::lock_guard<std::mutex> lock(g_encoderMutex);
    const char* reason = "none";
    if (g_encoder) {
        switch (g_encoder->GetNvencFailure()) {
            case EncoderCore::NvencFailure::NoDriver: reason = "no-driver"; break;
            case EncoderCore::NvencFailure::DriverTooOld: reason = "driver-too-old"; break;
            case EncoderCore::NvencFailure::Other: reason = "other"; break;
            case EncoderCore::NvencFailure::Disabled: reason = "disabled"; break;
            default: break;
        }
    }
    return Napi::String::New(info.Env(), reason);
}

Napi::Value DestroyEncoder(const Napi::CallbackInfo& info) {
    std::lock_guard<std::mutex> lock(g_encoderMutex);
    g_encoder.reset();
    return info.Env().Undefined();
}

Napi::Value DestroyEncoderLow(const Napi::CallbackInfo& info) {
    std::lock_guard<std::mutex> lock(g_encoderMutex);
    g_encoderLow.reset();
    return info.Env().Undefined();
}

Napi::Value EncodeCurrentFrame(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    Napi::Array result = Napi::Array::New(env);
    std::lock_guard<std::mutex> lock(g_encoderMutex);
    if (!g_encoder || !ActiveComposeTexture()) return result;

    auto packets = g_encoder->EncodeFrame(ActiveComposeTexture());
    result = Napi::Array::New(env, packets.size());
    for (size_t i = 0; i < packets.size(); i++) {
        result.Set(i, Napi::Buffer<uint8_t>::Copy(env, packets[i].data(), packets[i].size()));
    }
    return result;
}

Napi::Value EncodeCurrentFrameLow(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    Napi::Array result = Napi::Array::New(env);
    std::lock_guard<std::mutex> lock(g_encoderMutex);
    if (!g_encoderLow || !ActiveComposeTexture()) return result;

    auto packets = g_encoderLow->EncodeFrame(ActiveComposeTexture());
    result = Napi::Array::New(env, packets.size());
    for (size_t i = 0; i < packets.size(); i++) {
        result.Set(i, Napi::Buffer<uint8_t>::Copy(env, packets[i].data(), packets[i].size()));
    }
    return result;
}

// `info[0]` = "high"/"low". Chamado pelo loop quando NÃO chegou frame novo (tela parada): sem
// isso, keyframe pedido por espectador novo (OnChannelOpen), troca de tier ou `'K'` do viewer só
// saía quando algo mudasse na tela — espectador entrando com a tela parada (ex.: depois do
// fallback de codec, teste A6) ficava com a tela preta até alguém mexer em algo. Reencoda a última
// textura composta (persistente) só se tiver keyframe pendente; retorna os pacotes pro JS mandar.
// App em TELA CHEIA EXCLUSIVA (Direct3D) rodando agora — `SHQueryUserNotificationState` é a mesma
// consulta que o Windows usa pra segurar notificações durante jogos. Só leitura de estado do shell:
// nada é injetado no jogo (sem risco de anti-cheat, diferente de captura por hook). Usado pelo loop
// pra explicar a tela congelada (DXGI/WGC não recebem frame de tela cheia exclusiva) — tarefa B2.
Napi::Value IsExclusiveFullscreenActive(const Napi::CallbackInfo& info) {
    QUERY_USER_NOTIFICATION_STATE state{};
    bool active = SUCCEEDED(SHQueryUserNotificationState(&state)) && state == QUNS_RUNNING_D3D_FULL_SCREEN;
    return Napi::Boolean::New(info.Env(), active);
}

Napi::Value EncodePendingKeyframe(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    std::string tier = (info.Length() > 0 && info[0].IsString()) ? info[0].As<Napi::String>().Utf8Value() : "high";
    {
        // Pedidos de keyframe das sessões normalmente são consumidos no envio — sem envio (tela
        // parada), consome aqui. Ordem de locks: sessões antes do encoder (ver topo do arquivo).
        std::lock_guard<std::mutex> sessionsLock(g_sessionsMutex);
        bool keyframeNeeded = false;
        for (auto& entry : g_transportSessions) {
            if (entry.second.tier != tier || !entry.second.transport->IsConnected()) continue;
            if (entry.second.transport->ConsumeKeyframeRequest()) keyframeNeeded = true;
        }
        if (keyframeNeeded) ForceKeyframeForTierLocked(tier);
    }
    std::lock_guard<std::mutex> lock(g_encoderMutex);
    EncoderCore* enc = EncoderForTier(tier);
    if (!enc || !enc->KeyframePending() || !ActiveComposeTexture()) return Napi::Array::New(env);
    auto packets = enc->EncodeFrame(ActiveComposeTexture());
    Napi::Array result = Napi::Array::New(env, packets.size());
    for (size_t i = 0; i < packets.size(); i++) {
        result.Set(i, Napi::Buffer<uint8_t>::Copy(env, packets[i].data(), packets[i].size()));
    }
    return result;
}

// `info[0]` (opcional) = "high"/"low", padrão "high" — mantém a assinatura antiga (sem argumento)
// funcionando pra qualquer chamador esquecido.
Napi::Value ForceKeyframe(const Napi::CallbackInfo& info) {
    std::string tier = (info.Length() > 0 && info[0].IsString()) ? info[0].As<Napi::String>().Utf8Value() : "high";
    ForceKeyframeForTierLocked(tier);
    return info.Env().Undefined();
}

// `info[2]` (opcional) = "high"/"low", padrão "high" — qual encoder ajustar. `info[1]` (opcional,
// padrão true) = forçar keyframe na troca — passar `false` no ajuste automático de congestionamento
// (AIMD, ver main/index.ts e comentário em EncoderCore.h). Cada tier tem seu PRÓPRIO AIMD agora
// (buffer/bitrate independentes por tier, ver `transportMaxBufferedAmount`).
Napi::Value SetEncoderBitrate(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    if (info.Length() < 1 || !info[0].IsNumber()) {
        return Napi::Boolean::New(env, false);
    }
    int bitrateBps = info[0].As<Napi::Number>().Int32Value();
    bool forceKeyframe = info.Length() < 2 || !info[1].IsBoolean() || info[1].As<Napi::Boolean>().Value();
    std::string tier = (info.Length() > 2 && info[2].IsString()) ? info[2].As<Napi::String>().Utf8Value() : "high";
    std::lock_guard<std::mutex> lock(g_encoderMutex);
    EncoderCore* enc = EncoderForTier(tier);
    if (!enc) return Napi::Boolean::New(env, false);
    return Napi::Boolean::New(env, enc->SetBitrate(bitrateBps, forceKeyframe));
}

Napi::Value SetCursorEnabled(const Napi::CallbackInfo& info) {
    if (info.Length() > 0 && info[0].IsBoolean()) {
        bool enabled = info[0].As<Napi::Boolean>().Value();
        if (g_core) g_core->SetCaptureCursor(enabled);
        // No caminho de janela isso só tem efeito na PRÓXIMA `startWindow()` (propriedade da
        // sessão WGC, fixada na criação — ver WindowCaptureCore::SetCaptureCursor).
        if (g_windowCore) g_windowCore->SetCaptureCursor(enabled);
    }
    return info.Env().Undefined();
}

// ---------------------------------------------------------------------------------------------
// Áudio (WASAPI process-loopback + Opus, ver AudioCaptureCore.h) — pedido do usuário: excluir o
// Discord (já está na mesma call, ouviria a própria voz duas vezes se saísse pela transmissão
// também) da captura de áudio de sistema do pipeline nativo.
// ---------------------------------------------------------------------------------------------

static std::wstring Utf8ToWide(const std::string& s) {
    if (s.empty()) return {};
    const int len = MultiByteToWideChar(CP_UTF8, 0, s.data(), static_cast<int>(s.size()), nullptr, 0);
    std::wstring out(len, L'\0');
    MultiByteToWideChar(CP_UTF8, 0, s.data(), static_cast<int>(s.size()), out.data(), len);
    return out;
}

static std::string WideToUtf8(const std::wstring& s) {
    if (s.empty()) return {};
    const int len = WideCharToMultiByte(CP_UTF8, 0, s.data(), static_cast<int>(s.size()), nullptr, 0, nullptr, nullptr);
    std::string out(len, '\0');
    WideCharToMultiByte(CP_UTF8, 0, s.data(), static_cast<int>(s.size()), out.data(), len, nullptr, nullptr);
    return out;
}

// Array JS de nomes de executável (ex.: ["Discord.exe", "NVIDIA Broadcast.exe"]) — apps cujo
// áudio NUNCA sai na transmissão (ver AudioCaptureCore.h, "mixer por app").
static std::vector<std::wstring> ReadExeNameArray(const Napi::Value& value) {
    std::vector<std::wstring> names;
    if (!value.IsArray()) return names;
    Napi::Array arr = value.As<Napi::Array>();
    for (uint32_t i = 0; i < arr.Length(); i++) {
        Napi::Value item = arr.Get(i);
        if (item.IsString()) names.push_back(Utf8ToWide(item.As<Napi::String>().Utf8Value()));
    }
    return names;
}

static Napi::Array CapturedSourcesArray(Napi::Env env) {
    std::vector<std::wstring> names = g_audioCore ? g_audioCore->CapturedExeNames() : std::vector<std::wstring>{};
    Napi::Array arr = Napi::Array::New(env, names.size());
    for (size_t i = 0; i < names.size(); i++) arr.Set(i, Napi::String::New(env, WideToUtf8(names[i])));
    return arr;
}

// Caminho de MONITOR — `info[0]` = array de executáveis excluídos. Mixa o áudio de todo app com
// sessão de áudio ativa menos esses (e menos o próprio app). Retorna `{ ok, sources }`.
Napi::Value InitAudioCapture(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    std::vector<std::wstring> excluded = info.Length() > 0 ? ReadExeNameArray(info[0]) : std::vector<std::wstring>{};

    g_audioCore = std::make_unique<AudioCaptureCore>();
    bool ok = g_audioCore->InitializeForSystem(excluded);
    Napi::Object result = Napi::Object::New(env);
    result.Set("ok", ok);
    result.Set("sources", CapturedSourcesArray(env));
    if (!ok) g_audioCore.reset();
    return result;
}

// Caminho de JANELA — `info[0]` = HWND (mesmo formato de `StartWindow`), `info[1]` = array de
// executáveis excluídos. Só a árvore de processos dona da janela entra (ver
// AudioCaptureCore::InitializeForWindow).
Napi::Value InitAudioCaptureForWindow(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    Napi::Object result = Napi::Object::New(env);
    if (info.Length() < 1 || !info[0].IsNumber()) {
        result.Set("ok", false);
        return result;
    }
    HWND hwnd = reinterpret_cast<HWND>(static_cast<uintptr_t>(info[0].As<Napi::Number>().Int64Value()));
    std::vector<std::wstring> excluded = info.Length() > 1 ? ReadExeNameArray(info[1]) : std::vector<std::wstring>{};

    g_audioCore = std::make_unique<AudioCaptureCore>();
    bool ok = g_audioCore->InitializeForWindow(hwnd, excluded);
    result.Set("ok", ok);
    result.Set("sources", CapturedSourcesArray(env));
    if (!ok) g_audioCore.reset();
    return result;
}

// Troca a lista de exclusão AO VIVO (`info[0]` = array) — sem reiniciar a captura.
Napi::Value SetAudioExcludedApps(const Napi::CallbackInfo& info) {
    if (g_audioCore && info.Length() > 0) g_audioCore->SetExcludedExeNames(ReadExeNameArray(info[0]));
    return CapturedSourcesArray(info.Env());
}

// `info[0]` = `startUs` (QPC µs, mesmo `nowUs()` usado como origem dos timestamps de vídeo). A partir
// daqui cada pacote Opus vai DIRETO da thread de áudio pras sessões conectadas, sem passar pelo
// loop JS (ver AudioCaptureCore.h — era o loop JS que limitava a latência do áudio, e com ela a do
// vídeo, que espera o áudio pra ficar sincronizado no espectador).
Napi::Value StartAudioForwarding(const Napi::CallbackInfo& info) {
    if (!g_audioCore || info.Length() < 1 || !info[0].IsNumber()) return Napi::Boolean::New(info.Env(), false);
    {
        std::lock_guard<std::mutex> lock(g_sessionsMutex);
        g_audioStreamStartUs = static_cast<int64_t>(info[0].As<Napi::Number>().Int64Value());
    }
    g_audioCore->SetPacketCallback([](const EncodedAudioPacket& packet) {
        std::lock_guard<std::mutex> lock(g_sessionsMutex);
        const int64_t ptsUs = packet.ptsUs - g_audioStreamStartUs;
        if (ptsUs < 0) return; // capturado antes do início da transmissão
        for (auto& entry : g_transportSessions) {
            if (!entry.second.transport->IsConnected()) continue;
            entry.second.transport->SendAudioFrame(packet.data.data(), packet.data.size(), static_cast<uint64_t>(ptsUs));
        }
    });
    return Napi::Boolean::New(info.Env(), true);
}

// Diagnóstico do mixer (ver AudioCaptureCore::TakeMixStats) — `{ maxArrivalLagMs, lateSamples }`.
Napi::Value GetAudioMixStats(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    Napi::Object obj = Napi::Object::New(env);
    AudioCaptureCore::MixStats stats = g_audioCore ? g_audioCore->TakeMixStats() : AudioCaptureCore::MixStats{};
    obj.Set("maxArrivalLagMs", stats.maxArrivalLagMs);
    obj.Set("lateSamples", static_cast<double>(stats.lateSamples));
    return obj;
}

// Executáveis sendo capturados agora (diagnóstico/UI).
Napi::Value GetAudioSources(const Napi::CallbackInfo& info) {
    return CapturedSourcesArray(info.Env());
}

// Apps com sessão de áudio agora (`[{ exe, active }]`) — pra UI de silenciar app.
Napi::Value ListAudioApps(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    auto apps = AudioCaptureCore::ListAudioApps();
    Napi::Array arr = Napi::Array::New(env, apps.size());
    for (size_t i = 0; i < apps.size(); i++) {
        Napi::Object obj = Napi::Object::New(env);
        obj.Set("exe", Napi::String::New(env, WideToUtf8(apps[i].exeName)));
        obj.Set("active", apps[i].active);
        arr.Set(i, obj);
    }
    return arr;
}

Napi::Value DestroyAudioCapture(const Napi::CallbackInfo& info) {
    g_audioCore.reset();
    return info.Env().Undefined();
}

// Diagnóstico (ver AudioCaptureCore::LastRms) — não usado no caminho de produção.
Napi::Value GetAudioRms(const Napi::CallbackInfo& info) {
    return Napi::Number::New(info.Env(), g_audioCore ? g_audioCore->LastRms() : 0.0);
}

// Chamado do mesmo loop JS que já poll vídeo (main/index.ts) — retorna 0+ pacotes Opus prontos
// pra mandar (o `AudioCaptureCore` já acumula PCM internamente até fechar um frame de 10ms).
// Cada item = `{ data: Buffer, ptsUs: number }` — `ptsUs` no MESMO relógio de `nowUs()` (QPC),
// instante real de captura da primeira amostra do pacote.
Napi::Value PollAudioPackets(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    Napi::Array result = Napi::Array::New(env);
    if (!g_audioCore) return result;

    auto packets = g_audioCore->PollEncodedPackets();
    result = Napi::Array::New(env, packets.size());
    for (size_t i = 0; i < packets.size(); i++) {
        Napi::Object obj = Napi::Object::New(env);
        obj.Set("data", Napi::Buffer<uint8_t>::Copy(env, packets[i].data.data(), packets[i].data.size()));
        obj.Set("ptsUs", static_cast<double>(packets[i].ptsUs));
        result.Set(i, obj);
    }
    return result;
}

// ---------------------------------------------------------------------------------------------
// Transporte nativo (libdatachannel, Fase 4) — mesclado neste addon (era `transport-core`
// separado). Sinalização (SDP/ICE, baixa frequência) exposta pra JS via ThreadSafeFunction; envio
// de frame (`TransportSendVideoFrame`, alta frequência) é chamado do loop JS a cada frame.
// ---------------------------------------------------------------------------------------------

// `info[0]` = viewerId (string, gerado pelo backend na conexão WS — ver
// backend/src/services/nativeWsRelay.ts). `info[2]` (opcional) = "h264"/"hevc"/"av1" — TEM que ser
// o codec REALMENTE ativo do encoder (`getActiveCodec()`, não o pedido original), senão a detecção
// de keyframe no bitstream (`ContainsKeyframeNal`/`ContainsKeyframeObu` em TransportCore.cpp) lê o
// formato errado. `info[3]` (opcional) = "high"/"low" — tier inicial da sessão (Sprint 27/
// simulcast), padrão "high" (todo espectador novo entra na qualidade alta; troca depois via
// `transportSetViewerTier`).
Napi::Value TransportCreateSession(const Napi::CallbackInfo& info) {
    std::lock_guard<std::mutex> sessionsLock(g_sessionsMutex);
    Napi::Env env = info.Env();
    if (info.Length() < 1 || !info[0].IsString()) return Napi::Boolean::New(env, false);
    std::string viewerId = info[0].As<Napi::String>().Utf8Value();

    std::vector<std::string> stunUrls;
    if (info.Length() > 1 && info[1].IsArray()) {
        Napi::Array arr = info[1].As<Napi::Array>();
        for (uint32_t i = 0; i < arr.Length(); i++) {
            stunUrls.push_back(arr.Get(i).As<Napi::String>().Utf8Value());
        }
    }
    VideoCodecType codec = (info.Length() > 2 && info[2].IsString())
        ? ParseCodec(info[2].As<Napi::String>().Utf8Value())
        : VideoCodecType::H264;
    std::string tier = (info.Length() > 3 && info[3].IsString()) ? info[3].As<Napi::String>().Utf8Value() : "high";

    auto transport = std::make_unique<TransportCore>();
    if (!transport->Initialize(stunUrls, codec)) return Napi::Boolean::New(env, false);

    // Quando o DataChannel de vídeo abre de verdade, força o PRÓXIMO frame do TIER dessa sessão a
    // ser keyframe — liga direto no encoder em C++, nunca passa por JS/N-API no caminho quente.
    // Sem isso, um espectador entrando no meio de um GOP receberia um P-frame como primeiro chunk
    // — e o WebCodecs EXIGE que o primeiro seja "key", senão rejeita tudo. Efeito colateral
    // aceito: um viewer novo entrando força keyframe pra TODOS os outros do MESMO tier (o encoder
    // é compartilhado por tier, não dá pra mandar streams diferentes por espectador sem codificar
    // de novo pra cada um) — tier diferente não é afetado (encoder independente).
    // ATENÇÃO: esse callback dispara na thread INTERNA do libdatachannel (SCTP/DTLS worker), não
    // na thread do Node — por isso usa `ForceKeyframeForTierLocked` (protegida por
    // `g_encoderMutex`) em vez de tocar `g_encoder`/`g_encoderLow` direto. Ver comentário grande
    // em `g_encoderMutex` — bug real de concorrência achado via dump de crash.
    transport->OnChannelOpen([tier]() { ForceKeyframeForTierLocked(tier); });
    const uint64_t generation = g_nextSessionGeneration++;

    if (g_onLocalDescriptionSet) {
        transport->OnLocalDescription([viewerId, generation](const std::string& sdp, const std::string& type) {
            auto* data = new std::tuple<std::string, std::string, std::string, uint64_t>(viewerId, sdp, type, generation);
            g_onLocalDescriptionTsfn.NonBlockingCall(
                data, [](Napi::Env env, Napi::Function cb, std::tuple<std::string, std::string, std::string, uint64_t>* d) {
                    if (IsCurrentSession(std::get<0>(*d), std::get<3>(*d))) {
                        cb.Call({Napi::String::New(env, std::get<0>(*d)), Napi::String::New(env, std::get<1>(*d)),
                                 Napi::String::New(env, std::get<2>(*d))});
                    }
                    delete d;
                });
        });
    }
    if (g_onLocalCandidateSet) {
        transport->OnLocalCandidate([viewerId, generation](const std::string& candidate, const std::string& mid) {
            auto* data = new std::tuple<std::string, std::string, std::string, uint64_t>(viewerId, candidate, mid, generation);
            g_onLocalCandidateTsfn.NonBlockingCall(
                data, [](Napi::Env env, Napi::Function cb, std::tuple<std::string, std::string, std::string, uint64_t>* d) {
                    if (IsCurrentSession(std::get<0>(*d), std::get<3>(*d))) {
                        cb.Call({Napi::String::New(env, std::get<0>(*d)), Napi::String::New(env, std::get<1>(*d)),
                                 Napi::String::New(env, std::get<2>(*d))});
                    }
                    delete d;
                });
        });
    }
    if (g_onStateChangeSet) {
        transport->OnStateChange([viewerId, generation](const std::string& state) {
            auto* data = new std::tuple<std::string, std::string, uint64_t>(viewerId, state, generation);
            g_onStateChangeTsfn.NonBlockingCall(
                data, [](Napi::Env env, Napi::Function cb, std::tuple<std::string, std::string, uint64_t>* d) {
                    if (IsCurrentSession(std::get<0>(*d), std::get<2>(*d))) {
                        cb.Call({Napi::String::New(env, std::get<0>(*d)), Napi::String::New(env, std::get<1>(*d))});
                    }
                    delete d;
                });
        });
    }

    ViewerSession vs;
    vs.transport = std::move(transport);
    vs.tier = tier;
    vs.generation = generation;
    g_transportSessions[viewerId] = std::move(vs);
    return Napi::Boolean::New(env, true);
}

static bool IsCurrentSession(const std::string& viewerId, uint64_t generation) {
    std::lock_guard<std::mutex> lock(g_sessionsMutex);
    auto it = g_transportSessions.find(viewerId);
    return it != g_transportSessions.end() && it->second.generation == generation;
}

// `info[0]` = viewerId, `info[1]` = "high"/"low" — troca a qualidade de uma sessão JÁ ATIVA
// (Sprint 27/simulcast, ver "set-quality" em main/index.ts). Não recria a sessão WebRTC (o
// DataChannel continua o mesmo) — só muda de QUAL encoder essa sessão passa a receber frame no
// próximo `TransportSendVideoFrame`. Força keyframe no encoder do tier NOVO (mesmo raciocínio do
// `OnChannelOpen`: o primeiro chunk que essa sessão vai receber depois da troca precisa ser "key").
Napi::Value TransportSetViewerTier(const Napi::CallbackInfo& info) {
    std::lock_guard<std::mutex> sessionsLock(g_sessionsMutex);
    Napi::Env env = info.Env();
    if (info.Length() < 2 || !info[0].IsString() || !info[1].IsString()) return Napi::Boolean::New(env, false);
    auto it = g_transportSessions.find(info[0].As<Napi::String>().Utf8Value());
    if (it == g_transportSessions.end()) return Napi::Boolean::New(env, false);

    std::string tier = info[1].As<Napi::String>().Utf8Value();
    it->second.tier = tier;
    ForceKeyframeForTierLocked(tier);
    return Napi::Boolean::New(env, true);
}

// `info[0]` = viewerId. Fecha só a sessão desse espectador — os outros continuam recebendo o
// stream normalmente (diferente do V1 singleton, onde fechar a sessão derrubava todo mundo).
Napi::Value TransportCloseSession(const Napi::CallbackInfo& info) {
    std::lock_guard<std::mutex> sessionsLock(g_sessionsMutex);
    if (info.Length() > 0 && info[0].IsString()) {
        g_transportSessions.erase(info[0].As<Napi::String>().Utf8Value());
    }
    return info.Env().Undefined();
}

// Fecha TODAS as sessões de uma vez — usado só quando a transmissão inteira para (ver
// stopNativeTransport em main/index.ts), não no ciclo normal de um viewer saindo.
Napi::Value TransportCloseAllSessions(const Napi::CallbackInfo& info) {
    std::lock_guard<std::mutex> sessionsLock(g_sessionsMutex);
    g_transportSessions.clear();
    return info.Env().Undefined();
}

Napi::Value TransportAddVideoChannel(const Napi::CallbackInfo& info) {
    std::lock_guard<std::mutex> sessionsLock(g_sessionsMutex);
    Napi::Env env = info.Env();
    if (info.Length() < 1 || !info[0].IsString()) return Napi::Boolean::New(env, false);
    auto it = g_transportSessions.find(info[0].As<Napi::String>().Utf8Value());
    return Napi::Boolean::New(env, it != g_transportSessions.end() && it->second.transport->AddVideoChannel());
}

Napi::Value TransportAddAudioChannel(const Napi::CallbackInfo& info) {
    std::lock_guard<std::mutex> sessionsLock(g_sessionsMutex);
    Napi::Env env = info.Env();
    if (info.Length() < 1 || !info[0].IsString()) return Napi::Boolean::New(env, false);
    auto it = g_transportSessions.find(info[0].As<Napi::String>().Utf8Value());
    return Napi::Boolean::New(env, it != g_transportSessions.end() && it->second.transport->AddAudioChannel());
}

Napi::Value TransportCreateOffer(const Napi::CallbackInfo& info) {
    std::lock_guard<std::mutex> sessionsLock(g_sessionsMutex);
    Napi::Env env = info.Env();
    if (info.Length() < 1 || !info[0].IsString()) return Napi::Boolean::New(env, false);
    auto it = g_transportSessions.find(info[0].As<Napi::String>().Utf8Value());
    return Napi::Boolean::New(env, it != g_transportSessions.end() && it->second.transport->CreateOffer());
}

Napi::Value TransportSetRemoteDescription(const Napi::CallbackInfo& info) {
    std::lock_guard<std::mutex> sessionsLock(g_sessionsMutex);
    Napi::Env env = info.Env();
    if (info.Length() < 3) return Napi::Boolean::New(env, false);
    auto it = g_transportSessions.find(info[0].As<Napi::String>().Utf8Value());
    if (it == g_transportSessions.end()) return Napi::Boolean::New(env, false);
    return Napi::Boolean::New(
        env, it->second.transport->SetRemoteDescription(info[1].As<Napi::String>().Utf8Value(), info[2].As<Napi::String>().Utf8Value()));
}

Napi::Value TransportAddRemoteCandidate(const Napi::CallbackInfo& info) {
    std::lock_guard<std::mutex> sessionsLock(g_sessionsMutex);
    Napi::Env env = info.Env();
    if (info.Length() < 3) return Napi::Boolean::New(env, false);
    auto it = g_transportSessions.find(info[0].As<Napi::String>().Utf8Value());
    if (it == g_transportSessions.end()) return Napi::Boolean::New(env, false);
    return Napi::Boolean::New(
        env, it->second.transport->AddRemoteCandidate(info[1].As<Napi::String>().Utf8Value(), info[2].As<Napi::String>().Utf8Value()));
}

Napi::Value TransportIsConnected(const Napi::CallbackInfo& info) {
    std::lock_guard<std::mutex> sessionsLock(g_sessionsMutex);
    Napi::Env env = info.Env();
    if (info.Length() < 1 || !info[0].IsString()) return Napi::Boolean::New(env, false);
    auto it = g_transportSessions.find(info[0].As<Napi::String>().Utf8Value());
    return Napi::Boolean::New(env, it != g_transportSessions.end() && it->second.transport->IsConnected());
}

// Quantos espectadores estão com sessão CONECTADA agora — usado pro contador no LiveCard (antes
// era sempre 0 ou 1, V1 só suportava 1 espectador). Conta TODOS os tiers juntos — o LiveCard
// mostra "espectadores", não "espectadores em alta qualidade".
Napi::Value TransportConnectedCount(const Napi::CallbackInfo& info) {
    std::lock_guard<std::mutex> sessionsLock(g_sessionsMutex);
    int count = 0;
    for (auto& entry : g_transportSessions) {
        if (entry.second.transport->IsConnected()) count++;
    }
    return Napi::Number::New(info.Env(), count);
}

// Maior `bufferedAmount()` entre as sessões conectadas de UM tier (Sprint 27/simulcast —
// `info[0]` = "high"/"low", padrão "high") — cada tier tem seu PRÓPRIO AIMD agora (ver
// main/index.ts), já que cada um tem encoder e bitrate independentes. 0 se não tiver nenhuma
// sessão conectada NESSE tier (nada represado).
Napi::Value TransportMaxBufferedAmount(const Napi::CallbackInfo& info) {
    std::lock_guard<std::mutex> sessionsLock(g_sessionsMutex);
    std::string tier = (info.Length() > 0 && info[0].IsString()) ? info[0].As<Napi::String>().Utf8Value() : "high";
    size_t maxAmount = 0;
    for (auto& entry : g_transportSessions) {
        if (entry.second.tier != tier || !entry.second.transport->IsConnected()) continue;
        maxAmount = std::max(maxAmount, entry.second.transport->GetBufferedAmount());
    }
    return Napi::Number::New(info.Env(), static_cast<double>(maxAmount));
}

// Sinais de congestionamento de UM tier pro AIMD (main/index.ts) — `maxQueueDelayMs` = maior
// atraso de fila acima do RTT mínimo entre as sessões (medido por ack do espectador, ver
// TransportCore.h "Controle de latência"), `droppedFrames` = frames descartados por
// congestionamento desde a última leitura (zera ao ler), `maxBufferedAmount` = sinal antigo
// (fila do libdatachannel), mantido pra espectador sem ack.
Napi::Value TransportGetTierStats(const Napi::CallbackInfo& info) {
    std::lock_guard<std::mutex> sessionsLock(g_sessionsMutex);
    Napi::Env env = info.Env();
    std::string tier = (info.Length() > 0 && info[0].IsString()) ? info[0].As<Napi::String>().Utf8Value() : "high";
    double maxQueueDelayMs = 0.0;
    uint32_t droppedFrames = 0;
    size_t maxBuffered = 0;
    for (auto& entry : g_transportSessions) {
        if (entry.second.tier != tier || !entry.second.transport->IsConnected()) continue;
        maxQueueDelayMs = std::max(maxQueueDelayMs, entry.second.transport->GetQueueDelayMs());
        droppedFrames += entry.second.transport->TakeDroppedFrames();
        maxBuffered = std::max(maxBuffered, entry.second.transport->GetBufferedAmount());
    }
    Napi::Object result = Napi::Object::New(env);
    result.Set("maxQueueDelayMs", maxQueueDelayMs);
    result.Set("droppedFrames", droppedFrames);
    result.Set("maxBufferedAmount", static_cast<double>(maxBuffered));
    return result;
}

// Mesmos sinais do `TransportGetTierStats`, mas POR ESPECTADOR (array de
// `{viewerId, tier, queueDelayMs, droppedFrames, bufferedAmount}`, só sessões conectadas) — o AIMD
// em main/index.ts agrega por tier sozinho e consegue separar "1 espectador com rede ruim" de "a
// rede do host congestionou": no primeiro caso rebaixa só aquele espectador pro tier "low" em vez
// de derrubar o bitrate de todo mundo (bug reportado no teste A2). `droppedFrames` zera ao ler.
Napi::Value TransportGetViewerStats(const Napi::CallbackInfo& info) {
    std::lock_guard<std::mutex> sessionsLock(g_sessionsMutex);
    Napi::Env env = info.Env();
    Napi::Array result = Napi::Array::New(env);
    uint32_t index = 0;
    for (auto& entry : g_transportSessions) {
        if (!entry.second.transport->IsConnected()) continue;
        Napi::Object item = Napi::Object::New(env);
        item.Set("viewerId", entry.first);
        item.Set("tier", entry.second.tier);
        item.Set("queueDelayMs", entry.second.transport->GetQueueDelayMs());
        item.Set("droppedFrames", entry.second.transport->TakeDroppedFrames());
        item.Set("bufferedAmount", static_cast<double>(entry.second.transport->GetBufferedAmount()));
        result.Set(index++, item);
    }
    return result;
}

// Envio direto da thread JS (loop em main/index.ts, ver histórico — StreamWorker numa thread
// nativa própria não resolveu o stutter, a causa real era o bug do PacingHandler, não threading).
// `info[0]` = "high"/"low" (Sprint 27/simulcast) — de QUAL tier é esse frame (o chamador já
// codificou com o encoder certo, aqui só decide o fan-out). `timestampUs` = microssegundos desde
// o início do stream. Manda só pras sessões DAQUELE tier (antes do simulcast ia pra todas — agora
// cada tier tem seu próprio grupo de espectadores). Retorna `true` se pelo menos UMA sessão do
// tier recebeu com sucesso.
Napi::Value TransportSendVideoFrame(const Napi::CallbackInfo& info) {
    std::lock_guard<std::mutex> sessionsLock(g_sessionsMutex);
    Napi::Env env = info.Env();
    if (info.Length() < 3 || !info[0].IsString() || !info[1].IsBuffer() || !info[2].IsNumber()) {
        return Napi::Boolean::New(env, false);
    }
    std::string tier = info[0].As<Napi::String>().Utf8Value();
    Napi::Buffer<uint8_t> buffer = info[1].As<Napi::Buffer<uint8_t>>();
    int64_t timestampUs = info[2].As<Napi::Number>().Int64Value();

    bool anyOk = false;
    bool keyframeNeeded = false;
    for (auto& entry : g_transportSessions) {
        if (entry.second.tier != tier) continue;
        // Filtro extra além do que `TransportCore::SendVideoFrame` já checa internamente —
        // `TransportMaxBufferedAmount`/`TransportConnectedCount` já filtravam por `IsConnected()`,
        // esse loop (e o de áudio abaixo) nunca filtrava, mandando `send()` cego pra QUALQUER
        // sessão no mapa independente do estado real da conexão (ver bug real achado via dump de
        // crash, comentário grande em `TransportCore::SendAudioFrame`).
        if (!entry.second.transport->IsConnected()) continue;
        if (entry.second.transport->SendVideoFrame(buffer.Data(), buffer.Length(), static_cast<uint64_t>(timestampUs))) {
            anyOk = true;
        }
        // Sessão que descartou frames por congestionamento (e já escoou a fila) ou cujo decoder
        // pediu recuperação — ver "Controle de latência" em TransportCore.h. Keyframe é do encoder
        // do TIER (compartilhado), então sai pra todo mundo desse tier, não só pra essa sessão.
        if (entry.second.transport->ConsumeKeyframeRequest()) keyframeNeeded = true;
    }
    if (keyframeNeeded) ForceKeyframeForTierLocked(tier);
    return Napi::Boolean::New(env, anyOk);
}

// Áudio não tem tier — manda pra TODAS as sessões que já abriram canal de áudio (as que não
// abriram simplesmente ignoram, `SendAudioFrame` retorna `false` sem side-effect).
Napi::Value TransportSendAudioFrame(const Napi::CallbackInfo& info) {
    std::lock_guard<std::mutex> sessionsLock(g_sessionsMutex);
    Napi::Env env = info.Env();
    if (info.Length() < 2 || !info[0].IsBuffer() || !info[1].IsNumber()) {
        return Napi::Boolean::New(env, false);
    }
    Napi::Buffer<uint8_t> buffer = info[0].As<Napi::Buffer<uint8_t>>();
    int64_t timestampUs = info[1].As<Napi::Number>().Int64Value();

    bool anyOk = false;
    for (auto& entry : g_transportSessions) {
        // Ver comentário equivalente em `TransportSendVideoFrame` acima — bug real achado via
        // dump de crash (KERNELBASE, thread crashando dentro de `TransportCore::SendAudioFrame`,
        // ver TASKS.md): esse loop nunca filtrava por `IsConnected()` antes de mandar `send()`.
        if (!entry.second.transport->IsConnected()) continue;
        if (entry.second.transport->SendAudioFrame(buffer.Data(), buffer.Length(), static_cast<uint64_t>(timestampUs))) {
            anyOk = true;
        }
    }
    return Napi::Boolean::New(env, anyOk);
}

// Callbacks do libdatachannel disparam numa thread interna dele, não na thread do Node —
// `NonBlockingCall` enfileira de volta pro loop de eventos do Node sem bloquear essa thread
// (`BlockingCall` já causou um crash real aqui — ver histórico de TransportCore.cpp). Registrados
// UMA VEZ globalmente (não por sessão) — ver comentário nos `g_on*Tsfn` no topo do arquivo.
Napi::Value TransportOnLocalDescription(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    if (info.Length() < 1 || !info[0].IsFunction()) return env.Undefined();
    // Cada "native-transport:start" registra de novo — solta o anterior (senão o TSFN velho, e o
    // closure JS dele com a janela/estado da transmissão anterior, ficava vivo pra sempre).
    if (g_onLocalDescriptionSet) g_onLocalDescriptionTsfn.Release();
    g_onLocalDescriptionTsfn = Napi::ThreadSafeFunction::New(env, info[0].As<Napi::Function>(), "onLocalDescription", 0, 1);
    g_onLocalDescriptionSet = true;
    return env.Undefined();
}

Napi::Value TransportOnLocalCandidate(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    if (info.Length() < 1 || !info[0].IsFunction()) return env.Undefined();
    // Cada "native-transport:start" registra de novo — solta o anterior (senão o TSFN velho, e o
    // closure JS dele com a janela/estado da transmissão anterior, ficava vivo pra sempre).
    if (g_onLocalCandidateSet) g_onLocalCandidateTsfn.Release();
    g_onLocalCandidateTsfn = Napi::ThreadSafeFunction::New(env, info[0].As<Napi::Function>(), "onLocalCandidate", 0, 1);
    g_onLocalCandidateSet = true;
    return env.Undefined();
}

Napi::Value TransportOnStateChange(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    if (info.Length() < 1 || !info[0].IsFunction()) return env.Undefined();
    // Cada "native-transport:start" registra de novo — solta o anterior (senão o TSFN velho, e o
    // closure JS dele com a janela/estado da transmissão anterior, ficava vivo pra sempre).
    if (g_onStateChangeSet) g_onStateChangeTsfn.Release();
    g_onStateChangeTsfn = Napi::ThreadSafeFunction::New(env, info[0].As<Napi::Function>(), "onStateChange", 0, 1);
    g_onStateChangeSet = true;
    return env.Undefined();
}

Napi::Object Init(Napi::Env env, Napi::Object exports) {
    exports.Set("initialize", Napi::Function::New(env, Initialize));
    exports.Set("nowUs", Napi::Function::New(env, NowUs));
    exports.Set("setGpuPriorityClass", Napi::Function::New(env, SetGpuPriorityClass));
    exports.Set("listMonitors", Napi::Function::New(env, ListMonitors));
    exports.Set("start", Napi::Function::New(env, Start));
    exports.Set("startWindow", Napi::Function::New(env, StartWindow));
    exports.Set("stop", Napi::Function::New(env, Stop));
    exports.Set("acquireFrame", Napi::Function::New(env, AcquireFrame));
    exports.Set("acquireFrameGpuOnly", Napi::Function::New(env, AcquireFrameGpuOnly));
    exports.Set("setCursorEnabled", Napi::Function::New(env, SetCursorEnabled));
    exports.Set("initEncoder", Napi::Function::New(env, InitEncoder));
    exports.Set("initEncoderLow", Napi::Function::New(env, InitEncoderLow));
    exports.Set("isUsingHardwareMft", Napi::Function::New(env, IsUsingHardwareMft));
    exports.Set("getNvencFailure", Napi::Function::New(env, GetNvencFailure));
    exports.Set("isUsingSoftwareEncoder", Napi::Function::New(env, IsUsingSoftwareEncoder));
    exports.Set("getActiveCodec", Napi::Function::New(env, GetActiveCodec));
    exports.Set("destroyEncoder", Napi::Function::New(env, DestroyEncoder));
    exports.Set("destroyEncoderLow", Napi::Function::New(env, DestroyEncoderLow));
    exports.Set("encodeCurrentFrame", Napi::Function::New(env, EncodeCurrentFrame));
    exports.Set("encodeCurrentFrameLow", Napi::Function::New(env, EncodeCurrentFrameLow));
    exports.Set("setEncoderBitrate", Napi::Function::New(env, SetEncoderBitrate));
    exports.Set("forceKeyframe", Napi::Function::New(env, ForceKeyframe));

    exports.Set("initAudioCapture", Napi::Function::New(env, InitAudioCapture));
    exports.Set("initAudioCaptureForWindow", Napi::Function::New(env, InitAudioCaptureForWindow));
    exports.Set("destroyAudioCapture", Napi::Function::New(env, DestroyAudioCapture));
    exports.Set("pollAudioPackets", Napi::Function::New(env, PollAudioPackets));
    exports.Set("getAudioRms", Napi::Function::New(env, GetAudioRms));
    exports.Set("setAudioExcludedApps", Napi::Function::New(env, SetAudioExcludedApps));
    exports.Set("getAudioSources", Napi::Function::New(env, GetAudioSources));
    exports.Set("getAudioMixStats", Napi::Function::New(env, GetAudioMixStats));
    exports.Set("startAudioForwarding", Napi::Function::New(env, StartAudioForwarding));
    exports.Set("listAudioApps", Napi::Function::New(env, ListAudioApps));

    exports.Set("transportCreateSession", Napi::Function::New(env, TransportCreateSession));
    exports.Set("transportSetViewerTier", Napi::Function::New(env, TransportSetViewerTier));
    exports.Set("transportCloseSession", Napi::Function::New(env, TransportCloseSession));
    exports.Set("transportCloseAllSessions", Napi::Function::New(env, TransportCloseAllSessions));
    exports.Set("transportAddVideoChannel", Napi::Function::New(env, TransportAddVideoChannel));
    exports.Set("transportAddAudioChannel", Napi::Function::New(env, TransportAddAudioChannel));
    exports.Set("transportCreateOffer", Napi::Function::New(env, TransportCreateOffer));
    exports.Set("transportSetRemoteDescription", Napi::Function::New(env, TransportSetRemoteDescription));
    exports.Set("transportAddRemoteCandidate", Napi::Function::New(env, TransportAddRemoteCandidate));
    exports.Set("transportIsConnected", Napi::Function::New(env, TransportIsConnected));
    exports.Set("transportConnectedCount", Napi::Function::New(env, TransportConnectedCount));
    exports.Set("transportMaxBufferedAmount", Napi::Function::New(env, TransportMaxBufferedAmount));
    exports.Set("transportGetTierStats", Napi::Function::New(env, TransportGetTierStats));
    exports.Set("isExclusiveFullscreenActive", Napi::Function::New(env, IsExclusiveFullscreenActive));
    exports.Set("encodePendingKeyframe", Napi::Function::New(env, EncodePendingKeyframe));
    exports.Set("transportGetViewerStats", Napi::Function::New(env, TransportGetViewerStats));
    exports.Set("transportSendVideoFrame", Napi::Function::New(env, TransportSendVideoFrame));
    exports.Set("transportSendAudioFrame", Napi::Function::New(env, TransportSendAudioFrame));
    exports.Set("transportOnLocalDescription", Napi::Function::New(env, TransportOnLocalDescription));
    exports.Set("transportOnLocalCandidate", Napi::Function::New(env, TransportOnLocalCandidate));
    exports.Set("transportOnStateChange", Napi::Function::New(env, TransportOnStateChange));

    return exports;
}

NODE_API_MODULE(capture_core, Init)
