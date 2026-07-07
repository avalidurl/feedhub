/**
 * feedhub — unified newsletter + RSS hub. Cloudflare Worker.
 *  - D1 (DB) is the system of record; sends/broadcasts PKs make double-send impossible.
 *  - Poller DO polls the 4 feeds every 10 min, dedups by canonical_url (the PK), latches
 *    new posts (notified_at), enqueues email + xmtp fan-out, and caches /feed.{xml,json} to KV.
 *  - Email fans out via a Queue consumer → one Resend broadcast per post (broadcasts PK).
 *  - XMTP fans out via the external xmtp-bot service (MLS can't run in a Worker) pulling feedhub-xmtp.
 *  - Unsubscribe is a tamper-proof HMAC signed with a Worker secret + per-subscriber salt.
 */
import { recoverMessageAddress } from "viem";

import type { PaymentEnv } from "./payments/env";
import { fetchLlmsAggregate, llmsCombinedText, SOCIAL_CATALOG } from "./estate";
import { listBlogSites, readBlogPost } from "./blog";
import { handleAgentEmail } from "./agent-email";
import { agentEmailRecipientMap } from "./agent-email-recipients";
import { buildOpenApi } from "./discovery/openapi";
import { AGENT_EMAIL_SKU, skuDescription, x402Requirements } from "./payments/x402";
import { assetR2Key, serveAsset } from "./assets";

