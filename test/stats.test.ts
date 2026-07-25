import test from "node:test";
import assert from "node:assert/strict";
import {
  pickBaseline,
  counterDelta,
  appendSample,
  extractSample,
  parseWindow,
  handleStats,
  STATS_SOURCES,
  WINDOWS,
  type Sample,
} from "../src/stats.ts";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

function fakeKv(seed: Record<string, string> = {}) {
  const store = new Map<string, string>(Object.entries(seed));
  return {
    store,
    async get(k: string) {
      return store.has(k) ? store.get(k)! : null;
    },
    async put(k: string, v: string) {
      store.set(k, v);
    },
  };
}
const envWith = (kv: ReturnType<typeof fakeKv>) => ({ FEED_CACHE: kv }) as unknown as Parameters<typeof handleStats>[0];

function withFetch<T>(impl: typeof fetch, fn: () => Promise<T>): Promise<T> {
  const original = globalThis.fetch;
  globalThis.fetch = impl;
  return fn().finally(() => {
    globalThis.fetch = original;
  });
}
const jsonFetch = (body: unknown) => (async () => new Response(JSON.stringify(body), { status: 200 })) as unknown as typeof fetch;
const deadFetch = (async () => {
  throw new Error("down");
}) as unknown as typeof fetch;

test("pickBaseline takes the newest sample at or before now-window", () => {
  const now = Date.now();
  const samples: Sample[] = [
    { ts: now - 9 * DAY, v: { n: 1 } },
    { ts: now - 7 * DAY - HOUR, v: { n: 5 } },
    { ts: now - 3 * DAY, v: { n: 20 } },
  ];
  assert.equal(pickBaseline(samples, now, WINDOWS["7d"])?.v.n, 5);
  assert.equal(pickBaseline(samples, now, WINDOWS["24h"])?.v.n, 20);
});

test("pickBaseline returns null when history is shorter than the window", () => {
  const now = Date.now();
  assert.equal(pickBaseline([{ ts: now - 2 * HOUR, v: { n: 3 } }], now, WINDOWS["7d"]), null);
});

test("counterDelta never returns a negative or invents a zero", () => {
  assert.deepEqual(counterDelta(20, 8), { value: 12, reset: false });
  assert.deepEqual(counterDelta(8, 8), { value: 0, reset: false });
  assert.deepEqual(counterDelta(3, 20), { value: null, reset: true }); // counter reset
  assert.deepEqual(counterDelta(undefined, 8), { value: null, reset: false });
  assert.deepEqual(counterDelta(20, undefined), { value: null, reset: false });
});

test("appendSample writes at most once an hour and drops samples past retention", () => {
  const now = Date.now();
  const first = appendSample([], { ts: now, v: { n: 1 } });
  assert.equal(first.wrote, true);

  const tooSoon = appendSample(first.samples, { ts: now + 10 * 60_000, v: { n: 2 } });
  assert.equal(tooSoon.wrote, false);
  assert.equal(tooSoon.samples.length, 1);

  const later = appendSample(first.samples, { ts: now + HOUR, v: { n: 2 } });
  assert.equal(later.wrote, true);
  assert.equal(later.samples.length, 2);

  const aged = appendSample([{ ts: now - 30 * DAY, v: { n: 0 } }, ...later.samples], { ts: now + 2 * HOUR, v: { n: 3 } });
  assert.ok(aged.samples.every((s) => s.ts >= now + 2 * HOUR - 8 * DAY), "30-day-old sample dropped");
});

test("extractSample keeps only tracked finite numbers", () => {
  const s = extractSample(STATS_SOURCES.ishtar, { courtship_turns: 156, couples: 14, couples_active: 14, agents_admitted: 26, revenue_usdc: 0, updated: "x", markets: null }, 1);
  assert.deepEqual(s.v, { courtship_turns: 156, couples: 14, agents_admitted: 26, couples_active: 14 });
});

test("parseWindow defaults to 7d and rejects unknown windows", () => {
  assert.equal(parseWindow(null).key, "7d");
  assert.equal(parseWindow("24h").sec, 86_400);
  assert.equal(parseWindow("all").key, "7d");
  assert.equal(parseWindow("90d").key, "7d");
});

