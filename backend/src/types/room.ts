export type RoomQuality = "auto" | "low" | "medium" | "high" | "max";
export type RoomResolution = "auto" | "720p" | "1080p" | "1440p" | "2160p";
export type RoomFps = "auto" | 30 | 60;

export interface RoomSettings {
  resolution: RoomResolution;
  fps: RoomFps;
  quality: RoomQuality;
}

export interface Room {
  id: string;
  hostIdentity: string;
  createdAt: number;
  settings: RoomSettings;
  // Transporte nativo (libdatachannel, ver docs/NATIVE_CAPTURE.md Fase 4) em vez de LiveKit pro
  // vídeo — decidido pelo host na criação da sala (settings.nativeTransport no desktop). O viewer
  // usa isso pra escolher entre useRoomStream (LiveKit) e useNativeStream (RTCPeerConnection cru).
  nativeMode: boolean;
  // Sala privada não aparece em GET /rooms — só entra quem tem o link.
  isPrivate: boolean;
  // Hash scrypt (`salt:hash` em hex) — nunca a senha em texto puro. null = sala aberta.
  passwordHash: string | null;
  // De onde o host transmite — app desktop ou navegador (viewer web). Vem no `source` do POST
  // /rooms; cliente antigo sem o campo cai no `isWebLive` legado (ver `resolveRoomSource`).
  source: RoomSource;
  // Versão do app desktop que criou a sala (null no web ou em app antigo que não manda).
  appVersion: string | null;
  // Nome que o host escolheu mostrar no aviso do Discord (opt-in no app, já sanitizado). Declarado
  // pelo cliente, não verificado. null = não mostrar (padrão, e app/web antigo que não manda).
  hostName: string | null;
  // SHA-256 (hex) do segredo do host — exigido no DELETE e no WS `role=host`. null = sala criada
  // por cliente antigo (desktop ≤ 1.1.1) que não sabe mandar o segredo: modo de transição, sem
  // proteção (ver skill prod-changes, tabela de versões). Decidido na criação, nunca depois.
  hostSecretHash: string | null;
}

export type RoomSource = "desktop" | "web";

export interface CreateRoomRequest {
  settings?: Partial<RoomSettings>;
  slug?: string;
  nativeMode?: boolean;
  isPrivate?: boolean;
  password?: string;
  source?: RoomSource;
  appVersion?: string;
  // Opt-in: nome a mostrar no aviso do Discord. Validado/sanitizado em routes/rooms.ts.
  hostName?: string;
  // Cliente sabe guardar e mandar `hostSecret` (desktop ≥ 1.2.0 e viewer web atual).
  hostAuth?: boolean;
  // LEGADO (web 1.0.15 e anteriores) — substituído por `source`. Mantido pra salas criadas por
  // clientes já publicados continuarem com a origem certa.
  isWebLive?: boolean;
}

export interface CreateRoomResponse {
  roomId: string;
  hostToken: string;
  livekitUrl: string;
  viewerUrl: string;
  nativeMode: boolean;
  // Só quando o cliente pediu `hostAuth`. Mostrado uma vez; o backend guarda só o hash.
  hostSecret?: string;
}

export interface ViewerTokenResponse {
  token: string;
  livekitUrl: string;
  roomId: string;
}

export interface RoomSummary {
  roomId: string;
  createdAt: number;
  settings: RoomSettings;
  hasPassword: boolean;
  // Espectadores conectados agora (LiveKit: participantes menos o host; nativo: sockets de viewer
  // no relay). null quando o LiveKit está inacessível e não dá pra saber.
  viewerCount: number | null;
  // Link do viewer web — o app desktop abre ele numa janela própria pra assistir (aba "Assistir").
  viewerUrl: string;
  source: RoomSource;
}

export interface ListRoomsResponse {
  rooms: RoomSummary[];
}