export interface Env extends PaymentEnv {
  DB: D1Database;
  FEED_CACHE: KVNamespace;
  ASSETS: R2Bucket;
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
  XMTP_BOT_TOKEN: string; // least-privilege bearer for the xmtp-bot (only /admin/xmtp/*)
  RESEND_API_KEY: string;
  RESEND_SEGMENT: string;
  RESEND_WEBHOOK_SECRET: string;
  TURNSTILE_SECRET: string;
  AGENT_EMAIL_SENDER?: string;
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

// ---------- Aggregate API catalog (api.gokhan.vc is the front door to the whole estate) ----------
// GET / content-negotiates: JSON for agents, HTML for browsers. GET /_meta always returns this JSON.
const CATALOG = {
  name: "api.gokhan.vc",
  description: "Aggregate API front door for Gökhan Turhan's web estate — one endpoint, many services.",
  version: "2",
  docs: "https://api.gokhan.vc/",
  discovery: {
    openapi: "https://api.gokhan.vc/openapi.json",
    x402: "https://api.gokhan.vc/.well-known/x402",
  },
  services: [
    {
      id: "feed", title: "Unified cross-site RSS + JSON feed", kind: "local", auth: "none", status: "live",
      base_path: "/feed",
      endpoints: [
        { method: "GET", path: "/feed.xml", desc: "Unified RSS 2.0 across all sites (permanent alias)" },
        { method: "GET", path: "/feed.json", desc: "Unified JSON Feed 1.1 (permanent alias)" },
        { method: "GET", path: "/feed/rss.xml", desc: "Namespaced RSS 2.0 (same body)" },
        { method: "GET", path: "/feed/feed.json", desc: "Namespaced JSON Feed (same body)" },
      ],
      sources: ["ishtar.numetal.xyz", "numetal.xyz", "gokhan.vc", "gokhanturhan.com"],
    },
    {
      id: "newsletter", title: "Newsletter subscription (email + XMTP)", kind: "local", auth: "hmac-token", status: "live",
      base_path: "/newsletter",
      endpoints: [
        { method: "POST", path: "/newsletter/subscribe", auth: "none", desc: "Subscribe email and/or wallet (double opt-in)" },
        { method: "GET", path: "/newsletter/confirm?t=", auth: "hmac-token", desc: "Confirm an email subscription" },
        { method: "POST", path: "/newsletter/xmtp/subscribe", auth: "wallet-sig (SIWE — enforcement pending)", desc: "Subscribe a wallet for XMTP" },
        { method: "GET|POST", path: "/newsletter/unsubscribe?t=", auth: "hmac-token", desc: "One-click opt-out (RFC 8058)" },
      ],
      legacy_aliases: ["/subscribe", "/confirm", "/unsubscribe", "/xmtp/subscribe", "/webhooks/resend", "/admin/*"],
      note: "Legacy root paths (/confirm, /unsubscribe, /feed.xml, /feed.json) are permanent — they are baked into already-sent mail and published feeds.",
    },
    {
      id: "numetal", title: "$NUMETAL fee engine + status", kind: "proxy", canonical_host: "numetal.xyz", auth: "none", status: "live",
      base_path: "/numetal",
      endpoints: [
        { method: "GET", path: "/numetal/fees", desc: "Live $NUMETAL snapshot (price, supply, burned, fdv, mcap)" },
        { method: "GET", path: "/numetal/burns", desc: "Fee-engine burn/buyback events" },
        { method: "GET", path: "/numetal/status", desc: "Public status.numetal.xyz snapshot" },
      ],
    },
    {
      id: "ishtar", title: "Ishtar — agentic dating (x402 / MPP)", kind: "link", canonical_host: "api.ishtar.numetal.xyz", auth: "x402 (Base + Solana) | mpp | wallet-sig", status: "live",
      base_path: "/ishtar",
      discovery: { skill: "https://api.ishtar.numetal.xyz/skill", well_known: "https://api.ishtar.numetal.xyz/.well-known/x402", mcp: "https://api.ishtar.numetal.xyz/mcp" },
      note: "Payments terminate at the canonical host. The gateway LINKS, never proxies — so the x402/MPP 402 realm and payTo stay intact for CDP Bazaar / x402scan / mppscan settlement.",
    },
    {
      id: "heartbench", title: "HeartBench — model-dating leaderboard", kind: "link", canonical_host: "api.ishtar.numetal.xyz", auth: "none", status: "live",
      base_path: "/heartbench",
      link: "https://api.ishtar.numetal.xyz/api/heartbench",
    },
    {
      id: "llms", title: "Estate llms.txt aggregate", kind: "local", auth: "none", status: "live",
      base_path: "/llms",
      endpoints: [
        { method: "GET", path: "/llms", desc: "JSON map of llms.txt per estate site (KV-cached 1h)" },
        { method: "GET", path: "/llms.txt", desc: "Combined plain-text llms index" },
        { method: "GET", path: "/llms?full=1", desc: "Include llms-full.txt where available (ishtar only)" },
      ],
      sources: ["ishtar.numetal.xyz", "numetal.xyz", "gokhan.vc", "gokhanturhan.com"],
    },
    {
      id: "blog", title: "Unified blog reader", kind: "local", auth: "none", status: "live",
      base_path: "/blog",
      endpoints: [
        { method: "GET", path: "/blog/{site}/{slug}", desc: "Post body as JSON (content_text + metadata)" },
        { method: "GET", path: "/blog?site=&slug=", desc: "Query-string alias" },
      ],
      sites: ["ishtar", "numetal", "gokhanvc", "memex"],
    },
    {
      id: "social", title: "Social follow + join links", kind: "local", auth: "none", status: "live",
      base_path: "/social",
      endpoints: [{ method: "GET", path: "/social", desc: "Structured follow/join/contact catalog per property" }],
    },
    {
      id: "agent-email", title: "Paid agent cold email", kind: "local", auth: "x402 | mpp", status: "live",
      base_path: "/agent",
      endpoints: [
        { method: "POST", path: "/agent/email", auth: "x402 | mpp", desc: "$1 USDC per email — bare POST returns 402 (no send); recipient keys at GET /agent" },
        { method: "GET", path: "/agent", auth: "none", desc: "Service descriptor + recipient key→inbox map + 402 probe hint" },
      ],
      payTo: { x402_base: "0x36de990133D36d7E3DF9a820aA3eDE5a2320De71", mpp_tempo: "0x3e267aA9439C82FfB36078676E67901a1ca6D352" },
      convention: "Subject should include [PAID x402] or [PAID MPP]; payment tx/order id in body helps triage.",
    },
  ],
};

function catalogHtml(): string {
  const svc = CATALOG.services.map((s) => {
    const eps = ("endpoints" in s && s.endpoints ? s.endpoints : []).map((e: any) =>
      `<li><code>${e.method} ${e.path}</code> <span class="m">— ${e.desc}${e.auth && e.auth !== "none" ? ` · <em>${e.auth}</em>` : ""}</span></li>`).join("");
    const link = ("link" in s && s.link) ? s.link : (("canonical_host" in s && s.canonical_host && s.kind === "link") ? `https://${s.canonical_host}/` : "");
    return `<section><h2>${escapeHtml(s.title)} <span class="tag">${s.kind}</span></h2>` +
      (("note" in s && s.note) ? `<p class="m">${escapeHtml(String(s.note))}</p>` : "") +
      (eps ? `<ul>${eps}</ul>` : (link ? `<p><a href="${link}">${link}</a></p>` : "")) + `</section>`;
  }).join("");
  return `<!doctype html><meta charset="utf-8"><title>api.gokhan.vc</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<link rel="alternate" type="application/json" href="/openapi.json" title="OpenAPI 3.1">
<style>body{font:15px/1.65 ui-monospace,Menlo,monospace;max-width:720px;margin:6vh auto;padding:0 20px;color:#141414;background:#f7f7f5}h1{font-size:22px;margin-bottom:2px}h2{font-size:15px;margin:26px 0 6px;border-top:1px solid #ddd;padding-top:18px}code{background:#e7e7e7;padding:1px 5px;font-size:13px}a{color:#e10600}.m{color:#6a6a6a}em{color:#8a5a00;font-style:normal}ul{padding-left:18px}.tag{font-size:10px;background:#141414;color:#f7f7f5;padding:1px 6px;vertical-align:middle;text-transform:uppercase;letter-spacing:.05em}</style>
<h1>api.gokhan.vc</h1>
<p class="m">${escapeHtml(CATALOG.description)} <br>Machine catalog: <a href="/_meta">/_meta</a> · Health: <a href="/health">/health</a></p>
<section><h2>Discovery <span class="tag">agents</span></h2><ul>
<li><code>GET /openapi.json</code> <span class="m">— OpenAPI 3.1 (x402scan / MPPscan read this)</span></li>
<li><code>GET /.well-known/x402</code> <span class="m">— x402 payment discovery</span></li>
</ul></section>
${svc}`;
}

// ---------- subscribe form (hosted on the gateway; native POST, no JS → works under any site CSP) ----------
const PAGE_CSS = `body{font:15px/1.6 ui-monospace,Menlo,monospace;max-width:520px;margin:12vh auto;padding:0 24px;color:#141414;background:#f7f7f5}h1{font-size:22px;margin:0 0 6px}.m{color:#6a6a6a;font-size:13px}form{margin:22px 0}input[type=email]{width:100%;box-sizing:border-box;padding:11px 12px;border:1px solid #141414;background:#fff;font:inherit;margin-bottom:10px}button{padding:11px 20px;border:1px solid #141414;background:#141414;color:#f7f7f5;font:inherit;cursor:pointer}button:hover{background:#e10600;border-color:#e10600}a{color:#e10600}`;
function subscribeForm(site: string): string {
  const s = escapeHtml(site);
  return `<!doctype html><meta charset="utf-8"><title>Subscribe — Gökhan Turhan</title>
<meta name="viewport" content="width=device-width,initial-scale=1"><style>${PAGE_CSS}</style>
<h1>Subscribe</h1>
<p class="m">One newsletter across everything I make — Ishtar, Numetal, the journal, the brief. Signal only.</p>
<form method="POST" action="https://api.gokhan.vc/newsletter/subscribe">
  <input type="email" name="email" required autofocus placeholder="you@email.com" autocomplete="email">
  <input type="hidden" name="site" value="${s}">
  <button type="submit">Subscribe</button>
</form>
<p class="m">Double opt-in — you'll get one email to confirm. Unsubscribe anytime, one click.</p>`;
}
function subscribeThanks(): string {
  return `<!doctype html><meta charset="utf-8"><title>Almost there — Gökhan Turhan</title>
<meta name="viewport" content="width=device-width,initial-scale=1"><style>${PAGE_CSS}</style>
<h1>Almost there.</h1>
<p>Check your inbox for a confirmation link — click it and you're in.</p>
<p class="m">Didn't get it? Give it a minute, then check spam. <a href="https://api.gokhan.vc/newsletter/subscribe">Try again</a>.</p>`;
}
const htmlResp = (body: string, co: Record<string, string>, status = 200) =>
  new Response(body, { status, headers: { "content-type": "text/html; charset=utf-8", ...co } });

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

// Approximate KV rate limiter. KV is eventually consistent, so this bounds abuse to the right
// order of magnitude rather than an exact count — enough to stop the unauthenticated /subscribe
// confirm-email mailbomb (which rides the same Resend account/domain as the launch blast).
async function rlHit(env: Env, key: string, limit: number, windowSec: number): Promise<boolean> {
  const k = "rl:" + key;
  const n = (parseInt((await env.FEED_CACHE.get(k)) || "0", 10) || 0);
  if (n >= limit) return false;
  await env.FEED_CACHE.put(k, String(n + 1), { expirationTtl: windowSec });
  return true;
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
    // Trailing-slash-insensitive (except root). Everything routes off `rawp`.
    const rawp = url.pathname.replace(/\/+$/, "") || "/";
    const co = cors(env, req);
    if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: { ...co, "Access-Control-Allow-Methods": "GET,POST,OPTIONS", "Access-Control-Allow-Headers": "content-type,authorization,payment-signature,x-payment" } });

    // ===== gateway meta =====
    if (rawp === "/health") return json({ ok: true, service: "api.gokhan.vc" }, 200, co);
    if (rawp === "/_meta") return json(CATALOG, 200, co);
    if (rawp === "/openapi.json") return json(buildOpenApi(env), 200, co);
    if (rawp === "/.well-known/x402") {
      const base = (env.PUBLIC_API_URL || "https://api.gokhan.vc").replace(/\/+$/, "");
      const sku = AGENT_EMAIL_SKU;
      const resources = env.PAY_TO
        ? [{
            resource: `${base}${sku.route}`,
            type: "http",
            x402Version: 2,
            description: skuDescription(sku),
            mimeType: "application/json",
            accepts: [x402Requirements(env, sku, env.PAY_TO)],
          }]
        : [];
      return json({ x402Version: 2, resources }, 200, co);
    }
    if (rawp === "/favicon.ico") {
      return new Response(
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" fill="#161616"/><text x="16" y="22" text-anchor="middle" font-family="ui-monospace,monospace" font-size="14" fill="#e10600">G</text></svg>',
        { status: 200, headers: { "content-type": "image/svg+xml", "cache-control": "public, max-age=86400", ...co } },
      );
    }
    if (rawp === "/" || rawp === "/index.html") {
      if ((req.headers.get("Accept") || "").includes("text/html"))
        return new Response(catalogHtml(), { status: 200, headers: { "content-type": "text/html; charset=utf-8", ...co } });
      return json(CATALOG, 200, co);
    }

    // ===== feed (read side) — /feed.xml + /feed.json are PERMANENT load-bearing aliases =====
    if (rawp === "/feed.xml" || rawp === "/feed/rss.xml") return kvFeed(env, "rendered:feed.xml", "application/rss+xml; charset=utf-8", co);
    if (rawp === "/feed.json" || rawp === "/feed/feed.json") return kvFeed(env, "rendered:feed.json", "application/feed+json; charset=utf-8", co);
    if (rawp === "/feed") return json({ rss: "https://api.gokhan.vc/feed.xml", json: "https://api.gokhan.vc/feed.json" }, 200, co);

    // ===== numetal (proxy, short-KV-cached) =====
    if (rawp === "/numetal/fees") return proxyJson(env, co, "https://numetal.xyz/fees/data", "proxy:numetal:fees");
    if (rawp === "/numetal/burns") return proxyJson(env, co, "https://numetal.xyz/fees/events", "proxy:numetal:burns");
    if (rawp === "/numetal/status") return proxyJson(env, co, "https://status.numetal.xyz/status.json", "proxy:numetal:status");

    // ===== ishtar / heartbench — LINK, never proxy (keeps x402/MPP settlement realm intact) =====
    if (rawp === "/ishtar") return Response.redirect("https://api.ishtar.numetal.xyz/", 302);
    if (rawp === "/heartbench") return Response.redirect("https://api.ishtar.numetal.xyz/api/heartbench", 302);

    // ===== llms aggregate =====
    if (rawp === "/llms" || rawp === "/estate/llms") {
      const full = url.searchParams.get("full") === "1";
      const cacheKey = full ? "llms:full:v1" : "llms:index:v1";
      let payload = await env.FEED_CACHE.get(cacheKey);
      if (!payload) {
        const agg = await fetchLlmsAggregate(full);
        payload = JSON.stringify(agg);
        await env.FEED_CACHE.put(cacheKey, payload, { expirationTtl: 3600 });
      }
      return new Response(payload, { headers: { "content-type": "application/json; charset=utf-8", "cache-control": "public, max-age=3600", ...co } });
    }
    if (rawp === "/llms.txt") {
      let text = await env.FEED_CACHE.get("llms:combined:v1");
      if (!text) {
        const agg = await fetchLlmsAggregate(false);
        text = llmsCombinedText(agg.sites);
        await env.FEED_CACHE.put("llms:combined:v1", text, { expirationTtl: 3600 });
      }
      return new Response(text, { headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "public, max-age=3600", ...co } });
    }

    // ===== unified blog reader =====
    if (rawp === "/blog" && req.method === "GET") {
      const site = url.searchParams.get("site") || "";
      const slug = url.searchParams.get("slug") || "";
      if (!site || !slug) return json({ sites: listBlogSites(), usage: "GET /blog/{site}/{slug} or ?site=&slug=" }, 200, co);
      const feedCache = await env.FEED_CACHE.get("rendered:feed.json");
      const post = await readBlogPost(site, slug, feedCache);
      if ("error" in post) return json({ error: post.error }, post.status, co);
      return json(post, 200, co);
    }
    const blogMatch = rawp.match(/^\/blog\/([^/]+)\/([^/]+)$/);
    if (blogMatch && req.method === "GET") {
      const feedCache = await env.FEED_CACHE.get("rendered:feed.json");
      const post = await readBlogPost(decodeURIComponent(blogMatch[1]), decodeURIComponent(blogMatch[2]), feedCache);
      if ("error" in post) return json({ error: post.error }, post.status, co);
      return json(post, 200, co);
    }

    // ===== social catalog =====
    if (rawp === "/social") return json(SOCIAL_CATALOG, 200, { ...co, "cache-control": "public, max-age=86400" });

    // ===== paid agent email =====
    if (rawp === "/agent/email" || rawp === "/email/send") return handleAgentEmail(req, env, co);
    if (rawp === "/agent") {
      const svc = CATALOG.services.find((s) => s.id === "agent-email");
      return json({
        ...svc,
        price_usd: "1.00",
        recipients: agentEmailRecipientMap(),
        probe_402: {
          safe: true,
          note: "Bare POST returns 402 before body validation — no email is sent.",
          curl: 'curl -v -X POST https://api.gokhan.vc/agent/email -H "Content-Type: application/json" -d \'{"subject":"probe","body":"402 test"}\'',
          expect_headers: ["payment-required", "www-authenticate", "x-order-id"],
        },
      }, 200, co);
    }

    // ===== newsletter service descriptor =====
    if (rawp === "/newsletter") return json(CATALOG.services.find((s) => s.id === "newsletter"), 200, co);

    // ===== newsletter — strip the /newsletter/* prefix and fall through to the legacy handlers.
    // Legacy root paths stay live too, so any URL already baked into sent mail keeps working. =====
    const p = rawp.startsWith("/newsletter/") ? rawp.slice("/newsletter".length) : rawp;

    if (p === "/subscribe" && req.method === "GET") return htmlResp(subscribeForm(url.searchParams.get("site") || "web"), co);
    if (p === "/subscribe" && req.method === "POST") return subscribe(req, env, co);
    if (p === "/confirm" && req.method === "GET") return confirm(url, env);
    if (p === "/xmtp/subscribe" && req.method === "POST") return xmtpSubscribe(req, env, co);
    if (p === "/unsubscribe") return unsubscribe(req, url, env);
    if (p === "/webhooks/resend" && req.method === "POST") return resendWebhook(req, env);
    if (p === "/admin/status") return adminStatus(req, env);
    if (p === "/admin/import" && req.method === "POST") return adminImport(req, env);
    if (p === "/admin/poll" && req.method === "POST") {
      if (!bearerOk(req, env)) return new Response("unauthorized", { status: 401 });
      await env.POLLER.get(env.POLLER.idFromName("singleton")).fetch("https://poller/run");
      return json({ ok: true, polled: true });
    }
    if (p === "/admin/dispatch-blast" && req.method === "POST") return adminDispatchBlast(req, env);
    // xmtp-bot integration (admin-gated; the external CF-Container bot calls these over HTTPS)
    if (p === "/admin/xmtp/recipients") return adminXmtpRecipients(req, env);
    if (p === "/admin/xmtp/report" && req.method === "POST") return adminXmtpReport(req, env);
    if (p === "/admin/xmtp/pending") return adminXmtpPending(req, env);
    if (p === "/admin/xmtp/sent") return adminXmtpSent(req, env);

    // ===== public R2 assets (assets.numetal.xyz + /assets/* alias on api.gokhan.vc) =====
    const assetKey = assetR2Key(url.hostname, rawp);
    if (assetKey) return serveAsset(req, env, assetKey, co);

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

