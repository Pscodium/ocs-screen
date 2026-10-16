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
}

export interface CreateRoomRequest {
  settings?: Partial<RoomSettings>;
  slug?: string;
  nativeMode?: boolean;
  isPrivate?: boolean;
  password?: string;
}

export interface CreateRoomResponse {
  roomId: string;
  hostToken: string;
  livekitUrl: string;
  viewerUrl: string;
  nativeMode: boolean;
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
  // Link do viewer web — o app desktop abre ele numa janela própria pra assistir (aba "Assistir").
  viewerUrl: string;
}

export interface ListRoomsResponse {
  rooms: RoomSummary[];
}
