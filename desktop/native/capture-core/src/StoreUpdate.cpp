// Atualização pela Microsoft Store DE DENTRO do app (Windows.Services.Store.StoreContext) — a API
// oficial de "in-app update" pra apps da Store, permitida pela política (diferente de self-update
// via electron-updater, que é proibido). Antes o app só abria a Store em "Downloads e
// atualizações" e o usuário tinha que achar e clicar em atualizar; agora o próprio app pergunta
// à Store se tem pacote novo e pede o download+instalação (o Windows mostra um diálogo de
// confirmação dele, e reinicia o app no fim — ver RegisterApplicationRestart abaixo).
//
// Ref.: https://learn.microsoft.com/windows/uwp/packaging/self-install-package-updates
// App desktop (MSIX/Desktop Bridge) precisa de IInitializeWithWindow com o HWND da janela pros
// diálogos da Store terem dono.
//
// C++/WinRT (headers do Windows SDK) só neste arquivo — o resto do addon usa WRL. `.get()` em
// operação assíncrona não pode rodar numa thread STA (a do Node é), por isso tudo roda nas
// threads do libuv via AsyncWorker, entrando no MTA.

#include <Unknwn.h>
#include <windows.h>
#include <shobjidl.h>

#include <winrt/Windows.Foundation.h>
#include <winrt/Windows.Foundation.Collections.h>
#include <winrt/Windows.Services.Store.h>

#include <napi.h>
#include <string>

using namespace winrt::Windows::Services::Store;
using winrt::Windows::Foundation::Collections::IVectorView;

namespace {

void EnterMta() {
    try {
        winrt::init_apartment(winrt::apartment_type::multi_threaded);
    } catch (...) {
        // já inicializado nessa thread (pool do libuv é reaproveitado) — tudo bem
    }
}

StoreContext ContextFor(uint64_t hwnd) {
    StoreContext ctx = StoreContext::GetDefault();
    if (hwnd) {
        auto init = ctx.as<::IInitializeWithWindow>();
        winrt::check_hresult(init->Initialize(reinterpret_cast<HWND>(hwnd)));
    }
    return ctx;
}

std::string ErrorText(const winrt::hresult_error& e) {
    char hex[16];
    snprintf(hex, sizeof(hex), "0x%08X", static_cast<uint32_t>(e.code()));
    return std::string("store ") + hex + ": " + winrt::to_string(e.message());
}

class CheckWorker : public Napi::AsyncWorker {
public:
    CheckWorker(Napi::Env env, uint64_t hwnd) : Napi::AsyncWorker(env), hwnd_(hwnd), deferred_(Napi::Promise::Deferred::New(env)) {}
    Napi::Promise Promise() { return deferred_.Promise(); }

    void Execute() override {
        EnterMta();
        try {
            auto ctx = ContextFor(hwnd_);
            IVectorView<StorePackageUpdate> updates = ctx.GetAppAndOptionalStorePackageUpdatesAsync().get();
            count_ = updates.Size();
            for (auto const& u : updates) mandatory_ = mandatory_ || u.Mandatory();
        } catch (const winrt::hresult_error& e) {
            SetError(ErrorText(e));
        } catch (...) {
            SetError("store: exceção desconhecida");
        }
    }
    void OnOK() override {
        auto obj = Napi::Object::New(Env());
        obj.Set("count", Napi::Number::New(Env(), count_));
        obj.Set("mandatory", Napi::Boolean::New(Env(), mandatory_));
        deferred_.Resolve(obj);
    }
    void OnError(const Napi::Error& e) override { deferred_.Reject(e.Value()); }

private:
    uint64_t hwnd_;
    uint32_t count_ = 0;
    bool mandatory_ = false;
    Napi::Promise::Deferred deferred_;
};

class InstallWorker : public Napi::AsyncProgressQueueWorker<double> {
public:
    InstallWorker(Napi::Env env, uint64_t hwnd, Napi::Function onProgress)
        : Napi::AsyncProgressQueueWorker<double>(env), hwnd_(hwnd), deferred_(Napi::Promise::Deferred::New(env)) {
        if (!onProgress.IsEmpty()) progressCb_ = Napi::Persistent(onProgress);
    }
    Napi::Promise Promise() { return deferred_.Promise(); }

    void Execute(const ExecutionProgress& progress) override {
        EnterMta();
        try {
            auto ctx = ContextFor(hwnd_);
            auto updates = ctx.GetAppAndOptionalStorePackageUpdatesAsync().get();
            if (updates.Size() == 0) {
                state_ = "no_updates";
                return;
            }
            // O Windows fecha o app pra trocar o pacote; isso faz ele abrir de novo depois.
            RegisterApplicationRestart(L"--after-store-update", 0);
            auto op = ctx.RequestDownloadAndInstallStorePackageUpdatesAsync(updates);
            op.Progress([&progress](auto const&, StorePackageUpdateStatus const& s) {
                double p = s.TotalDownloadProgress;  // 0..1 (download + instalação)
                progress.Send(&p, 1);
            });
            StorePackageUpdateResult result = op.get();
            switch (result.OverallState()) {
                case StorePackageUpdateState::Completed: state_ = "completed"; break;
                case StorePackageUpdateState::Canceled: state_ = "canceled"; break;
                case StorePackageUpdateState::OtherError: state_ = "other_error"; break;
                case StorePackageUpdateState::ErrorLowBattery: state_ = "low_battery"; break;
                case StorePackageUpdateState::ErrorWiFiRecommended: state_ = "wifi_recommended"; break;
                case StorePackageUpdateState::ErrorWiFiRequired: state_ = "wifi_required"; break;
                default: state_ = "pending"; break;
            }
        } catch (const winrt::hresult_error& e) {
            SetError(ErrorText(e));
        } catch (...) {
            SetError("store: exceção desconhecida");
        }
    }
    void OnProgress(const double* data, size_t count) override {
        if (!count || progressCb_.IsEmpty()) return;
        progressCb_.Call({Napi::Number::New(Env(), data[count - 1])});
    }
    void OnOK() override { deferred_.Resolve(Napi::String::New(Env(), state_)); }
    void OnError(const Napi::Error& e) override { deferred_.Reject(e.Value()); }

private:
    uint64_t hwnd_;
    std::string state_ = "unknown";
    Napi::FunctionReference progressCb_;
    Napi::Promise::Deferred deferred_;
};

uint64_t HwndArg(const Napi::CallbackInfo& info) {
    if (info.Length() < 1 || !info[0].IsNumber()) return 0;
    return static_cast<uint64_t>(info[0].As<Napi::Number>().Int64Value());
}

}  // namespace

// storeCheckUpdates(hwnd): Promise<{count, mandatory}>
Napi::Value StoreCheckUpdates(const Napi::CallbackInfo& info) {
    auto* w = new CheckWorker(info.Env(), HwndArg(info));
    auto p = w->Promise();
    w->Queue();
    return p;
}

// storeInstallUpdates(hwnd, onProgress(0..1)): Promise<"completed"|"canceled"|"no_updates"|...>
Napi::Value StoreInstallUpdates(const Napi::CallbackInfo& info) {
    Napi::Function cb = info.Length() > 1 && info[1].IsFunction() ? info[1].As<Napi::Function>() : Napi::Function();
    auto* w = new InstallWorker(info.Env(), HwndArg(info), cb);
    auto p = w->Promise();
    w->Queue();
    return p;
}