// Thin read-only proxy for public upstream JSON (numetal fees/burns/status). 60s KV cache so a
// burst on api.gokhan.vc never hammers the origin; upstream stays the source of truth.
async function proxyJson(env: Env, co: Record<string, string>, upstream: string, cacheKey: string): Promise<Response> {
  let body = await env.FEED_CACHE.get(cacheKey);
  if (body === null) {
    try {
      const r = await fetch(upstream, { headers: { "User-Agent": "api.gokhan.vc/1.0" } });
      if (!r.ok) return json({ error: "upstream_status", status: r.status, upstream }, 502, co);
      body = await r.text();
      await env.FEED_CACHE.put(cacheKey, body, { expirationTtl: 60 });
    } catch {
      return json({ error: "upstream_unreachable", upstream }, 502, co);
    }
  }
  return new Response(body, { headers: { "content-type": "application/json; charset=utf-8", "cache-control": "public, max-age=60", ...co } });
}

// ---------- subscribe ----------
async function subscribe(req: Request, env: Env, co: Record<string, string>): Promise<Response> {
  const wantsHtml = (req.headers.get("Accept") || "").includes("text/html");
  let form: FormData;
  try { form = await req.formData(); } catch { return json({ error: "expected form-encoded body" }, 400, co); }
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
  // Rate-limit this unauthenticated endpoint: it writes D1 rows and (email path) fires an outbound
  // Resend confirm mail — a mailbomb/abuse vector that could torch the sender reputation the launch
  // blast depends on. Global + per-IP + per-recipient caps. Turnstile lands when the public form ships.
  const ip = req.headers.get("CF-Connecting-IP") || "0";
  if (!(await rlHit(env, "sub:global", 60, 3600)) || !(await rlHit(env, "sub:ip:" + ip, 8, 3600)))
    return json({ error: "rate_limited" }, 429, co);
  if (email && !(await rlHit(env, "sub:to:" + email, 1, 3600)))
    return json({ error: "rate_limited" }, 429, co);
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
    if (wantsHtml) return htmlResp(subscribeThanks(), co);
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

const xmtpSubMessage = (wallet: string) => `Subscribe ${wallet} to the Gökhan Turhan newsletter over XMTP.`;

async function xmtpSubscribe(req: Request, env: Env, co: Record<string, string>): Promise<Response> {
  const b = await req.json().catch(() => ({})) as any;
  const wallet = (b.wallet || "").trim().toLowerCase();
  const signature = (b.signature || "").trim();
  if (!/^0x[a-f0-9]{40}$/.test(wallet)) return json({ error: "bad wallet" }, 400, co);
  // Prove wallet ownership (EIP-191) — without this, anyone could enroll third-party wallets and
  // flood the table. Only the wallet holder can produce this signature; replay just re-subscribes
  // the same wallet (idempotent), so a static message is sufficient.
  if (!/^0x[0-9a-fA-F]{128,}$/.test(signature)) return json({ error: "signature required" }, 400, co);
  let recovered = "";
  try { recovered = (await recoverMessageAddress({ message: xmtpSubMessage(wallet), signature: signature as `0x${string}` })).toLowerCase(); }
  catch { return json({ error: "bad signature" }, 400, co); }
  if (recovered !== wallet) return json({ error: "signature does not match wallet" }, 400, co);
  // Rate-limit the (now-authenticated) write to bound row creation / D1 cost.
  const ip = req.headers.get("CF-Connecting-IP") || "0";
  if (!(await rlHit(env, "xmtp:global", 60, 3600)) || !(await rlHit(env, "xmtp:ip:" + ip, 10, 3600)))
    return json({ error: "rate_limited" }, 429, co);
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
// Per-brand newsletter sender display names — always "… by Gökhan Turhan". Same verified
// address (newsletter@gokhan.vc) so SPF/DKIM/DMARC alignment is unchanged; only the display name
// varies by the post's origin feed.
const BRAND_SENDER: Record<string, string> = {
  ishtar: "Ishtar by Gökhan Turhan",
  numetal: "Numetal Dispatch by Gökhan Turhan",
  atelier: "Brief by Atelier Gökhan Turhan VC",
  personal: "Journal by Gökhan Turhan",
};
function senderFor(originFeed: string, env: Env): string {
  const name = BRAND_SENDER[originFeed] || "Gökhan Turhan";
  const m = env.SENDER.match(/<([^>]+)>/);
  return `${name} <${m ? m[1] : "newsletter@gokhan.vc"}>`;
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
      audience_id: env.RESEND_SEGMENT, from: senderFor(item.origin_feed, env), subject: item.title,
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
  const body = item.content_html
    ? String(item.content_html)
    : item.summary
      ? `<p>${escapeHtml(item.summary)}</p>`
      : "";
  return `<h1>${escapeHtml(item.title)}</h1>${body}<p><a href="${escapeHtml(item.canonical_url)}">Read the full post →</a></p><p><a href="https://ishtar.numetal.xyz/deck/not-raising-a-preseed/ishtar-deck-not-a-preseed.pdf">Download the deck (PDF) →</a></p><hr/><p><a href="{{{RESEND_UNSUBSCRIBE_URL}}}">Unsubscribe</a></p>`;
}
function escapeHtml(s: string): string {
  return String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c] as string));
}

