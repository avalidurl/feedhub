import test from "node:test";
import assert from "node:assert/strict";
import { resolveSiteId, llmsCombinedText, SOCIAL_CATALOG } from "../src/estate.ts";
import { parsePaymentHeader } from "../src/payments/x402.ts";

test("resolveSiteId accepts aliases", () => {
  assert.equal(resolveSiteId("gokhan.vc")?.id, "gokhanvc");
  assert.equal(resolveSiteId("memex")?.host, "gokhanturhan.com");
  assert.equal(resolveSiteId("ishtar.numetal.xyz")?.id, "ishtar");
  assert.equal(resolveSiteId("unknown"), null);
});

test("llmsCombinedText includes host sections", () => {
  const text = llmsCombinedText([
    { site: "gokhanvc", host: "gokhan.vc", url: "https://gokhan.vc/llms.txt", status: 200, content: "# test" },
    { site: "numetal", host: "numetal.xyz", url: "https://numetal.xyz/llms.txt", status: 404, error: "http_404" },
  ]);
  assert.match(text, /gokhan\.vc/);
  assert.match(text, /unavailable/);
});

test("social catalog has four properties", () => {
  assert.equal(SOCIAL_CATALOG.properties.length, 4);
  const memex = SOCIAL_CATALOG.properties.find((p) => p.id === "memex");
  assert.ok(memex?.follow.some((f) => f.href.includes("x.com/goekhan")));
});

test("parsePaymentHeader reads authorization fields", () => {
  const payload = btoa(JSON.stringify({
    payload: { authorization: { to: "0x36de990133D36d7E3DF9a820aA3eDE5a2320De71", value: "1000000", nonce: "abc" } },
    network: "eip155:8453",
  }));
  const terms = parsePaymentHeader(payload);
  assert.equal(terms?.to?.toLowerCase(), "0x36de990133d36d7e3df9a820aa3ede5a2320de71");
  assert.equal(terms?.value, "1000000");
  assert.equal(terms?.nonce, "abc");
});