test("no all-time total is ever emitted in the response body", async () => {
  const kv = fakeKv();
  const res = await withFetch(jsonFetch({ courtship_turns: 156, couples: 14, couples_active: 14, agents_admitted: 26, updated: "2026-07-25T19:22:50.355Z" }), () =>
    handleStats(envWith(kv), {}, STATS_SOURCES.ishtar, "7d"),
  );
  const body = await res.json() as Record<string, unknown>;
  assert.equal(JSON.stringify(body).includes("156"), false, "all-time total leaked into the payload");
  assert.equal((body.value as Record<string, unknown>).courtship_turns, null, "no baseline yet → null, not 0");
  assert.equal(body.insufficient_history, true);
  assert.equal(body.as_of, "2026-07-25T19:22:50.355Z");
  // Ishtar's `updated` is generated when the request is made, so it can never go stale. Labelling
  // it plain "upstream" would invite a freshness monitor that is green forever.
  assert.equal(body.as_of_source, "upstream_request_time");
});

test("with a warm history the window reports a real delta", async () => {
  const now = Date.now();
  const kv = fakeKv({
    "stats:ishtar:hist": JSON.stringify([
      { ts: now - 8 * DAY, v: { courtship_turns: 100, couples: 10, agents_admitted: 20, couples_active: 10 } },
      { ts: now - 7 * DAY - HOUR, v: { courtship_turns: 144, couples: 13, agents_admitted: 23, couples_active: 13 } },
    ]),
  });
  const res = await withFetch(jsonFetch({ courtship_turns: 156, couples: 14, couples_active: 14, agents_admitted: 26, updated: "2026-07-25T19:22:50.355Z" }), () =>
    handleStats(envWith(kv), {}, STATS_SOURCES.ishtar, "7d"),
  );
  const body = await res.json() as Record<string, any>;
  assert.equal(res.status, 200);
  assert.deepEqual(body.value, { courtship_turns: 12, couples: 1, agents_admitted: 3 });
  assert.deepEqual(body.gauge, { couples_active: 14 });
  assert.equal(body.stale, false);
  assert.ok(body.baseline.age_sec >= 7 * 86_400);
});

test("a dead upstream falls back to the sample history and flags itself stale", async () => {
  const now = Date.now();
  const kv = fakeKv({
    "stats:curb:hist": JSON.stringify([
      { ts: now - 8 * DAY, v: { matches: 1, openOffers: 3 } },
      { ts: now - 2 * HOUR, v: { matches: 2, openOffers: 1 } },
    ]),
  });
  const res = await withFetch(deadFetch, () => handleStats(envWith(kv), {}, STATS_SOURCES.curb, "7d"));
  const body = await res.json() as Record<string, any>;
  assert.equal(res.status, 200);
  assert.equal(body.stale, true);
  assert.equal(res.headers.get("x-stale"), "1");
  assert.equal(body.as_of_source, "last_sample");
  assert.equal(body.value.matches, 1);
  assert.equal(body.gauge.open_offers, 1);
});

test("a dead upstream with no history 502s instead of emitting zeros", async () => {
  const kv = fakeKv();
  const res = await withFetch(deadFetch, () => handleStats(envWith(kv), {}, STATS_SOURCES.curb, "7d"));
  const body = await res.json() as Record<string, any>;
  assert.equal(res.status, 502);
  assert.equal(body.value.matches, null);
  assert.equal(body.gauge.open_offers, null);
  assert.equal(body.as_of, null);
});

test("curb reports gateway_fetch as_of because its upstream carries no timestamp", async () => {
  const kv = fakeKv();
  const res = await withFetch(jsonFetch({ ok: true, openOffers: 1, matches: 2, feeBps: 500 }), () =>
    handleStats(envWith(kv), {}, STATS_SOURCES.curb, "7d"),
  );
  const body = await res.json() as Record<string, any>;
  assert.equal(body.as_of_source, "gateway_fetch");
  assert.equal(body.gauge.open_offers, 1);
  assert.equal(body.value.matches, null);
});

test("a counter that moves backwards reports null and flags the reset", async () => {
  const now = Date.now();
  const kv = fakeKv({
    "stats:curb:hist": JSON.stringify([{ ts: now - 7 * DAY - HOUR, v: { matches: 90, openOffers: 2 } }]),
  });
  const res = await withFetch(jsonFetch({ ok: true, openOffers: 1, matches: 2 }), () =>
    handleStats(envWith(kv), {}, STATS_SOURCES.curb, "7d"),
  );
  const body = await res.json() as Record<string, any>;
  assert.equal(body.value.matches, null);
  assert.equal(body.reset_detected, true);
});
