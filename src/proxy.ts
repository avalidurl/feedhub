/**
 * Read-only JSON proxy for public estate upstreams (numetal fees / burns / status).
 *
 * Two properties every bound panel on the estate depends on:
 *
 *  1. PER-FEED TTL. Each call site passes its own `ttlSec`. There is no shared constant any more,
 *     so lengthening the burns cache cannot drag the status feed onto the same stale window —
 *     the status feed is the premise of the `● LIVE` → `STATUS n/n` binding and needs the tight one.
 *
 *  2. STALE-IF-ERROR. Every successful JSON body is also written to `<cacheKey>:lkg` (last known
 *     good) at 24h. When upstream 5xxs, times out, or is unreachable, the last good body is served
 *     with `x-stale: 1` instead of a 502 — a 30-second upstream blip no longer blanks the bound
 *     panels on four properties. Only a cold cache (or a gap longer than 24h) still 502s.
 *
 * `x-stale`/`x-stale-age` are listed in `Access-Control-Expose-Headers`: without that, cross-origin
 * `fetch()` cannot read them at all, and every consumer would render a stale body as live. The
 * body itself is passed through byte-identical — staleness is signalled beside it, never inside it,
 * so existing consumers of the raw upstream shape keep working.
 */

export interface ProxyEnv {
  FEED_CACHE: KVNamespace;
}

/** Cloudflare KV rejects an `expirationTtl` below 60s (docs: kv/api/write-key-value-pairs). */
const KV_MIN_TTL_SEC = 60;
/** How long a last-known-good body stays servable after upstream goes dark. */
const LKG_TTL_SEC = 86_400;
/** Stale bodies get a short edge cache: long enough to absorb a burst, short enough to retry soon. */
const STALE_MAX_AGE_SEC = 30;

const EXPOSE_HEADERS = "x-stale, x-stale-age, x-upstream, x-upstream-error";

interface LkgEnvelope {
  ts: number;
  body: string;
}

/** Guards the LKG slot: an upstream HTML error page must never become the "last known good" JSON. */
export function isJsonPayload(text: string): boolean {
  try {
    const v = JSON.parse(text);
    return v !== null && typeof v === "object";
  } catch {
    return false;
  }
}

export function encodeLkg(body: string, ts: number): string {
  return JSON.stringify({ ts, body } satisfies LkgEnvelope);
}

export function decodeLkg(raw: string | null): LkgEnvelope | null {
  if (!raw) return null;
  try {
    const v = JSON.parse(raw) as Partial<LkgEnvelope>;
    if (typeof v?.body !== "string" || typeof v?.ts !== "number") return null;
    return { ts: v.ts, body: v.body };
  } catch {
    return null;
  }
}

function baseHeaders(co: Record<string, string>): Record<string, string> {
  return {
    "content-type": "application/json; charset=utf-8",
    "access-control-expose-headers": EXPOSE_HEADERS,
    ...co,
  };
}

function freshResponse(body: string, co: Record<string, string>, ttlSec: number, upstream: string): Response {
  return new Response(body, {
    headers: { ...baseHeaders(co), "cache-control": `public, max-age=${ttlSec}`, "x-stale": "0", "x-upstream": upstream },
  });
}

function staleResponse(lkg: LkgEnvelope, co: Record<string, string>, upstream: string, err: string): Response {
  const ageSec = Math.max(0, Math.round((Date.now() - lkg.ts) / 1000));
  return new Response(lkg.body, {
    headers: {
      ...baseHeaders(co),
      "cache-control": `public, max-age=${STALE_MAX_AGE_SEC}`,
      "x-stale": "1",
      "x-stale-age": String(ageSec),
      "x-upstream": upstream,
      "x-upstream-error": err,
    },
  });
}

/**
 * Proxy `upstream` as JSON, hot-cached in KV under `cacheKey` for `ttlSec`, with a 24h
 * last-known-good fallback. `ttlSec` is per-call-site on purpose — see the header comment.
 */
export async function proxyJson(
  env: ProxyEnv,
  co: Record<string, string>,
  upstream: string,
  cacheKey: string,
  ttlSec: number,
): Promise<Response> {
  const lkgKey = `${cacheKey}:lkg`;
  const hot = await env.FEED_CACHE.get(cacheKey);
  if (hot !== null) return freshResponse(hot, co, ttlSec, upstream);

  let failure: { error: string; detail: Record<string, unknown> };
  try {
    const r = await fetch(upstream, { headers: { "User-Agent": "api.gokhan.vc/1.0" } });
    if (r.ok) {
      const body = await r.text();
      await env.FEED_CACHE.put(cacheKey, body, { expirationTtl: Math.max(KV_MIN_TTL_SEC, ttlSec) });
      if (isJsonPayload(body)) {
        await env.FEED_CACHE.put(lkgKey, encodeLkg(body, Date.now()), { expirationTtl: LKG_TTL_SEC });
      }
      return freshResponse(body, co, ttlSec, upstream);
    }
    failure = { error: `upstream_status_${r.status}`, detail: { error: "upstream_status", status: r.status, upstream } };
  } catch {
    failure = { error: "upstream_unreachable", detail: { error: "upstream_unreachable", upstream } };
  }

  const lkg = decodeLkg(await env.FEED_CACHE.get(lkgKey));
  if (lkg) return staleResponse(lkg, co, upstream, failure.error);

  // No last-known-good body to fall back on — fail loudly rather than invent one.
  return new Response(JSON.stringify({ ...failure.detail, stale: false, note: "no last-known-good body cached" }), {
    status: 502,
    headers: { ...baseHeaders(co), "x-stale": "0", "x-upstream": upstream, "x-upstream-error": failure.error },
  });
}
