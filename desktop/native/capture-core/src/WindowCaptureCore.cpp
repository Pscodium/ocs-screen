#include "WindowCaptureCore.h"

#define NOMINMAX
#include <windows.h>
#include <roapi.h>
#include <inspectable.h>
#include <wrl/client.h>
#include <wrl/implements.h>
#include <wrl/wrappers/corewrappers.h>
// windows.graphics.capture.h só FORWARD-DECLARA `SizeInt32`/`DirectXPixelFormat` (assume que quem
// inclui já trouxe a definição completa de antes).
#include <windows.graphics.h>
#include <windows.graphics.directx.h>
#include <windows.graphics.capture.h>
#include <windows.graphics.capture.interop.h>
#include <windows.graphics.directx.direct3d11.h>
#include <windows.graphics.directx.direct3d11.interop.h>
#include <dxgi1_2.h>
#include <mutex>
#include <condition_variable>
#include <atomic>

using namespace Microsoft::WRL;
using namespace Microsoft::WRL::Wrappers;
using namespace ABI::Windows::Graphics;
using namespace ABI::Windows::Graphics::Capture;
using namespace ABI::Windows::Graphics::DirectX;
using namespace ABI::Windows::Graphics::DirectX::Direct3D11;

namespace {

// Handler de `Direct3D11CaptureFramePool::FrameArrived` — dispara numa thread própria do WGC
// (não a thread do Node/Electron), então só faz o mínimo (copia o ponteiro COM da textura +
// acorda quem tá esperando) — nenhuma chamada de D3D11 acontece aqui, só no lado que chama
// `AcquireFrameGpuOnly` (thread JS), pra não ter dois lados mexendo no mesmo `ID3D11DeviceContext`
// ao mesmo tempo sem sincronização.
// `FtmBase` (Free-Threaded Marshaler) é obrigatório aqui — `add_FrameArrived` recusa o handler com
// `RO_E_MUST_BE_AGILE` (0x8000001C) sem ele: o evento dispara de uma thread MTA interna do WGC,
// então o WinRT exige que o delegate seja "agile" (chamável de qualquer apartment sem marshaling).
class FrameArrivedHandler final
    : public RuntimeClass<RuntimeClassFlags<ClassicCom>,
                          __FITypedEventHandler_2_Windows__CGraphics__CCapture__CDirect3D11CaptureFramePool_IInspectable,
                          FtmBase> {
public:
    std::mutex mutex;
    std::condition_variable cv;
    bool hasNewFrame = false;
    bool closed = false;
    ComPtr<ID3D11Texture2D> pendingTexture;
    int pendingWidth = 0;
    int pendingHeight = 0;
    // Preenchido pelo WindowCaptureCore antes de iniciar — necessário pra dar `Recreate()` no
    // frame pool quando a janela muda de tamanho (`ContentSize` do frame difere do tamanho que o
    // pool foi criado).
    IDirect3DDevice* winrtDevice = nullptr;
    int poolWidth = 0;
    int poolHeight = 0;

    HRESULT STDMETHODCALLTYPE Invoke(IDirect3D11CaptureFramePool* sender, IInspectable*) override {
        ComPtr<IDirect3D11CaptureFrame> frame;
        if (FAILED(sender->TryGetNextFrame(&frame)) || !frame) return S_OK;

        SizeInt32 contentSize{};
        frame->get_ContentSize(&contentSize);

        if (contentSize.Width != poolWidth || contentSize.Height != poolHeight) {
            // Janela redimensionou — recria o pool no tamanho novo. O frame atual (do tamanho
            // antigo) é descartado; o próximo FrameArrived já chega no tamanho certo.
            poolWidth = contentSize.Width;
            poolHeight = contentSize.Height;
            SizeInt32 newSize{contentSize.Width, contentSize.Height};
            sender->Recreate(winrtDevice, DirectXPixelFormat_B8G8R8A8UIntNormalized, 2, newSize);
            return S_OK;
        }

        ComPtr<IDirect3DSurface> surface;
        if (FAILED(frame->get_Surface(&surface))) return S_OK;

        ComPtr<Windows::Graphics::DirectX::Direct3D11::IDirect3DDxgiInterfaceAccess> access;
        if (FAILED(surface.As(&access))) return S_OK;

        ComPtr<ID3D11Texture2D> texture;
        if (FAILED(access->GetInterface(IID_PPV_ARGS(&texture)))) return S_OK;

        {
            std::lock_guard<std::mutex> lock(mutex);
            pendingTexture = texture;
            pendingWidth = contentSize.Width;
            pendingHeight = contentSize.Height;
            hasNewFrame = true;
        }
        cv.notify_one();
        return S_OK;
    }
};

// Handler de `GraphicsCaptureItem::Closed` — dispara quando a janela capturada é destruída (app
// fechado) ou o processo dono morre. Depois disso a sessão inteira não presta mais pra nada; só
// sinaliza quem tá esperando em `AcquireFrameGpuOnly` pra parar de esperar frame que nunca mais vem.
class ItemClosedHandler final
    : public RuntimeClass<RuntimeClassFlags<ClassicCom>,
                          __FITypedEventHandler_2_Windows__CGraphics__CCapture__CGraphicsCaptureItem_IInspectable,
                          FtmBase> {
public:
    // Ponteiro cru de propósito — o dono real é o `ComPtr<FrameArrivedHandler>` em
    // `Impl::frameHandler`, que vive (no mínimo) tanto quanto esse handler (os dois morrem juntos
    // quando `Impl` é destruído em `Stop()`).
    FrameArrivedHandler* target = nullptr;

    HRESULT STDMETHODCALLTYPE Invoke(IGraphicsCaptureItem*, IInspectable*) override {
        if (target) {
            std::lock_guard<std::mutex> lock(target->mutex);
            target->closed = true;
            target->cv.notify_all();
        }
        return S_OK;
    }
};

} // namespace

