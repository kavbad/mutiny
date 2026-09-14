// KV-backed storage for applications, invites, sessions, rate limits, and daily usage.
import type Anthropic from "@anthropic-ai/sdk";

export interface Env {
  KV: KVNamespace;
  ANTHROPIC_API_KEY: string;
  ADMIN_TOKEN: string;
  ALLOWED_ORIGINS: string;
  SITE_ORIGIN: string;
  WORLD_MODEL: string;
  WORLD_MODEL_URL: string;
  DAILY_TOKEN_CEILING: string;
  MAX_TURNS: string;
}

export type FounderProfile = {
  idea?: string;
  goal?: string;
  time?: string;
  background?: string;
  constraints?: string;
  noticed?: string;
};

export type Application = {
  id: string;
  name: string;
  email: string;
  idea: string;
  stage: string;
  createdAt: string;
  status: "new" | "invited" | "started" | "done";
  inviteToken?: string;
  sessionId?: string;
  finishedEmail?: string;
  finishedAt?: string;
};

export type Invite = {
  token: string;
  applicationId: string;
  createdAt: string;
  expiresAt: string;
  sessionId?: string;
};

// A render is anything the page drew for this session; stored so a reload can replay it.
export type Render =
  | { kind: "rebel"; text: string }
  | { kind: "you"; text: string }
  | { kind: "tool"; name: string; input: unknown }
  | { kind: "field"; reading: unknown };

export type Positioning = {
  headline: string;
  strengths: string[];
  weaknesses: string[];
  opportunities: string[];
};

export type SessionRecord = {
  id: string;
  applicationId: string;
  createdAt: string;
  updatedAt: string;
  status: "open" | "done" | "capped";
  turns: number;
  messages: Anthropic.Beta.BetaMessageParam[];
  profile: FounderProfile;
  renders: Render[];
  // Tool calls from the last assistant turn that still need results on the next user turn.
  pendingResults: Anthropic.Beta.BetaToolResultBlockParam[];
  pendingTerminal?: { id: string; name: string; input: unknown };
  chosenPosition?: string;
  positioning?: Positioning;
  fieldReading?: unknown;
  email?: string;
  usage: { input: number; output: number; cacheRead: number; cacheWrite: number };
};

export const nowISO = () => new Date().toISOString();

export function id(bytes = 16): string {
  const a = new Uint8Array(bytes);
  crypto.getRandomValues(a);
  return Array.from(a, (b) => b.toString(16).padStart(2, "0")).join("");
}

const json = <T>(v: T) => JSON.stringify(v);

export async function getApp(env: Env, appId: string) {
  return env.KV.get<Application>(`app:${appId}`, "json");
}
export async function putApp(env: Env, app: Application) {
  await env.KV.put(`app:${app.id}`, json(app));
}
export async function listApps(env: Env): Promise<Application[]> {
  const out: Application[] = [];
  let cursor: string | undefined;
  do {
    const page = await env.KV.list({ prefix: "app:", cursor });
    const got = await Promise.all(page.keys.map((k) => env.KV.get<Application>(k.name, "json")));
    for (const a of got) if (a) out.push(a);
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor);
  return out.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

export async function getInvite(env: Env, token: string) {
  return env.KV.get<Invite>(`inv:${token}`, "json");
}
export async function putInvite(env: Env, inv: Invite) {
  await env.KV.put(`inv:${inv.token}`, json(inv));
}

export async function getSession(env: Env, sessionId: string) {
  return env.KV.get<SessionRecord>(`session:${sessionId}`, "json");
}
export async function putSession(env: Env, s: SessionRecord) {
  s.updatedAt = nowISO();
  await env.KV.put(`session:${s.id}`, json(s));
}
export async function listSessions(env: Env): Promise<SessionRecord[]> {
  const out: SessionRecord[] = [];
  let cursor: string | undefined;
  do {
    const page = await env.KV.list({ prefix: "session:", cursor });
    const got = await Promise.all(page.keys.map((k) => env.KV.get<SessionRecord>(k.name, "json")));
    for (const s of got) if (s) out.push(s);
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor);
  return out.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

// Fixed-window counter per (kind, ip). Returns true when the request is allowed.
export async function rateLimit(env: Env, kind: string, ip: string, limit: number, windowSec: number) {
  const win = Math.floor(Date.now() / 1000 / windowSec);
  const key = `rl:${kind}:${ip}:${win}`;
  const n = Number((await env.KV.get(key)) ?? "0") + 1;
  await env.KV.put(key, String(n), { expirationTtl: windowSec * 2 });
  return n <= limit;
}

const dayKey = () => `usage:day:${new Date().toISOString().slice(0, 10)}`;
export async function getDailyOutputTokens(env: Env) {
  return Number((await env.KV.get(dayKey())) ?? "0");
}
export async function addDailyOutputTokens(env: Env, n: number) {
  const key = dayKey();
  const total = Number((await env.KV.get(key)) ?? "0") + n;
  await env.KV.put(key, String(total), { expirationTtl: 60 * 60 * 48 });
  return total;
}
