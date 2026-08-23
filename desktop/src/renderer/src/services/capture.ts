import { AUTO_FPS_TARGET, RESOLUTION_CONSTRAINTS, type StreamSettings } from "../types/stream";
import type { CaptureSource } from "../../../preload/index";

export interface CaptureResult {
  stream: MediaStream;
  settings: MediaTrackSettings;
  hasAudio: boolean;
  stopAll: () => void;
}

// Constraints com `mandatory`/`chromeMediaSource` são uma extensão proprietária do Chromium/
// Electron, fora da spec padrão de MediaTrackConstraints — por isso o cast. É o que o Electron
// expõe no lugar do getDisplayMedia() pra resolver o stream a partir de um id do desktopCapturer.
//
// Sem min/maxWidth/maxHeight/FrameRate dentro de `mandatory` de propósito: o backend WGC
// (Windows.Graphics.Capture) trava em retry infinito com E_INVALIDARG quando esses limites (que
// são EXATOS, não negociáveis) não batem com a fonte — a promise do getUserMedia nunca resolve
// nem rejeita. `optional` é diferente: é o formato legado do Chrome pra hints NEGOCIÁVEIS (mais
// parecido com `ideal` do padrão moderno) — não trava a sessão numa exigência inegociável, só
// pede. Testado com o timeout de segurança abaixo como rede de proteção (se travar mesmo assim,
// falha em 8s com erro claro em vez de travar o app pra sempre).
interface ElectronDesktopConstraints {
  video: {
    mandatory: {
      chromeMediaSource: "desktop";
      chromeMediaSourceId: string;
    };
    optional?: Array<{ minFrameRate: number } | { maxFrameRate: number }>;
  };
  audio:
    | false
    | {
        mandatory: {
          chromeMediaSource: "desktop";
        };
      };
}

const CAPTURE_TIMEOUT_MS = 8000;

function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) => setTimeout(() => reject(new Error(message)), ms)),
  ]);
}

// `onSourceEnded` dispara quando a track para inesperadamente (ex.: usuário fecha a janela
// compartilhada). Sem diálogo nativo aqui — a fonte já foi escolhida via SourcePicker.
export async function captureScreen(
  settings: StreamSettings,
  source: CaptureSource,
  onSourceEnded?: () => void,
): Promise<CaptureResult> {
  const constraints: ElectronDesktopConstraints = {
    video: {
      mandatory: {
        chromeMediaSource: "desktop",
        chromeMediaSourceId: source.id,
      },
      // Pede o FPS já na negociação inicial da sessão de captura — sem isso, o WGC costuma
      // inicializar num FPS conservador (30) e o `applyConstraints()` de depois (abaixo) só
      // consegue REFINAR uma sessão já criada, não trocar a cadência real de entrega de frame
      // que foi fixada na criação. Isso explicava a app desktop entregar FPS mais baixo/instável
      // que o navegador (que já manda o frameRate desejado dentro do próprio getDisplayMedia
      // inicial) mesmo com o mesmo encoder de hardware.
      //
      // "Automático" também manda um alvo real (AUTO_FPS_TARGET) em vez de não mandar nada —
      // testado em produção: sem NENHUM hint, o WGC não necessariamente escolhe algo razoável
      // sozinho (ficou em ~20fps, pior que pedir 30 explicitamente). "Automático" precisa
      // significar "um bom padrão", não "sem controle nenhum".
      optional: [
        { minFrameRate: settings.fps === "auto" ? AUTO_FPS_TARGET : settings.fps },
        { maxFrameRate: settings.fps === "auto" ? AUTO_FPS_TARGET : settings.fps },
      ],
    },
    // `chromeMediaSource: "desktop"` no áudio pede o loopback do SISTEMA INTEIRO — não é isolado
    // por janela (a Windows não expõe captura de áudio de um app específico por essa API), mas
    // nada impede de pedir independente do tipo de fonte de vídeo escolhida. Antes isso ficava
    // bloqueado pra janela achando que não funcionava — nunca foi testado de verdade.
    audio: { mandatory: { chromeMediaSource: "desktop" } },
  };

  const stream = await withTimeout(
    navigator.mediaDevices.getUserMedia(constraints as unknown as MediaStreamConstraints),
    CAPTURE_TIMEOUT_MS,
    `Não foi possível capturar "${source.name}" (o Windows recusou essa fonte — tenta escolher outra tela/janela).`,
  );

  const [videoTrack] = stream.getVideoTracks();

  // Sem constraint na captura, o WGC costuma cair num FPS conservador (30) e sempre entrega a
  // resolução nativa do monitor. Pede FPS/resolução reais pelo caminho PADRÃO (applyConstraints,
  // não `mandatory`) depois que a track já existe — esse caminho é negociado, não trava o app se
  // o SO recusar (só ignora, sem hang, diferente do `mandatory` que travava em loop).
  const desiredConstraints: MediaTrackConstraints = {};
  const fpsTarget = settings.fps === "auto" ? AUTO_FPS_TARGET : settings.fps;
  desiredConstraints.frameRate = { ideal: fpsTarget, max: fpsTarget };
  if (settings.resolution !== "auto") {
    const { width, height } = RESOLUTION_CONSTRAINTS[settings.resolution];
    desiredConstraints.width = { ideal: width, max: width };
    desiredConstraints.height = { ideal: height, max: height };
  }
  if (Object.keys(desiredConstraints).length > 0) {
    try {
      await videoTrack.applyConstraints(desiredConstraints);
    } catch {
      // Sem sorte — segue com o que a captura já entregou (resolução/fps nativos).
    }
  }

  // Não fixo por padrão (testado em produção: piora stutter/frame drop em jogos — ver
  // docs/INSIGHTS-ENCODER.md #1) — vira opt-in via toggle "Melhorar texto" nas configurações.
  // "text" é o hint mais forte disponível, o mesmo espírito do "melhorar leitura de texto" do
  // Discord: só liga quando o usuário sabe que vai compartilhar código/documento parado.
  if (settings.sharpText) {
    videoTrack.contentHint = "text";
  }

  // Parâmetros solicitados não são garantia — sempre checar capacidades reais (CLAUDE.md §Captura de tela).
  const actualSettings = videoTrack.getSettings();
  const hasAudio = stream.getAudioTracks().length > 0;
  if (onSourceEnded) videoTrack.onended = onSourceEnded;

  return {
    stream,
    settings: actualSettings,
    hasAudio,
    stopAll: () => {
      stream.getTracks().forEach((track) => track.stop());
    },
  };
}