struct WindowCaptureCore::Impl {
    ComPtr<IGraphicsCaptureItem> item;
    ComPtr<IDirect3D11CaptureFramePool> framePool;
    ComPtr<IGraphicsCaptureSession> session;
    ComPtr<IDirect3DDevice> winrtDevice;
    ComPtr<FrameArrivedHandler> frameHandler;
    ComPtr<ItemClosedHandler> closedHandler;
    EventRegistrationToken frameArrivedToken{};
    EventRegistrationToken closedToken{};
    bool started = false;
};

// `RoInitialize` é por-thread e por-processo (referência contada internamente pelo COM) — chamado
// uma vez só, nunca desfeito (`RoUninitialize`) de propósito: `Start()`/`Stop()` podem acontecer
// várias vezes na vida do processo (uma transmissão por vez), e não vale o risco de desinicializar
// WinRT enquanto outra parte do Electron ainda possa depender de COM inicializado nessa thread.
// Liberado de qualquer forma quando o processo termina.
static std::atomic<bool> g_roInitialized{false};

static bool EnsureRoInitialized() {
    if (g_roInitialized.exchange(true)) return true;
    HRESULT hr = RoInitialize(RO_INIT_MULTITHREADED);
    // S_OK = inicializou agora. S_FALSE = já tava inicializado (conta como sucesso).
    // RPC_E_CHANGED_MODE = já tem COM inicializado nessa thread num apartment diferente (STA) —
    // ainda assim utilizável pra RoGetActivationFactory/CreateForWindow, que não exigem MTA.
    return hr == S_OK || hr == S_FALSE || hr == RPC_E_CHANGED_MODE;
}

WindowCaptureCore::WindowCaptureCore() {}
WindowCaptureCore::~WindowCaptureCore() {
    Stop();
}

