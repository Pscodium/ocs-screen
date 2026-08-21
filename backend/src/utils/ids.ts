import { customAlphabet } from "nanoid";

// Sem caracteres ambíguos (0/O, 1/I/l) — link legível para digitar/ler em voz alta.
const alphabet = "23456789ABCDEFGHJKMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz";

export const generateRoomId = customAlphabet(alphabet, 8);
export const generateIdentity = customAlphabet(alphabet, 12);
