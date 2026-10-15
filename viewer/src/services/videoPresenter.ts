// Entrega os frames de vídeo decodificados ao `<video>` (via MediaStreamTrackGenerator) ALINHADOS AO
// VSYNC do display, em vez de um `setTimeout` por frame.
//
// Motivo (medido no E2E com a métrica de judder — |intervalo exibido − intervalo capturado|): com
// `setTimeout`, ~1-2% dos frames saíam 12-25ms fora do ritmo (mais de um vsync de 165Hz) — timer
// atrasado quando a thread da página está ocupada (render do React, GC, outro timer). É o "FPS
// estável mas não parece fluido". Aqui um único loop de `requestAnimationFrame` (roda no ritmo do
// display) escreve, a cada vsync, o frame mais novo cujo horário de apresentação já chegou; se dois
// frames caírem no mesmo vsync (só depois de um atraso), o mais velho é descartado — mostrar os dois
// em sequência atrasaria tudo que vem depois.
//
// Aba em segundo plano: `requestAnimationFrame` para de rodar — nesse caso escreve direto (sem
// alinhar), pra fila não crescer nem o áudio seguir sozinho.

interface Pending {
  frame: VideoFrame;
  atMs: number;
  writer: WritableStreamDefaultWriter<VideoFrame>;
}

export class VideoPresenter {
  private queue: Pending[] = [];
  private rafId: number | null = null;
  private lastRafMs: number | null = null;
  private vsyncMs = 1000 / 60;
  private closed = false;
  private readonly onVisibility = () => {
    if (document.visibilityState === "hidden") this.flushAll();
  };

  constructor() {
    document.addEventListener("visibilitychange", this.onVisibility);
  }

  // `atMs` = instante (`performance.now()`) em que o frame deve aparecer.
  enqueue(writer: WritableStreamDefaultWriter<VideoFrame>, frame: VideoFrame, atMs: number): void {
    if (this.closed) {
      frame.close();
      return;
    }
    if (document.visibilityState === "hidden") {
      this.write({ frame, atMs, writer });
      return;
    }
    // Chegam em ordem quase sempre; inserção ordenada cobre a exceção.
    let i = this.queue.length;
    while (i > 0 && this.queue[i - 1].atMs > atMs) i--;
    this.queue.splice(i, 0, { frame, atMs, writer });
    if (this.rafId === null) this.rafId = requestAnimationFrame(this.tick);
  }

  close(): void {
    this.closed = true;
    document.removeEventListener("visibilitychange", this.onVisibility);
    if (this.rafId !== null) cancelAnimationFrame(this.rafId);
    for (const p of this.queue) p.frame.close();
    this.queue = [];
  }

  private readonly tick = (rafMs: number): void => {
    this.rafId = null;
    if (this.lastRafMs !== null) {
      const interval = rafMs - this.lastRafMs;
      // Intervalo do display (EWMA), ignorando pulos de rAF (aba perdeu foco, travada longa).
      if (interval > 2 && interval < 50) this.vsyncMs += (interval - this.vsyncMs) * 0.1;
    }
    this.lastRafMs = rafMs;

    // Tudo que vence até o meio do próximo intervalo de vsync entra NESTE vsync.
    const deadline = performance.now() + this.vsyncMs / 2;
    let due = -1;
    while (due + 1 < this.queue.length && this.queue[due + 1].atMs <= deadline) due++;
    if (due >= 0) {
      for (let i = 0; i < due; i++) this.queue[i].frame.close();
      this.write(this.queue[due]);
      this.queue.splice(0, due + 1);
    }
    if (this.queue.length > 0) this.rafId = requestAnimationFrame(this.tick);
  };

  private flushAll(): void {
    const last = this.queue.pop();
    for (const p of this.queue) p.frame.close();
    this.queue = [];
    if (last) this.write(last);
  }

  private write(p: Pending): void {
    p.writer.write(p.frame).catch(() => p.frame.close());
  }
}
