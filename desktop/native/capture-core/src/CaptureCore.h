#pragma once

#include <d3d11.h>
#include <dxgi1_2.h>
#include <wrl/client.h>
#include <vector>
#include <string>
#include <cstdint>

using Microsoft::WRL::ComPtr;

struct MonitorInfo {
    int index;
    int x;
    int y;
    int width;
    int height;
};

struct FrameData {
    int width = 0;
    int height = 0;
    // BGRA, width*height*4 bytes, row-major, sem padding — já compactado a partir do RowPitch
    // real da textura (que pode ter padding de alinhamento diferente da largura visível).
    std::vector<uint8_t> pixels;
};

enum class AcquireResult {
    Ok,
    // Nenhum frame novo dentro do timeout — normal (tela parada), não é erro.
    Timeout,
    // DXGI_ERROR_ACCESS_LOST — a sessão de duplicação morreu (troca de resolução, UAC, GPU
    // resetou). Quem chama precisa Stop() + Start() de novo.
    AccessLost,
    Error
};

// Captura de tela via DXGI Desktop Duplication + Direct3D 11 — alternativa ao WGC que o
// Electron/Chromium usa por padrão via desktopCapturer. Ver docs/NATIVE_CAPTURE.md.
class CaptureCore {
public:
    CaptureCore();
    ~CaptureCore();

    bool Initialize();
    std::vector<MonitorInfo> ListMonitors();
    bool Start(int monitorIndex);
    void Stop();
    AcquireResult AcquireFrame(FrameData& outFrame, uint32_t timeoutMs);
    void SetCaptureCursor(bool enabled) { captureCursor_ = enabled; }

    // Pra o EncoderCore (NVENC) codificar direto da GPU sem passar pela CPU — precisa do MESMO
    // device (não pode misturar recursos entre devices D3D11 diferentes) e da textura já composta
    // (com cursor desenhado) do último AcquireFrame bem-sucedido.
    ID3D11Device* GetDevice() const { return device_.Get(); }
    ID3D11Texture2D* GetComposeTexture() const { return composeTexture_.Get(); }
    int GetWidth() const { return width_; }
    int GetHeight() const { return height_; }

private:
    ComPtr<ID3D11Device> device_;
    ComPtr<ID3D11DeviceContext> context_;
    ComPtr<IDXGIOutputDuplication> duplication_;
    ComPtr<ID3D11Texture2D> stagingTexture_;
    // Textura intermediária GDI-compatible (D3D11_RESOURCE_MISC_GDI_COMPATIBLE) — DXGI Desktop
    // Duplication não desenha o cursor no frame por padrão (é composto pelo DWM depois da captura
    // acontecer). Compõe o cursor aqui via GDI (GetDC/DrawIconEx) antes de copiar pra staging.
    ComPtr<ID3D11Texture2D> composeTexture_;
    int width_ = 0;
    int height_ = 0;
    // Canto superior-esquerdo do monitor em coordenadas de tela inteira (multi-monitor) — cursor
    // vem de GetCursorInfo() em coordenadas globais, precisa desse offset pra virar coordenada
    // local da textura capturada.
    int originX_ = 0;
    int originY_ = 0;
    // Ligado por padrão — usuário pode desligar via configurações (algumas capturas, ex.
    // demonstração de vídeo/apresentação estática, não querem o cursor piscando no meio).
    bool captureCursor_ = true;

    bool CreateStagingTexture(int width, int height);
    bool CreateComposeTexture(int width, int height);
    void DrawCursorOverlay();
};
