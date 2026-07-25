import test from "node:test";
import assert from "node:assert/strict";
import { proxyJson, isJsonPayload, encodeLkg, decodeLkg } from "../src/proxy.ts";

/** Minimal in-memory KV double — records the TTL each key was written with. */
function fakeKv() {
  const store = new Map<string, string>();
  const ttls = new Map<string, number | undefined>();
  return {
    store,
    ttls,
    async get(k: string) {
      return store.has(k) ? store.get(k)! : null;
    },
    async put(k: string, v: string, opts?: { expirationTtl?: number }) {
      store.set(k, v);
      ttls.set(k, opts?.expirationTtl);
    },
  };
}

function envWith(kv: ReturnType<typeof fakeKv>) {
  return { FEED_CACHE: kv } as unknown as Parameters<typeof proxyJson>[0];
}

function withFetch<T>(impl: typeof fetch, fn: () => Promise<T>): Promise<T> {
  const original = globalThis.fetch;
  globalThis.fetch = impl;
  return fn().finally(() => {
    globalThis.fetch = original;
  });
}

const okFetch = (body: string) => (async () => new Response(body, { status: 200 })) as unknown as typeof fetch;
const failFetch = (status: number) => (async () => new Response("nope", { status })) as unknown as typeof fetch;
const throwFetch = (async () => {
  throw new Error("network down");
}) as unknown as typeof fetch;

test("isJsonPayload accepts objects and arrays, rejects error pages and scalars", () => {
  assert.equal(isJsonPayload('{"a":1}'), true);
  assert.equal(isJsonPayload("[1,2]"), true);
  assert.equal(isJsonPayload("<html>502</html>"), false);
  assert.equal(isJsonPayload("null"), false);
  assert.equal(isJsonPayload("42"), false);
});

test("lkg envelope round-trips and rejects junk", () => {
  const round = decodeLkg(encodeLkg('{"ok":true}', 1234));
  assert.deepEqual(round, { ts: 1234, body: '{"ok":true}' });
  assert.equal(decodeLkg(null), null);
  assert.equal(decodeLkg("not json"), null);
  assert.equal(decodeLkg('{"body":"x"}'), null); // missing ts
});

test("each call site gets its own KV ttl — a long burns ttl cannot move the status feed", async () => {
  const kv = fakeKv();
  await withFetch(okFetch('{"events":[]}'), () =>
    proxyJson(envWith(kv), {}, "https://numetal.xyz/fees/events", "proxy:numetal:burns", 300),
  );
  await withFetch(okFetch('{"services":14}'), () =>
    proxyJson(envWith(kv), {}, "https://status.numetal.xyz/status.json", "proxy:numetal:status", 60),
  );
  assert.equal(kv.ttls.get("proxy:numetal:burns"), 300);
  assert.equal(kv.ttls.get("proxy:numetal:status"), 60);
});

test("ttl below the KV 60s floor is clamped on write but honoured in cache-control", async () => {
  const kv = fakeKv();
  const res = await withFetch(okFetch('{"a":1}'), () =>
    proxyJson(envWith(kv), {}, "https://up.example/x", "proxy:x", 30),
  );
  assert.equal(kv.ttls.get("proxy:x"), 60);
  assert.equal(res.headers.get("cache-control"), "public, max-age=30");
});

test("a successful fetch writes the last-known-good slot at 24h", async () => {
  const kv = fakeKv();
  const res = await withFetch(okFetch('{"price":"0.0000026"}'), () =>
    proxyJson(envWith(kv), {}, "https://numetal.xyz/fees/data", "proxy:numetal:fees", 60),
  );
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("x-stale"), "0");
  assert.equal(kv.ttls.get("proxy:numetal:fees:lkg"), 86_400);
  assert.equal(decodeLkg(kv.store.get("proxy:numetal:fees:lkg")!)?.body, '{"price":"0.0000026"}');
});

test("a non-JSON 200 is passed through but never poisons the last-known-good slot", async () => {
  const kv = fakeKv();
  const res = await withFetch(okFetch("<html>maintenance</html>"), () =>
    proxyJson(envWith(kv), {}, "https://up.example/x", "proxy:x", 60),
  );
  assert.equal(res.status, 200);
  assert.equal(kv.store.has("proxy:x:lkg"), false);
});

test("upstream 5xx serves the last-known-good body with x-stale: 1 instead of a 502", async () => {
  const kv = fakeKv();
  await withFetch(okFetch('{"n":1}'), () => proxyJson(envWith(kv), {}, "https://up.example/x", "proxy:x", 60));
  kv.store.delete("proxy:x"); // hot cache expires; lkg survives

  const res = await withFetch(failFetch(503), () => proxyJson(envWith(kv), {}, "https://up.example/x", "proxy:x", 60));
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("x-stale"), "1");
  assert.equal(res.headers.get("x-upstream-error"), "upstream_status_503");
  assert.ok(Number(res.headers.get("x-stale-age")) >= 0);
  assert.equal(await res.text(), '{"n":1}');
});

test("an unreachable upstream also serves last-known-good", async () => {
  const kv = fakeKv();
  await withFetch(okFetch('{"n":2}'), () => proxyJson(envWith(kv), {}, "https://up.example/x", "proxy:x", 60));
  kv.store.delete("proxy:x");

  const res = await withFetch(throwFetch, () => proxyJson(envWith(kv), {}, "https://up.example/x", "proxy:x", 60));
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("x-stale"), "1");
  assert.equal(res.headers.get("x-upstream-error"), "upstream_unreachable");
});

test("with no last-known-good body the proxy still fails loudly with 502", async () => {
  const kv = fakeKv();
  const res = await withFetch(failFetch(500), () => proxyJson(envWith(kv), {}, "https://up.example/x", "proxy:x", 60));
  assert.equal(res.status, 502);
  assert.equal(res.headers.get("x-stale"), "0");
  assert.equal((await res.json() as { error: string }).error, "upstream_status");
});

test("x-stale headers are CORS-exposed or no cross-origin consumer can read them", async () => {
  const kv = fakeKv();
  const co = { "Access-Control-Allow-Origin": "https://numetal.xyz", Vary: "Origin" };
  const res = await withFetch(okFetch('{"a":1}'), () => proxyJson(envWith(kv), co, "https://up.example/x", "proxy:x", 60));
  const expose = res.headers.get("access-control-expose-headers") ?? "";
  assert.match(expose, /x-stale/);
  assert.match(expose, /x-stale-age/);
  assert.equal(res.headers.get("access-control-allow-origin"), "https://numetal.xyz");
});
