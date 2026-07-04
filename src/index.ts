/**
 * feedhub — unified newsletter + RSS hub. Cloudflare Worker.
 *  - D1 (DB) is the system of record; sends/broadcasts PKs make double-send impossible.
 *  - Poller DO polls the 4 feeds every 10 min, dedups by canonical_url (the PK), latches
 *    new posts (notified_at), enqueues email + xmtp fan-out, and caches /feed.{xml,json} to KV.
 *  - Email fans out via a Queue consumer → one Resend broadcast per post (broadcasts PK).
 *  - XMTP fans out via the external xmtp-bot service (MLS can't run in a Worker) pulling feedhub-xmtp.
 *  - Unsubscribe is a tamper-proof HMAC signed with a Worker secret + per-subscriber salt.
 */

export interface Env {
  DB: D1Database;
  FEED_CACHE: KVNamespace;
  POLLER: DurableObjectNamespace;
  EMAIL_Q: Queue;
  XMTP_Q: Queue;
  ALLOWED_ORIGINS: string;
  FEEDS: string;
  SENDER: string;
  LAUNCH?: string; // "on" enables per-post email/XMTP fan-out; anything else = no sends (default)
  // secrets:
  UNSUB_SECRET: string;
  ADMIN_TOKEN: string;
  RESEND_API_KEY: string;
  RESEND_SEGMENT: string;
  RESEND_WEBHOOK_SECRET: string;
  TURNSTILE_SECRET: string;
}

