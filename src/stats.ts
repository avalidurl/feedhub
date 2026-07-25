/**
 * Windowed product counters — GET /ishtar/stats, GET /curb/stats.
 *
 * WHY THIS IS NOT A PROXY. Both upstreams publish ALL-TIME counters only, verified 2026-07-25:
 *   api.ishtar.numetal.xyz/api/public/stats → {agents_admitted,couples,couples_active,
 *     courtship_turns,markets,revenue_usdc,buyback_reserve_usdc,updated}   (ACAO *)
 *   curb.numetal.xyz/health                 → {openOffers,matches,feeBps,…} (ACAO curb only)
 * `?window=7d` and `?days=7` are accepted and IGNORED by ishtar — the payload is byte-identical.
 * So a window cannot be asked for; it has to be measured. This route keeps an hourly sample
 * history in KV and reports `current − baseline`, where the baseline is the newest sample at or
 * before `now − window`. That is the only honest way to turn a monotonic all-time counter into
 * "what happened in the last 7 days".
 *
 * An all-time counter scrolls identically whether the product got forty turns this week or none
 * since March; a windowed one degrades to a truthful 0. Totals are therefore NEVER emitted here —
 * they exist only inside the KV history that computes the delta.
 *
 * Failure semantics, in order of preference:
 *   upstream ok            → value = current − baseline, as_of = upstream timestamp
 *   upstream down, history → value computed from the newest SAMPLE, `stale: true`, x-stale: 1
 *   no baseline old enough → value = null (renders `—`), `insufficient_history: true`. NEVER 0.
 *   counter went backwards → value = null, `reset_detected: true`. NEVER a negative "activity".
 */

export interface StatsEnv {
  FEED_CACHE: KVNamespace;
}

/** Windows offered. Retention below must cover the largest one. */
export const WINDOWS: Record<string, number> = {
  "24h": 86_400,
  "7d": 604_800,
};
export const DEFAULT_WINDOW = "7d";

/** One sample per hour is enough resolution for a 24h/7d delta and keeps the history ~20 KB. */
const SAMPLE_INTERVAL_SEC = 3_600;
/** Largest window + 1 day of slack, so a 7d baseline always exists once warm. */
const RETENTION_SEC = 8 * 86_400;
/** Upstream hot-cache TTL. KV's floor is 60s. */
const UPSTREAM_TTL_SEC = 60;

export interface Sample {
  ts: number;
  v: Record<string, number>;
}

export interface StatsSource {
  id: string;
  upstream: string;
  /** Monotonic all-time counters → reported as a delta over the window. */
  counters: Record<string, string>;
  /** Point-in-time values (an open-offer count can go down) → reported as-is, no window. */
  gauges: Record<string, string>;
  /** Upstream field carrying its own freshness stamp, if it has one. */
  asOfField?: string;
  /**
   * True when that stamp is generated at REQUEST time rather than at data-change time — i.e. it
   * always reads fresh and can never prove anything. Reported as `upstream_request_time` so no
   * monitor is built on a value that is structurally incapable of going stale.
   */
  asOfIsRequestTime?: boolean;
  note: string;
}

export const STATS_SOURCES: Record<string, StatsSource> = {
  ishtar: {
    id: "ishtar",
    upstream: "https://api.ishtar.numetal.xyz/api/public/stats",
    counters: { courtship_turns: "courtship_turns", couples: "couples", agents_admitted: "agents_admitted" },
    gauges: { couples_active: "couples_active" },
    asOfField: "updated",
    asOfIsRequestTime: true,
    note:
      "Upstream publishes all-time counters only; the window is measured here from an hourly sample history. Its `updated` field is generated at request time (verified 2026-07-25: it tracks the caller's clock to ~150ms across repeated calls), so it always reads fresh and proves nothing about data age — do not build a freshness monitor on as_of for this source. coverage_sec and baseline.age_sec are the honest signals.",
  },
  curb: {
    id: "curb",
    upstream: "https://curb.numetal.xyz/health",
    counters: { matches: "matches" },
    gauges: { open_offers: "openOffers" },
    note:
      "Upstream is a health document with no timestamp, so as_of is the gateway's own fetch time — it cannot prove upstream freshness, only that the fetch succeeded. open_offers is a gauge (it can go down) and is reported unwindowed; matches is treated as monotonic and windowed.",
  },
};

