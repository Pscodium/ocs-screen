#include <napi.h>
#include <algorithm>
#include <memory>
#include <string>
#include <tuple>
#include <unordered_map>
// NOMINMAX — sem isso, windows.h define macros `min`/`max` que quebram `std::max` mais abaixo
// (TransportMaxBufferedAmount) com erro de sintaxe C2589/C2059 (o pré-processador expande
// `std::max(...)` literalmente pra `std::(...)` antes do compilador ver o template).
#define NOMINMAX
#include <windows.h>
#include <avrt.h>
#include "CaptureCore.h"
#include "WindowCaptureCore.h"
#include "EncoderCore.h"
#include "TransportCore.h"
#include "VideoCodecType.h"
#include "AudioCaptureCore.h"

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
};

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

static std::unique_ptr<EncoderCore> g_encoder;
static std::unique_ptr<EncoderCore> g_encoderLow;
static std::unordered_map<std::string, ViewerSession> g_transportSessions;
static HANDLE g_mmcssHandle = nullptr;

// Áudio (ver AudioCaptureCore.h) — único, compartilhado por TODOS os espectadores (não tem tier
// "low"/"high" pra áudio, diferente do vídeo/simulcast: bitrate de áudio é baixo o bastante pra
// não valer a complexidade de codificar duas vezes).
static std::unique_ptr<AudioCaptureCore> g_audioCore;

// `g_encoder` (high) ou `g_encoderLow` (low) — usado nos vários pontos que precisam resolver "o
// encoder desse tier" sem duplicar o if/else toda vez.
static EncoderCore* EncoderForTier(const std::string& tier) {
    return tier == "low" ? g_encoderLow.get() : g_encoder.get();
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

    g_encoderLow = std::make_unique<EncoderCore>();
    bool ok = g_encoderLow->Initialize(ActiveDevice(), ActiveWidth(), ActiveHeight(), fps, bitrateBps, codec);
    if (!ok) g_encoderLow.reset();
    return Napi::Boolean::New(env, ok);
}

Napi::Value GetActiveCodec(const Napi::CallbackInfo& info) {
    return Napi::String::New(info.Env(), CodecToString(g_encoder ? g_encoder->GetActiveCodec() : VideoCodecType::H264));
}

// Exposto pro host avisar o usuário/HUD de dev quando caiu pro fallback de software (Media
// Foundation) por NVENC não estar disponível — bem mais pesado em CPU, vale saber que caiu nesse
// caminho (ver docs/NATIVE_CAPTURE.md Fase 3 "Fallback de encoder por software").
Napi::Value IsUsingSoftwareEncoder(const Napi::CallbackInfo& info) {
    return Napi::Boolean::New(info.Env(), g_encoder && g_encoder->IsUsingSoftwareFallback());
}

Napi::Value DestroyEncoder(const Napi::CallbackInfo& info) {
    g_encoder.reset();
    return info.Env().Undefined();
}

Napi::Value DestroyEncoderLow(const Napi::CallbackInfo& info) {
    g_encoderLow.reset();
    return info.Env().Undefined();
}

Napi::Value EncodeCurrentFrame(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    Napi::Array result = Napi::Array::New(env);
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
    if (!g_encoderLow || !ActiveComposeTexture()) return result;

    auto packets = g_encoderLow->EncodeFrame(ActiveComposeTexture());
    result = Napi::Array::New(env, packets.size());
    for (size_t i = 0; i < packets.size(); i++) {
        result.Set(i, Napi::Buffer<uint8_t>::Copy(env, packets[i].data(), packets[i].size()));
    }
    return result;
}

