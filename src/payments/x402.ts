/**
 * x402 payment adapter for api.gokhan.vc agent email ($1 USDC).
 * Adapted from numetal-datebook — same payTo / facilitator stack as Ishtar.
 */
import type { Env } from "./env";

export interface Sku {
  id: string;
  priceUsd: string;
  route: string;
}

export const AGENT_EMAIL_SKU: Sku = {
  id: "agent_email",
  priceUsd: "$1.00",
  route: "/agent/email",
};

const SKU_DESCRIPTIONS: Record<string, string> = {
  agent_email: "Paid cold email to Gökhan Turhan — $1 USDC per message (x402 on Base or MPP on Tempo).",
};

export const skuDescription = (sku: Sku): string => SKU_DESCRIPTIONS[sku.id] ?? `api.gokhan.vc ${sku.id}`;

export const STAGING_NETWORK = "eip155:84532";
export const STAGING_FACILITATOR = "https://x402.org/facilitator";
export const USDC_BASE_SEPOLIA = "0x036CbD53842c5426634e7929541eC2318f3dCF7e";
export const MAINNET_NETWORK = "eip155:8453";
export const CDP_FACILITATOR = "https://api.cdp.coinbase.com/platform/v2/x402";
export const USDC_BASE_MAINNET = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
export const X402_VERSION = 2;
export const X402_MAX_TIMEOUT_SECONDS = 300;

export interface VerifiedPayment {
  verified: boolean;
  payer?: string;
  tx?: string;
  amountUsdc?: string;
  nonce?: string;
  network?: string;
  payTo?: string;
  raw?: string;
}

const jwtEnc = new TextEncoder();
const b64url = (b: Uint8Array): string => btoa(String.fromCharCode(...b)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const fromB64 = (s: string): Uint8Array => Uint8Array.from(atob(s.trim()), (c) => c.charCodeAt(0));

export function parsePaymentHeader(header: string): { to?: string; value?: string; nonce?: string; network?: string } | null {
  let obj: Record<string, unknown> | null = null;
  for (const decode of [() => atob(header), () => header]) {
    try { obj = JSON.parse(decode()) as Record<string, unknown>; break; } catch { /* next */ }
  }
  if (!obj) return null;
  const payload = (obj.payload ?? {}) as Record<string, unknown>;
  const auth = (payload.authorization ?? obj.authorization ?? payload ?? {}) as Record<string, unknown>;
  const accepted = (obj.accepted ?? {}) as Record<string, unknown>;
  const asStr = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);
  return {
    network: asStr(obj.network ?? payload.network ?? accepted.network),
    to: asStr(auth.to),
    value: auth.value != null ? String(auth.value) : undefined,
    nonce: asStr(auth.nonce ?? obj.nonce),
  };
}

function apiBase(env: Env): string {
  return (env.PUBLIC_API_URL || "https://api.gokhan.vc").replace(/\/+$/, "");
}

function modeCfg(env: Env) {
  if (env.X402_MODE === "mainnet")
    return { network: MAINNET_NETWORK, facilitator: CDP_FACILITATOR, asset: USDC_BASE_MAINNET, mainnet: true, eip712: { name: "USD Coin", version: "2" } };
  return { network: STAGING_NETWORK, facilitator: STAGING_FACILITATOR, asset: USDC_BASE_SEPOLIA, mainnet: false, eip712: { name: "USDC", version: "2" } };
}

export function x402Requirements(env: Env, sku: Sku, payTo: string) {
  const cfg = modeCfg(env);
  const dollars = Number(sku.priceUsd.replace("$", ""));
  return {
    scheme: "exact",
    network: cfg.network,
    amount: String(Math.round(dollars * 1e6)),
    asset: cfg.asset,
    payTo,
    maxTimeoutSeconds: X402_MAX_TIMEOUT_SECONDS,
    extra: cfg.eip712,
  };
}

