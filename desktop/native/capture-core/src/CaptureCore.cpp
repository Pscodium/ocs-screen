#include "CaptureCore.h"
#include <cstring>
#include <windows.h>
#include <dxgi1_2.h>

CaptureCore::CaptureCore() {}

CaptureCore::~CaptureCore() {
    Stop();
}

bool CaptureCore::Initialize() {
    D3D_FEATURE_LEVEL featureLevel;
    HRESULT hr = D3D11CreateDevice(
        nullptr,
        D3D_DRIVER_TYPE_HARDWARE,
        nullptr,
        0,
        nullptr,
        0,
        D3D11_SDK_VERSION,
        device_.GetAddressOf(),
        &featureLevel,
        context_.GetAddressOf());
    if (FAILED(hr)) return false;

    // Pequeno boost de agendamento de GPU (escala -7 a 7, 0 = padrão) pra esse device — sem isso,
    // sob contenção real de GPU (jogo rodando ao mesmo tempo), o driver pode atrasar os comandos
    // de CopyResource da captura atrás dos comandos de renderização do jogo, derrubando o fps de
    // CAPTURA mesmo com AcquireNextFrame retornando rápido (frame pronto, só a cópia é que demora
    // a ser agendada na GPU).
    //
    // NÃO usar o valor máximo (7) aqui — medido em teste: o EncoderCore roda NVENC no MESMO
    // device (mesma prioridade), então captura+encode com prioridade 7 (máxima da escala) ficam
    // ACIMA do processo do jogo (prioridade padrão 0) e literalmente roubam fatia de GPU dele a
    // cada frame — jogo trava/stutter. 1 é o suficiente pra não passar fome sob contenção leve,
    // sem sequestrar o jogo.
    // `SetGPUThreadPriority` não é suportado por todo driver — falha graciosamente sem quebrar a
    // captura (só continua na prioridade padrão do driver).
    ComPtr<IDXGIDevice> dxgiDevice;
    if (SUCCEEDED(device_.As(&dxgiDevice))) {
        dxgiDevice->SetGPUThreadPriority(1);
    }

    return true;
}

std::vector<MonitorInfo> CaptureCore::ListMonitors() {
    std::vector<MonitorInfo> result;
    if (!device_) return result;

    ComPtr<IDXGIDevice> dxgiDevice;
    if (FAILED(device_.As(&dxgiDevice))) return result;

    ComPtr<IDXGIAdapter> adapter;
    if (FAILED(dxgiDevice->GetAdapter(&adapter))) return result;

    UINT index = 0;
    ComPtr<IDXGIOutput> output;
    while (adapter->EnumOutputs(index, output.ReleaseAndGetAddressOf()) != DXGI_ERROR_NOT_FOUND) {
        DXGI_OUTPUT_DESC desc;
        if (SUCCEEDED(output->GetDesc(&desc)) && desc.AttachedToDesktop) {
            MonitorInfo info;
            info.index = static_cast<int>(index);
            info.x = desc.DesktopCoordinates.left;
            info.y = desc.DesktopCoordinates.top;
            info.width = desc.DesktopCoordinates.right - desc.DesktopCoordinates.left;
            info.height = desc.DesktopCoordinates.bottom - desc.DesktopCoordinates.top;
            result.push_back(info);
        }
        index++;
    }
    return result;
}

bool CaptureCore::CreateStagingTexture(int width, int height) {
    D3D11_TEXTURE2D_DESC desc = {};
    desc.Width = width;
    desc.Height = height;
    desc.MipLevels = 1;
    desc.ArraySize = 1;
    desc.Format = DXGI_FORMAT_B8G8R8A8_UNORM;
    desc.SampleDesc.Count = 1;
    desc.Usage = D3D11_USAGE_STAGING;
    desc.CPUAccessFlags = D3D11_CPU_ACCESS_READ;
    desc.BindFlags = 0;

    stagingTexture_.Reset();
    HRESULT hr = device_->CreateTexture2D(&desc, nullptr, stagingTexture_.GetAddressOf());
    if (FAILED(hr)) return false;

    width_ = width;
    height_ = height;
    return true;
}

bool CaptureCore::CreateComposeTexture(int width, int height) {
    D3D11_TEXTURE2D_DESC desc = {};
    desc.Width = width;
    desc.Height = height;
    desc.MipLevels = 1;
    desc.ArraySize = 1;
    desc.Format = DXGI_FORMAT_B8G8R8A8_UNORM;
    desc.SampleDesc.Count = 1;
    // DEFAULT + RENDER_TARGET + GDI_COMPATIBLE (não STAGING) — só uma textura com esses bind
    // flags pode ser aberta como HDC via IDXGISurface1::GetDC, que é como o GDI (DrawIconEx)
    // desenha nela. A leitura pra CPU continua vindo da textura STAGING separada, copiada
    // DEPOIS do cursor já estar composto aqui.
    desc.Usage = D3D11_USAGE_DEFAULT;
    desc.BindFlags = D3D11_BIND_RENDER_TARGET;
    desc.MiscFlags = D3D11_RESOURCE_MISC_GDI_COMPATIBLE;

    composeTexture_.Reset();
    HRESULT hr = device_->CreateTexture2D(&desc, nullptr, composeTexture_.GetAddressOf());
    return SUCCEEDED(hr);
}

