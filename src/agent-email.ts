/**
 * Paid agent cold email — $1 USDC via x402 (Base) or MPP (Tempo).
 * POST /agent/email → 402 without payment → verify → Resend to founder inbox.
 */
import { AGENT_EMAIL_RECIPIENT_KEYS, resolveAgentEmailRecipient } from "./agent-email-recipients";
import type { PaymentEnv } from "./payments/env";
import { AGENT_EMAIL_SKU, encodeX402Header, parsePaymentHeader, verifyX402Payment, x402Challenge } from "./payments/x402";
import { buildMppChallengeHeader, mppEnabled, mppReceiptHeader, parseMppAuth, verifyMppPayment, MPP_NETWORK } from "./payments/mpp";

type AgentEmailEnv = PaymentEnv & {
  DB: D1Database;
  FEED_CACHE: KVNamespace;
  RESEND_API_KEY: string;
  SENDER: string;
  AGENT_EMAIL_SENDER?: string;
};

const MAX_SUBJECT = 200;
const MAX_BODY = 8000;
const MAX_FROM = 200;

export interface AgentEmailBody {
  subject?: string;
  body?: string;
  from_email?: string;
  recipient?: string;
  agent?: { name?: string; url?: string; wallet?: string };
}

function escapeHtml(s: string): string {
  return String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c] as string));
}