/** CDP Bazaar discovery extension — indexes the paid agent-email surface on first mainnet settle. */
export function x402BazaarExtension(sku: Sku): { bazaar: unknown } | null {
  if (sku.id !== "agent_email") return null;
  const input = {
    type: "http",
    method: "POST",
    bodyType: "json",
    body: { subject: "Agent intro", body: "Hello Gökhan — reaching out via paid agent email.", recipient: "contact" },
  };
  const output = {
    type: "json",
    example: { ok: true, order_id: "agentemail:x402:example", recipient: "contact@gokhanturhan.com", payer: "0x...", rail: "x402" },
  };
  return {
    bazaar: {
      description: skuDescription(sku),
      info: { input, output },
      schema: {
        $schema: "https://json-schema.org/draft/2020-12/schema",
        type: "object",
        properties: {
          input: {
            type: "object",
            properties: {
              type: { type: "string" },
              method: { type: "string" },
              bodyType: { type: "string" },
              body: {
                type: "object",
                properties: {
                  subject: { type: "string", maxLength: 200 },
                  body: { type: "string", maxLength: 8000 },
                  recipient: { type: "string", enum: ["contact", "investments"] },
                },
                required: ["subject", "body"],
              },
            },
            required: ["type", "method", "body"],
          },
          output: {
            type: "object",
            properties: {
              type: { type: "string" },
              example: {
                type: "object",
                properties: {
                  ok: { type: "boolean" },
                  order_id: { type: "string" },
                  recipient: { type: "string" },
                  payer: { type: "string" },
                  rail: { type: "string" },
                },
                required: ["ok", "order_id"],
              },
            },
            required: ["example"],
          },
        },
        required: ["input", "output"],
      },
    },
  };
}

export function x402ResourceInfo(env: Env, sku: Sku) {
  return { url: `${apiBase(env)}${sku.route}`, description: skuDescription(sku), mimeType: "application/json" };
}

export function encodeX402Header(obj: unknown): string {
  const bytes = new TextEncoder().encode(JSON.stringify(obj));
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

export async function x402Challenge(env: Env, sku: Sku, payTo: string, orderId: string, mppHeader?: string): Promise<Response> {
  const ext = x402BazaarExtension(sku);
  const body = {
    x402Version: X402_VERSION,
    error: "payment required",
    resource: x402ResourceInfo(env, sku),
    accepts: [x402Requirements(env, sku, payTo)],
    ...(ext ? { extensions: ext } : {}),
  };
  const headers: Record<string, string> = {
    "content-type": "application/json",
    "cache-control": "no-store",
    "x-order-id": orderId,
    "PAYMENT-REQUIRED": encodeX402Header(body),
  };
  if (mppHeader) headers["WWW-Authenticate"] = mppHeader;
  return new Response(JSON.stringify(body, null, 2), { status: 402, headers });
}

export async function cdpBearer(keyId: string, secretB64: string, method: string, host: string, path: string): Promise<string> {
  const raw = fromB64(secretB64);
  const seed = raw.length >= 32 ? raw.slice(0, 32) : raw;
  const pkcs8 = new Uint8Array([0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x04, 0x22, 0x04, 0x20, ...seed]);
  const key = await crypto.subtle.importKey("pkcs8", pkcs8, { name: "Ed25519" }, false, ["sign"]);
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: "EdDSA", typ: "JWT", kid: keyId, nonce: b64url(crypto.getRandomValues(new Uint8Array(16))) };
  const payload = { sub: keyId, iss: "cdp", aud: ["cdp_service"], nbf: now, exp: now + 120, uris: [`${method} ${host}${path}`] };
  const signingInput = `${b64url(jwtEnc.encode(JSON.stringify(header)))}.${b64url(jwtEnc.encode(JSON.stringify(payload)))}`;
  const sig = new Uint8Array(await crypto.subtle.sign({ name: "Ed25519" }, key, jwtEnc.encode(signingInput)));
  return `${signingInput}.${b64url(sig)}`;
}

