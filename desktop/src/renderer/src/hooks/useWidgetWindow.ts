import { useEffect, useRef } from "react";

// Quando a transmissão está ao vivo, encolhe a janela para uma barra compacta sempre-no-topo
// (estilo overlay de compartilhamento), fora do caminho do usuário. Resize/posicionamento real
// acontece no processo principal (só ele pode mexer no BrowserWindow).
export function useWidgetWindow(isLive: boolean) {
  const appliedRef = useRef<boolean | null>(null);

  useEffect(() => {
    if (isLive === appliedRef.current) return;
    appliedRef.current = isLive;
    window.screenshare.window.setWidgetMode(isLive);
  }, [isLive]);
}
