import { useEffect, useRef, useState } from "react";
import { fetchMinAppVersion, UPDATE_REQUIRED_EVENT } from "../services/backend";

export type UpdateChannel = "github" | "store" | "dev";

// De quanto em quanto tempo reconsulta a versão mínima com o app aberto (app fica aberto por dias
// na bandeja — sem isso só descobria o bloqueio ao reabrir).
const MIN_VERSION_POLL_MS = 30 * 60_000;

function isOlder(current: string, min: string): boolean {
  const parse = (v: string) => v.split(/[-+]/)[0].split(".").map((p) => Number.parseInt(p, 10) || 0);
  const a = parse(current);
  const b = parse(min);
  for (let i = 0; i < 3; i++) if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) < (b[i] ?? 0);
  return false;
}

export type UpdatePhase = "idle" | "available" | "downloading" | "downloaded" | "error";

export interface UpdateState {
  phase: UpdatePhase;
  version: string | null;
  releaseNotes: string | null;
  percent: number;
  error: string | null;
}

const initialState: UpdateState = {
  phase: "idle",
  version: null,
  releaseNotes: null,
  percent: 0,
  error: null,
};

// HTML de verdade, não markdown — o feed do GitHub que o electron-updater lê já vem renderizado
// assim (ver nota em UpdateModal.tsx), o mock precisa refletir isso pra testar o caso real.
const MOCK_RELEASE_NOTES = `<ul>
<li>Suporte a 4K60 com codec AV1 quando o hardware aguenta</li>
<li>Corrigido áudio vindo ligado mesmo com o player mutado</li>
<li>Widget agora aparece na frente de qualquer outra janela</li>
<li>Pequenas melhorias de estabilidade</li>
</ul>`;

export function useAppUpdater() {
  const [state, setState] = useState<UpdateState>(initialState);
  const [dismissed, setDismissed] = useState(false);
  const [channel, setChannel] = useState<UpdateChannel>("dev");
  // Versão mínima exigida quando a instalada está abaixo dela — modal não fecha.
  const [requiredMin, setRequiredMin] = useState<string | null>(null);
  // Modo mock (botão de debug) não deve disparar IPC de verdade — troca só o comportamento local
  // de download()/install() enquanto ativo, pra dar pra ver o modal inteiro sem publicar nada.
  const isMockRef = useRef(false);
  const mockTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    const offAvailable = window.screenshare.updater.onAvailable((info) => {
      isMockRef.current = false;
      setDismissed(false);
      setState({ phase: "available", version: info.version, releaseNotes: info.releaseNotes, percent: 0, error: null });
    });
    const offProgress = window.screenshare.updater.onDownloadProgress((progress) => {
      setState((prev) => ({ ...prev, phase: "downloading", percent: progress.percent }));
    });
    const offDownloaded = window.screenshare.updater.onDownloaded(() => {
      setState((prev) => ({ ...prev, phase: "downloaded", percent: 100 }));
    });
    const offError = window.screenshare.updater.onError((message) => {
      setState((prev) => ({ ...prev, phase: "error", error: message }));
    });

    void window.screenshare.updater.channel().then(setChannel);

    const checkMin = async () => {
      const min = await fetchMinAppVersion();
      setRequiredMin(min && isOlder(__APP_VERSION__, min) ? min : null);
    };
    void checkMin();
    const pollTimer = setInterval(() => void checkMin(), MIN_VERSION_POLL_MS);
    // Backend recusou criar sala (426) — mais rápido que esperar o próximo poll.
    const onRequired = (event: Event) => {
      const min = (event as CustomEvent<string | null>).detail;
      setRequiredMin(min ?? "?");
    };
    window.addEventListener(UPDATE_REQUIRED_EVENT, onRequired);

    return () => {
      clearInterval(pollTimer);
      window.removeEventListener(UPDATE_REQUIRED_EVENT, onRequired);
      offAvailable();
      offProgress();
      offDownloaded();
      offError();
      if (mockTimerRef.current) clearInterval(mockTimerRef.current);
    };
  }, []);

  const simulate = () => {
    isMockRef.current = true;
    setDismissed(false);
    setState({
      phase: "available",
      version: "9.9.9-mock",
      releaseNotes: MOCK_RELEASE_NOTES,
      percent: 0,
      error: null,
    });
  };

  const download = () => {
    if (!isMockRef.current && channel === "store") {
      window.screenshare.updater.openStore();
      return;
    }
    if (!isMockRef.current) {
      window.screenshare.updater.download();
      return;
    }
    // Fake progresso — só pra validar visual da barra sem baixar nada de verdade.
    let percent = 0;
    setState((prev) => ({ ...prev, phase: "downloading", percent: 0 }));
    mockTimerRef.current = setInterval(() => {
      percent += 12;
      if (percent >= 100) {
        if (mockTimerRef.current) clearInterval(mockTimerRef.current);
        setState((prev) => ({ ...prev, phase: "downloaded", percent: 100 }));
      } else {
        setState((prev) => ({ ...prev, phase: "downloading", percent }));
      }
    }, 250);
  };

  const install = () => {
    if (!isMockRef.current) {
      window.screenshare.updater.install();
      return;
    }
    setDismissed(true);
  };

  const required = requiredMin !== null && !isMockRef.current;
  return {
    ...state,
    // Obrigatória abre mesmo sem `update:available` ter chegado (checagem falhou/ainda não rodou).
    phase: required && state.phase === "idle" ? ("available" as const) : state.phase,
    channel,
    required,
    requiredMin,
    visible: required || (state.phase !== "idle" && !dismissed),
    download,
    install,
    dismiss: () => {
      if (!required) setDismissed(true);
    },
    simulate,
  };
}