async function sha256Hex(s: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export async function handleAgentEmail(req: Request, env: AgentEmailEnv, co: Record<string, string>): Promise<Response> {
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405, co);
  if (!env.PAY_TO) return json({ error: "payments_not_configured" }, 503, co);
  if (!env.RESEND_API_KEY) return json({ error: "email_not_configured" }, 503, co);

  const ip = req.headers.get("CF-Connecting-IP") || "0";
  if (!(await rlHit(env, "agentemail:ip:" + ip, 20, 3600))) return json({ error: "rate_limited" }, 429, co);

  const paymentHeader = req.headers.get("payment-signature") ?? req.headers.get("x-payment");
  const mppCred = mppEnabled(env) ? parseMppAuth(req.headers.get("authorization") ?? undefined) : null;
  const sku = AGENT_EMAIL_SKU;

  if (!paymentHeader && !mppCred) {
    const mppHeader = mppEnabled(env) ? await buildMppChallengeHeader(env, sku) : undefined;
    return x402Challenge(env, sku, env.PAY_TO, "agentemail:pending", mppHeader);
  }

  const parsed = (await req.json().catch(() => ({}))) as AgentEmailBody;
  const subject = (parsed.subject || "").trim();
  const body = (parsed.body || "").trim();
  const fromEmail = (parsed.from_email || "").trim().toLowerCase();
  const recipientKey = (parsed.recipient || "contact").trim().toLowerCase();
  const to = resolveAgentEmailRecipient(recipientKey);
  if (!to) return json({ error: "bad_recipient", allowed: AGENT_EMAIL_RECIPIENT_KEYS }, 400, co);
  if (!subject || subject.length > MAX_SUBJECT) return json({ error: "bad_subject", max: MAX_SUBJECT }, 400, co);
  if (!body || body.length > MAX_BODY) return json({ error: "bad_body", max: MAX_BODY }, 400, co);
  if (fromEmail && (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(fromEmail) || fromEmail.length > MAX_FROM)) {
    return json({ error: "bad_from_email" }, 400, co);
  }

  const isMpp = !paymentHeader && !!mppCred;
  const orderId = isMpp
    ? `agentemail:mpp:${mppCred!.challenge.id ?? "noid"}`
    : `agentemail:x402:${parsePaymentHeader(paymentHeader!)?.nonce ?? "nononce"}`;

  const prior = await env.DB.prepare("SELECT order_id FROM agent_emails WHERE order_id=?1").bind(orderId).first();
  if (prior) return json({ error: "payment_already_used", order_id: orderId }, 409, co);

  const v = isMpp ? await verifyMppPayment(env, mppCred!, sku) : await verifyX402Payment(env, paymentHeader!, sku, env.PAY_TO);
  if (!v.verified || !v.payer) {
    const mppHeader = mppEnabled(env) ? await buildMppChallengeHeader(env, sku) : undefined;
    return x402Challenge(env, sku, env.PAY_TO, orderId, mppHeader);
  }

  if (v.tx) {
    const txUsed = await env.DB.prepare("SELECT order_id FROM agent_emails WHERE settlement_tx=?1").bind(v.tx).first();
    if (txUsed) return json({ error: "settlement_tx_already_used", tx: v.tx }, 409, co);
  }

  const payer = v.payer.toLowerCase();
  if (!(await rlHit(env, "agentemail:payer:" + payer, 10, 86400))) return json({ error: "payer_rate_limited" }, 429, co);

  const paidTag = isMpp ? "[PAID MPP]" : "[PAID x402]";
  const finalSubject = subject.startsWith("[PAID") ? subject : `${paidTag} ${subject}`;
  const bodyHash = await sha256Hex(body);
  const agentMeta = parsed.agent ? JSON.stringify(parsed.agent).slice(0, 500) : null;

  const html = `<p><strong>Paid agent email</strong> — $1 USDC via ${isMpp ? "MPP/Tempo" : "x402/Base"}</p>
<ul>
<li>Order: <code>${escapeHtml(orderId)}</code></li>
<li>Payer: <code>${escapeHtml(payer)}</code></li>
${v.tx ? `<li>Tx: <code>${escapeHtml(v.tx)}</code></li>` : ""}
${fromEmail ? `<li>Reply-to: ${escapeHtml(fromEmail)}</li>` : ""}
${agentMeta ? `<li>Agent: <code>${escapeHtml(agentMeta)}</code></li>` : ""}
</ul>
<hr/>
<pre style="white-space:pre-wrap;font-family:ui-monospace,Menlo,monospace">${escapeHtml(body)}</pre>`;

  const send = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: "Bearer " + env.RESEND_API_KEY, "content-type": "application/json", "User-Agent": "feedhub/2.0" },
    body: JSON.stringify({
      from: env.AGENT_EMAIL_SENDER || env.SENDER,
      to: [to],
      reply_to: fromEmail || undefined,
      subject: finalSubject,
      html,
      text: `${paidTag}\nOrder: ${orderId}\nPayer: ${payer}\nTx: ${v.tx ?? "n/a"}\n\n${body}`,
    }),
  });
  const sent = (await send.json().catch(() => ({}))) as { id?: string; message?: string };
  if (!send.ok) return json({ error: "send_failed", detail: sent.message ?? send.status }, 502, co);

  await env.DB.prepare(
    `INSERT INTO agent_emails (order_id,payer,amount_usdc,network,nonce,settlement_tx,subject,recipient,from_email,body_hash,resend_id,agent_meta,status,created_at)
     VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,'sent',?13)`,
  ).bind(
    orderId, payer, v.amountUsdc ?? "1.00", isMpp ? MPP_NETWORK : (v.network ?? "eip155:8453"),
    v.nonce ?? null, v.tx ?? null, finalSubject, to, fromEmail || null, bodyHash,
    sent.id ?? null, agentMeta, Date.now(),
  ).run();

  const headers: Record<string, string> = { ...co, "content-type": "application/json" };
  if (isMpp && v.tx) headers["Payment-Receipt"] = mppReceiptHeader(env, mppCred!.challenge.id!, v.tx, sku);
  else if (v.tx) headers["PAYMENT-RESPONSE"] = encodeX402Header({ success: true, transaction: v.tx, network: v.network, payer: v.payer });

  return new Response(JSON.stringify({
    ok: true,
    order_id: orderId,
    resend_id: sent.id,
    recipient: to,
    subject: finalSubject,
    payer,
    tx: v.tx,
    rail: isMpp ? "mpp" : "x402",
    note: "Paid emails use [PAID x402] or [PAID MPP] in the subject — include payment receipt id or tx in follow-ups.",
  }), { status: 200, headers });
}

function json(data: unknown, status = 200, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json", ...headers } });
}

async function rlHit(env: AgentEmailEnv, key: string, limit: number, windowSec: number): Promise<boolean> {
  const k = "rl:" + key;
  const n = parseInt((await env.FEED_CACHE.get(k)) || "0", 10) || 0;
  if (n >= limit) return false;
  await env.FEED_CACHE.put(k, String(n + 1), { expirationTtl: windowSec });
  return true;
}
