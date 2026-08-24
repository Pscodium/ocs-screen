#include <napi.h>
#include <memory>
#include <windows.h>
#include <avrt.h>
#include "CaptureCore.h"
#include "EncoderCore.h"

// Instância única de propósito — o app só transmite uma fonte por vez (mesma premissa que o
// resto do projeto já assume, ver isWidgetMode em main/index.ts). Simplifica o binding N-API
// bastante em troca de não suportar múltiplas capturas simultâneas, o que nunca foi um requisito.
static std::unique_ptr<CaptureCore> g_core;
static std::unique_ptr<EncoderCore> g_encoder;
static HANDLE g_mmcssHandle = nullptr;

Napi::Value Initialize(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    g_core = std::make_unique<CaptureCore>();
    bool ok = g_core->Initialize();

    // Registra a thread que chama isso (a main thread do Electron, que também roda o loop de
    // polling de captura) na classe MMCSS "Capture" — dá prioridade de agendamento de CPU mais
    // alta sob contenção (mesma técnica usada por apps de captura de tela/jogo pra não perder
    // timing quando o processo do jogo tá pesando a máquina). Falha em silêncio se não suportado
    // (`g_mmcssHandle` continua nulo, sem efeito colateral).
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
    return Napi::Boolean::New(env, g_core->Start(monitorIndex));
}

Napi::Value Stop(const Napi::CallbackInfo& info) {
    if (g_core) g_core->Stop();
    return info.Env().Undefined();
}

// timeoutMs baixo (chamado a partir de um polling loop em JS, não deve travar o processo main
// por muito tempo por chamada — ver ponte no main process).
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

// Encoder NVENC (Fase 3, ver docs/NATIVE_CAPTURE.md) — opera SOBRE uma captura já em andamento
// (precisa do device e das dimensões do CaptureCore). Só existe pra validar o pipeline isolado
// por enquanto (grava .h264/testa qualidade); ainda não plugado no fluxo de transmissão real.
Napi::Value InitEncoder(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    if (!g_core || info.Length() < 2 || !info[0].IsNumber() || !info[1].IsNumber()) {
        return Napi::Boolean::New(env, false);
    }
    int fps = info[0].As<Napi::Number>().Int32Value();
    int bitrateBps = info[1].As<Napi::Number>().Int32Value();

    g_encoder = std::make_unique<EncoderCore>();
    bool ok = g_encoder->Initialize(g_core->GetDevice(), g_core->GetWidth(), g_core->GetHeight(), fps, bitrateBps);
    if (!ok) g_encoder.reset();
    return Napi::Boolean::New(env, ok);
}

Napi::Value DestroyEncoder(const Napi::CallbackInfo& info) {
    g_encoder.reset();
    return info.Env().Undefined();
}

// Codifica a textura já composta (com cursor) do último AcquireFrame bem-sucedido — chamar depois
// de um `acquireFrame()` que retornou um frame, não em vez dele (a captura continua alimentando o
// caminho antigo via CPU normalmente; isso aqui é um caminho PARALELO ainda em validação).
Napi::Value EncodeCurrentFrame(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    Napi::Array result = Napi::Array::New(env);
    if (!g_encoder || !g_core) return result;

    auto packets = g_encoder->EncodeFrame(g_core->GetComposeTexture());
    result = Napi::Array::New(env, packets.size());
    for (size_t i = 0; i < packets.size(); i++) {
        result.Set(i, Napi::Buffer<uint8_t>::Copy(env, packets[i].data(), packets[i].size()));
    }
    return result;
}

Napi::Value ForceKeyframe(const Napi::CallbackInfo& info) {
    if (g_encoder) g_encoder->ForceKeyframe();
    return info.Env().Undefined();
}

Napi::Value SetEncoderBitrate(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    if (!g_encoder || info.Length() < 1 || !info[0].IsNumber()) {
        return Napi::Boolean::New(env, false);
    }
    int bitrateBps = info[0].As<Napi::Number>().Int32Value();
    return Napi::Boolean::New(env, g_encoder->SetBitrate(bitrateBps));
}

Napi::Value SetCursorEnabled(const Napi::CallbackInfo& info) {
    if (g_core && info.Length() > 0 && info[0].IsBoolean()) {
        g_core->SetCaptureCursor(info[0].As<Napi::Boolean>().Value());
    }
    return info.Env().Undefined();
}

Napi::Object Init(Napi::Env env, Napi::Object exports) {
    exports.Set("initialize", Napi::Function::New(env, Initialize));
    exports.Set("listMonitors", Napi::Function::New(env, ListMonitors));
    exports.Set("start", Napi::Function::New(env, Start));
    exports.Set("stop", Napi::Function::New(env, Stop));
    exports.Set("acquireFrame", Napi::Function::New(env, AcquireFrame));
    exports.Set("setCursorEnabled", Napi::Function::New(env, SetCursorEnabled));
    exports.Set("initEncoder", Napi::Function::New(env, InitEncoder));
    exports.Set("destroyEncoder", Napi::Function::New(env, DestroyEncoder));
    exports.Set("encodeCurrentFrame", Napi::Function::New(env, EncodeCurrentFrame));
    exports.Set("setEncoderBitrate", Napi::Function::New(env, SetEncoderBitrate));
    exports.Set("forceKeyframe", Napi::Function::New(env, ForceKeyframe));
    return exports;
}

NODE_API_MODULE(capture_core, Init)
