#include <napi.h>
#include <memory>
#include <unordered_map>
#include "TransportCore.h"

// Uma PeerConnection por espectador — cada espectador tem seu próprio ID de sessão (gerado do
// lado JS, junto com a sinalização). Isso é o mais próximo de um "SFU" que esse addon faz: cada
// sessão aqui dentro é só ponto-a-ponto, distribuir pra N espectadores é só criar N sessões e
// mandar o mesmo frame codificado (SendVideoFrame) pra todas.
static std::unordered_map<int, std::unique_ptr<TransportCore>> g_sessions;
static int g_nextSessionId = 1;

Napi::Value CreateSession(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    std::vector<std::string> stunUrls;
    if (info.Length() > 0 && info[0].IsArray()) {
        Napi::Array arr = info[0].As<Napi::Array>();
        for (uint32_t i = 0; i < arr.Length(); i++) {
            stunUrls.push_back(arr.Get(i).As<Napi::String>().Utf8Value());
        }
    }

    auto session = std::make_unique<TransportCore>();
    if (!session->Initialize(stunUrls)) {
        return env.Null();
    }

    int id = g_nextSessionId++;
    g_sessions[id] = std::move(session);
    return Napi::Number::New(env, id);
}

Napi::Value CloseSession(const Napi::CallbackInfo& info) {
    if (info.Length() > 0 && info[0].IsNumber()) {
        g_sessions.erase(info[0].As<Napi::Number>().Int32Value());
    }
    return info.Env().Undefined();
}

TransportCore* GetSession(int id) {
    auto it = g_sessions.find(id);
    return it != g_sessions.end() ? it->second.get() : nullptr;
}

Napi::Value AddVideoTrack(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    if (info.Length() < 2 || !info[1].IsNumber()) return Napi::Boolean::New(env, false);
    auto* session = GetSession(info[0].As<Napi::Number>().Int32Value());
    int bitrateBps = info[1].As<Napi::Number>().Int32Value();
    return Napi::Boolean::New(env, session && session->AddVideoTrack(bitrateBps));
}

Napi::Value CreateOffer(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    auto* session = info.Length() > 0 ? GetSession(info[0].As<Napi::Number>().Int32Value()) : nullptr;
    return Napi::Boolean::New(env, session && session->CreateOffer());
}

Napi::Value SetRemoteDescription(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    if (info.Length() < 3) return Napi::Boolean::New(env, false);
    auto* session = GetSession(info[0].As<Napi::Number>().Int32Value());
    if (!session) return Napi::Boolean::New(env, false);
    return Napi::Boolean::New(env, session->SetRemoteDescription(
        info[1].As<Napi::String>().Utf8Value(), info[2].As<Napi::String>().Utf8Value()));
}

Napi::Value AddRemoteCandidate(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    if (info.Length() < 3) return Napi::Boolean::New(env, false);
    auto* session = GetSession(info[0].As<Napi::Number>().Int32Value());
    if (!session) return Napi::Boolean::New(env, false);
    return Napi::Boolean::New(env, session->AddRemoteCandidate(
        info[1].As<Napi::String>().Utf8Value(), info[2].As<Napi::String>().Utf8Value()));
}

Napi::Value SendVideoFrame(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    if (info.Length() < 3 || !info[1].IsBuffer()) return Napi::Boolean::New(env, false);
    auto* session = GetSession(info[0].As<Napi::Number>().Int32Value());
    if (!session) return Napi::Boolean::New(env, false);

    Napi::Buffer<uint8_t> buffer = info[1].As<Napi::Buffer<uint8_t>>();
    uint32_t timestampRtp = info[2].As<Napi::Number>().Uint32Value();
    return Napi::Boolean::New(env, session->SendVideoFrame(buffer.Data(), buffer.Length(), timestampRtp));
}

Napi::Value IsConnected(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    auto* session = info.Length() > 0 ? GetSession(info[0].As<Napi::Number>().Int32Value()) : nullptr;
    return Napi::Boolean::New(env, session && session->IsConnected());
}