function decodePayment(header: string): Record<string, unknown> | null {
  for (const dec of [() => atob(header), () => header]) {
    try { return JSON.parse(dec()) as Record<string, unknown>; } catch { /* next */ }
  }
  return null;
}

export async function verifyX402Payment(env: Env, paymentHeader: string, sku: Sku, payTo: string): Promise<VerifiedPayment> {
  const cfg = modeCfg(env);
  try {
    const terms = parsePaymentHeader(paymentHeader);
    if (!terms?.value || !terms.to) return { verified: false, raw: "payment terms unreadable" };
    let value: bigint;
    try { value = BigInt(terms.value); } catch { return { verified: false, raw: "bad amount" }; }
    const required = BigInt(Math.round(Number(sku.priceUsd.replace("$", "")) * 1e6));
    if (value < required) return { verified: false, raw: "underpayment" };
    if (terms.to.toLowerCase() !== payTo.toLowerCase()) return { verified: false, raw: "payTo mismatch" };
    if (terms.network && terms.network !== cfg.network) return { verified: false, raw: "network mismatch" };
    const ok = (): VerifiedPayment => ({
      verified: true,
      nonce: terms.nonce,
      payTo: terms.to,
      network: cfg.network,
      amountUsdc: (Number(value) / 1e6).toFixed(6),
    });

    if (cfg.mainnet) {
      if (!env.CDP_API_KEY_ID || !env.CDP_API_KEY_SECRET) return { verified: false, raw: "cdp keys missing" };
      const host = "api.cdp.coinbase.com";
      const base = "/platform/v2/x402";
      const paymentPayload = decodePayment(paymentHeader);
      if (!paymentPayload) return { verified: false, raw: "payment payload unreadable" };
      if (!paymentPayload.resource) paymentPayload.resource = x402ResourceInfo(env, sku).url;
      const ext = x402BazaarExtension(sku);
      const paymentRequirements = { ...x402Requirements(env, sku, payTo), ...(ext ? { extensions: ext } : {}) };
      const body = JSON.stringify({ x402Version: X402_VERSION, paymentPayload, paymentRequirements });
      const vTok = await cdpBearer(env.CDP_API_KEY_ID, env.CDP_API_KEY_SECRET, "POST", host, `${base}/verify`);
      const vr = await fetch(`${cfg.facilitator}/verify`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${vTok}` }, body });
      if (!vr.ok) return { verified: false, raw: `cdp verify ${vr.status}` };
      const vj = (await vr.json()) as { isValid?: boolean; invalidReason?: string; payer?: string };
      if (!vj.isValid) return { verified: false, raw: vj.invalidReason ?? "cdp rejected" };
      const sTok = await cdpBearer(env.CDP_API_KEY_ID, env.CDP_API_KEY_SECRET, "POST", host, `${base}/settle`);
      const sr = await fetch(`${cfg.facilitator}/settle`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${sTok}` }, body });
      if (!sr.ok) return { verified: false, raw: `cdp settle ${sr.status}` };
      const sj = (await sr.json()) as { success?: boolean; errorReason?: string; transaction?: string; payer?: string };
      if (!sj.success) return { verified: false, raw: sj.errorReason ?? "cdp settle failed" };
      return { ...ok(), payer: sj.payer, tx: sj.transaction };
    }

    const res = await fetch(`${cfg.facilitator}/verify`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ payment: paymentHeader, network: cfg.network, payTo, resource: sku.route }),
    });
    if (!res.ok) return { verified: false, raw: `facilitator ${res.status}` };
    const j = (await res.json()) as VerifiedPayment & { isValid?: boolean };
    if (!(j.verified ?? j.isValid ?? false)) return { verified: false, raw: j.raw ?? "facilitator rejected" };
    return { ...j, ...ok() };
  } catch (err) {
    return { verified: false, raw: `verify_error: ${(err as Error).message}` };
  }
}