async function resendWebhook(req: Request, env: Env): Promise<Response> {
  const raw = await req.text();
  // Resend signs webhooks via Svix. Fail CLOSED: with no secret set the endpoint refuses to
  // mutate state at all (else anyone could POST a fake bounce to unsubscribe a victim). To enable
  // bounce/complaint reconciliation, register the Resend webhook and `wrangler secret put RESEND_WEBHOOK_SECRET`.
  if (!env.RESEND_WEBHOOK_SECRET) return new Response("webhook not configured", { status: 503 });
  const ok = await verifySvix(env.RESEND_WEBHOOK_SECRET, req.headers, raw).catch(() => false);
  if (!ok) return new Response("bad signature", { status: 401 });
  let evt: any = {};
  try { evt = JSON.parse(raw); } catch { return new Response(null, { status: 200 }); }
  const type = evt?.type, email = evt?.data?.email || evt?.data?.to?.[0];
  if (email && (type === "email.bounced" || type === "email.complained")) {
    await env.DB.prepare("UPDATE subscribers SET email_status=?2 WHERE email=?1").bind(String(email).toLowerCase(), type === "email.complained" ? "unsub" : "bounced").run();
  }
  return new Response(null, { status: 200 });
}

// Svix webhook signature (Resend uses Svix). secret = "whsec_<base64>"; signed content =
// `${svix-id}.${svix-timestamp}.${rawBody}`; header carries space-separated "v1,<b64sig>" entries.
async function verifySvix(secret: string, headers: Headers, body: string): Promise<boolean> {
  const id = headers.get("svix-id"), ts = headers.get("svix-timestamp"), sigHeader = headers.get("svix-signature");
  if (!id || !ts || !sigHeader) return false;
  const rawSecret = secret.startsWith("whsec_") ? secret.slice(6) : secret;
  const keyBytes = Uint8Array.from(atob(rawSecret), (c) => c.charCodeAt(0));
  const key = await crypto.subtle.importKey("raw", keyBytes, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, enc.encode(`${id}.${ts}.${body}`)));
  const expected = btoa(String.fromCharCode(...mac));
  for (const part of sigHeader.split(" ")) {
    const [ver, s] = part.split(",");
    if (ver === "v1" && s && timingSafeEq(s, expected)) return true;
  }
  return false;
}

