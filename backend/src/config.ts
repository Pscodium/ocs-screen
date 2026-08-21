function required(name: string, fallback?: string): string {
  const value = process.env[name] ?? fallback;
  if (!value) throw new Error(`Missing required env var: ${name}`);
  return value;
}

export const config = {
  port: Number(process.env.PORT ?? 4000),
  host: process.env.HOST ?? "0.0.0.0",
  corsOrigin: process.env.CORS_ORIGIN ?? "*",
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