// DXGI Desktop Duplication entrega o frame SEM o cursor (o DWM compõe o cursor depois, fora do
// que a duplicação captura) — sem isso, a transmissão nunca mostra onde o mouse está, o que
// quebra completamente casos de uso como suporte remoto/demonstração (CLAUDE.md §Experiência
// esperada). GetCursorInfo()/DrawIconEx() são a forma padrão do Win32 de compor o cursor do
// sistema manualmente numa superfície GDI-compatible.
void CaptureCore::DrawCursorOverlay() {
    CURSORINFO cursorInfo = {};
    cursorInfo.cbSize = sizeof(CURSORINFO);
    if (!GetCursorInfo(&cursorInfo) || !(cursorInfo.flags & CURSOR_SHOWING) || !cursorInfo.hCursor) {
        return;
    }

    ComPtr<IDXGISurface1> surface;
    if (FAILED(composeTexture_.As(&surface))) return;

    HDC dc;
    if (FAILED(surface->GetDC(FALSE, &dc))) return;

    // GetCursorInfo() devolve posição em coordenadas de tela inteira (todos os monitores);
    // originX_/originY_ trazem isso pra coordenada local desse monitor especificamente.
    int drawX = cursorInfo.ptScreenPos.x - originX_;
    int drawY = cursorInfo.ptScreenPos.y - originY_;

    // O ponto de referência do cursor não é o canto superior-esquerdo do ícone (ex.: seta tem o
    // hotspot na ponta, não no centro do bitmap) — sem subtrair o hotspot, o cursor desenhado
    // fica visualmente deslocado da posição real do clique.
    ICONINFO iconInfo;
    if (GetIconInfo(cursorInfo.hCursor, &iconInfo)) {
        drawX -= static_cast<int>(iconInfo.xHotspot);
        drawY -= static_cast<int>(iconInfo.yHotspot);
        if (iconInfo.hbmMask) DeleteObject(iconInfo.hbmMask);
        if (iconInfo.hbmColor) DeleteObject(iconInfo.hbmColor);
    }

    DrawIconEx(dc, drawX, drawY, cursorInfo.hCursor, 0, 0, 0, nullptr, DI_NORMAL);

    surface->ReleaseDC(nullptr);
}

bool CaptureCore::Start(int monitorIndex) {
    if (!device_) return false;

    ComPtr<IDXGIDevice> dxgiDevice;
    if (FAILED(device_.As(&dxgiDevice))) return false;

    ComPtr<IDXGIAdapter> adapter;
    if (FAILED(dxgiDevice->GetAdapter(&adapter))) return false;

    ComPtr<IDXGIOutput> output;
    if (FAILED(adapter->EnumOutputs(static_cast<UINT>(monitorIndex), output.GetAddressOf()))) return false;

    DXGI_OUTPUT_DESC outputDesc;
    if (FAILED(output->GetDesc(&outputDesc))) return false;
    originX_ = outputDesc.DesktopCoordinates.left;
    originY_ = outputDesc.DesktopCoordinates.top;

    ComPtr<IDXGIOutput1> output1;
    if (FAILED(output.As(&output1))) return false;

    duplication_.Reset();
    HRESULT hr = output1->DuplicateOutput(device_.Get(), duplication_.GetAddressOf());
    if (FAILED(hr)) return false;

    DXGI_OUTDUPL_DESC duplDesc;
    duplication_->GetDesc(&duplDesc);
    const int w = static_cast<int>(duplDesc.ModeDesc.Width);
    const int h = static_cast<int>(duplDesc.ModeDesc.Height);
    return CreateStagingTexture(w, h) && CreateComposeTexture(w, h);
}

void CaptureCore::Stop() {
    duplication_.Reset();
    stagingTexture_.Reset();
    composeTexture_.Reset();
    width_ = 0;
    height_ = 0;
    originX_ = 0;
    originY_ = 0;
}

