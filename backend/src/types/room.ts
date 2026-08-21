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
}

export interface CreateRoomRequest {
  settings?: Partial<RoomSettings>;
}

export interface CreateRoomResponse {
  roomId: string;
  hostToken: string;
  livekitUrl: string;
  viewerUrl: string;
}

export interface ViewerTokenResponse {
  token: string;
  livekitUrl: string;
  roomId: string;
}
