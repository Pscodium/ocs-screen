#pragma once

#include <windows.h>
#include <mmdeviceapi.h>
#include <audioclient.h>
#include <audioclientactivationparams.h>
#include <string>
#include <vector>
#include <cstdint>
#include <atomic>
#include <opus.h>

// Captura de áudio "de sistema" pro pipeline nativo (DXGI/WGC→NVENC→libdatachannel, ver
// docs/NATIVE_CAPTURE.md). Não existia NENHUM áudio nesse caminho até aqui — só o caminho LiveKit
// tinha (loopback do dispositivo padrão inteiro, via getDisplayMedia do Chromium).
//
// Usa a API de "process loopback" do Windows (10 2004+, `AUDIOCLIENT_ACTIVATION_TYPE_PROCESS_LOOPBACK`)
// em vez do loopback de dispositivo inteiro — permite EXCLUIR a árvore de processos de 1 app
// específico do que é capturado (`PROCESS_LOOPBACK_MODE_EXCLUDE_TARGET_PROCESS_TREE`), pedido
// direto do usuário: excluir o Discord (ele já está na call, ouviria a própria voz 2x se o áudio
// dele saísse pela transmissão também). O `TargetProcessId` é sempre necessário mesmo em modo
// EXCLUDE (a API não aceita "exclua ninguém" — se não tiver processo pra excluir, cai pro loopback
// de dispositivo inteiro normal via `Initialize` sem exclusão, ver `InitializeDeviceLoopback`).
//
// "Retorno do microfone" (2º pedido do usuário) NÃO é resolvido por essa API: loopback captura
// SAÍDA (alto-falante), microfone é ENTRADA — só apareceria misturado na saída se o usuário tiver
// "Escutar este dispositivo" ligado no mic (monitoramento), o que é uma configuração de mixer do
// Windows, não um processo específico pra excluir. Não implementado aqui — documentado como fora
// do alcance dessa técnica (ver docs/TASKS.md).
class AudioCaptureCore {
public:
    AudioCaptureCore();
    ~AudioCaptureCore();

    // `excludeProcessId` = 0 significa "sem exclusão" (loopback de dispositivo padrão normal,
    // caminho mais simples e mais testado). Qualquer valor != 0 ativa o modo
    // process-loopback+exclude (Discord, tipicamente resolvido via FindProcessIdByName). Usado no
    // caminho de MONITOR (compartilha a tela inteira, então só faz sentido EXCLUIR 1 app
    // específico, não incluir só 1 — senão o resto do sistema ficaria mudo).
    bool Initialize(DWORD excludeProcessId);

    // Caminho de JANELA (WGC) — pedido do usuário: isolar só o áudio do APP EM DESTAQUE (a janela
    // sendo compartilhada), não o sistema inteiro. Resolve o processo DONO da janela a partir do
    // HWND (`GetWindowThreadProcessId`), acha a RAIZ da árvore dele (mesmo processo multi-processo
    // que `FindProcessIdByName` já trata — reaproveitado aqui via o nome do executável resolvido)
    // e ativa em modo INCLUDE (`PROCESS_LOOPBACK_MODE_INCLUDE_TARGET_PROCESS_TREE`) — captura SÓ
    // aquela árvore de processos, todo o resto do sistema fica de fora automaticamente (Discord
    // incluído, sem precisar de exclusão nenhuma nesse caminho).
    bool InitializeForWindow(HWND hwnd);

    void Shutdown();

    // Puxa todo PCM disponível do WASAPI (não bloqueia — se não tiver nada novo, não faz nada),
    // acumula num buffer interno e codifica em pacotes Opus de 20ms (960 amostras/canal @48kHz)
    // sempre que o buffer acumulado alcança esse tamanho. Pode gerar 0, 1 ou vários pacotes numa
    // única chamada (ex.: se o polling do loop JS atrasar um pouco). Chamado do mesmo loop
    // `setImmediate` que já poll a captura de vídeo (main/index.ts) — sem thread própria, mesmo
    // estilo do resto do addon.
    std::vector<std::vector<uint8_t>> PollEncodedPackets();

    bool IsActive() const { return audioClient_ != nullptr; }

    // Amplitude média (RMS) do PCM cru capturado desde a última chamada — só pra diagnóstico
    // (validar de verdade se a exclusão por processo tá funcionando, comparando com/sem exclusão
    // enquanto uma fonte conhecida toca), não usado no caminho de produção.
    float LastRms() const { return lastRms_; }

    // Acha o PID de um processo pelo nome do executável (ex.: L"Discord.exe") — usado pra resolver
    // o `excludeProcessId` sem o JS precisar saber nada de Win32. `Discord.exe` é só o processo
    // PAI/launcher — `PROCESS_LOOPBACK_MODE_EXCLUDE_TARGET_PROCESS_TREE` cobre a árvore inteira
    // (processos filhos de renderer/GPU, mesmo padrão multi-processo do Electron) a partir dele,
    // não precisa achar cada processo filho manualmente.
    static DWORD FindProcessIdByName(const wchar_t* exeName);

private:
    bool InitializeProcessLoopback(DWORD targetProcessId, PROCESS_LOOPBACK_MODE mode);
    bool InitializeDeviceLoopback();
    bool CreateEncoder();
    bool EnsureComInitialized();

    IAudioClient* audioClient_ = nullptr;
    IAudioCaptureClient* captureClient_ = nullptr;
    OpusEncoder* encoder_ = nullptr;

    bool comInitializedHere_ = false;
    WAVEFORMATEX format_{};
    // Buffer intercalado (interleaved) float32, acumulando até completar um frame Opus de 20ms.
    std::vector<float> pcmBuffer_;
    size_t samplesPerChannelPerFrame_ = 960; // 20ms @ 48kHz
    float lastRms_ = 0.f;
};