// ---------- admin ----------
function bearerOk(req: Request, env: Env): boolean {
  return timingSafeEq(req.headers.get("Authorization") || "", "Bearer " + env.ADMIN_TOKEN);
}
// Constant-time SHA-256 compare — no length or value oracle.
async function ctEq(a: string, b: string): Promise<boolean> {
  const [ha, hb] = await Promise.all([
    crypto.subtle.digest("SHA-256", enc.encode(a)),
    crypto.subtle.digest("SHA-256", enc.encode(b)),
  ]);
  const x = new Uint8Array(ha), y = new Uint8Array(hb);
  let d = 0;
  for (let i = 0; i < 32; i++) d |= x[i] ^ y[i];
  return d === 0;
}
// The xmtp-bot's least-privilege gate: accepts the scoped XMTP_BOT_TOKEN OR the full ADMIN_TOKEN,
// so a bot-container compromise cannot reach /admin/import|poll|status.
async function botOk(req: Request, env: Env): Promise<boolean> {
  const got = req.headers.get("Authorization") || "";
  if (env.XMTP_BOT_TOKEN && (await ctEq(got, "Bearer " + env.XMTP_BOT_TOKEN))) return true;
  return ctEq(got, "Bearer " + env.ADMIN_TOKEN);
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
// One-shot per-post email broadcast (bypasses LAUNCH + queue; idempotent via broadcasts PK).
async function adminDispatchBlast(req: Request, env: Env): Promise<Response> {
  if (!bearerOk(req, env)) return new Response("unauthorized", { status: 401 });
  const b = await req.json().catch(() => ({})) as any;
  const url = normalizeUrl(String(b.canonical_url || "").trim());
  const title = String(b.title || "").trim();
  const summary = String(b.summary || "").trim();
  const content_html = b.html ? String(b.html) : null;
  if (!url) return json({ error: "canonical_url required" }, 400);
  if (!title) return json({ error: "title required" }, 400);
  const ts = now();
  await env.DB.prepare(
    `INSERT INTO items (canonical_url,title,summary,content_html,origin_feed,published,first_seen,notified_at)
     VALUES (?1,?2,?3,?4,'ishtar',?5,?5,?5)
     ON CONFLICT(canonical_url) DO UPDATE SET title=?2, summary=?3, content_html=COALESCE(?4,content_html)`
  ).bind(url, title, summary || null, content_html, ts).run();
  await emailBroadcast(env, url);
  const bc = await env.DB.prepare(
    "SELECT resend_bcast,state FROM broadcasts WHERE canonical_url=?1 AND channel='email'"
  ).bind(url).first<{ resend_bcast: string; state: string }>();
  const subs = await env.DB.prepare(
    "SELECT COUNT(*) c, SUM(email_status='active' AND email IS NOT NULL) active_email FROM subscribers"
  ).first<{ c: number; active_email: number }>();
  return json({ ok: true, canonical_url: url, broadcast: bc, subscribers: subs });
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
    // Mirror active email rows into the Resend audience so D1 and the audience can't drift
    // (the manual blast targets the Resend audience, not a D1 query).
    if (email) await resendUpsertContact(env, email, false).catch(() => {});
    ins++;
  }
  return json({ ok: true, imported: ins });
}

