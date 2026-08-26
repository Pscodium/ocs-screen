function required(name: string, fallback?: string): string {
  const value = process.env[name] ?? fallback;
  if (!value) throw new Error(`Missing required env var: ${name}`);
  return value;
}

export const config = {
  port: Number(process.env.PORT ?? 4000),
  host: process.env.HOST ?? "0.0.0.0",
  // Lista separada por vírgula. O app desktop Electron não roda no domínio do viewer:
  // - build de produção → carrega via file://, cujo Origin em fetch/XHR é a string literal "null"
  // - `npm run dev` → http://localhost:5174 (servidor Vite do electron-vite, porta fixa — ver
  //   desktop/electron.vite.config.ts — pra não colidir com a porta 5173 do viewer)
  // Por isso essas origens sempre são liberadas além do que vier em CORS_ORIGIN.
  corsOrigins: [
    ...(process.env.CORS_ORIGIN?.split(",").map((origin) => origin.trim()) ?? []),
    "null",
    "http://localhost:5174",
  ] as string[],
  // Origem pública do viewer web — usada para montar o link completo da sala. Nunca deduzir do CORS_ORIGIN.
  viewerUrl: required("VIEWER_URL", "http://localhost:5173"),
  livekit: {
    url: required("LIVEKIT_URL", "ws://localhost:7880"),
    apiKey: required("LIVEKIT_API_KEY", "devkey"),
    apiSecret: required("LIVEKIT_API_SECRET", "devsecret1234567890"),
  },
  room: {
    tokenTtlSeconds: Number(process.env.ROOM_TOKEN_TTL_SECONDS ?? 60 * 60 * 6),
    emptyRoomTtlSeconds: Number(process.env.ROOM_EMPTY_TTL_SECONDS ?? 60 * 5),
  },
  // TURN (CLAUDE.md §Infraestrutura já previa isso desde o início — só STUN público era usado até
  // aqui, "só pra validar"). `secret`/`realm` batem com um coturn configurado com
  // `use-auth-secret`/`static-auth-secret` (ver infra/docker/docker-compose.yml) — credenciais são
  // geradas por requisição (`services/turn.ts`), nunca fixas, e expiram sozinhas (mesmo espírito
  // de "tokens temporários" que o resto do projeto já segue pra sala/LiveKit). Sem `TURN_SECRET`
  // configurado, o servidor simplesmente não oferece TURN (STUN público continua funcionando
  // sozinho, mesmo fallback de sempre) — nunca trava o boot do backend por isso.
  turn: {
    secret: process.env.TURN_SECRET ?? null,
    // Host(s) que os clientes usam pra alcançar o coturn — pode ser IP público ou domínio, não o
    // hostname interno do container. Múltiplos separados por vírgula (ex.: TCP e UDP em portas
    // diferentes, ou vários pontos de entrada).
    urls: (process.env.TURN_URLS ?? "turn:localhost:3478").split(",").map((u) => u.trim()),
    ttlSeconds: Number(process.env.TURN_CREDENTIAL_TTL_SECONDS ?? 60 * 60), // 1h
  },
} as const;