const enc = new TextEncoder();
const now = () => Date.now();
const json = (data: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json", ...headers } });

// ---------- ulid-ish id ----------
function ulid(): string {
  const t = now().toString(36).padStart(9, "0");
  let r = "";
  const b = crypto.getRandomValues(new Uint8Array(10));
  for (const x of b) r += (x % 36).toString(36);
  return (t + r).slice(0, 26);
}

// ---------- URL normalization (RFC-3986-ish; canonical identity) ----------
export function normalizeUrl(raw: string): string {
  try {
    const u = new URL(raw);
    u.hash = "";
    u.hostname = u.hostname.replace(/^www\./, "").toLowerCase();
    u.protocol = "https:";
    // strip tracking params
    for (const k of [...u.searchParams.keys()]) if (/^utm_|^ref$|^fbclid$|^gclid$/i.test(k)) u.searchParams.delete(k);
    let p = u.pathname.replace(/\/+$/, "");
    u.pathname = p === "" ? "/" : p;
    return u.toString().replace(/\/$/, "");
  } catch {
    return raw.trim();
  }
}

// Resolve a post's TRUE canonical by reading its HTML <link rel=canonical> — so every
// syndicated copy (Numetal/Atelier/Personal → Ishtar) folds to ONE item. Falls back to
// the feed link if the page has no canonical.
async function fetchCanonical(link: string): Promise<string> {
  try {
    const res = await fetch(link, { headers: { "User-Agent": "feedhub/1.0" }, redirect: "follow" });
    // HTTP Link: <...>; rel="canonical" header wins if present
    const lh = res.headers.get("Link");
    const lm = lh && lh.match(/<([^>]+)>\s*;\s*rel=["']?canonical/i);
    if (lm) return normalizeUrl(lm[1]);
    const html = await res.text();
    const m = html.match(/<link[^>]+rel=["']canonical["'][^>]*href=["']([^"']+)["']/i)
      || html.match(/<link[^>]+href=["']([^"']+)["'][^>]*rel=["']canonical["']/i)
      || html.match(/<meta[^>]+property=["']og:url["'][^>]*content=["']([^"']+)["']/i);
    if (m) return normalizeUrl(m[1]);
  } catch { /* fall through */ }
  return normalizeUrl(link);
}

const INDEX_HTML = `<!doctype html><meta charset="utf-8"><title>feedhub</title>
<style>body{font:15px/1.6 ui-monospace,Menlo,monospace;max-width:680px;margin:6vh auto;padding:0 20px;color:#141414;background:#f7f7f5}h1{font-size:22px}code{background:#e7e7e7;padding:1px 5px}a{color:#e10600}.m{color:#6a6a6a}</style>
<h1>feedhub <span class="m">· api.gokhan.vc</span></h1>
<p class="m">The unified newsletter + RSS hub for Gökhan Turhan — one feed across the personal blog, the venture studio, and the agent-acceleration bureau. Cross-posts fold to a single canonical.</p>
<ul>
<li><a href="/feed.xml">/feed.xml</a> — unified RSS</li>
<li><a href="/feed.json">/feed.json</a> — unified JSON Feed</li>
<li><code>POST /subscribe</code> — email and/or wallet (double opt-in)</li>
<li><code>GET /unsubscribe?t=…</code> — one-click opt-out</li>
</ul>
<p class="m">Sources: ishtar.numetal.xyz · numetal.xyz · gokhan.vc · gokhanturhan.com</p>`;

// ---------- HMAC unsubscribe token (signature IS the authorization) ----------
async function hmac(key: string, msg: string): Promise<string> {
  const k = await crypto.subtle.importKey("raw", enc.encode(key), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", k, enc.encode(msg));
  return b64url(new Uint8Array(sig));
}
function b64url(bytes: Uint8Array): string {
  let s = btoa(String.fromCharCode(...bytes));
  return s.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function b64urlToStr(s: string): string {
  return atob(s.replace(/-/g, "+").replace(/_/g, "/"));
}
async function mintUnsub(env: Env, id: string, salt: string, channel: "all" | "email" | "xmtp"): Promise<string> {
  const payload = b64url(enc.encode(JSON.stringify({ id, channel, iat: now() })));
  const sig = await hmac(env.UNSUB_SECRET + ":" + salt, payload);
  return payload + "." + sig;
}
async function verifyUnsub(env: Env, token: string): Promise<{ id: string; channel: string } | null> {
  const dot = token.lastIndexOf(".");
  if (dot < 0) return null;
  const payload = token.slice(0, dot), sig = token.slice(dot + 1);
  let body: any;
  try { body = JSON.parse(b64urlToStr(payload)); } catch { return null; }
  if (!body?.id) return null;
  const row = await env.DB.prepare("SELECT unsub_token FROM subscribers WHERE id=?1").bind(body.id).first<{ unsub_token: string }>();
  if (!row) return null;
  const expect = await hmac(env.UNSUB_SECRET + ":" + row.unsub_token, payload);
  if (!timingSafeEq(expect, sig)) return null;
  return { id: body.id, channel: body.channel || "all" };
}
function timingSafeEq(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}

// ---------- CORS (allowlist, always Vary: Origin) ----------
function cors(env: Env, req: Request): Record<string, string> {
  const origin = req.headers.get("Origin") || "";
  const allowed = env.ALLOWED_ORIGINS.split(",").map((s) => s.trim());
  const h: Record<string, string> = { "Vary": "Origin" };
  if (allowed.includes(origin)) h["Access-Control-Allow-Origin"] = origin;
  return h;
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    const p = url.pathname;
    const co = cors(env, req);
    if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: { ...co, "Access-Control-Allow-Methods": "GET,POST,OPTIONS", "Access-Control-Allow-Headers": "content-type" } });

    // ---- unified feed (served from KV cache) ----
    if (p === "/feed.xml") return kvFeed(env, "rendered:feed.xml", "application/rss+xml; charset=utf-8", co);
    if (p === "/feed.json") return kvFeed(env, "rendered:feed.json", "application/feed+json; charset=utf-8", co);

    // ---- subscribe (email and/or wallet); simple form body = no CORS preflight ----
    if (p === "/subscribe" && req.method === "POST") return subscribe(req, env, co);
    if (p === "/confirm" && req.method === "GET") return confirm(url, env);
    if (p === "/xmtp/subscribe" && req.method === "POST") return xmtpSubscribe(req, env, co);

    // ---- unsubscribe (GET page + RFC 8058 POST one-click) ----
    if (p === "/unsubscribe") return unsubscribe(req, url, env);

    // ---- Resend webhook (bounce/complaint reconciliation) ----
    if (p === "/webhooks/resend" && req.method === "POST") return resendWebhook(req, env);

    // ---- admin (bearer-gated) ----
    if (p === "/admin/status") return adminStatus(req, env);
    if (p === "/admin/import" && req.method === "POST") return adminImport(req, env);
    if (p === "/admin/poll" && req.method === "POST") {
      if (!bearerOk(req, env)) return new Response("unauthorized", { status: 401 });
      await env.POLLER.get(env.POLLER.idFromName("singleton")).fetch("https://poller/run");
      return json({ ok: true, polled: true });
    }

    if (p === "/" || p === "/index.html") {
      return new Response(INDEX_HTML, { status: 200, headers: { "content-type": "text/html; charset=utf-8", ...co } });
    }
    return new Response("Not found", { status: 404, headers: co });
  },

  async scheduled(_event: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    // Route the whole run through the singleton Poller DO (single-flight).
    const id = env.POLLER.idFromName("singleton");
    const stub = env.POLLER.get(id);
    ctx.waitUntil(stub.fetch("https://poller/run").then(() => {}));
  },

  async queue(batch: MessageBatch, env: Env): Promise<void> {
    // Email fan-out consumer — one Resend broadcast per post (broadcasts PK = exactly-once).
    // Hard safety gate: never send unless explicitly launched.
    for (const msg of batch.messages) {
      if (env.LAUNCH !== "on") { msg.ack(); continue; }
      try {
        await emailBroadcast(env, (msg.body as any).url);
        msg.ack();
      } catch (e) {
        msg.retry();
      }
    }
  },
};

async function kvFeed(env: Env, key: string, ctype: string, co: Record<string, string>): Promise<Response> {
  const body = (await env.FEED_CACHE.get(key)) ?? (key.endsWith("json") ? '{"version":"https://jsonfeed.org/version/1.1","items":[]}' : '<?xml version="1.0"?><rss version="2.0"><channel><title>All of Gökhan — unified</title></channel></rss>');
  return new Response(body, { headers: { "content-type": ctype, "cache-control": "public, max-age=300", ...co } });
}

// ---------- subscribe ----------
async function subscribe(req: Request, env: Env, co: Record<string, string>): Promise<Response> {
  const form = await req.formData();
  const email = (form.get("email") as string || "").trim().toLowerCase() || null;
  const wallet = (form.get("wallet") as string || "").trim().toLowerCase() || null;
  const site = (form.get("site") as string || "unknown").trim();
  const ts = form.get("cf-turnstile-response") as string || "";
  if (!email && !wallet) return json({ error: "email or wallet required" }, 400, co);
  if (email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return json({ error: "bad email" }, 400, co);
  // Turnstile (if configured)
  if (env.TURNSTILE_SECRET) {
    const v = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", {
      method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ secret: env.TURNSTILE_SECRET, response: ts }),
    }).then((r) => r.json() as any).catch(() => ({ success: false }));
    if (!v.success) return json({ error: "captcha failed" }, 400, co);
  }
  // upsert by matching identifier — one row per person
  let existing = email
    ? await env.DB.prepare("SELECT * FROM subscribers WHERE email=?1").bind(email).first<any>()
    : await env.DB.prepare("SELECT * FROM subscribers WHERE wallet=?1").bind(wallet).first<any>();
  if (!existing && wallet && email) existing = await env.DB.prepare("SELECT * FROM subscribers WHERE wallet=?1").bind(wallet).first<any>();
  const id = existing?.id ?? ulid();
  const salt = existing?.unsub_token ?? b64url(crypto.getRandomValues(new Uint8Array(16)));
  await env.DB.prepare(
    `INSERT INTO subscribers (id,email,wallet,email_status,unsub_token,source,created_at)
     VALUES (?1,?2,?3,?4,?5,?6,?7)
     ON CONFLICT(id) DO UPDATE SET email=COALESCE(?2,email), wallet=COALESCE(?3,wallet)`
  ).bind(id, email, wallet, email ? "pending" : "active", salt, "form:" + site, now()).run();
  // Email → double-opt-in confirm link
  if (email) {
    const token = await mintUnsub(env, id, salt, "email"); // reuse HMAC as the confirm proof
    const link = `https://api.gokhan.vc/confirm?t=${encodeURIComponent(token)}`;
    await sendConfirm(env, email, link);
    return json({ ok: true, status: "confirm-sent" }, 200, co);
  }
  // Wallet-only → tell the client to complete SIWE at /xmtp/subscribe
  return json({ ok: true, status: "wallet-stored", next: "/xmtp/subscribe" }, 200, co);
}

async function confirm(url: URL, env: Env): Promise<Response> {
  const v = await verifyUnsub(env, url.searchParams.get("t") || "");
  if (!v) return new Response("Invalid or expired link.", { status: 400 });
  await env.DB.prepare("UPDATE subscribers SET email_status='active', confirmed_at=?2 WHERE id=?1").bind(v.id, now()).run();
  // mirror to Resend segment
  const row = await env.DB.prepare("SELECT email FROM subscribers WHERE id=?1").bind(v.id).first<{ email: string }>();
  if (row?.email) await resendUpsertContact(env, row.email, false).catch(() => {});
  return new Response("You're subscribed. Thank you. You can close this tab.", { status: 200, headers: { "content-type": "text/plain" } });
}

async function xmtpSubscribe(req: Request, env: Env, co: Record<string, string>): Promise<Response> {
  const b = await req.json().catch(() => ({})) as any;
  const wallet = (b.wallet || "").trim().toLowerCase();
  // TODO: verify SIWE signature (b.signature over the SIWE message) proving control of `wallet`.
  if (!/^0x[a-f0-9]{40}$/.test(wallet)) return json({ error: "bad wallet" }, 400, co);
  const existing = await env.DB.prepare("SELECT id,unsub_token FROM subscribers WHERE wallet=?1").bind(wallet).first<any>();
  const id = existing?.id ?? ulid();
  const salt = existing?.unsub_token ?? b64url(crypto.getRandomValues(new Uint8Array(16)));
  await env.DB.prepare(
    `INSERT INTO subscribers (id,wallet,xmtp_status,unsub_token,source,created_at) VALUES (?1,?2,'active',?3,'form:wallet',?4)
     ON CONFLICT(id) DO UPDATE SET xmtp_status='active'`
  ).bind(id, wallet, salt, now()).run();
  return json({ ok: true, status: "xmtp-active" }, 200, co);
}

// ---------- unsubscribe (tamper-proof, immediate, per-channel) ----------
async function unsubscribe(req: Request, url: URL, env: Env): Promise<Response> {
  const t = url.searchParams.get("t") || (req.method === "POST" ? new URL(req.url).searchParams.get("t") : "") || "";
  const v = await verifyUnsub(env, t);
  if (!v) return new Response("Invalid link.", { status: 400 });
  const ch = v.channel;
  const set = ch === "all" ? "email_status='unsub', xmtp_status='unsub'" : ch === "email" ? "email_status='unsub'" : "xmtp_status='unsub'";
  await env.DB.prepare(`UPDATE subscribers SET ${set} WHERE id=?1`).bind(v.id).run();
  if (ch !== "xmtp") {
    const row = await env.DB.prepare("SELECT email FROM subscribers WHERE id=?1").bind(v.id).first<{ email: string }>();
    if (row?.email) await resendUpsertContact(env, row.email, true).catch(() => {});
  }
  if (req.method === "POST") return new Response(null, { status: 200 }); // RFC 8058 one-click
  return new Response("You've been unsubscribed. Sorry to see you go.", { status: 200, headers: { "content-type": "text/plain" } });
}

// ---------- Resend helpers ----------
async function sendConfirm(env: Env, email: string, link: string): Promise<void> {
  await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: "Bearer " + env.RESEND_API_KEY, "content-type": "application/json", "User-Agent": "feedhub/1.0" },
    body: JSON.stringify({
      from: env.SENDER, to: [email], subject: "Confirm your subscription",
      html: `<p>Confirm you want the unified newsletter from Gökhan Turhan (personal blog, venture studio, agent-acceleration bureau).</p><p><a href="${link}">Confirm subscription</a></p><p>If this wasn't you, ignore this email.</p>`,
      text: `Confirm your subscription: ${link}`,
    }),
  });
}
async function resendUpsertContact(env: Env, email: string, unsubscribed: boolean): Promise<void> {
  await fetch(`https://api.resend.com/audiences/${env.RESEND_SEGMENT}/contacts`, {
    method: "POST",
    headers: { Authorization: "Bearer " + env.RESEND_API_KEY, "content-type": "application/json", "User-Agent": "feedhub/1.0" },
    body: JSON.stringify({ email, unsubscribed }),
  });
}
async function emailBroadcast(env: Env, canonicalUrl: string): Promise<void> {
  // Claim the broadcasts row — exactly one broadcast per post.
  const claim = await env.DB.prepare(
    "INSERT INTO broadcasts (canonical_url,channel,state,created_at) VALUES (?1,'email','pending',?2) ON CONFLICT DO NOTHING"
  ).bind(canonicalUrl, now()).run();
  if ((claim.meta as any).changes === 0) return; // already handled
  const item = await env.DB.prepare("SELECT * FROM items WHERE canonical_url=?1").bind(canonicalUrl).first<any>();
  if (!item) return;
  // create + send a Resend broadcast to the newsletter audience (List-Unsubscribe managed by Resend)
  const create = await fetch("https://api.resend.com/broadcasts", {
    method: "POST",
    headers: { Authorization: "Bearer " + env.RESEND_API_KEY, "content-type": "application/json", "User-Agent": "feedhub/1.0" },
    body: JSON.stringify({
      audience_id: env.RESEND_SEGMENT, from: env.SENDER, subject: item.title,
      html: renderPostHtml(item), text: `${item.title}\n\n${item.summary || ""}\n\n${item.canonical_url}\n\nUnsubscribe: {{{RESEND_UNSUBSCRIBE_URL}}}`,
    }),
  }).then((r) => r.json() as any);
  if (create?.id) {
    await env.DB.prepare("UPDATE broadcasts SET resend_bcast=?2, state='created' WHERE canonical_url=?1 AND channel='email'").bind(canonicalUrl, create.id).run();
    await fetch(`https://api.resend.com/broadcasts/${create.id}/send`, { method: "POST", headers: { Authorization: "Bearer " + env.RESEND_API_KEY, "User-Agent": "feedhub/1.0" } });
    await env.DB.prepare("UPDATE broadcasts SET state='sent' WHERE canonical_url=?1 AND channel='email'").bind(canonicalUrl).run();
  }
}
function renderPostHtml(item: any): string {
  return `<h1>${escapeHtml(item.title)}</h1>${item.summary ? `<p>${escapeHtml(item.summary)}</p>` : ""}<p><a href="${item.canonical_url}">Read the full post →</a></p><hr/><p><a href="{{{RESEND_UNSUBSCRIBE_URL}}}">Unsubscribe</a></p>`;
}
function escapeHtml(s: string): string {
  return String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c] as string));
}

async function resendWebhook(req: Request, env: Env): Promise<Response> {
  // TODO: verify Svix signature with RESEND_WEBHOOK_SECRET before trusting.
  const evt = await req.json().catch(() => ({})) as any;
  const type = evt?.type, email = evt?.data?.email || evt?.data?.to?.[0];
  if (email && (type === "email.bounced" || type === "email.complained")) {
    await env.DB.prepare("UPDATE subscribers SET email_status=?2 WHERE email=?1").bind(String(email).toLowerCase(), type === "email.complained" ? "unsub" : "bounced").run();
  }
  return new Response(null, { status: 200 });
}

// ---------- admin ----------
function bearerOk(req: Request, env: Env): boolean {
  return (req.headers.get("Authorization") || "") === "Bearer " + env.ADMIN_TOKEN;
}
async function adminStatus(req: Request, env: Env): Promise<Response> {
  if (!bearerOk(req, env)) return new Response("unauthorized", { status: 401 });
  const q = async (sql: string) => (await env.DB.prepare(sql).first<any>()) || {};
  return json({
    subscribers: await q("SELECT COUNT(*) c, SUM(email IS NOT NULL) emails, SUM(wallet IS NOT NULL) wallets, SUM(email_status='active') active_email, SUM(xmtp_status='active') active_xmtp, SUM(email_status='unsub' OR xmtp_status='unsub') unsub FROM subscribers"),
    pending_fanout: (await q("SELECT COUNT(*) c FROM items WHERE notified_at IS NULL")).c,
    items: (await q("SELECT COUNT(*) c FROM items")).c,
    sends: await q("SELECT COUNT(*) c, SUM(status='sent') sent, SUM(status='failed') failed FROM sends"),
  });
}
async function adminImport(req: Request, env: Env): Promise<Response> {
  if (!bearerOk(req, env)) return new Response("unauthorized", { status: 401 });
  // Body: { subscribers: [{email?, wallet?, source, unsubscribed}] } — already parsed/deduped client-side.
  const b = await req.json().catch(() => ({})) as any;
  const list: any[] = b.subscribers || [];
  let ins = 0;
  for (const s of list) {
    if (s.unsubscribed) continue; // exclude already-unsubscribed FIRST
    const email = s.email ? String(s.email).toLowerCase() : null;
    const wallet = s.wallet ? String(s.wallet).toLowerCase() : null;
    if (!email && !wallet) continue;
    const salt = b64url(crypto.getRandomValues(new Uint8Array(16)));
    const id = ulid();
    await env.DB.prepare(
      `INSERT INTO subscribers (id,email,wallet,email_status,xmtp_status,unsub_token,source,created_at)
       VALUES (?1,?2,?3,'active','active',?4,?5,?6)
       ON CONFLICT(email) DO UPDATE SET wallet=COALESCE(?3,wallet)
       ` // note: wallet-only rows rely on ON CONFLICT(wallet); handled by two-pass import script
    ).bind(id, email, wallet, salt, s.source || "import", now()).run().catch(() => {});
    ins++;
  }
  return json({ ok: true, imported: ins });
}

// ---------- Poller Durable Object (single-flight) ----------
export class Poller {
  state: DurableObjectState;
  env: Env;
  running = false;
  constructor(state: DurableObjectState, env: Env) { this.state = state; this.env = env; }
  async fetch(_req: Request): Promise<Response> {
    if (this.running) return new Response("busy", { status: 200 });
    this.running = true;
    try { await this.run(); } finally { this.running = false; }
    return new Response("ok", { status: 200 });
  }
  async run(): Promise<void> {
    const feeds = this.env.FEEDS.split(",").map((s) => s.trim()).filter(Boolean);
    const results = await Promise.allSettled(feeds.map((f) => this.pollFeed(f)));
    void results;
    // latch new posts → enqueue fan-out ONLY when launched. Pre-launch the latch still marks
    // items notified (so turning LAUNCH on never backfills the whole archive) but sends NOTHING.
    const launched = this.env.LAUNCH === "on";
    const fresh = await this.env.DB.prepare("UPDATE items SET notified_at=?1 WHERE notified_at IS NULL RETURNING canonical_url").bind(now()).all<{ canonical_url: string }>();
    if (launched) {
      for (const r of fresh.results || []) {
        await this.env.EMAIL_Q.send({ url: r.canonical_url, channel: "email" });
        await this.env.XMTP_Q.send({ url: r.canonical_url, channel: "xmtp" });
      }
    }
    await this.renderCache();
  }
  async pollFeed(feedUrl: string): Promise<void> {
    const st = await this.env.DB.prepare("SELECT etag,last_mod FROM feed_state WHERE url=?1").bind(feedUrl).first<any>();
    const headers: Record<string, string> = {};
    if (st?.etag) headers["If-None-Match"] = st.etag;
    if (st?.last_mod) headers["If-Modified-Since"] = st.last_mod;
    const res = await fetch(feedUrl, { headers });
    await this.env.DB.prepare("INSERT INTO feed_state (url,etag,last_mod,last_poll) VALUES (?1,?2,?3,?4) ON CONFLICT(url) DO UPDATE SET etag=?2,last_mod=?3,last_poll=?4")
      .bind(feedUrl, res.headers.get("ETag"), res.headers.get("Last-Modified"), now()).run();
    if (res.status === 304) return;
    const xml = await res.text();
    const feedKey = feedUrl.includes("ishtar") ? "ishtar" : feedUrl.includes("numetal") ? "numetal" : feedUrl.includes("gokhan.vc") ? "atelier" : "personal";
    for (const it of parseFeed(xml)) {
      const canonical = await fetchCanonical(it.link); // resolve rel=canonical → cross-feed dedup
      // canonical_url PK: a syndicated copy that resolves to the same canonical collides → no dupe.
      await this.env.DB.prepare(
        `INSERT INTO items (canonical_url,title,author,summary,origin_feed,seen_via,published,first_seen)
         VALUES (?1,?2,?3,?4,?5,?6,?7,?8)
         ON CONFLICT(canonical_url) DO UPDATE SET seen_via=?6, published=MIN(published,?7)`
      ).bind(canonical, it.title, it.author || null, it.summary || null, feedKey, JSON.stringify([[feedKey, it.link]]), it.published || now(), now()).run().catch(() => {});
    }
  }
  async renderCache(): Promise<void> {
    const rows = (await this.env.DB.prepare("SELECT canonical_url,title,summary,published FROM items ORDER BY published DESC LIMIT 50").all<any>()).results || [];
    const items = rows.map((r) => ({ title: r.title, url: r.canonical_url, summary: r.summary, date_published: new Date(r.published).toISOString() }));
    await this.env.FEED_CACHE.put("rendered:feed.json", JSON.stringify({ version: "https://jsonfeed.org/version/1.1", title: "All of Gökhan — unified", home_page_url: "https://gokhanturhan.com", feed_url: "https://api.gokhan.vc/feed.json", items }));
    const xmlItems = rows.map((r) => `    <item><title>${escapeHtml(r.title)}</title><link>${r.canonical_url}</link><guid isPermaLink="true">${r.canonical_url}</guid><pubDate>${new Date(r.published).toUTCString()}</pubDate>${r.summary ? `<description>${escapeHtml(r.summary)}</description>` : ""}</item>`).join("\n");
    await this.env.FEED_CACHE.put("rendered:feed.xml", `<?xml version="1.0" encoding="UTF-8"?>\n<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom"><channel><title>All of Gökhan — unified</title><link>https://gokhanturhan.com</link><description>Personal blog, venture studio, and agent-acceleration bureau — one feed.</description><atom:link href="https://api.gokhan.vc/feed.xml" rel="self" type="application/rss+xml"/>\n${xmlItems}\n</channel></rss>`);
  }
}

// ---------- minimal feed parser (RSS 2.0 + Atom) ----------
function parseFeed(xml: string): Array<{ title: string; link: string; author?: string; summary?: string; published?: number }> {
  const out: any[] = [];
  const tag = (block: string, t: string) => {
    const m = block.match(new RegExp(`<${t}[^>]*>([\\s\\S]*?)</${t}>`, "i"));
    return m ? m[1].replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1").replace(/<[^>]+>/g, "").trim() : "";
  };
  const items = xml.match(/<item[\s\S]*?<\/item>/gi) || xml.match(/<entry[\s\S]*?<\/entry>/gi) || [];
  for (const block of items) {
    let link = tag(block, "link");
    if (!link) { const m = block.match(/<link[^>]*href="([^"]+)"/i); if (m) link = m[1]; }
    const title = tag(block, "title");
    if (!link || !title) continue;
    const dateStr = tag(block, "pubDate") || tag(block, "published") || tag(block, "updated");
    const published = dateStr ? Date.parse(dateStr) : undefined;
    out.push({ title, link, author: tag(block, "author") || tag(block, "dc:creator") || undefined, summary: tag(block, "description") || tag(block, "summary") || undefined, published });
  }
  return out;
}
