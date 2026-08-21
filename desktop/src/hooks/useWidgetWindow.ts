import { useEffect, useRef } from "react";
import { getCurrentWindow, LogicalSize, PhysicalPosition, currentMonitor } from "@tauri-apps/api/window";

const NORMAL_SIZE = { width: 440, height: 720 };
const WIDGET_SIZE = { width: 360, height: 132 };
const WIDGET_MARGIN = 24;

// Quando a transmissão está ao vivo, encolhe a janela para uma barra compacta
// sempre visível (estilo overlay de compartilhamento), fora do caminho do usuário.
export function useWidgetWindow(isLive: boolean) {
  const appliedRef = useRef(false);

  useEffect(() => {
    const appWindow = getCurrentWindow();

    (async () => {
      if (isLive === appliedRef.current) return;
      appliedRef.current = isLive;

      if (isLive) {
        await appWindow.setSize(new LogicalSize(WIDGET_SIZE.width, WIDGET_SIZE.height));
        await appWindow.setAlwaysOnTop(true);

        const monitor = await currentMonitor();
        if (monitor) {
          const scale = monitor.scaleFactor;
          const x = monitor.position.x + monitor.size.width - WIDGET_SIZE.width * scale - WIDGET_MARGIN * scale;
          const y = monitor.position.y + monitor.size.height - WIDGET_SIZE.height * scale - WIDGET_MARGIN * scale;
          await appWindow.setPosition(new PhysicalPosition(Math.round(x), Math.round(y)));
        }
      } else {
        await appWindow.setAlwaysOnTop(false);
        await appWindow.setSize(new LogicalSize(NORMAL_SIZE.width, NORMAL_SIZE.height));
        await appWindow.center();
      }
    })();
  }, [isLive]);
}