AcquireResult CaptureCore::AcquireFrame(FrameData& outFrame, uint32_t timeoutMs) {
    if (!duplication_) return AcquireResult::Error;

    ComPtr<IDXGIResource> desktopResource;
    DXGI_OUTDUPL_FRAME_INFO frameInfo;

    HRESULT hr = duplication_->AcquireNextFrame(timeoutMs, &frameInfo, desktopResource.ReleaseAndGetAddressOf());
    if (hr == DXGI_ERROR_WAIT_TIMEOUT) {
        return AcquireResult::Timeout;
    }
    if (hr == DXGI_ERROR_ACCESS_LOST) {
        return AcquireResult::AccessLost;
    }
    if (FAILED(hr)) {
        // Falha genérica (não timeout, não access-lost) — confere se o DEVICE inteiro morreu
        // (TDR do driver) antes de devolver um erro "normal". Se morreu, NENHUMA chamada D3D11
        // daqui pra frente é segura (é o caminho mais provável do crash sem log medido sob carga
        // pesada de GPU — ver AcquireResult::DeviceLost).
        if (device_ && FAILED(device_->GetDeviceRemovedReason())) {
            return AcquireResult::DeviceLost;
        }
        return AcquireResult::Error;
    }

    ComPtr<ID3D11Texture2D> acquiredTexture;
    hr = desktopResource.As(&acquiredTexture);
    if (FAILED(hr)) {
        duplication_->ReleaseFrame();
        return AcquireResult::Error;
    }

    // Copia GPU→GPU pra uma textura intermediária GDI-compatible (não direto pra STAGING — GDI
    // não consegue abrir HDC numa textura de staging) pra poder compor o cursor por cima antes de
    // ler os pixels. Um copy extra em troca de o cursor aparecer na transmissão.
    context_->CopyResource(composeTexture_.Get(), acquiredTexture.Get());
    duplication_->ReleaseFrame();

    if (captureCursor_) {
        DrawCursorOverlay();
    }

    // Copia GPU→GPU de novo pra STAGING (a original do WGC/DXGI e a compose texture não dão pra
    // Map() direto) — depois sim GPU→CPU via Map. Dois copies GPU→GPU são baratos comparado ao
    // pipeline instável que o WGC-via-Chromium tem hoje.
    context_->CopyResource(stagingTexture_.Get(), composeTexture_.Get());

    D3D11_MAPPED_SUBRESOURCE mapped;
    hr = context_->Map(stagingTexture_.Get(), 0, D3D11_MAP_READ, 0, &mapped);
    if (FAILED(hr)) {
        return AcquireResult::Error;
    }

    outFrame.width = width_;
    outFrame.height = height_;
    outFrame.pixels.resize(static_cast<size_t>(width_) * static_cast<size_t>(height_) * 4);

    const uint8_t* src = static_cast<const uint8_t*>(mapped.pData);
    uint8_t* dst = outFrame.pixels.data();
    const size_t rowBytes = static_cast<size_t>(width_) * 4;
    for (int y = 0; y < height_; y++) {
        std::memcpy(dst + static_cast<size_t>(y) * rowBytes, src + static_cast<size_t>(y) * mapped.RowPitch, rowBytes);
    }

    context_->Unmap(stagingTexture_.Get(), 0);

    return AcquireResult::Ok;
}

AcquireResult CaptureCore::AcquireFrameGpuOnly(uint32_t timeoutMs) {
    if (!duplication_) return AcquireResult::Error;

    ComPtr<IDXGIResource> desktopResource;
    DXGI_OUTDUPL_FRAME_INFO frameInfo;

    HRESULT hr = duplication_->AcquireNextFrame(timeoutMs, &frameInfo, desktopResource.ReleaseAndGetAddressOf());
    if (hr == DXGI_ERROR_WAIT_TIMEOUT) {
        return AcquireResult::Timeout;
    }
    if (hr == DXGI_ERROR_ACCESS_LOST) {
        return AcquireResult::AccessLost;
    }
    if (FAILED(hr)) {
        // Ver nota igual em AcquireFrame() — device removido precisa parar ANTES de qualquer
        // outra chamada D3D11/NVENC nele.
        if (device_ && FAILED(device_->GetDeviceRemovedReason())) {
            return AcquireResult::DeviceLost;
        }
        return AcquireResult::Error;
    }

    ComPtr<ID3D11Texture2D> acquiredTexture;
    hr = desktopResource.As(&acquiredTexture);
    if (FAILED(hr)) {
        duplication_->ReleaseFrame();
        return AcquireResult::Error;
    }

    context_->CopyResource(composeTexture_.Get(), acquiredTexture.Get());
    duplication_->ReleaseFrame();

    if (captureCursor_) {
        DrawCursorOverlay();
        // `IDXGISurface1::GetDC`/`ReleaseDC` (dentro de DrawCursorOverlay) é interop GDI↔DXGI —
        // não sincroniza sozinho com comandos D3D11 SEGUINTES no mesmo device. Sem esse Flush, o
        // `CopyResource` que o EncoderCore faz logo depois (ler composeTexture_ pro buffer de
        // entrada do NVENC) pode disparar antes do desenho do cursor terminar de ser submetido de
        // verdade na GPU — textura "rasgada" (parte com o desenho, parte sem), que decodifica como
        // um artefato de cor visível (medido em produção: bloco de cor errada, sempre no mesmo
        // instante das micro-engasgadas — mesma causa, dois sintomas). O readback antigo
        // (Map/memcpy, removido por custo) escondia isso de graça porque Map() já força esse
        // mesmo sync como efeito colateral.
        context_->Flush();
    }

    // Sem staging/Map/memcpy — a textura composta (GetComposeTexture()) já é o suficiente pro
    // NVENC ler direto via CopyResource GPU→GPU (EncoderCore::EncodeFrame).
    return AcquireResult::Ok;
}
