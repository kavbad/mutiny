// Kavon's side: the application queue, approvals, and finished intakes.
import { type Env, getApp, putApp, listApps, listSessions, getSession, putInvite, id, nowISO } from "./store";

export function isAdmin(request: Request, env: Env) {
  const auth = request.headers.get("authorization") || "";
  const token = auth.replace(/^Bearer\s+/i, "").trim();
  return !!env.ADMIN_TOKEN && token.length > 0 && token === env.ADMIN_TOKEN;
}

export async function adminListApplications(env: Env) {
  const apps = await listApps(env);
  return apps.map((a) => ({
    ...a,
    inviteLink: a.inviteToken ? `${env.SITE_ORIGIN}/intake/?k=${a.inviteToken}` : null,
  }));
}

export async function adminApprove(env: Env, appId: string) {
  const app = await getApp(env, appId);
  if (!app) return { error: "no such application", status: 404 };
  if (!app.inviteToken) {
    const token = id(16);
    const createdAt = nowISO();
    const expiresAt = new Date(Date.now() + 30 * 24 * 3600 * 1000).toISOString();
    await putInvite(env, { token, applicationId: app.id, createdAt, expiresAt });
    app.inviteToken = token;
    if (app.status === "new") app.status = "invited";
    await putApp(env, app);
  }
  return { link: `${env.SITE_ORIGIN}/intake/?k=${app.inviteToken}`, app };
}

export async function adminListSessions(env: Env) {
  const sessions = await listSessions(env);
  return sessions.map((s) => ({
    id: s.id, applicationId: s.applicationId, status: s.status, turns: s.turns,
    profile: s.profile, positioning: s.positioning ?? null, chosenPosition: s.chosenPosition ?? null,
    email: s.email ?? null, usage: s.usage, createdAt: s.createdAt, updatedAt: s.updatedAt,
  }));
}

export async function adminGetSession(env: Env, sessionId: string) {
  const s = await getSession(env, sessionId);
  if (!s) return null;
  const { messages: _messages, ...rest } = s;
  return rest;
}
