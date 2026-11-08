import { Client } from "@xhayper/discord-rpc";

// Discord Rich Presence: mostra "Jogando OCS Screen · Transmitindo tela" no perfil e ícone do
// lado do nome no canal de voz enquanto a transmissão está ativa. Usa o IPC local do Discord
// desktop — se o Discord não estiver aberto, falha em silêncio.
// Client ID é público (não é secret). Criar em https://discord.com/developers/applications.
const DISCORD_CLIENT_ID = process.env.DISCORD_CLIENT_ID ?? "1566617659301171282";

let client: Client | null = null;
let ready = false;
let streaming = false;
let startedAt = 0;
let viewerUrl: string | null = null;
let viewers = 0;

function apply(): void {
  if (!client || !ready) return;
  const user = client.user;
  if (!user) return;
  if (streaming) {
    void user
      .setActivity({
        details: "Transmitindo tela",
        state: viewers > 0 ? `Ao vivo · ${viewers} assistindo` : "Ao vivo",
        startTimestamp: startedAt,
        largeImageKey: "logo",
        largeImageText: "OCS Screen",
        smallImageKey: "live",
        smallImageText: "Ao vivo",
        // Botões: só quem OLHA o perfil vê; o próprio usuário não vê o botão no próprio cliente.
        buttons: viewerUrl && /^https?:\/\//.test(viewerUrl) ? [{ label: "Assistir transmissão", url: viewerUrl }] : undefined,
      })
      .catch(() => undefined);
  } else {
    void user.clearActivity().catch(() => undefined);
  }
}

async function ensureClient(): Promise<void> {
  if (client || !/^\d+$/.test(DISCORD_CLIENT_ID)) return;
  const c = new Client({ clientId: DISCORD_CLIENT_ID });
  client = c;
  c.on("ready", () => {
    ready = true;
    apply();
  });
  c.on("disconnected", () => {
    ready = false;
    client = null;
  });
  try {
    await c.login();
  } catch {
    // Discord fechado / sem IPC — ignora, tenta de novo na próxima transmissão.
    ready = false;
    client = null;
  }
}

export function setDiscordStreaming(active: boolean, url: string | null = null, viewerCount = 0): void {
  if (active === streaming && url === viewerUrl && viewerCount === viewers) return;
  if (active && !streaming) startedAt = Date.now();
  streaming = active;
  viewerUrl = url;
  viewers = viewerCount;
  if (client && ready) apply();
  else if (active) void ensureClient();
}

// Nome do usuário logado no Discord desktop — vem no READY do IPC local (independe da opção
// "Compartilhar atividade"). Usado SÓ como sugestão pro apelido nas configurações; quem decide se
// ele vai no aviso é a pessoa (toggle opt-in na HomePage). null = Discord fechado/sem resposta.
export async function getDiscordUserName(timeoutMs = 3000): Promise<string | null> {
  if (!client) void ensureClient();
  const deadline = Date.now() + timeoutMs;
  while (!(client && ready && client.user) && Date.now() < deadline) {
    if (!client) return null; // login falhou
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  const user = client?.user;
  if (!user) return null;
  const globalName = (user as { global_name?: string | null }).global_name;
  return globalName?.trim() || user.username || null;
}

export function destroyDiscordPresence(): void {
  const c = client;
  client = null;
  ready = false;
  if (c) void c.destroy().catch(() => undefined);
}
