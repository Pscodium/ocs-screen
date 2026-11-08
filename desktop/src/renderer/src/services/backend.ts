import type { StreamSettings } from "../types/stream";

export const backendUrl = import.meta.env.VITE_BACKEND_URL ?? "http://localhost:4000";

export interface CreateRoomResponse {
  roomId: string;
  hostToken: string;
  livekitUrl: string;
  viewerUrl: string;
  nativeMode: boolean;
  // Backend antigo não devolve — aí a sala fica no modo sem proteção, como antes.
  hostSecret?: string;
}

// Segredo de host por sala, só em memória (nunca persistido): prova pro backend que quem encerra a
// sala ou conecta como host é quem criou. Some ao fechar o app, junto com a transmissão.
const hostSecrets = new Map<string, string>();

export function getHostSecret(roomId: string): string | undefined {
  return hostSecrets.get(roomId);
}

export class UpdateRequiredError extends Error {
  constructor(readonly minVersion: string | null) {
    super("Esta versão do app não é mais suportada. Atualize para continuar transmitindo.");
  }
}

// Evento global que o useAppUpdater escuta pra abrir o modal de atualização obrigatória — quem
// recebe o 426 (criação de sala) não precisa conhecer o modal.
export const UPDATE_REQUIRED_EVENT = "app:update-required";

// Versão mínima aceita pelo backend (null = nenhuma). Falha de rede → null (não bloqueia ninguém
// por estar offline).
export async function fetchMinAppVersion(): Promise<string | null> {
  try {
    const res = await fetch(`${backendUrl}/app/version`);
    if (!res.ok) return null;
    const data = (await res.json()) as { minVersion?: unknown };
    return typeof data.minVersion === "string" ? data.minVersion : null;
  } catch {
    return null;
  }
}

// Sala privada = fora da lista pública ("Assistir"/home do viewer), só entra quem tem o link.
// Senha = espectador digita antes de assistir (o backend guarda só o hash e confere no token/WS).
export interface RoomAccess {
  isPrivate: boolean;
  password?: string;
  // Opt-in (aba "Configuração"): apelido mostrado no aviso do Discord. Ausente = aviso sem nome.
  hostName?: string;
}

export async function createRoom(
  settings: StreamSettings,
  slug?: string,
  nativeMode?: boolean,
  access: RoomAccess = { isPrivate: false },
): Promise<CreateRoomResponse> {
  const res = await fetch(`${backendUrl}/rooms`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      settings,
      slug: slug || undefined,
      nativeMode,
      isPrivate: access.isPrivate,
      password: access.password || undefined,
      hostName: access.hostName || undefined,
      source: "desktop",
      hostAuth: true,
      appVersion: __APP_VERSION__,
    }),
  });
  if (!res.ok) {
    if (res.status === 426) {
      const body = (await res.json().catch(() => null)) as { minVersion?: string } | null;
      window.dispatchEvent(new CustomEvent(UPDATE_REQUIRED_EVENT, { detail: body?.minVersion ?? null }));
      throw new UpdateRequiredError(body?.minVersion ?? null);
    }
    if (res.status === 409) throw new Error("Esse nome de sala já está em uso.");
    if (res.status === 400) throw new Error("Nome de sala ou senha inválidos (nome: letras, números e hífen; senha: até 128 caracteres).");
    throw new Error("Falha ao criar sala de transmissão.");
  }
  const room = (await res.json()) as CreateRoomResponse;
  if (room.hostSecret) hostSecrets.set(room.roomId, room.hostSecret);
  return room;
}

export async function endRoom(roomId: string): Promise<void> {
  const secret = hostSecrets.get(roomId);
  try {
    await fetch(`${backendUrl}/rooms/${roomId}`, {
      method: "DELETE",
      headers: secret ? { "X-Host-Secret": secret } : {},
    });
  } finally {
    hostSecrets.delete(roomId);
  }
}

export interface RoomSummary {
  roomId: string;
  createdAt: number;
  hasPassword?: boolean;
  viewerUrl: string;
  settings?: Pick<StreamSettings, "resolution" | "fps" | "quality">;
  // null quando o backend não consegue saber (LiveKit fora do ar).
  viewerCount?: number | null;
  // De onde o host transmite. Ausente em backend antigo (aí a UI não mostra a origem).
  source?: "desktop" | "web";
}

// Rótulo curto da origem da transmissão (campo `source` do backend).
export function roomSourceLabel(source: RoomSummary["source"]): string | null {
  if (source === "desktop") return "App";
  if (source === "web") return "Navegador";
  return null;
}

export async function fetchActiveRooms(): Promise<RoomSummary[]> {
  const res = await fetch(`${backendUrl}/rooms`);
  if (!res.ok) throw new Error("Falha ao listar transmissões ativas.");
  const data = await res.json();
  return data.rooms;
}

