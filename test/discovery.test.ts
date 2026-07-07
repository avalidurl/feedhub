import test from "node:test";
import assert from "node:assert/strict";
import { buildOpenApi } from "../src/discovery/openapi.ts";

const PAY = "0x36de990133D36d7E3DF9a820aA3eDE5a2320De71";
const env = {
  PUBLIC_API_URL: "https://api.gokhan.vc",
  PAY_TO: PAY,
  MPP_ENABLED: "true",
  MPP_SECRET_KEY: "test-secret",
  MPP_RECIPIENT: "0x3e267aA9439C82FfB36078676E67901a1ca6D352",
  X402_MODE: "mainnet",
} as const;

test("openapi declares paid agent email with x402+mpp and schemas", () => {
  const doc = buildOpenApi(env) as {
    paths: Record<string, { post?: { "x-payment-info"?: { protocols: unknown[]; price: { amount: string } }; requestBody?: unknown; security?: Array<Record<string, string[]>> } }>;
    components?: { securitySchemes?: Record<string, unknown> };
  };
  const op = doc.paths["/agent/email"]?.post;
  assert.ok(op?.["x-payment-info"], "x-payment-info");
  assert.ok(op?.requestBody, "requestBody");
  assert.equal(op?.["x-payment-info"]?.price.amount, "1.000000");
  const proto = (op?.["x-payment-info"]?.protocols as Array<Record<string, unknown>>).map((x) => Object.keys(x)[0]);
  assert.deepEqual(proto, ["x402", "mpp"]);
  const secKeys = (op?.security ?? []).flatMap((s) => Object.keys(s));
  assert.deepEqual(secKeys, ["x402", "mpp"]);
  assert.ok(doc.components?.securitySchemes?.x402);
  assert.ok(doc.components?.securitySchemes?.mpp);
});

test("openapi declares free reads with security: []", () => {
  const doc = buildOpenApi(env) as {
    paths: Record<string, { get?: { security?: unknown[]; "x-payment-info"?: unknown }; post?: { security?: unknown[]; "x-payment-info"?: unknown } }>;
  };
  const freeGets = [
    "/health", "/_meta", "/", "/feed", "/feed.xml", "/feed.json", "/feed/rss.xml", "/feed/feed.json",
    "/openapi.json", "/.well-known/x402", "/llms", "/llms.txt", "/social", "/blog", "/blog/{site}/{slug}",
    "/numetal/fees", "/numetal/burns", "/numetal/status", "/agent", "/newsletter", "/newsletter/confirm", "/newsletter/unsubscribe",
  ];
  for (const p of freeGets) {
    const op = doc.paths[p]?.get;
    assert.ok(op, `${p} GET`);
    assert.deepEqual(op?.security, [], `${p} security`);
    assert.equal(op?.["x-payment-info"], undefined, `${p} not paid`);
  }
  for (const p of ["/newsletter/subscribe", "/newsletter/xmtp/subscribe"]) {
    const op = doc.paths[p]?.post;
    assert.ok(op, `${p} POST`);
    assert.deepEqual(op?.security, [], `${p} security`);
    assert.equal(op?.["x-payment-info"], undefined, `${p} not paid`);
  }
  const unsubPost = doc.paths["/newsletter/unsubscribe"]?.post;
  assert.deepEqual(unsubPost?.security, [], "/newsletter/unsubscribe POST security");
});

test("every operation declares security explicitly (free=[] or paid schemes)", () => {
  const doc = buildOpenApi(env) as {
    paths: Record<string, Record<string, { security?: unknown[]; "x-payment-info"?: unknown }>>;
  };
  for (const [path, methods] of Object.entries(doc.paths)) {
    for (const [method, op] of Object.entries(methods)) {
      assert.ok("security" in op, `${method.toUpperCase()} ${path} missing security`);
      if (op["x-payment-info"]) {
        assert.ok((op.security ?? []).length > 0, `${method.toUpperCase()} ${path} paid needs security schemes`);
      } else {
        assert.deepEqual(op.security, [], `${method.toUpperCase()} ${path} free must be security: []`);
      }
    }
  }
});

test("ownership proofs only when AGENTCASH_OWNERSHIP_PROOF is set", () => {
  const without = buildOpenApi(env) as Record<string, unknown>;
  assert.equal(without["x-discovery"], undefined);
  const withProof = buildOpenApi({ ...env, AGENTCASH_OWNERSHIP_PROOF: "proof-a, proof-b" }) as {
    "x-discovery"?: { ownershipProofs?: string[] };
  };
  assert.deepEqual(withProof["x-discovery"]?.ownershipProofs, ["proof-a", "proof-b"]);
});

test("openapi has guidance and contact email", () => {
  const doc = buildOpenApi(env) as { info: { "x-guidance"?: string; contact?: { email?: string } } };
  assert.ok(doc.info["x-guidance"]?.includes("/agent/email"));
  assert.equal(doc.info.contact?.email, "contact@gokhan.vc");
});