// ---------- pure helpers (unit-tested) ----------

/** Newest sample at or before `nowMs - windowSec`. Null when the history does not reach back far enough. */
export function pickBaseline(samples: Sample[], nowMs: number, windowSec: number): Sample | null {
  const cutoff = nowMs - windowSec * 1000;
  let best: Sample | null = null;
  for (const s of samples) if (s.ts <= cutoff && (!best || s.ts > best.ts)) best = s;
  return best;
}

/**
 * `current - baseline` for a monotonic counter. Null (never 0, never negative) when either side is
 * missing or the counter moved backwards — a reset is not an activity figure.
 */
export function counterDelta(current: number | undefined, baseline: number | undefined): { value: number | null; reset: boolean } {
  if (!Number.isFinite(current as number) || !Number.isFinite(baseline as number)) return { value: null, reset: false };
  const d = (current as number) - (baseline as number);
  if (d < 0) return { value: null, reset: true };
  return { value: d, reset: false };
}

/** Append at most one sample per SAMPLE_INTERVAL_SEC and drop anything past retention. */
export function appendSample(samples: Sample[], next: Sample): { samples: Sample[]; wrote: boolean } {
  const newest = samples.reduce<Sample | null>((a, s) => (!a || s.ts > a.ts ? s : a), null);
  if (newest && next.ts - newest.ts < SAMPLE_INTERVAL_SEC * 1000) return { samples, wrote: false };
  const cutoff = next.ts - RETENTION_SEC * 1000;
  const kept = samples.filter((s) => s.ts >= cutoff);
  kept.push(next);
  kept.sort((a, b) => a.ts - b.ts);
  return { samples: kept, wrote: true };
}

/** Pull the numeric fields this source tracks out of an upstream payload. */
export function extractSample(src: StatsSource, payload: Record<string, unknown>, ts: number): Sample {
  const v: Record<string, number> = {};
  for (const field of [...Object.values(src.counters), ...Object.values(src.gauges)]) {
    const raw = payload[field];
    if (typeof raw === "number" && Number.isFinite(raw)) v[field] = raw;
  }
  return { ts, v };
}

export function parseWindow(raw: string | null): { key: string; sec: number } {
  const key = raw && raw in WINDOWS ? raw : DEFAULT_WINDOW;
  return { key, sec: WINDOWS[key] };
}

// ---------- KV plumbing ----------

const histKey = (id: string) => `stats:${id}:hist`;
const upstreamKey = (id: string) => `stats:${id}:upstream`;

export async function readHistory(env: StatsEnv, id: string): Promise<Sample[]> {
  try {
    const raw = await env.FEED_CACHE.get(histKey(id));
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((s): s is Sample => typeof s?.ts === "number" && typeof s?.v === "object" && s.v !== null);
  } catch {
    return [];
  }
}

async function writeHistory(env: StatsEnv, id: string, samples: Sample[]): Promise<void> {
  await env.FEED_CACHE.put(histKey(id), JSON.stringify(samples), { expirationTtl: RETENTION_SEC + 86_400 });
}

