#pragma once

#include <d3d11.h>
#include <wrl/client.h>
#include <windows.h>
#include <memory>
#include <cstdint>

using Microsoft::WRL::ComPtr;

enum class WindowAcquireResult {
    Ok,
    // Nenhum frame novo dentro do timeout — normal (janela parada), não é erro.
    Timeout,
    // O `GraphicsCaptureItem` fechou (janela destruída/processo dono morreu) — quem chama precisa
    // parar e voltar pro picker (a janela escolhida não existe mais).
    ItemClosed,
    Error
};

// Captura de UMA janela específica via Windows.Graphics.Capture (WGC) — o "WGC Backend" que
// docs/NATIVE_CAPTURE.md §Backend Abstrato já previa desde o início, ao lado do DXGI Backend
// (`CaptureCore`, monitor inteiro). DXGI Desktop Duplication não consegue isolar uma janela (só
// enxerga o desktop inteiro já composto pelo DWM); WGC é a API que o Windows oferece justamente
// pra isso — é o que o `desktopCapturer` do Electron já usa por baixo dos panos pra janela, só que
// aqui vai direto pro NVENC sem passar pelo pipeline do Chromium.
//
// Mantém seu PRÓPRIO device D3D11 (não compartilha com o device do `CaptureCore` de monitor) — os
// dois nunca capturam ao mesmo tempo (uma transmissão usa monitor OU janela, nunca as duas), então
// não precisam compartilhar nada, e manter separado evita qualquer risco de um afetar o outro.
//
// Implementado via COM "ABI" puro (sem C++/WinRT, sem coroutines) — mesmo estilo `Microsoft::WRL`
// já usado no resto do projeto (CaptureCore usa `ComPtr` do mesmo jeito). Toda a complexidade de
// tipos ABI/WinRT (GraphicsCaptureItem, Direct3D11CaptureFramePool, etc.) fica escondida atrás
// desse header via pimpl — quem inclui esse .h só vê tipos D3D11/Win32 normais.
class WindowCaptureCore {
public:
    WindowCaptureCore();
    ~WindowCaptureCore();

    bool Initialize();

    // `hwnd` é a janela escolhida no SourcePicker — o desktopCapturer não expõe o HWND direto (só
    // um id tipo "window:12345:0"), então quem chama (addon.cpp) extrai o HWND desse id antes.
    bool Start(HWND hwnd);
    void Stop();

    // Espera até `timeoutMs` por um frame novo, copia (GPU→GPU) pra `GetComposeTexture()` — mesmo
    // contrato do `CaptureCore::AcquireFrameGpuOnly` (sem readback CPU, pro EncoderCore ler direto
    // via CopyResource). Frame pool redimensiona sozinho quando a janela muda de tamanho.
    WindowAcquireResult AcquireFrameGpuOnly(uint32_t timeoutMs);

    // Aplica na hora se já tiver sessão ativa (`IGraphicsCaptureSession2::put_IsCursorCaptureEnabled`,
    // só existe a partir do Windows 10 2004+ — QI falhando em builds mais antigos só significa que
    // o cursor sempre vem incluído, sem crash) — e também fica valendo pra próxima `Start()`.
    void SetCaptureCursor(bool enabled);

    ID3D11Device* GetDevice() const { return device_.Get(); }
    ID3D11Texture2D* GetComposeTexture() const { return composeTexture_.Get(); }
    int GetWidth() const { return width_; }
    int GetHeight() const { return height_; }

private:
    struct Impl;
    std::unique_ptr<Impl> impl_;

    ComPtr<ID3D11Device> device_;
    ComPtr<ID3D11DeviceContext> context_;
    ComPtr<ID3D11Texture2D> composeTexture_;
    int width_ = 0;
    int height_ = 0;
    bool captureCursor_ = true;

    bool EnsureComposeTexture(int width, int height);
};
