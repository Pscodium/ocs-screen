// "Jogo" sintético pra testar captura de janela/monitor sob condições de jogo real:
// swap chain D3D11 em flip model (como jogos modernos), limitador de FPS preciso (waitable timer de
// alta resolução, como o frame cap de um jogo), carga de GPU configurável (pixel shader pesado em
// tela cheia) e opção de tela cheia exclusiva. Conteúdo muda todo frame (barras andando + contador
// binário de frame), então todo frame é único — dá pra contar frame perdido na captura.
//
// Uso: gamesim.exe [--fps N] [--load N] [--draws D] [--fullscreen] [--width W --height H] [--seconds S]
//   --fps 0      = sem limite (só vsync)
//   --load N     = iterações TOTAIS do laço do pixel shader por frame (0 = leve; ~4000 já pesa e
//                  ~12000 satura uma RTX 3060 a ~30fps), divididas em D draws
//   --draws D    = em quantos draws a carga é dividida (padrão 64). Jogo real faz centenas de draws
//                  por frame e o escalonador da GPU intercala outros processos entre eles; 1 draw
//                  gigante (--draws 1) é patológico — nada preempta e a captura passa fome.
//   --fullscreen = tela cheia exclusiva (SetFullscreenState)
// Imprime 1x/s no stdout: "gamesim fps=<presentados no último segundo>".
#define NOMINMAX
#include <windows.h>
#include <d3d11.h>
#include <dxgi1_2.h>
#include <d3dcompiler.h>
#include <wrl/client.h>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <string>

#pragma comment(lib, "d3d11.lib")
#pragma comment(lib, "dxgi.lib")
#pragma comment(lib, "d3dcompiler.lib")
#pragma comment(lib, "user32.lib")

using Microsoft::WRL::ComPtr;

static bool g_running = true;

static LRESULT CALLBACK WndProc(HWND hwnd, UINT msg, WPARAM wp, LPARAM lp) {
    if (msg == WM_DESTROY || (msg == WM_KEYDOWN && wp == VK_ESCAPE)) {
        g_running = false;
        PostQuitMessage(0);
        return 0;
    }
    return DefWindowProcW(hwnd, msg, wp, lp);
}

static const char* kShader = R"(
cbuffer Params : register(b0) { float time; uint frame; uint load; float pad; };
float4 vs(uint id : SV_VertexID) : SV_Position {
    float2 uv = float2((id << 1) & 2, id & 2);
    return float4(uv * float2(2, -2) + float2(-1, 1), 0, 1);
}
float4 ps(float4 pos : SV_Position) : SV_Target {
    float2 p = pos.xy;
    float3 c = float3(frac(p.x / 400 + time * 0.5), frac(p.y / 300 + time * 0.3), 0.5 + 0.5 * sin(time * 2));
    // barra vertical andando 8px por frame — cada frame é visualmente único
    if (abs(fmod(p.x - frame * 8.0, 1280.0)) < 40) c = float3(1, 1, 1);
    // contador binário do número do frame no canto (16 bits, quadrados de 24px)
    if (p.y < 24 && p.x < 16 * 24) { uint bit = (uint)(p.x / 24); c = ((frame >> bit) & 1) ? float3(1, 0, 0) : float3(0, 0, 0); }
    float acc = 0;
    for (uint i = 0; i < load; i++) acc += sin(p.x * 0.001 + i) * cos(p.y * 0.001 - i);
    return float4(c + acc * 1e-6, 1);
}
)";

