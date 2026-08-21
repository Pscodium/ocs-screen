function required(name: string, fallback?: string): string {
  const value = process.env[name] ?? fallback;
  if (!value) throw new Error(`Missing required env var: ${name}`);
  return value;
}

export const config = {
  port: Number(process.env.PORT ?? 4000),
  host: process.env.HOST ?? "0.0.0.0",
  // Lista separada por vírgula. O app desktop Tauri não roda no domínio do viewer:
  // - build de produção → tauri://localhost / http://tauri.localhost (protocolo custom do Tauri)
  // - `tauri dev` → http://localhost:1420 (servidor Vite, é o que o webview carrega em dev)
  // Por isso essas origens sempre são liberadas além do que vier em CORS_ORIGIN.
  corsOrigins: [
    ...(process.env.CORS_ORIGIN?.split(",").map((origin) => origin.trim()) ?? []),
    "tauri://localhost",
    "http://tauri.localhost",
    "https://tauri.localhost",
    "http://localhost:1420",
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
} as const;
