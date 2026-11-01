import { useEffect, useRef, useState } from "react";
import { FullscreenIcon } from "./Icons";

// ~15 quadros/s: fluido o bastante pra acompanhar o que está saindo. Cada quadro é uma miniatura de
// ~320px que a GPU reduz e devolve sem esperar (addon.cpp `CapturePreview`) — custo desprezível pra
// transmissão. Pausa com a janela escondida/minimizada.
const PREVIEW_INTERVAL_MS = 66;

interface LivePreviewProps {
  // Abre a transmissão como um espectador vê (viewer numa janela grande) — a miniatura daqui é
  // reduzida pela GPU e não mostra a qualidade real do encode.
  onExpand: () => void;
}

// Preview da própria transmissão no widget (pipeline nativo).
export function LivePreview({ onExpand }: LivePreviewProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const tick = async () => {
      if (!document.hidden) {
        try {
          const frame = await window.screenshare.capture.preview();
          const canvas = canvasRef.current;
          if (cancelled) return;
          if (frame && canvas) {
            if (canvas.width !== frame.width || canvas.height !== frame.height) {
              canvas.width = frame.width;
              canvas.height = frame.height;
            }
            const pixels = new Uint8ClampedArray(frame.data.buffer as ArrayBuffer, frame.data.byteOffset, frame.data.byteLength);
            canvas.getContext("2d")?.putImageData(new ImageData(pixels, frame.width, frame.height), 0, 0);
            setReady(true);
          }
        } catch {
          // Captura reiniciando (troca de fonte, GPU resetando) — tenta no próximo quadro.
        }
      }
      if (!cancelled) timer = setTimeout(tick, PREVIEW_INTERVAL_MS);
    };
    tick();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, []);

  return (
    <div className="live-preview">
      <canvas ref={canvasRef} className="live-preview-canvas" />
      {!ready && <span className="spinner" />}
      <button
        className="live-preview-expand"
        onClick={onExpand}
        title="Ver em tela maior, como um espectador vê (conta como 1 espectador)"
      >
        <FullscreenIcon size={13} />
        Ampliar
      </button>
    </div>
  );
}
