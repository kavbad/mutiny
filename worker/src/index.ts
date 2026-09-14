// mutiny-api: the Worker behind mutiny.ai's intake.
import {
  type Env, type Application, type SessionRecord,
  getApp, putApp, getInvite, putInvite, getSession, putSession,
  rateLimit, getDailyOutputTokens, id, nowISO,
} from "./store";
import { runTurn, type Frame } from "./rebel";
import { isAdmin, adminListApplications, adminApprove, adminListSessions, adminGetSession } from "./admin";

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

function corsHeaders(request: Request, env: Env): Record<string, string> {
  const origin = request.headers.get("origin") || "";
  const allowed = (env.ALLOWED_ORIGINS || "").split(",").map((s) => s.trim()).filter(Boolean);
  const ok = allowed.includes(origin) || /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin);
  return {
    "access-control-allow-origin": ok ? origin : allowed[0] || "",
    "access-control-allow-methods": "GET, POST, OPTIONS",
    "access-control-allow-headers": "content-type, authorization",
    "access-control-max-age": "86400",
    "vary": "origin",
  };
}

const json = (body: unknown, status = 200, extra: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json; charset=utf-8", ...extra } });

async function readJSON<T>(request: Request): Promise<T | null> {
  try { return (await request.json()) as T; } catch { return null; }
}

const ipOf = (r: Request) => r.headers.get("cf-connecting-ip") || r.headers.get("x-forwarded-for") || "local";

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const cors = corsHeaders(request, env);
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
    try {
      const res = await route(request, env, ctx);
      for (const [k, v] of Object.entries(cors)) res.headers.set(k, v);
      return res;
    } catch (e) {
      console.error(e);
      return json({ error: "something broke on our side" }, 500, cors);
    }
  },
};

