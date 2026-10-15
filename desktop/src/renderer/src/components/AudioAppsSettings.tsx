import { useCallback, useEffect, useState } from "react";
import type { AudioAppEntry } from "../../../preload/index";

const REFRESH_MS = 2000;

// Quais apps entram no áudio da transmissão (pipeline nativo — mixer por app, ver
// native/capture-core/src/AudioCaptureCore.h). Lista os apps que estão com sessão de áudio agora +
// os já silenciados; desligar um app tira ele do áudio NA HORA, mesmo com a transmissão no ar, e
// fica salvo pras próximas. Discord/NVIDIA Broadcast já vêm silenciados (quem tá na call ouviria a
// própria voz/a dos outros de novo pela transmissão). Só fica montado enquanto visível (o pai
// decide) — atualiza a lista a cada 2s enquanto isso.
export function AudioAppsSettings() {
  const [apps, setApps] = useState<AudioAppEntry[] | null>(null);

  const refresh = useCallback(async () => {
    try {
      const list = await window.screenshare.nativeAudio.listApps();
      list.sort((a, b) => Number(b.active) - Number(a.active) || a.exe.localeCompare(b.exe));
      setApps(list);
    } catch {
      setApps([]);
    }
  }, []);

  useEffect(() => {
    refresh();
    const interval = setInterval(refresh, REFRESH_MS);
    return () => clearInterval(interval);
  }, [refresh]);

  const toggle = async (exe: string, include: boolean) => {
    if (!apps) return;
    const excluded = apps.filter((a) => (a.exe === exe ? !include : a.excluded)).map((a) => a.exe);
    setApps(apps.map((a) => (a.exe === exe ? { ...a, excluded: !include } : a)));
    await window.screenshare.nativeAudio.setExcluded(excluded);
    refresh();
  };

  return (
    <div className="audio-apps">
      <p className="toggle-row-hint">Só o áudio dos apps ligados vai pra transmissão. Vale na hora.</p>
      {apps === null && <p className="toggle-row-hint">Carregando...</p>}
      {apps !== null && apps.length === 0 && <p className="toggle-row-hint">Nenhum app tocando áudio agora.</p>}
      {apps?.map((appEntry) => (
        <label className="toggle-row" key={appEntry.exe}>
          <span className="toggle-row-label">
            {appEntry.exe.replace(/\.exe$/i, "")}
            <span className="toggle-row-hint">
              {appEntry.excluded ? "Silenciado" : appEntry.active ? "Tocando agora" : "Sem som no momento"}
            </span>
          </span>
          <span className="toggle-switch">
            <input type="checkbox" checked={!appEntry.excluded} onChange={(e) => toggle(appEntry.exe, e.target.checked)} />
            <span className="toggle-slider" />
          </span>
        </label>
      ))}
    </div>
  );
}
