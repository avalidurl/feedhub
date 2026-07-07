/**
 * MPP push-mode verification for api.gokhan.vc agent email.
 * Tempo TIP-20 transfer hash verification — adapted from numetal-datebook (push path only).
 */
import type { Env } from "./env";
import type { Sku, VerifiedPayment } from "./x402";

export const TEMPO_USDC = "0x20c000000000000000000000b9537d11c60e8b50";
export const TEMPO_CHAIN_ID = 4217;
export const MPP_NETWORK = `eip155:${TEMPO_CHAIN_ID}`;
const DEFAULT_TEMPO_RPC = "https://rpc.tempo.xyz";
const TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const CHALLENGE_TTL_MS = 10 * 60 * 1000;

export function mppEnabled(env: Env): boolean {
  const on = env.MPP_ENABLED === "1" || env.MPP_ENABLED === "true";
  return on && !!env.MPP_SECRET_KEY && !!(env.MPP_RECIPIENT || env.PAY_TO);
}

export function mppRecipient(env: Env): string {
  return (env.MPP_RECIPIENT || env.PAY_TO || "").toLowerCase();
}

export function mppCurrency(env: Env): string {
  return (env.MPP_CURRENCY || TEMPO_USDC).toLowerCase();
}

function tempoRpc(env: Env): string {
  return env.TEMPO_RPC_URL || DEFAULT_TEMPO_RPC;
}

function mppRealm(env: Env): string {
  return new URL(env.PUBLIC_API_URL || "https://api.gokhan.vc").host;
}

export function atomicAmount(sku: Sku): string {
  return String(Math.round(Number(sku.priceUsd.replace("$", "")) * 1e6));
}

export function b64urlEncode(s: string): string {
  const bytes = new TextEncoder().encode(s);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function b64urlDecode(s: string): string {
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (s.length % 4)) % 4);
  const bin = atob(b64);
  return new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)));
}

async function hmacB64url(secret: string, input: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(input)));
  let bin = "";
  for (const b of sig) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function ctEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}

function bindingInput(realm: string, method: string, intent: string, request: string, expires: string, digest: string, opaque: string): string {
  return [realm, method, intent, request, expires, digest, opaque].join("|");
}

export async function buildMppChallengeHeader(env: Env, sku: Sku): Promise<string> {
  const realm = mppRealm(env);
  const request = b64urlEncode(JSON.stringify({
    amount: atomicAmount(sku),
    currency: mppCurrency(env),
    methodDetails: { chainId: TEMPO_CHAIN_ID, supportedModes: ["push"] },
    recipient: mppRecipient(env),
  }));
  const opaque = b64urlEncode(JSON.stringify({ n: crypto.randomUUID(), s: sku.id }));
  const expires = new Date(Date.now() + CHALLENGE_TTL_MS).toISOString().replace(/\.\d{3}Z$/, "Z");
  const id = await hmacB64url(env.MPP_SECRET_KEY!, bindingInput(realm, "tempo", "charge", request, expires, "", opaque));
  return `Payment id="${id}", realm="${realm}", method="tempo", intent="charge", expires="${expires}", opaque="${opaque}", request="${request}"`;
}

export interface MppCredential {
  challenge: { id?: string; realm?: string; method?: string; intent?: string; request?: string; expires?: string; opaque?: string; digest?: string };
  payload: { type?: string; signature?: string; hash?: string };
}

export function parseMppAuth(header: string | undefined): MppCredential | null {
  if (!header) return null;
  const m = header.match(/^Payment\s+([A-Za-z0-9_-]+)$/i);
  if (!m) return null;
  try {
    const cred = JSON.parse(b64urlDecode(m[1]!)) as MppCredential;
    if (!cred?.challenge || !cred?.payload) return null;
    return cred;
  } catch {
    return null;
  }
}

interface RpcLog { address: string; topics: string[]; data: string }
const topicAddr = (topic: string): string => ("0x" + topic.slice(-40)).toLowerCase();