// ---------- xmtp-bot integration (admin-gated) ----------
// The external CF-Container XMTP bot pulls its recipient list here (feedhub stays the system of
// record + keeps UNSUB_SECRET). feedhub pre-mints each per-recipient xmtp unsub URL so the bot
// never needs the HMAC secret. Returns the wallet subscribers that are XMTP-active.
async function adminXmtpRecipients(req: Request, env: Env): Promise<Response> {
  if (!(await botOk(req, env))) return new Response("unauthorized", { status: 401 });
  const rows = (await env.DB.prepare(
    "SELECT id, wallet, unsub_token FROM subscribers WHERE xmtp_status='active' AND wallet IS NOT NULL"
  ).all<{ id: string; wallet: string; unsub_token: string }>()).results || [];
  const recipients = [];
  for (const r of rows) {
    const token = await mintUnsub(env, r.id, r.unsub_token, "xmtp");
    recipients.push({ subscriber_id: r.id, wallet: r.wallet, unsub_url: `https://api.gokhan.vc/unsubscribe?t=${encodeURIComponent(token)}` });
  }
  return json({ count: recipients.length, recipients });
}

// The bot reports per-recipient results here → writes the sends ledger (channel='xmtp'). The
// composite PK (canonical_url,subscriber_id,channel) makes a re-run idempotent per recipient.
// `key` occupies the canonical_url slot: a real post URL for fan-out, or a campaign key (e.g.
// "launch-2026-07") for the one-time blast.
async function adminXmtpReport(req: Request, env: Env): Promise<Response> {
  if (!(await botOk(req, env))) return new Response("unauthorized", { status: 401 });
  const b = await req.json().catch(() => ({})) as any;
  const key = String(b.key || "").trim().slice(0, 400);
  const results: any[] = Array.isArray(b.results) ? b.results : [];
  if (!key) return json({ error: "key required" }, 400);
  if (results.length > 1000) return json({ error: "too many results (max 1000)" }, 400);
  const OK = new Set(["sent", "failed", "skipped", "queued"]);
  let n = 0;
  for (const r of results) {
    const sid = String(r?.subscriber_id || "").trim();
    if (!sid || sid.length > 40) continue;
    const status = OK.has(r?.status) ? r.status : "sent";
    // INSERT ... SELECT guards against ghost rows: only writes if the subscriber_id truly exists.
    await env.DB.prepare(
      `INSERT INTO sends (canonical_url, subscriber_id, channel, status, provider_id, attempts, updated_at)
       SELECT ?1, ?2, 'xmtp', ?3, ?4, 1, ?5 WHERE EXISTS (SELECT 1 FROM subscribers WHERE id=?2)
       ON CONFLICT(canonical_url,subscriber_id,channel) DO UPDATE SET status=?3, provider_id=?4, attempts=attempts+1, updated_at=?5`
    ).bind(key, sid, status, r.provider_id ? String(r.provider_id).slice(0, 200) : null, now()).run().catch(() => {});
    n++;
  }
  return json({ ok: true, recorded: n });
}

