#include <napi.h>
#include <algorithm>
#include <memory>
#include <string>
#include <tuple>
#include <unordered_map>
#include <windows.h>
#include <avrt.h>
#include "CaptureCore.h"
#include "EncoderCore.h"
#include "TransportCore.h"
#include "StreamWorker.h"
#include "VideoCodecType.h"

// "h264"/"hevc" (case-sensitive, vem sempre de string literal do lado JS) — qualquer coisa que
// não seja "hevc" cai em H.264, o padrão seguro.
static VideoCodecType ParseCodec(const std::string& s) {
    return s == "hevc" ? VideoCodecType::HEVC : VideoCodecType::H264;
}
static const char* CodecToString(VideoCodecType codec) {
    return codec == VideoCodecType::HEVC ? "hevc" : "h264";
}

// Captura e encoder continuam únicos de propósito — o app só transmite UMA fonte por vez (não
// tem sentido capturar/codificar a mesma tela duas vezes pra espectadores diferentes). O
// transporte, esse sim, agora é 1 sessão `TransportCore` POR ESPECTADOR (`g_transportSessions`,
// chave = viewerId) — é o "SFU" desse projeto: mesmo frame codificado, `TransportSendVideoFrame`
// manda pra TODAS as sessões ativas (fan-out direto em C++, sem round-trip por JS por viewer).
// V1 (1 sessão só, `g_transport` singleton) ficou pra trás — ver docs/NATIVE_CAPTURE.md Fase 4.
static std::unique_ptr<CaptureCore> g_core;
static std::unique_ptr<EncoderCore> g_encoder;
static std::unordered_map<std::string, std::unique_ptr<TransportCore>> g_transportSessions;
static std::unique_ptr<StreamWorker> g_worker;
static HANDLE g_mmcssHandle = nullptr;

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
    // roda em thread PRÓPRIA (StreamWorker) e não passa mais por aqui — isso só beneficia o
    // caminho antigo (raw frame → LiveKit), que ainda usa a main thread pro loop de captura.
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
// por muito tempo por chamada — ver ponte no main process). Só usado pelo caminho antigo (raw
// frame → LiveKit); o transporte nativo usa StreamWorker/AcquireFrameGpuOnly numa thread própria.
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
    if (!g_core) return env.Null();

    uint32_t timeoutMs = 0;
    if (info.Length() > 0 && info[0].IsNumber()) {
        timeoutMs = info[0].As<Napi::Number>().Uint32Value();
    }

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