bool WindowCaptureCore::Initialize() {
    if (!EnsureRoInitialized()) return false;

    D3D_FEATURE_LEVEL featureLevel;
    // `D3D11_CREATE_DEVICE_BGRA_SUPPORT` é exigido pelo WGC — o device usado pra criar o
    // `Direct3D11CaptureFramePool` precisa suportar superfícies BGRA compatíveis com Direct2D/WinRT
    // (sem essa flag, `CreateDirect3D11DeviceFromDXGIDevice` funciona, mas o frame pool falha).
    UINT flags = D3D11_CREATE_DEVICE_BGRA_SUPPORT;
    HRESULT hr = D3D11CreateDevice(
        nullptr,
        D3D_DRIVER_TYPE_HARDWARE,
        nullptr,
        flags,
        nullptr,
        0,
        D3D11_SDK_VERSION,
        device_.GetAddressOf(),
        &featureLevel,
        context_.GetAddressOf());
    if (FAILED(hr)) return false;

    // Mesmo boost de agendamento de GPU que o `CaptureCore` (monitor/DXGI) já tem desde a Fase 1
    // — sem isso, sob jogo 3D pesado competindo pela mesma GPU, os comandos de captura/encode
    // desse device podiam ficar atrás dos comandos de renderização do jogo na fila do driver,
    // derrubando o fps de captura mesmo com frame novo disponível no WGC. 1 (não o máximo 7) —
    // mesmo motivo já documentado em CaptureCore::Initialize: prioridade máxima rouba fatia de GPU
    // do jogo, prioridade 1 só evita passar fome sob contenção leve.
    ComPtr<IDXGIDevice> dxgiDevice;
    if (SUCCEEDED(device_.As(&dxgiDevice))) {
        dxgiDevice->SetGPUThreadPriority(1);
    }

    return true;
}

bool WindowCaptureCore::EnsureComposeTexture(int width, int height) {
    if (composeTexture_ && width_ == width && height_ == height) return true;

    D3D11_TEXTURE2D_DESC desc = {};
    desc.Width = static_cast<UINT>(width);
    desc.Height = static_cast<UINT>(height);
    desc.MipLevels = 1;
    desc.ArraySize = 1;
    desc.Format = DXGI_FORMAT_B8G8R8A8_UNORM;
    desc.SampleDesc.Count = 1;
    desc.Usage = D3D11_USAGE_DEFAULT;
    desc.BindFlags = D3D11_BIND_RENDER_TARGET | D3D11_BIND_SHADER_RESOURCE;

    composeTexture_.Reset();
    HRESULT hr = device_->CreateTexture2D(&desc, nullptr, composeTexture_.GetAddressOf());
    if (FAILED(hr)) return false;

    width_ = width;
    height_ = height;
    return true;
}

bool WindowCaptureCore::Start(HWND hwnd) {
    // Janela minimizada reporta um `GraphicsCaptureItem::Size` de ~160×28 (retângulo de ícone da
    // barra de tarefas, não o tamanho restaurado real) — passaria pela checagem de size>0 mais
    // abaixo e capturaria um vídeo minúsculo sem erro nenhum. Recusa aqui, antes de gastar
    // qualquer chamada WGC.
    if (!device_ || !IsWindow(hwnd) || IsIconic(hwnd)) return false;

    Stop();
    impl_ = std::make_unique<Impl>();

    ComPtr<IDXGIDevice> dxgiDevice;
    if (FAILED(device_.As(&dxgiDevice))) {
        impl_.reset();
        return false;
    }

    ComPtr<IInspectable> inspectableDevice;
    if (FAILED(CreateDirect3D11DeviceFromDXGIDevice(dxgiDevice.Get(), &inspectableDevice))) {
        impl_.reset();
        return false;
    }
    if (FAILED(inspectableDevice.As(&impl_->winrtDevice))) {
        impl_.reset();
        return false;
    }

    ComPtr<IGraphicsCaptureItemInterop> interopFactory;
    if (FAILED(RoGetActivationFactory(
            HStringReference(RuntimeClass_Windows_Graphics_Capture_GraphicsCaptureItem).Get(),
            IID_PPV_ARGS(&interopFactory)))) {
        impl_.reset();
        return false;
    }
    if (FAILED(interopFactory->CreateForWindow(hwnd, IID_PPV_ARGS(&impl_->item)))) {
        // Falha esperada pra janelas não capturáveis (ex.: já fechada, sem permissão, ou o
        // Windows recusa por política) — quem chama mostra erro e volta pro picker.
        impl_.reset();
        return false;
    }

    // Tamanho pequeno demais (ex.: janela MINIMIZADA — Windows reporta um retângulo de ícone tipo
    // 160×28 em vez do tamanho real restaurado) não é exatamente um erro, mas não faz sentido
    // como transmissão — quem chama trata esse `false` como "escolhe outra janela" (mesma UX de
    // qualquer fonte não capturável). Confirmado testando com janela minimizada de verdade.
    SizeInt32 size{};
    impl_->item->get_Size(&size);
    if (size.Width <= 0 || size.Height <= 0) {
        impl_.reset();
        return false;
    }

    ComPtr<IDirect3D11CaptureFramePoolStatics2> framePoolStatics2;
    if (FAILED(RoGetActivationFactory(
            HStringReference(RuntimeClass_Windows_Graphics_Capture_Direct3D11CaptureFramePool).Get(),
            IID_PPV_ARGS(&framePoolStatics2)))) {
        impl_.reset();
        return false;
    }

    if (FAILED(framePoolStatics2->CreateFreeThreaded(
            impl_->winrtDevice.Get(), DirectXPixelFormat_B8G8R8A8UIntNormalized, 2, size, &impl_->framePool))) {
        impl_.reset();
        return false;
    }

    impl_->frameHandler = Make<FrameArrivedHandler>();
    impl_->frameHandler->winrtDevice = impl_->winrtDevice.Get();
    impl_->frameHandler->poolWidth = size.Width;
    impl_->frameHandler->poolHeight = size.Height;

    if (FAILED(impl_->framePool->add_FrameArrived(impl_->frameHandler.Get(), &impl_->frameArrivedToken))) {
        impl_.reset();
        return false;
    }

    impl_->closedHandler = Make<ItemClosedHandler>();
    impl_->closedHandler->target = impl_->frameHandler.Get();
    impl_->item->add_Closed(impl_->closedHandler.Get(), &impl_->closedToken);

    if (FAILED(impl_->framePool->CreateCaptureSession(impl_->item.Get(), &impl_->session))) {
        impl_.reset();
        return false;
    }

    SetCaptureCursor(captureCursor_);

    if (FAILED(impl_->session->StartCapture())) {
        impl_.reset();
        return false;
    }

    impl_->started = true;
    return EnsureComposeTexture(size.Width, size.Height);
}