async function fetchUpstream(env: StatsEnv, src: StatsSource): Promise<Record<string, unknown> | null> {
  const key = upstreamKey(src.id);
  const hot = await env.FEED_CACHE.get(key);
  if (hot !== null) {
    try {
      return JSON.parse(hot) as Record<string, unknown>;
    } catch {
      /* fall through to a live fetch */
    }
  }
  try {
    const r = await fetch(src.upstream, { headers: { "User-Agent": "api.gokhan.vc/1.0" } });
    if (!r.ok) return null;
    const text = await r.text();
    const parsed = JSON.parse(text) as unknown;
    if (parsed === null || typeof parsed !== "object") return null;
    await env.FEED_CACHE.put(key, text, { expirationTtl: UPSTREAM_TTL_SEC });
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

/**
 * Record one sample per source. Called from the cron so the history keeps building with zero
 * traffic — without it a 7d window is only ever measurable on sites that happen to get hourly hits.
 */
export async function sampleAllStats(env: StatsEnv): Promise<void> {
  for (const src of Object.values(STATS_SOURCES)) {
    try {
      const payload = await fetchUpstream(env, src);
      if (!payload) continue;
      const samples = await readHistory(env, src.id);
      const next = appendSample(samples, extractSample(src, payload, Date.now()));
      if (next.wrote) await writeHistory(env, src.id, next.samples);
    } catch {
      /* one bad source must not stop the others */
    }
  }
}

// ---------- handler ----------

export async function handleStats(
  env: StatsEnv,
  co: Record<string, string>,
  src: StatsSource,
  windowRaw: string | null,
): Promise<Response> {
  const win = parseWindow(windowRaw);
  const nowMs = Date.now();

  const payload = await fetchUpstream(env, src);
  let samples = await readHistory(env, src.id);

  if (payload) {
    const next = appendSample(samples, extractSample(src, payload, nowMs));
    samples = next.samples;
    if (next.wrote) await writeHistory(env, src.id, next.samples);
  }

  // Current reading: live payload if we have one, else the newest sample we ever took.
  const newestSample = samples.reduce<Sample | null>((a, s) => (!a || s.ts > a.ts ? s : a), null);
  const current: Record<string, number> | null = payload
    ? extractSample(src, payload, nowMs).v
    : newestSample?.v ?? null;

  const stale = !payload;
  let asOf: string | null = null;
  let asOfSource = "unavailable";
  if (payload) {
    const upstreamStamp = src.asOfField ? payload[src.asOfField] : undefined;
    if (typeof upstreamStamp === "string" && !Number.isNaN(Date.parse(upstreamStamp))) {
      asOf = new Date(upstreamStamp).toISOString();
      asOfSource = src.asOfIsRequestTime ? "upstream_request_time" : "upstream";
    } else {
      asOf = new Date(nowMs).toISOString();
      asOfSource = "gateway_fetch";
    }
  } else if (newestSample) {
    asOf = new Date(newestSample.ts).toISOString();
    asOfSource = "last_sample";
  }

  const baseline = pickBaseline(samples, nowMs, win.sec);
  const oldest = samples.reduce<Sample | null>((a, s) => (!a || s.ts < a.ts ? s : a), null);
  const coverageSec = oldest ? Math.round((nowMs - oldest.ts) / 1000) : 0;

  const value: Record<string, number | null> = {};
  let resetDetected = false;
  for (const [name, field] of Object.entries(src.counters)) {
    const d = counterDelta(current?.[field], baseline?.v[field]);
    value[name] = d.value;
    if (d.reset) resetDetected = true;
  }

  const gauge: Record<string, number | null> = {};
  for (const [name, field] of Object.entries(src.gauges)) {
    const raw = current?.[field];
    gauge[name] = Number.isFinite(raw as number) ? (raw as number) : null;
  }

  const body = {
    source: src.id,
    upstream: src.upstream,
    as_of: asOf,
    as_of_source: asOfSource,
    window: win.key,
    window_sec: win.sec,
    value,
    gauge,
    baseline: baseline ? { as_of: new Date(baseline.ts).toISOString(), age_sec: Math.round((nowMs - baseline.ts) / 1000) } : null,
    coverage_sec: coverageSec,
    samples: samples.length,
    stale,
    ...(baseline ? {} : { insufficient_history: true }),
    ...(resetDetected ? { reset_detected: true } : {}),
    note: src.note,
  };

  const headers: Record<string, string> = {
    "content-type": "application/json; charset=utf-8",
    "access-control-expose-headers": "x-stale, x-stale-age, x-upstream",
    "cache-control": `public, max-age=${UPSTREAM_TTL_SEC}`,
    "x-stale": stale ? "1" : "0",
    "x-upstream": src.upstream,
    ...co,
  };
  if (stale && newestSample) headers["x-stale-age"] = String(Math.round((nowMs - newestSample.ts) / 1000));

  // Nothing live and nothing remembered — say so with a 502 rather than emit a shape full of zeros.
  const status = stale && !newestSample ? 502 : 200;
  return new Response(JSON.stringify(body), { status, headers });
}