// `info[0]` (opcional) = "high"/"low", padrão "high" — mantém a assinatura antiga (sem argumento)
// funcionando pra qualquer chamador esquecido.
Napi::Value ForceKeyframe(const Napi::CallbackInfo& info) {
    std::string tier = (info.Length() > 0 && info[0].IsString()) ? info[0].As<Napi::String>().Utf8Value() : "high";
    EncoderCore* enc = EncoderForTier(tier);
    if (enc) enc->ForceKeyframe();
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

// `info[0]` (string, opcional) = nome do executável a excluir (ex.: "Discord.exe"). Resolve o PID
// aqui mesmo (via AudioCaptureCore::FindProcessIdByName) pra não expor Win32/PID pro lado JS —
// se o processo não estiver rodando (0 encontrado), cai pro loopback normal sem exclusão (não é
// erro: usuário pode não estar com o app aberto ainda).
Napi::Value InitAudioCapture(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    DWORD excludePid = 0;
    if (info.Length() > 0 && info[0].IsString()) {
        std::string exeNameUtf8 = info[0].As<Napi::String>().Utf8Value();
        std::wstring exeNameW(exeNameUtf8.begin(), exeNameUtf8.end());
        excludePid = AudioCaptureCore::FindProcessIdByName(exeNameW.c_str());
    }

    g_audioCore = std::make_unique<AudioCaptureCore>();
    bool ok = g_audioCore->Initialize(excludePid);
    if (!ok) g_audioCore.reset();

    Napi::Object result = Napi::Object::New(env);
    result.Set("ok", ok);
    result.Set("excludedPid", static_cast<double>(excludePid));
    return result;
}

// Caminho de JANELA — `info[0]` = HWND (mesmo formato de `StartWindow`). INCLUDE em vez de
// EXCLUDE: só o áudio da árvore de processos dona da janela compartilhada sai na transmissão
// (ver AudioCaptureCore::InitializeForWindow) — resolve sozinho o pedido do usuário de isolar só
// o app em destaque, sem precisar saber o nome dele nem excluir nada manualmente.
Napi::Value InitAudioCaptureForWindow(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    if (info.Length() < 1 || !info[0].IsNumber()) {
        return Napi::Object::New(env);
    }
    HWND hwnd = reinterpret_cast<HWND>(static_cast<uintptr_t>(info[0].As<Napi::Number>().Int64Value()));

    g_audioCore = std::make_unique<AudioCaptureCore>();
    bool ok = g_audioCore->InitializeForWindow(hwnd);
    if (!ok) g_audioCore.reset();

    Napi::Object result = Napi::Object::New(env);
    result.Set("ok", ok);
    return result;
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
// pra mandar (o `AudioCaptureCore` já acumula PCM internamente até fechar um frame de 20ms).
Napi::Value PollAudioPackets(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    Napi::Array result = Napi::Array::New(env);
    if (!g_audioCore) return result;

    auto packets = g_audioCore->PollEncodedPackets();
    result = Napi::Array::New(env, packets.size());
    for (size_t i = 0; i < packets.size(); i++) {
        result.Set(i, Napi::Buffer<uint8_t>::Copy(env, packets[i].data(), packets[i].size()));
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
    transport->OnChannelOpen([tier]() {
        EncoderCore* enc = EncoderForTier(tier);
        if (enc) enc->ForceKeyframe();
    });

    if (g_onLocalDescriptionSet) {
        transport->OnLocalDescription([viewerId](const std::string& sdp, const std::string& type) {
            auto* data = new std::tuple<std::string, std::string, std::string>(viewerId, sdp, type);
            g_onLocalDescriptionTsfn.NonBlockingCall(
                data, [](Napi::Env env, Napi::Function cb, std::tuple<std::string, std::string, std::string>* d) {
                    cb.Call({Napi::String::New(env, std::get<0>(*d)), Napi::String::New(env, std::get<1>(*d)),
                             Napi::String::New(env, std::get<2>(*d))});
                    delete d;
                });
        });
    }
    if (g_onLocalCandidateSet) {
        transport->OnLocalCandidate([viewerId](const std::string& candidate, const std::string& mid) {
            auto* data = new std::tuple<std::string, std::string, std::string>(viewerId, candidate, mid);
            g_onLocalCandidateTsfn.NonBlockingCall(
                data, [](Napi::Env env, Napi::Function cb, std::tuple<std::string, std::string, std::string>* d) {
                    cb.Call({Napi::String::New(env, std::get<0>(*d)), Napi::String::New(env, std::get<1>(*d)),
                             Napi::String::New(env, std::get<2>(*d))});
                    delete d;
                });
        });
    }
    if (g_onStateChangeSet) {
        transport->OnStateChange([viewerId](const std::string& state) {
            auto* data = new std::pair<std::string, std::string>(viewerId, state);
            g_onStateChangeTsfn.NonBlockingCall(
                data, [](Napi::Env env, Napi::Function cb, std::pair<std::string, std::string>* d) {
                    cb.Call({Napi::String::New(env, d->first), Napi::String::New(env, d->second)});
                    delete d;
                });
        });
    }

    ViewerSession vs;
    vs.transport = std::move(transport);
    vs.tier = tier;
    g_transportSessions[viewerId] = std::move(vs);
    return Napi::Boolean::New(env, true);
}

// `info[0]` = viewerId, `info[1]` = "high"/"low" — troca a qualidade de uma sessão JÁ ATIVA
// (Sprint 27/simulcast, ver "set-quality" em main/index.ts). Não recria a sessão WebRTC (o
// DataChannel continua o mesmo) — só muda de QUAL encoder essa sessão passa a receber frame no
// próximo `TransportSendVideoFrame`. Força keyframe no encoder do tier NOVO (mesmo raciocínio do
// `OnChannelOpen`: o primeiro chunk que essa sessão vai receber depois da troca precisa ser "key").
Napi::Value TransportSetViewerTier(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    if (info.Length() < 2 || !info[0].IsString() || !info[1].IsString()) return Napi::Boolean::New(env, false);
    auto it = g_transportSessions.find(info[0].As<Napi::String>().Utf8Value());
    if (it == g_transportSessions.end()) return Napi::Boolean::New(env, false);

    std::string tier = info[1].As<Napi::String>().Utf8Value();
    it->second.tier = tier;
    EncoderCore* enc = EncoderForTier(tier);
    if (enc) enc->ForceKeyframe();
    return Napi::Boolean::New(env, true);
}

// `info[0]` = viewerId. Fecha só a sessão desse espectador — os outros continuam recebendo o
// stream normalmente (diferente do V1 singleton, onde fechar a sessão derrubava todo mundo).
Napi::Value TransportCloseSession(const Napi::CallbackInfo& info) {
    if (info.Length() > 0 && info[0].IsString()) {
        g_transportSessions.erase(info[0].As<Napi::String>().Utf8Value());
    }
    return info.Env().Undefined();
}

// Fecha TODAS as sessões de uma vez — usado só quando a transmissão inteira para (ver
// stopNativeTransport em main/index.ts), não no ciclo normal de um viewer saindo.
Napi::Value TransportCloseAllSessions(const Napi::CallbackInfo& info) {
    g_transportSessions.clear();
    return info.Env().Undefined();
}

Napi::Value TransportAddVideoChannel(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    if (info.Length() < 1 || !info[0].IsString()) return Napi::Boolean::New(env, false);
    auto it = g_transportSessions.find(info[0].As<Napi::String>().Utf8Value());
    return Napi::Boolean::New(env, it != g_transportSessions.end() && it->second.transport->AddVideoChannel());
}

Napi::Value TransportAddAudioChannel(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    if (info.Length() < 1 || !info[0].IsString()) return Napi::Boolean::New(env, false);
    auto it = g_transportSessions.find(info[0].As<Napi::String>().Utf8Value());
    return Napi::Boolean::New(env, it != g_transportSessions.end() && it->second.transport->AddAudioChannel());
}

Napi::Value TransportCreateOffer(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    if (info.Length() < 1 || !info[0].IsString()) return Napi::Boolean::New(env, false);
    auto it = g_transportSessions.find(info[0].As<Napi::String>().Utf8Value());
    return Napi::Boolean::New(env, it != g_transportSessions.end() && it->second.transport->CreateOffer());
}

Napi::Value TransportSetRemoteDescription(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    if (info.Length() < 3) return Napi::Boolean::New(env, false);
    auto it = g_transportSessions.find(info[0].As<Napi::String>().Utf8Value());
    if (it == g_transportSessions.end()) return Napi::Boolean::New(env, false);
    return Napi::Boolean::New(
        env, it->second.transport->SetRemoteDescription(info[1].As<Napi::String>().Utf8Value(), info[2].As<Napi::String>().Utf8Value()));
}

Napi::Value TransportAddRemoteCandidate(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    if (info.Length() < 3) return Napi::Boolean::New(env, false);
    auto it = g_transportSessions.find(info[0].As<Napi::String>().Utf8Value());
    if (it == g_transportSessions.end()) return Napi::Boolean::New(env, false);
    return Napi::Boolean::New(
        env, it->second.transport->AddRemoteCandidate(info[1].As<Napi::String>().Utf8Value(), info[2].As<Napi::String>().Utf8Value()));
}

Napi::Value TransportIsConnected(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    if (info.Length() < 1 || !info[0].IsString()) return Napi::Boolean::New(env, false);
    auto it = g_transportSessions.find(info[0].As<Napi::String>().Utf8Value());
    return Napi::Boolean::New(env, it != g_transportSessions.end() && it->second.transport->IsConnected());
}

// Quantos espectadores estão com sessão CONECTADA agora — usado pro contador no LiveCard (antes
// era sempre 0 ou 1, V1 só suportava 1 espectador). Conta TODOS os tiers juntos — o LiveCard
// mostra "espectadores", não "espectadores em alta qualidade".
Napi::Value TransportConnectedCount(const Napi::CallbackInfo& info) {
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
    std::string tier = (info.Length() > 0 && info[0].IsString()) ? info[0].As<Napi::String>().Utf8Value() : "high";
    size_t maxAmount = 0;
    for (auto& entry : g_transportSessions) {
        if (entry.second.tier != tier || !entry.second.transport->IsConnected()) continue;
        maxAmount = std::max(maxAmount, entry.second.transport->GetBufferedAmount());
    }
    return Napi::Number::New(info.Env(), static_cast<double>(maxAmount));
}

// Envio direto da thread JS (loop em main/index.ts, ver histórico — StreamWorker numa thread
// nativa própria não resolveu o stutter, a causa real era o bug do PacingHandler, não threading).
// `info[0]` = "high"/"low" (Sprint 27/simulcast) — de QUAL tier é esse frame (o chamador já
// codificou com o encoder certo, aqui só decide o fan-out). `timestampUs` = microssegundos desde
// o início do stream. Manda só pras sessões DAQUELE tier (antes do simulcast ia pra todas — agora
// cada tier tem seu próprio grupo de espectadores). Retorna `true` se pelo menos UMA sessão do
// tier recebeu com sucesso.
Napi::Value TransportSendVideoFrame(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    if (info.Length() < 3 || !info[0].IsString() || !info[1].IsBuffer() || !info[2].IsNumber()) {
        return Napi::Boolean::New(env, false);
    }
    std::string tier = info[0].As<Napi::String>().Utf8Value();
    Napi::Buffer<uint8_t> buffer = info[1].As<Napi::Buffer<uint8_t>>();
    int64_t timestampUs = info[2].As<Napi::Number>().Int64Value();

    bool anyOk = false;
    for (auto& entry : g_transportSessions) {
        if (entry.second.tier != tier) continue;
        if (entry.second.transport->SendVideoFrame(buffer.Data(), buffer.Length(), static_cast<uint64_t>(timestampUs))) {
            anyOk = true;
        }
    }
    return Napi::Boolean::New(env, anyOk);
}

// Áudio não tem tier — manda pra TODAS as sessões que já abriram canal de áudio (as que não
// abriram simplesmente ignoram, `SendAudioFrame` retorna `false` sem side-effect).
Napi::Value TransportSendAudioFrame(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    if (info.Length() < 2 || !info[0].IsBuffer() || !info[1].IsNumber()) {
        return Napi::Boolean::New(env, false);
    }
    Napi::Buffer<uint8_t> buffer = info[0].As<Napi::Buffer<uint8_t>>();
    int64_t timestampUs = info[1].As<Napi::Number>().Int64Value();

    bool anyOk = false;
    for (auto& entry : g_transportSessions) {
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
    g_onLocalDescriptionTsfn = Napi::ThreadSafeFunction::New(env, info[0].As<Napi::Function>(), "onLocalDescription", 0, 1);
    g_onLocalDescriptionSet = true;
    return env.Undefined();
}

Napi::Value TransportOnLocalCandidate(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    if (info.Length() < 1 || !info[0].IsFunction()) return env.Undefined();
    g_onLocalCandidateTsfn = Napi::ThreadSafeFunction::New(env, info[0].As<Napi::Function>(), "onLocalCandidate", 0, 1);
    g_onLocalCandidateSet = true;
    return env.Undefined();
}

Napi::Value TransportOnStateChange(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    if (info.Length() < 1 || !info[0].IsFunction()) return env.Undefined();
    g_onStateChangeTsfn = Napi::ThreadSafeFunction::New(env, info[0].As<Napi::Function>(), "onStateChange", 0, 1);
    g_onStateChangeSet = true;
    return env.Undefined();
}

Napi::Object Init(Napi::Env env, Napi::Object exports) {
    exports.Set("initialize", Napi::Function::New(env, Initialize));
    exports.Set("listMonitors", Napi::Function::New(env, ListMonitors));
    exports.Set("start", Napi::Function::New(env, Start));
    exports.Set("startWindow", Napi::Function::New(env, StartWindow));
    exports.Set("stop", Napi::Function::New(env, Stop));
    exports.Set("acquireFrame", Napi::Function::New(env, AcquireFrame));
    exports.Set("acquireFrameGpuOnly", Napi::Function::New(env, AcquireFrameGpuOnly));
    exports.Set("setCursorEnabled", Napi::Function::New(env, SetCursorEnabled));
    exports.Set("initEncoder", Napi::Function::New(env, InitEncoder));
    exports.Set("initEncoderLow", Napi::Function::New(env, InitEncoderLow));
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
    exports.Set("transportSendVideoFrame", Napi::Function::New(env, TransportSendVideoFrame));
    exports.Set("transportSendAudioFrame", Napi::Function::New(env, TransportSendAudioFrame));
    exports.Set("transportOnLocalDescription", Napi::Function::New(env, TransportOnLocalDescription));
    exports.Set("transportOnLocalCandidate", Napi::Function::New(env, TransportOnLocalCandidate));
    exports.Set("transportOnStateChange", Napi::Function::New(env, TransportOnStateChange));

    return exports;
}

NODE_API_MODULE(capture_core, Init)