// Later per-post fan-out: posts latched (notified_at) but with no xmtp send yet. A non-Worker
// can't HTTP-pull a CF Queue, so the bot pulls work from D1 here instead.
async function adminXmtpPending(req: Request, env: Env): Promise<Response> {
  if (!(await botOk(req, env))) return new Response("unauthorized", { status: 401 });
  const rows = (await env.DB.prepare(
    `SELECT canonical_url, title, summary FROM items
     WHERE notified_at IS NOT NULL
       AND canonical_url NOT IN (SELECT DISTINCT canonical_url FROM sends WHERE channel='xmtp')
     ORDER BY published DESC LIMIT 20`
  ).all<any>()).results || [];
  return json({ count: rows.length, pending: rows });
}

// Subscriber ids already delivered for a campaign key — lets the bot make a launch/fanout idempotent
// (skip already-sent, retry only failures) so a re-fire never double-DMs anyone.
async function adminXmtpSent(req: Request, env: Env): Promise<Response> {
  if (!(await botOk(req, env))) return new Response("unauthorized", { status: 401 });
  const key = new URL(req.url).searchParams.get("key") || "";
  const rows = (await env.DB.prepare(
    "SELECT subscriber_id FROM sends WHERE channel='xmtp' AND canonical_url=?1 AND status='sent'"
  ).bind(key).all<{ subscriber_id: string }>()).results || [];
  return json({ sent: rows.map((r) => r.subscriber_id) });
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
    const xmlItems = rows.map((r) => `    <item><title>${escapeHtml(r.title)}</title><link>${escapeHtml(r.canonical_url)}</link><guid isPermaLink="true">${escapeHtml(r.canonical_url)}</guid><pubDate>${new Date(r.published).toUTCString()}</pubDate>${r.summary ? `<description>${escapeHtml(r.summary)}</description>` : ""}</item>`).join("\n");
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