// Callbacks do libdatachannel disparam numa thread interna dele, não na thread do Node — usar o
// N-API direto de lá quebraria (V8 não é thread-safe). `Napi::ThreadSafeFunction` enfileira a
// chamada de volta pro loop de eventos do Node com segurança.
Napi::Value OnLocalDescription(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    if (info.Length() < 2 || !info[1].IsFunction()) return env.Undefined();
    auto* session = GetSession(info[0].As<Napi::Number>().Int32Value());
    if (!session) return env.Undefined();

    auto tsfn = Napi::ThreadSafeFunction::New(env, info[1].As<Napi::Function>(), "onLocalDescription", 0, 1);
    session->OnLocalDescription([tsfn](const std::string& sdp, const std::string& type) mutable {
        auto* data = new std::pair<std::string, std::string>(sdp, type);
        tsfn.NonBlockingCall(data, [](Napi::Env env, Napi::Function jsCallback, std::pair<std::string, std::string>* data) {
            jsCallback.Call({Napi::String::New(env, data->first), Napi::String::New(env, data->second)});
            delete data;
        });
    });
    return env.Undefined();
}

Napi::Value OnLocalCandidate(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    if (info.Length() < 2 || !info[1].IsFunction()) return env.Undefined();
    auto* session = GetSession(info[0].As<Napi::Number>().Int32Value());
    if (!session) return env.Undefined();

    auto tsfn = Napi::ThreadSafeFunction::New(env, info[1].As<Napi::Function>(), "onLocalCandidate", 0, 1);
    session->OnLocalCandidate([tsfn](const std::string& candidate, const std::string& mid) mutable {
        auto* data = new std::pair<std::string, std::string>(candidate, mid);
        tsfn.NonBlockingCall(data, [](Napi::Env env, Napi::Function jsCallback, std::pair<std::string, std::string>* data) {
            jsCallback.Call({Napi::String::New(env, data->first), Napi::String::New(env, data->second)});
            delete data;
        });
    });
    return env.Undefined();
}

Napi::Value OnStateChange(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    if (info.Length() < 2 || !info[1].IsFunction()) return env.Undefined();
    auto* session = GetSession(info[0].As<Napi::Number>().Int32Value());
    if (!session) return env.Undefined();

    auto tsfn = Napi::ThreadSafeFunction::New(env, info[1].As<Napi::Function>(), "onStateChange", 0, 1);
    session->OnStateChange([tsfn](const std::string& state) mutable {
        auto* data = new std::string(state);
        // NonBlockingCall (não BlockingCall): a thread interna do libdatachannel só enfileira e
        // segue — se bloqueasse esperando o JS terminar, e o JS reagir a "failed" fechando a
        // sessão (pc_->close() tentando parar essa mesma thread), é auto-join/destruição a partir
        // da própria callback → crash reproduzido (ver docs/NATIVE_CAPTURE.md Sprint 22).
        tsfn.NonBlockingCall(data, [](Napi::Env env, Napi::Function jsCallback, std::string* data) {
            jsCallback.Call({Napi::String::New(env, *data)});
            delete data;
        });
    });
    return env.Undefined();
}

Napi::Value OnPliRequest(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    if (info.Length() < 2 || !info[1].IsFunction()) return env.Undefined();
    auto* session = GetSession(info[0].As<Napi::Number>().Int32Value());
    if (!session) return env.Undefined();

    auto tsfn = Napi::ThreadSafeFunction::New(env, info[1].As<Napi::Function>(), "onPliRequest", 0, 1);
    session->OnPliRequest([tsfn]() mutable {
        // NonBlockingCall pelo mesmo motivo do OnStateChange acima — mesma thread interna que
        // recebe RTCP PLI é a que pode acabar bloqueada num pc_->close() em cadeia.
        tsfn.NonBlockingCall([](Napi::Env env, Napi::Function jsCallback) {
            jsCallback.Call({});
        });
    });
    return env.Undefined();
}

Napi::Object Init(Napi::Env env, Napi::Object exports) {
    exports.Set("createSession", Napi::Function::New(env, CreateSession));
    exports.Set("closeSession", Napi::Function::New(env, CloseSession));
    exports.Set("addVideoTrack", Napi::Function::New(env, AddVideoTrack));
    exports.Set("createOffer", Napi::Function::New(env, CreateOffer));
    exports.Set("setRemoteDescription", Napi::Function::New(env, SetRemoteDescription));
    exports.Set("addRemoteCandidate", Napi::Function::New(env, AddRemoteCandidate));
    exports.Set("sendVideoFrame", Napi::Function::New(env, SendVideoFrame));
    exports.Set("isConnected", Napi::Function::New(env, IsConnected));
    exports.Set("onLocalDescription", Napi::Function::New(env, OnLocalDescription));
    exports.Set("onLocalCandidate", Napi::Function::New(env, OnLocalCandidate));
    exports.Set("onStateChange", Napi::Function::New(env, OnStateChange));
    exports.Set("onPliRequest", Napi::Function::New(env, OnPliRequest));
    return exports;
}

NODE_API_MODULE(transport_core, Init)