async function route(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const url = new URL(request.url);
  const path = url.pathname.replace(/\/+$/, "") || "/";
  const m = request.method;
  const ip = ipOf(request);

  if (path === "/" && m === "GET") return json({ ok: true, service: "mutiny-api" });

  // ---- applications ----
  if (path === "/applications" && m === "POST") {
    const body = await readJSON<{ name?: string; email?: string; idea?: string; stage?: string; website?: string }>(request);
    if (!body) return json({ error: "bad request" }, 400);
    if (body.website) return json({ ok: true }); // honeypot: bots fill it, people never see it
    const name = String(body.name || "").trim().slice(0, 120);
    const email = String(body.email || "").trim().toLowerCase().slice(0, 200);
    const idea = String(body.idea || "").trim().slice(0, 1200);
    const stage = String(body.stage || "").trim().slice(0, 60);
    if (name.length < 1) return json({ error: "Tell us your name." }, 400);
    if (!EMAIL.test(email)) return json({ error: "That email doesn't look right." }, 400);
    if (!(await rateLimit(env, "apply", ip, 5, 3600))) return json({ error: "Too many applications from this connection. Try again in an hour." }, 429);
    const app: Application = { id: id(12), name, email, idea, stage, createdAt: nowISO(), status: "new" };
    await putApp(env, app);
    return json({ ok: true, id: app.id });
  }

  // ---- admin ----
  if (path.startsWith("/admin")) {
    if (!isAdmin(request, env)) return json({ error: "unauthorized" }, 401);
    if (path === "/admin/applications" && m === "GET") return json(await adminListApplications(env));
    if (path === "/admin/approve" && m === "POST") {
      const body = await readJSON<{ id?: string }>(request);
      if (!body?.id) return json({ error: "id required" }, 400);
      const r = await adminApprove(env, body.id);
      if ("error" in r) return json({ error: r.error }, r.status);
      return json(r);
    }
    if (path === "/admin/sessions" && m === "GET") return json(await adminListSessions(env));
    const sm = path.match(/^\/admin\/sessions\/([a-f0-9]{16,64})$/);
    if (sm && m === "GET") { const s = await adminGetSession(env, sm[1]); return s ? json(s) : json({ error: "not found" }, 404); }
    return json({ error: "not found" }, 404);
  }

  // ---- sessions ----
  if (path === "/sessions" && m === "POST") {
    const body = await readJSON<{ k?: string }>(request);
    const k = String(body?.k || "").trim();
    if (!/^[a-f0-9]{32}$/.test(k)) return json({ error: "This link isn't valid." }, 400);
    if (!(await rateLimit(env, "open", ip, 20, 3600))) return json({ error: "Slow down a little." }, 429);
    const inv = await getInvite(env, k);
    if (!inv) return json({ error: "This link isn't valid." }, 404);
    if (inv.sessionId) return json({ sessionId: inv.sessionId, resumed: true });
    if (new Date(inv.expiresAt).getTime() < Date.now()) return json({ error: "This link has expired. Write to us and we'll send another." }, 410);
    const app = await getApp(env, inv.applicationId);
    if (!app) return json({ error: "This link isn't valid." }, 404);
    const session: SessionRecord = {
      id: id(16), applicationId: app.id, createdAt: nowISO(), updatedAt: nowISO(), status: "open", turns: 0,
      messages: [], profile: {}, renders: [], pendingResults: [],
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    };
    await putSession(env, session);
    inv.sessionId = session.id; await putInvite(env, inv);
    app.sessionId = session.id; app.status = "started"; await putApp(env, app);
    return json({ sessionId: session.id, resumed: false, founder: { name: app.name } });
  }

  const sm = path.match(/^\/sessions\/([a-f0-9]{32})(?:\/(turn|finish))?$/);
  if (sm) {
    const session = await getSession(env, sm[1]);
    if (!session) return json({ error: "No such conversation." }, 404);
    const app = await getApp(env, session.applicationId);
    if (!app) return json({ error: "No such conversation." }, 404);

    if (!sm[2] && m === "GET") {
      return json({
        status: session.status, turns: session.turns, profile: session.profile, renders: session.renders,
        pending: session.pendingTerminal ? { name: session.pendingTerminal.name, input: session.pendingTerminal.input } : null,
        email: session.email ?? null, founder: { name: app.name },
      });
    }

    if (sm[2] === "finish" && m === "POST") {
      const body = await readJSON<{ email?: string }>(request);
      const email = String(body?.email || "").trim().toLowerCase();
      if (!EMAIL.test(email)) return json({ error: "That email doesn't look right." }, 400);
      session.email = email; if (session.status === "open") session.status = "done";
      await putSession(env, session);
      app.finishedEmail = email; app.finishedAt = nowISO(); app.status = "done"; await putApp(env, app);
      return json({ ok: true });
    }

    if (sm[2] === "turn" && m === "POST") {
      const body = await readJSON<{ text?: string }>(request);
      const text = String(body?.text || "").slice(0, 4000);
      if (session.status === "capped") return json({ error: "This conversation has ended." }, 409);
      if (!(await rateLimit(env, "turn", ip, 30, 600))) return json({ error: "Rebel needs a breath. Try again in a few minutes." }, 429);
      const ceiling = Number(env.DAILY_TOKEN_CEILING || "0");
      if (ceiling && (await getDailyOutputTokens(env)) > ceiling) return json({ error: "Rebel has talked to a lot of founders today. Come back tomorrow; your link still works." }, 503);
      return streamTurn(env, ctx, app, session, text);
    }
  }

  return json({ error: "not found" }, 404);
}

function streamTurn(env: Env, ctx: ExecutionContext, app: Application, session: SessionRecord, text: string): Response {
  const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
  const writer = writable.getWriter();
  const enc = new TextEncoder();
  let closed = false;
  const send = (s: string) => { if (!closed) writer.write(enc.encode(s)).catch(() => { closed = true; }); };
  const emit = (f: Frame) => send(`data: ${JSON.stringify(f)}\n\n`);
  const ping = setInterval(() => send(`: ping\n\n`), 15000);

  // If the turn fails, the session goes back to how it was, so the founder can simply say it again.
  const snapshot = JSON.stringify(session);
  ctx.waitUntil((async () => {
    try {
      await runTurn(env, app, session, text, emit);
    } catch (e) {
      console.error(e);
      Object.assign(session, JSON.parse(snapshot) as SessionRecord);
      emit({ type: "error", message: "Rebel lost the thread for a moment. Say that again." });
    } finally {
      clearInterval(ping);
      try { await putSession(env, session); } catch (e) { console.error(e); }
      emit({ type: "done", status: session.status });
      closed = true;
      try { await writer.close(); } catch {}
    }
  })());

  return new Response(readable, {
    headers: { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-cache, no-transform", "x-accel-buffering": "no" },
  });
}
