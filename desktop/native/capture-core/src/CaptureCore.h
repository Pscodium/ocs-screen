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
    // resetou mas o DEVICE em si sobreviveu). Quem chama precisa Stop() + Start() de novo.
    AccessLost,
    // O DEVICE D3D11 inteiro morreu (TDR do driver, "Timeout Detection and Recovery" — comum sob
    // contenção pesada de GPU: jogo 3D + nossa captura+NVENC disputando a mesma GPU). Diferente
    // de AccessLost: aqui NENHUMA chamada D3D11/NVENC nesse device é segura — continuar chamando
    // CopyResource/EncodeFrame num device removido é o caminho mais provável do crash sem stack
    // trace nenhum medido em produção (jogando Rocket League, processo inteiro sumiu sem log).
    // Recuperar de verdade exigiria recriar TODO o pipeline (device, duplication, encoder) do
    // zero — fora de escopo por ora; por enquanto só para com segurança em vez de arriscar crash.
    DeviceLost,
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
    // Mesma captura, SEM o readback GPU→CPU (Map+memcpy de um frame inteiro, ~8MB em 1080p) — pro
    // caminho de transporte nativo, que só precisa da textura já composta (GetComposeTexture())
    // pro NVENC ler direto da GPU. Esse readback era puro desperdício nesse caminho, e o `Map()`
    // pode dar stall esperando a GPU quando ela também tá ocupada codificando (medido em produção:
    // taxa de loop caindo sob movimento de tela — ver StreamWorker.cpp).
    AcquireResult AcquireFrameGpuOnly(uint32_t timeoutMs);
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