int main(int argc, char** argv) {
    int fps = 60, load = 0, draws = 64, width = 1280, height = 720, seconds = 0;
    bool fullscreen = false;
    for (int i = 1; i < argc; i++) {
        std::string a = argv[i];
        auto next = [&](int& v) { if (i + 1 < argc) v = std::atoi(argv[++i]); };
        if (a == "--fps") next(fps);
        else if (a == "--load") next(load);
        else if (a == "--draws") next(draws);
        else if (a == "--width") next(width);
        else if (a == "--height") next(height);
        else if (a == "--seconds") next(seconds);
        else if (a == "--fullscreen") fullscreen = true;
    }

    WNDCLASSW wc{};
    wc.lpfnWndProc = WndProc;
    wc.hInstance = GetModuleHandleW(nullptr);
    wc.lpszClassName = L"gamesim";
    wc.hCursor = LoadCursor(nullptr, IDC_ARROW);
    RegisterClassW(&wc);
    RECT r{0, 0, width, height};
    AdjustWindowRect(&r, WS_OVERLAPPEDWINDOW, FALSE);
    HWND hwnd = CreateWindowW(L"gamesim", L"gamesim", WS_OVERLAPPEDWINDOW, 60, 60, r.right - r.left, r.bottom - r.top, nullptr, nullptr, wc.hInstance, nullptr);
    ShowWindow(hwnd, SW_SHOW);

    ComPtr<ID3D11Device> device;
    ComPtr<ID3D11DeviceContext> ctx;
    if (FAILED(D3D11CreateDevice(nullptr, D3D_DRIVER_TYPE_HARDWARE, nullptr, 0, nullptr, 0, D3D11_SDK_VERSION, &device, nullptr, &ctx))) return 1;
    ComPtr<IDXGIDevice> dxgiDevice;
    device.As(&dxgiDevice);
    ComPtr<IDXGIAdapter> adapter;
    dxgiDevice->GetAdapter(&adapter);
    ComPtr<IDXGIFactory2> factory;
    adapter->GetParent(IID_PPV_ARGS(&factory));

    DXGI_SWAP_CHAIN_DESC1 sd{};
    sd.Width = width;
    sd.Height = height;
    sd.Format = DXGI_FORMAT_B8G8R8A8_UNORM;
    sd.SampleDesc.Count = 1;
    sd.BufferUsage = DXGI_USAGE_RENDER_TARGET_OUTPUT;
    sd.BufferCount = 2;
    sd.SwapEffect = DXGI_SWAP_EFFECT_FLIP_DISCARD;
    ComPtr<IDXGISwapChain1> swap;
    if (FAILED(factory->CreateSwapChainForHwnd(device.Get(), hwnd, &sd, nullptr, nullptr, &swap))) return 2;
    if (fullscreen) swap->SetFullscreenState(TRUE, nullptr);

    ComPtr<ID3DBlob> vsb, psb, err;
    if (FAILED(D3DCompile(kShader, strlen(kShader), nullptr, nullptr, nullptr, "vs", "vs_5_0", 0, 0, &vsb, &err)) ||
        FAILED(D3DCompile(kShader, strlen(kShader), nullptr, nullptr, nullptr, "ps", "ps_5_0", 0, 0, &psb, &err))) {
        if (err) fprintf(stderr, "%s\n", (const char*)err->GetBufferPointer());
        return 3;
    }
    ComPtr<ID3D11VertexShader> vs;
    ComPtr<ID3D11PixelShader> ps;
    device->CreateVertexShader(vsb->GetBufferPointer(), vsb->GetBufferSize(), nullptr, &vs);
    device->CreatePixelShader(psb->GetBufferPointer(), psb->GetBufferSize(), nullptr, &ps);
    struct Params { float time; UINT frame; UINT load; float pad; };
    D3D11_BUFFER_DESC bd{sizeof(Params), D3D11_USAGE_DEFAULT, D3D11_BIND_CONSTANT_BUFFER};
    ComPtr<ID3D11Buffer> cb;
    device->CreateBuffer(&bd, nullptr, &cb);

    HANDLE timer = CreateWaitableTimerExW(nullptr, nullptr, CREATE_WAITABLE_TIMER_HIGH_RESOLUTION, TIMER_ALL_ACCESS);
    LARGE_INTEGER freq, start, nextFrame, lastReport;
    QueryPerformanceFrequency(&freq);
    QueryPerformanceCounter(&start);
    nextFrame = start;
    lastReport = start;
    const LONGLONG frameTicks = fps > 0 ? freq.QuadPart / fps : 0;
    UINT frame = 0, framesSinceReport = 0;

    while (g_running) {
        MSG msg;
        while (PeekMessageW(&msg, nullptr, 0, 0, PM_REMOVE)) {
            TranslateMessage(&msg);
            DispatchMessageW(&msg);
        }
        if (!g_running) break;

        if (frameTicks) {
            nextFrame.QuadPart += frameTicks;
            LARGE_INTEGER now;
            QueryPerformanceCounter(&now);
            if (nextFrame.QuadPart < now.QuadPart - frameTicks) nextFrame = now; // atrasou muito: reancora
            const LONGLONG waitTicks = nextFrame.QuadPart - now.QuadPart;
            if (waitTicks > 0) {
                LARGE_INTEGER due;
                due.QuadPart = -(waitTicks * 10000000 / freq.QuadPart);
                SetWaitableTimerEx(timer, &due, 0, nullptr, nullptr, nullptr, 0);
                WaitForSingleObject(timer, INFINITE);
            }
        }

        ComPtr<ID3D11Texture2D> back;
        swap->GetBuffer(0, IID_PPV_ARGS(&back));
        ComPtr<ID3D11RenderTargetView> rtv;
        device->CreateRenderTargetView(back.Get(), nullptr, &rtv);
        LARGE_INTEGER now;
        QueryPerformanceCounter(&now);
        const int drawCount = draws > 0 ? draws : 1;
        Params params{static_cast<float>(double(now.QuadPart - start.QuadPart) / freq.QuadPart), frame, static_cast<UINT>(load / drawCount), 0};
        ctx->UpdateSubresource(cb.Get(), 0, nullptr, &params, 0, 0);
        D3D11_VIEWPORT vp{0, 0, float(width), float(height), 0, 1};
        ctx->RSSetViewports(1, &vp);
        ctx->OMSetRenderTargets(1, rtv.GetAddressOf(), nullptr);
        ctx->IASetPrimitiveTopology(D3D11_PRIMITIVE_TOPOLOGY_TRIANGLELIST);
        ctx->VSSetShader(vs.Get(), nullptr, 0);
        ctx->PSSetShader(ps.Get(), nullptr, 0);
        ctx->PSSetConstantBuffers(0, 1, cb.GetAddressOf());
        for (int d = 0; d < drawCount; d++) ctx->Draw(3, 0);
        swap->Present(fps > 0 ? 0 : 1, 0);
        frame++;
        framesSinceReport++;

        if (now.QuadPart - lastReport.QuadPart >= freq.QuadPart) {
            printf("gamesim fps=%u\n", framesSinceReport);
            fflush(stdout);
            framesSinceReport = 0;
            lastReport = now;
            if (seconds > 0 && double(now.QuadPart - start.QuadPart) / freq.QuadPart >= seconds) g_running = false;
        }
    }
    if (fullscreen) swap->SetFullscreenState(FALSE, nullptr);
    return 0;
}
