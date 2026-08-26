import { createHmac } from "node:crypto";
import { config } from "../config.js";

export interface IceServerDescriptor {
  urls: string;
  username?: string;
  credential?: string;
}

// Credencial TURN de curta duração (convenção REST API do coturn, `use-auth-secret`): username =
// "<unix-timestamp-de-expiração>:<algo>", password = base64(HMAC-SHA1(secret, username)). O
// coturn recebe esse username/password do cliente durante o handshake TURN e valida sozinho sem
// nenhuma chamada de rede entre backend e coturn — só precisa dos dois compartilharem o mesmo
// `TURN_SECRET`. Nunca reaproveita a mesma credencial por muito tempo (`ttlSeconds`, padrão 1h) —
// mesmo princípio de token de sala já usado no resto do projeto (CLAUDE.md §Segurança).
function generateTurnCredential(secret: string, ttlSeconds: number): { username: string; password: string } {
  const expiresAt = Math.floor(Date.now() / 1000) + ttlSeconds;
  const username = `${expiresAt}:ocs-screen`;
  const password = createHmac("sha1", secret).update(username).digest("base64");
  return { username, password };
}

// Sempre inclui STUN público (fallback gratuito, funciona pra maioria das conexões sem precisar
// de relay) — TURN só entra na lista se `TURN_SECRET` estiver configurado (infra própria
// provisionada, ver infra/docker/docker-compose.yml). Sem isso, clientes atrás de NAT simétrico
// (o caso que STUN sozinho não resolve) ficam sem conseguir conectar — mesma limitação que já
// existia antes desta entrega, só documentada agora com solução real.
export function getIceServers(): IceServerDescriptor[] {
  const servers: IceServerDescriptor[] = [{ urls: "stun:stun.l.google.com:19302" }];

  if (!config.turn.secret) return servers;

  const { username, password } = generateTurnCredential(config.turn.secret, config.turn.ttlSeconds);
  for (const url of config.turn.urls) {
    servers.push({ urls: url, username, credential: password });
  }
  return servers;
}
