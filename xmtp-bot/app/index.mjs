// feedhub XMTP newsletter bot — the Node process inside the CF Container.
// HTTP control server on :8080 (the managing Worker forwards control requests here):
//   GET  /health            → liveness + our inboxId
//   POST /canmessage-dryrun → restore DB, register/rehydrate, canMessage the recipient list, NO sends
//   POST /launch-blast      → the one-time launch DM to XMTP-reachable subscribers (gated on LAUNCH_ARMED=1)
//   POST /fanout            → per-post fan-out (later)
// Persistence: the MLS DB is restored from R2 on first use and backed up after each op.
import { createServer } from "node:http";
import { createClient, reachable, sendDm, resolveWallet, inboxSummary } from "./xmtp.mjs";

const PORT = 8080;
const DB_PATH = "/data/xmtp.db3";
const {
  XMTP_WALLET_KEY,
  XMTP_DB_ENCRYPTION_KEY,
  XMTP_ENV = "production",
  FEEDHUB_ADMIN_URL,
  FEEDHUB_ADMIN_TOKEN,
  LAUNCH_ARMED = "0",
} = process.env;

// --- launch copy (subject locked by the operator; body carries both live posts + per-recipient unsub) ---
const LAUNCH_KEY = "launch-2026-07";
function launchMessage(unsubUrl) {
  return [
    "Hey — you follow my work, so you get this first. I've put everything into one feed, and two things just happened in two days:",
    "",
    "Yesterday I launched Ishtar — a world where the users are AI agents: they write their own dating docs, match, court, and commit on-chain, in the open.",
    "→ https://ishtar.numetal.xyz/blog/ishtar-is-live",
    "",
    "Today I opened a raise. It's not a pre-seed — $20k, $4k a head, capital pointed at agents that ship.",
    "→ https://ishtar.numetal.xyz/blog/not-raising-a-preseed",
    "",
    "— Gökhan",
    "",
    `Unsubscribe: ${unsubUrl}`,
  ].join("\n");
}

let client = null;
async function ensureClient() {
  if (client) return client;
  client = await createClient({ privateKey: XMTP_WALLET_KEY, env: XMTP_ENV, dbPath: DB_PATH, dbEncryptionKey: XMTP_DB_ENCRYPTION_KEY });
  // The container disk is ephemeral, so each cold start makes a new XMTP installation. Revoke every
  // OTHER installation so the inbox stays pinned at 1 and never hits the 10-installation cap. A
  // send-only newsletter bot keeps no message history, so losing the old installation costs nothing.
  try { await client.revokeAllOtherInstallations(); console.log("revoked other installations"); }
  catch (e) { console.error("revoke failed:", String(e?.message ?? e)); }
  console.log(`xmtp client ready inbox=${client.inboxId}`);
  return client;
}

async function fetchRecipients() {
  const r = await fetch(`${FEEDHUB_ADMIN_URL}/admin/xmtp/recipients`, { headers: { Authorization: "Bearer " + FEEDHUB_ADMIN_TOKEN } });
  if (!r.ok) throw new Error("recipients HTTP " + r.status);
  return (await r.json()).recipients || [];
}
async function reportSends(key, results) {
  await fetch(`${FEEDHUB_ADMIN_URL}/admin/xmtp/report`, {
    method: "POST",
    headers: { Authorization: "Bearer " + FEEDHUB_ADMIN_TOKEN, "content-type": "application/json" },
    body: JSON.stringify({ key, results }),
  });
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Subscriber ids already delivered for this campaign — makes launch-blast idempotent (retry failures,
// never double-DM a delivered recipient).
async function fetchSent(key) {
  const r = await fetch(`${FEEDHUB_ADMIN_URL}/admin/xmtp/sent?key=${encodeURIComponent(key)}`, { headers: { Authorization: "Bearer " + FEEDHUB_ADMIN_TOKEN } });
  return r.ok ? new Set((await r.json()).sent || []) : new Set();
}

// Resolve every recipient's wallet (0x as-is, .eth → address, else null) once per run.
async function resolvedRecipients() {
  const raw = await fetchRecipients();
  const out = [];
  for (const r of raw) out.push({ ...r, address: await resolveWallet(r.wallet) });
  return out;
}

async function canMessageDryRun() {
  const c = await ensureClient();
  const recips = await resolvedRecipients();
  const valid = recips.filter((r) => r.address);
  const map = await reachable(c, valid.map((r) => r.address));
  const reach = valid.filter((r) => map.get(r.address) === true).length;
  return { total: recips.length, resolvable: valid.length, invalid: recips.length - valid.length, reachable: reach };
}

async function launchBlast() {
  if (LAUNCH_ARMED !== "1") throw new Error("not armed (LAUNCH_ARMED != 1)");
  const c = await ensureClient();
  const recips = await resolvedRecipients();
  const alreadySent = await fetchSent(LAUNCH_KEY); // idempotent: never re-DM an already-delivered wallet
  const valid = recips.filter((r) => r.address);
  const map = await reachable(c, valid.map((r) => r.address));
  const results = [];
  let already = 0;
  for (const r of recips) {
    if (alreadySent.has(r.subscriber_id)) { already++; continue; }
    if (!r.address || map.get(r.address) !== true) { results.push({ subscriber_id: r.subscriber_id, status: "skipped" }); continue; }
    try {
      const id = await sendDm(c, r.address, launchMessage(r.unsub_url));
      results.push({ subscriber_id: r.subscriber_id, status: "sent", provider_id: id });
    } catch (e) {
      results.push({ subscriber_id: r.subscriber_id, status: "failed" });
      console.error("send failed", r.address, String(e?.message ?? e));
    }
    await sleep(120); // pace well under XMTP's ~3000-publishes/5-min per-IP write cap
  }
  await reportSends(LAUNCH_KEY, results);
  const by = (s) => results.filter((x) => x.status === s).length;
  return { total: recips.length, already_delivered: already, sent_now: by("sent"), skipped: by("skipped"), failed: by("failed") };
}

const send = (res, code, obj) => { res.writeHead(code, { "content-type": "application/json" }); res.end(JSON.stringify(obj)); };

createServer(async (req, res) => {
  try {
    if (req.url === "/health") return send(res, 200, { ok: true, inboxId: client?.inboxId ?? null, env: XMTP_ENV });
    if (req.method === "POST" && req.url === "/canmessage-dryrun") return send(res, 200, await canMessageDryRun());
    if (req.method === "POST" && req.url === "/launch-blast") return send(res, 200, await launchBlast());
    return send(res, 404, { error: "not found" });
  } catch (e) {
    send(res, 500, { error: String(e?.message ?? e) });
  }
}).listen(PORT, () => console.log("xmtp-bot listening on", PORT));