async function fetchTempoReceipt(env: Env, hash: string): Promise<{ status?: string; logs?: RpcLog[] } | null> {
  const r = await fetch(tempoRpc(env), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_getTransactionReceipt", params: [hash] }),
  });
  if (!r.ok) return null;
  const j = (await r.json()) as { result?: { status?: string; logs?: RpcLog[] } | null };
  return j.result ?? null;
}

function findTransferLog(env: Env, logs: RpcLog[] | undefined, want: bigint): RpcLog | undefined {
  const isHex = (s: string) => /^0x[0-9a-fA-F]*$/.test(s);
  return (logs ?? []).find(
    (l) =>
      l.address?.toLowerCase() === mppCurrency(env) &&
      l.topics?.[0] === TRANSFER_TOPIC &&
      l.topics.length >= 3 &&
      topicAddr(l.topics[2]!) === mppRecipient(env) &&
      isHex(l.data) &&
      BigInt(l.data || "0x0") >= want,
  );
}

async function verifyChallengeAuthenticity(env: Env, cred: MppCredential, sku: Sku): Promise<{ ok: true; amount: bigint } | { ok: false; raw: string }> {
  const ch = cred.challenge;
  if (ch.method !== "tempo" || ch.intent !== "charge") return { ok: false, raw: "method-unsupported" };
  if (!ch.id || !ch.request || ch.realm !== mppRealm(env)) return { ok: false, raw: "invalid-challenge" };
  const expectId = await hmacB64url(env.MPP_SECRET_KEY!, bindingInput(ch.realm, ch.method, ch.intent, ch.request, ch.expires ?? "", ch.digest ?? "", ch.opaque ?? ""));
  if (!ctEqual(expectId, ch.id)) return { ok: false, raw: "invalid-challenge" };
  if (ch.expires && Date.parse(ch.expires) < Date.now()) return { ok: false, raw: "payment-expired" };
  let req: { amount?: string; currency?: string; recipient?: string };
  try { req = JSON.parse(b64urlDecode(ch.request)); } catch { return { ok: false, raw: "malformed-credential" }; }
  if (req.currency?.toLowerCase() !== mppCurrency(env)) return { ok: false, raw: "verification-failed" };
  if (req.recipient?.toLowerCase() !== mppRecipient(env)) return { ok: false, raw: "verification-failed" };
  if (req.amount !== atomicAmount(sku)) return { ok: false, raw: "payment-insufficient" };
  return { ok: true, amount: BigInt(req.amount) };
}

export async function verifyMppPayment(env: Env, cred: MppCredential, sku: Sku): Promise<VerifiedPayment> {
  try {
    const ch = cred.challenge;
    const pre = await verifyChallengeAuthenticity(env, cred, sku);
    if (!pre.ok) return { verified: false, raw: pre.raw };
    const want = pre.amount;
    if (cred.payload.type !== "hash") return { verified: false, raw: "verification-failed" };
    const hash = cred.payload.hash;
    if (!hash || !/^0x[0-9a-fA-F]{64}$/.test(hash)) return { verified: false, raw: "malformed-credential" };
    let receipt: Awaited<ReturnType<typeof fetchTempoReceipt>> = null;
    for (let i = 0; i < 2 && !receipt; i++) {
      receipt = await fetchTempoReceipt(env, hash).catch(() => null);
      if (!receipt && i === 0) await new Promise((r) => setTimeout(r, 500));
    }
    if (!receipt || receipt.status !== "0x1") return { verified: false, raw: "verification-failed" };
    const log = findTransferLog(env, receipt.logs, want);
    if (!log) return { verified: false, raw: "verification-failed" };
    const payer = topicAddr(log.topics[1]!);
    return { verified: true, payer, tx: hash.toLowerCase(), amountUsdc: (Number(want) / 1e6).toFixed(2), nonce: ch.id };
  } catch {
    return { verified: false, raw: "verification-failed" };
  }
}

export function mppReceiptHeader(env: Env, challengeId: string, tx: string, sku: Sku): string {
  return b64urlEncode(JSON.stringify({
    challengeId,
    method: "tempo",
    reference: tx,
    settlement: { amount: atomicAmount(sku), currency: mppCurrency(env) },
    status: "success",
    timestamp: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
  }));
}