// Propriedade da SESSÃO (`IGraphicsCaptureSession2`, Windows 10 2004+) — diferente do
// `CaptureCore` de monitor (onde o cursor é desenhado manualmente via GDI a cada frame,
// `DrawCursorOverlay`), aqui é o WGC quem compõe o cursor sozinho quando ligado. Chamável a
// qualquer momento (sessão ativa ou não) — `captureCursor_` sempre guarda a preferência atual pra
// próxima `Start()`; se já tiver sessão rodando, aplica na hora também (pedido do usuário: o
// toggle "Mostrar cursor" não tinha efeito nenhum no meio de uma transmissão de janela).
void WindowCaptureCore::SetCaptureCursor(bool enabled) {
    captureCursor_ = enabled;
    if (!impl_ || !impl_->session) return;
    ComPtr<IGraphicsCaptureSession2> session2;
    if (SUCCEEDED(impl_->session.As(&session2))) {
        session2->put_IsCursorCaptureEnabled(enabled ? TRUE : FALSE);
    }
    // QI falhando é normal em builds mais antigos que o Windows 10 2004 — só significa que o
    // cursor sempre vem incluído (comportamento padrão do WGC antes dessa API existir), sem
    // crash, sem efeito no resto da captura.
}

void WindowCaptureCore::Stop() {
    impl_.reset();
    composeTexture_.Reset();
    width_ = 0;
    height_ = 0;
}

WindowAcquireResult WindowCaptureCore::AcquireFrameGpuOnly(uint32_t timeoutMs) {
    if (!impl_ || !impl_->started) return WindowAcquireResult::Error;

    ComPtr<ID3D11Texture2D> texture;
    int w = 0, h = 0;
    {
        std::unique_lock<std::mutex> lock(impl_->frameHandler->mutex);
        bool got = impl_->frameHandler->cv.wait_for(lock, std::chrono::milliseconds(timeoutMs), [this] {
            return impl_->frameHandler->hasNewFrame || impl_->frameHandler->closed;
        });
        if (impl_->frameHandler->closed) return WindowAcquireResult::ItemClosed;
        if (!got) return WindowAcquireResult::Timeout;

        texture = impl_->frameHandler->pendingTexture;
        w = impl_->frameHandler->pendingWidth;
        h = impl_->frameHandler->pendingHeight;
        impl_->frameHandler->hasNewFrame = false;
    }

    if (!texture) return WindowAcquireResult::Timeout;
    if (!EnsureComposeTexture(w, h)) return WindowAcquireResult::Error;

    context_->CopyResource(composeTexture_.Get(), texture.Get());
    return WindowAcquireResult::Ok;
}
