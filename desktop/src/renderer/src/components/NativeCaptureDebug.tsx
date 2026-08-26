import { useEffect, useRef, useState } from "react";
import { captureNative, isNativeCaptureAvailable, listNativeMonitors, type NativeMonitor } from "../services/nativeCapture";
import { defaultStreamSettings } from "../types/stream";
import type { NativeCaptureResult } from "../services/nativeCapture";

// Painel de teste dev-only pra validar o addon nativo (docs/NATIVE_CAPTURE.md) ponta a ponta —
// captura → MediaStreamTrackGenerator → <video> — antes de integrar no fluxo de transmissão de
// verdade (SourcePicker/useBroadcast). Só builda em import.meta.env.DEV.
export function NativeCaptureDebug() {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const captureRef = useRef<NativeCaptureResult | null>(null);
  const [available, setAvailable] = useState<boolean | null>(null);
  const [monitors, setMonitors] = useState<NativeMonitor[]>([]);
  const [running, setRunning] = useState(false);
  const [fps, setFps] = useState(0);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    isNativeCaptureAvailable().then(setAvailable);
    const off = window.screenshare.nativeCapture.onError(setError);
    return () => {
      off();
    };
  }, []);

  useEffect(() => {
    if (!running || !videoRef.current) return;
    let frames = 0;
    let raf = 0;
    let lastCount = performance.now();

    const tick = () => {
      frames++;
      const now = performance.now();
      if (now - lastCount >= 1000) {
        setFps(frames);
        frames = 0;
        lastCount = now;
      }
      // requestVideoFrameCallback existe no Chromium — conta frame de verdade decodificado/exibido,
      // não só o rAF do navegador (que roda mesmo sem frame novo nenhum).
      if ("requestVideoFrameCallback" in videoRef.current!) {
        raf = (videoRef.current as HTMLVideoElement & { requestVideoFrameCallback: (cb: () => void) => number }).requestVideoFrameCallback(tick);
      }
    };
    if (videoRef.current && "requestVideoFrameCallback" in videoRef.current) {
      raf = (videoRef.current as HTMLVideoElement & { requestVideoFrameCallback: (cb: () => void) => number }).requestVideoFrameCallback(tick);
    }
    return () => {
      if (videoRef.current && "cancelVideoFrameCallback" in videoRef.current) {
        (videoRef.current as HTMLVideoElement & { cancelVideoFrameCallback: (id: number) => void }).cancelVideoFrameCallback(raf);
      }
    };
  }, [running]);

  const start = async (monitorIndex: number) => {
    setError(null);
    try {
      const result = await captureNative(monitorIndex, defaultStreamSettings);
      captureRef.current = result;
      // O <video> só existe no DOM depois de `running` virar true (renderização condicional lá
      // embaixo) — `videoRef.current` ainda é null aqui nesse instante. `setRunning(true)` só
      // agenda o próximo render; o efeito abaixo (que roda DEPOIS do elemento montar de verdade)
      // é quem atribui `srcObject`.
      setRunning(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Erro desconhecido.");
    }
  };

  // Atribui srcObject só depois que o <video> realmente existe no DOM (running virou true e o
  // React já montou o elemento) — sem isso, a atribuição corria contra um ref ainda nulo e o
  // vídeo nunca recebia o stream (ficava parado em readyState 0 pra sempre).
  useEffect(() => {
    if (running && videoRef.current && captureRef.current) {
      videoRef.current.srcObject = captureRef.current.stream;
    }
  }, [running]);

  const stop = () => {
    captureRef.current?.stopAll();
    captureRef.current = null;
    setRunning(false);
    setFps(0);
  };

  if (available === null) return null;

  return (
    <div className="native-capture-debug">
      <div className="native-capture-debug-header">
        <span>🧪 Captura nativa {available ? "(disponível)" : "(indisponível)"}</span>
        {running && <span className="native-capture-debug-fps">{fps} fps</span>}
      </div>

      {!running && available && (
        <div className="native-capture-debug-actions">
          <button
            className="btn-secondary"
            onClick={async () => setMonitors(await listNativeMonitors())}
          >
            Listar monitores
          </button>
          {monitors.map((m) => (
            <button key={m.index} className="btn-secondary" onClick={() => start(m.index)}>
              Monitor {m.index} ({m.width}×{m.height})
            </button>
          ))}
        </div>
      )}

      {running && (
        <>
          <video ref={videoRef} autoPlay muted playsInline className="native-capture-debug-video" />
          <button className="btn-secondary" onClick={stop}>
            Parar
          </button>
        </>
      )}

      {error && <p className="error-text">{error}</p>}
    </div>
  );
}