// Encoder NVENC (Fase 3) — usado tanto pelo caminho de validação isolada antiga (initEncoder +
// encodeCurrentFrame chamados de JS) quanto internamente pelo StreamWorker (startStream), que
// também usa essa mesma instância `g_encoder` mas chama `EncodeFrame` direto em C++.
// `info[2]` (opcional) = "h264"/"hevc", o codec PEDIDO — cai pro padrão "h264" se omitido. O que
// realmente fica ativo pode ser diferente (cascata de fallback em EncoderCore::Initialize) — ver
// `IsUsingSoftwareEncoder`/`GetActiveCodec` pra saber o resultado real depois de chamar isso.
Napi::Value InitEncoder(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    if (!g_core || info.Length() < 2 || !info[0].IsNumber() || !info[1].IsNumber()) {
        return Napi::Boolean::New(env, false);
    }
    int fps = info[0].As<Napi::Number>().Int32Value();
    int bitrateBps = info[1].As<Napi::Number>().Int32Value();
    VideoCodecType codec = (info.Length() > 2 && info[2].IsString())
        ? ParseCodec(info[2].As<Napi::String>().Utf8Value())
        : VideoCodecType::H264;

    g_encoder = std::make_unique<EncoderCore>();
    bool ok = g_encoder->Initialize(g_core->GetDevice(), g_core->GetWidth(), g_core->GetHeight(), fps, bitrateBps, codec);
    if (!ok) g_encoder.reset();
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

// `info[1]` (opcional, padrão true) = forçar keyframe na troca — passar `false` no ajuste
// automático de congestionamento (AIMD, ver main/index.ts e comentário em EncoderCore.h).
Napi::Value SetEncoderBitrate(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    if (!g_encoder || info.Length() < 1 || !info[0].IsNumber()) {
        return Napi::Boolean::New(env, false);
    }
    int bitrateBps = info[0].As<Napi::Number>().Int32Value();
    bool forceKeyframe = info.Length() < 2 || !info[1].IsBoolean() || info[1].As<Napi::Boolean>().Value();
    return Napi::Boolean::New(env, g_encoder->SetBitrate(bitrateBps, forceKeyframe));
}

Napi::Value SetCursorEnabled(const Napi::CallbackInfo& info) {
    if (g_core && info.Length() > 0 && info[0].IsBoolean()) {
        g_core->SetCaptureCursor(info[0].As<Napi::Boolean>().Value());
    }
    return info.Env().Undefined();
}

// ---------------------------------------------------------------------------------------------
// Transporte nativo (libdatachannel, Fase 4) — mesclado neste addon (era `transport-core`
// separado) pra permitir que o StreamWorker chame `TransportCore::SendVideoFrame` DIRETO em C++,
// sem cruzar N-API por frame. Sinalização (SDP/ICE, baixa frequência) continua exposta pra JS via
// ThreadSafeFunction, igual antes.
// ---------------------------------------------------------------------------------------------

// `info[0]` = viewerId (string, gerado pelo backend na conexão WS — ver
// backend/src/services/nativeWsRelay.ts). `info[2]` (opcional) = "h264"/"hevc" — TEM que ser o
// codec REALMENTE ativo do encoder (`getActiveCodec()`, não o pedido original), senão a detecção
// de keyframe no bitstream (`ContainsKeyframeNal` em TransportCore.cpp) lê o formato errado.
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

    auto session = std::make_unique<TransportCore>();
    if (!session->Initialize(stunUrls, codec)) return Napi::Boolean::New(env, false);

    // Quando o DataChannel de vídeo abre de verdade, força o PRÓXIMO frame (compartilhado por
    // TODOS os espectadores, é o mesmo encode) a ser keyframe — liga direto no encoder em C++,
    // nunca passa por JS/N-API no caminho quente. Sem isso, um espectador entrando no meio de um
    // GOP receberia um P-frame como primeiro chunk — e o WebCodecs EXIGE que o primeiro seja
    // "key", senão rejeita tudo. Efeito colateral aceito: um viewer novo entrando força keyframe
    // pra TODOS (inclusive os já conectados) — soluço pequeno e raro, não vale a complexidade de
    // um keyframe "focado" só num espectador (o encoder é compartilhado, não dá pra mandar dois
    // streams diferentes sem codificar duas vezes).
    session->OnChannelOpen([]() {
        if (g_encoder) g_encoder->ForceKeyframe();
    });

    if (g_onLocalDescriptionSet) {
        session->OnLocalDescription([viewerId](const std::string& sdp, const std::string& type) {
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
        session->OnLocalCandidate([viewerId](const std::string& candidate, const std::string& mid) {
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
        session->OnStateChange([viewerId](const std::string& state) {
            auto* data = new std::pair<std::string, std::string>(viewerId, state);
            g_onStateChangeTsfn.NonBlockingCall(
                data, [](Napi::Env env, Napi::Function cb, std::pair<std::string, std::string>* d) {
                    cb.Call({Napi::String::New(env, d->first), Napi::String::New(env, d->second)});
                    delete d;
                });
        });
    }

    g_transportSessions[viewerId] = std::move(session);
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
    if (g_worker) {
        g_worker->Stop();
        g_worker.reset();
    }
    g_transportSessions.clear();
    return info.Env().Undefined();
}

Napi::Value TransportAddVideoChannel(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    if (info.Length() < 1 || !info[0].IsString()) return Napi::Boolean::New(env, false);
    auto it = g_transportSessions.find(info[0].As<Napi::String>().Utf8Value());
    return Napi::Boolean::New(env, it != g_transportSessions.end() && it->second->AddVideoChannel());
}

Napi::Value TransportCreateOffer(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    if (info.Length() < 1 || !info[0].IsString()) return Napi::Boolean::New(env, false);
    auto it = g_transportSessions.find(info[0].As<Napi::String>().Utf8Value());
    return Napi::Boolean::New(env, it != g_transportSessions.end() && it->second->CreateOffer());
}

Napi::Value TransportSetRemoteDescription(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    if (info.Length() < 3) return Napi::Boolean::New(env, false);
    auto it = g_transportSessions.find(info[0].As<Napi::String>().Utf8Value());
    if (it == g_transportSessions.end()) return Napi::Boolean::New(env, false);
    return Napi::Boolean::New(
        env, it->second->SetRemoteDescription(info[1].As<Napi::String>().Utf8Value(), info[2].As<Napi::String>().Utf8Value()));
}

Napi::Value TransportAddRemoteCandidate(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    if (info.Length() < 3) return Napi::Boolean::New(env, false);
    auto it = g_transportSessions.find(info[0].As<Napi::String>().Utf8Value());
    if (it == g_transportSessions.end()) return Napi::Boolean::New(env, false);
    return Napi::Boolean::New(
        env, it->second->AddRemoteCandidate(info[1].As<Napi::String>().Utf8Value(), info[2].As<Napi::String>().Utf8Value()));
}

Napi::Value TransportIsConnected(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    if (info.Length() < 1 || !info[0].IsString()) return Napi::Boolean::New(env, false);
    auto it = g_transportSessions.find(info[0].As<Napi::String>().Utf8Value());
    return Napi::Boolean::New(env, it != g_transportSessions.end() && it->second->IsConnected());
}

// Quantos espectadores estão com sessão CONECTADA agora — usado pro contador no LiveCard (antes
// era sempre 0 ou 1, V1 só suportava 1 espectador).
Napi::Value TransportConnectedCount(const Napi::CallbackInfo& info) {
    int count = 0;
    for (auto& entry : g_transportSessions) {
        if (entry.second->IsConnected()) count++;
    }
    return Napi::Number::New(info.Env(), count);
}

// Maior `bufferedAmount()` entre TODAS as sessões conectadas — o pior espectador manda no
// controle de congestionamento (ver docs/NATIVE_CAPTURE.md Fase 4 "Congestion control"), já que o
// encode é compartilhado (1 bitrate só pra todo mundo, sem simulcast ainda). 0 se não tiver
// nenhuma sessão conectada (nada represado).
Napi::Value TransportMaxBufferedAmount(const Napi::CallbackInfo& info) {
    size_t maxAmount = 0;
    for (auto& entry : g_transportSessions) {
        if (!entry.second->IsConnected()) continue;
        maxAmount = std::max(maxAmount, entry.second->GetBufferedAmount());
    }
    return Napi::Number::New(info.Env(), static_cast<double>(maxAmount));
}

// Envio direto da thread JS (loop em main/index.ts, ver histórico — StreamWorker numa thread
// nativa própria não resolveu o stutter, a causa real era o bug do PacingHandler, não threading).
// `timestampUs` = microssegundos desde o início do stream (relógio real, não passo fixo — mesmo
// raciocínio já validado antes com o timestamp RTP). SEM viewerId — manda pra TODAS as sessões
// ativas, é o fan-out (mesmo frame codificado, N espectadores). Retorna `true` se pelo menos UMA
// sessão recebeu com sucesso (não exige que TODAS aceitem — um espectador com canal ainda
// fechando não deve fazer os outros "falharem").
Napi::Value TransportSendVideoFrame(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    if (info.Length() < 2 || !info[0].IsBuffer() || !info[1].IsNumber()) {
        return Napi::Boolean::New(env, false);
    }
    Napi::Buffer<uint8_t> buffer = info[0].As<Napi::Buffer<uint8_t>>();
    int64_t timestampUs = info[1].As<Napi::Number>().Int64Value();

    bool anyOk = false;
    for (auto& entry : g_transportSessions) {
        if (entry.second->SendVideoFrame(buffer.Data(), buffer.Length(), static_cast<uint64_t>(timestampUs))) {
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

// ---------------------------------------------------------------------------------------------
// Loop de streaming (StreamWorker) — captura+encode+envio numa thread nativa dedicada, ver
// StreamWorker.h/.cpp. Precisa de g_core (já iniciado via Start), g_encoder (já inicializado via
// InitEncoder) e g_transport (já com AddVideoTrack chamado) prontos antes de chamar.
// ---------------------------------------------------------------------------------------------

// StreamWorker (thread nativa dedicada) não é o caminho ativo desde antes do multi-viewer (loop
// em JS venceu, ver docs/NATIVE_CAPTURE.md Sessão de 2026-08-24 "Threading do loop") — mantido no
// repo pra reaproveitar depois, mas segura UM `TransportCore*` só. Com sessão por espectador
// (`g_transportSessions`), reativar isso exigiria StreamWorker aceitar a lista inteira de sessões
// (ou um callback de fan-out) em vez de um ponteiro único — não vale reescrever agora pra um
// caminho que nem tá em uso. Desabilitado de propósito até esse rework acontecer.
Napi::Value StartStream(const Napi::CallbackInfo& info) {
    return Napi::Boolean::New(info.Env(), false);
}

Napi::Value StopStream(const Napi::CallbackInfo& info) {
    if (g_worker) {
        g_worker->Stop();
        g_worker.reset();
    }
    return info.Env().Undefined();
}

// Polling 1x/segundo do lado JS (mesmo padrão já usado pro caminho antigo de captura) — lê e
// zera os contadores atômicos do StreamWorker.
Napi::Value GetStreamStats(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    Napi::Object obj = Napi::Object::New(env);
    if (!g_worker) {
        obj.Set("running", false);
        return obj;
    }

    StreamWorkerStats stats = g_worker->ConsumeStats();
    obj.Set("running", g_worker->IsRunning());
    obj.Set("ended", g_worker->HasEnded());
    obj.Set("acquired", stats.acquired);
    obj.Set("timeouts", stats.timeouts);
    obj.Set("encodedPackets", stats.encodedPackets);
    obj.Set("emptyEncodeCalls", stats.emptyEncodeCalls);
    obj.Set("sendOk", stats.sendOk);
    obj.Set("sendFail", stats.sendFail);
    obj.Set("bytes", static_cast<double>(stats.bytes));
    return obj;
}

Napi::Object Init(Napi::Env env, Napi::Object exports) {
    exports.Set("initialize", Napi::Function::New(env, Initialize));
    exports.Set("listMonitors", Napi::Function::New(env, ListMonitors));
    exports.Set("start", Napi::Function::New(env, Start));
    exports.Set("stop", Napi::Function::New(env, Stop));
    exports.Set("acquireFrame", Napi::Function::New(env, AcquireFrame));
    exports.Set("acquireFrameGpuOnly", Napi::Function::New(env, AcquireFrameGpuOnly));
    exports.Set("setCursorEnabled", Napi::Function::New(env, SetCursorEnabled));
    exports.Set("initEncoder", Napi::Function::New(env, InitEncoder));
    exports.Set("isUsingSoftwareEncoder", Napi::Function::New(env, IsUsingSoftwareEncoder));
    exports.Set("getActiveCodec", Napi::Function::New(env, GetActiveCodec));
    exports.Set("destroyEncoder", Napi::Function::New(env, DestroyEncoder));
    exports.Set("encodeCurrentFrame", Napi::Function::New(env, EncodeCurrentFrame));
    exports.Set("setEncoderBitrate", Napi::Function::New(env, SetEncoderBitrate));
    exports.Set("forceKeyframe", Napi::Function::New(env, ForceKeyframe));

    exports.Set("transportCreateSession", Napi::Function::New(env, TransportCreateSession));
    exports.Set("transportCloseSession", Napi::Function::New(env, TransportCloseSession));
    exports.Set("transportCloseAllSessions", Napi::Function::New(env, TransportCloseAllSessions));
    exports.Set("transportAddVideoChannel", Napi::Function::New(env, TransportAddVideoChannel));
    exports.Set("transportCreateOffer", Napi::Function::New(env, TransportCreateOffer));
    exports.Set("transportSetRemoteDescription", Napi::Function::New(env, TransportSetRemoteDescription));
    exports.Set("transportAddRemoteCandidate", Napi::Function::New(env, TransportAddRemoteCandidate));
    exports.Set("transportIsConnected", Napi::Function::New(env, TransportIsConnected));
    exports.Set("transportConnectedCount", Napi::Function::New(env, TransportConnectedCount));
    exports.Set("transportMaxBufferedAmount", Napi::Function::New(env, TransportMaxBufferedAmount));
    exports.Set("transportSendVideoFrame", Napi::Function::New(env, TransportSendVideoFrame));
    exports.Set("transportOnLocalDescription", Napi::Function::New(env, TransportOnLocalDescription));
    exports.Set("transportOnLocalCandidate", Napi::Function::New(env, TransportOnLocalCandidate));
    exports.Set("transportOnStateChange", Napi::Function::New(env, TransportOnStateChange));

    exports.Set("startStream", Napi::Function::New(env, StartStream));
    exports.Set("stopStream", Napi::Function::New(env, StopStream));
    exports.Set("getStreamStats", Napi::Function::New(env, GetStreamStats));

    return exports;
}

NODE_API_MODULE(capture_core, Init)
