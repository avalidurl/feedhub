#!/usr/bin/env node
/**
 * One-shot dispatch newsletter — email (Resend broadcast) + XMTP wallet fan-out.
 * Usage: ADMIN_TOKEN=... node scripts/send-dispatch.mjs
 * Env: ADMIN_TOKEN (feedhub admin), optional XMTP_BOT_URL (default https://xmtp-bot.gokhan.vc)
 */
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || "";
const FEEDHUB = process.env.FEEDHUB_URL || "https://api.gokhan.vc";
const XMTP_BOT = process.env.XMTP_BOT_URL || "https://xmtp-bot.gokhan.vc";

const CANONICAL = "https://ishtar.numetal.xyz/blog/universal-sex-layer/";
const TITLE = "Ishtar — the universal sex layer";
const SUBJECT = "The universal sex layer is live";
const SUMMARY =
  '"Organs crawl like aphids upon the immobile motor of becoming" — Nick Land. Agent-native courtship infrastructure: your agent does the dating; you show up when both sides have already agreed.';
const HTML = `<blockquote><p><em>Organs crawl like aphids upon the immobile motor of becoming</em></p><p>— Nick Land</p></blockquote><p>I'm building the agent-native layer for romance — <strong>the universal sex layer</strong>. Not another swipe app. Your agent holds your dating doc and courts on the floor; humans meet only after mutual match, 18+ check, and consent.</p><p>Live today: floor, Talk, Window, API, MCP, HeartBench — real mainnet payments on x402 and MPP.</p>`;

if (!ADMIN_TOKEN) {
  console.error("ADMIN_TOKEN required");
  process.exit(1);
}

const auth = { Authorization: `Bearer ${ADMIN_TOKEN}`, "content-type": "application/json" };

async function main() {
  const status = await fetch(`${FEEDHUB}/admin/status`, { headers: auth });
  if (!status.ok) throw new Error(`admin/status ${status.status}`);
  const st = await status.json();
  console.log("subscribers:", st.subscribers);

  const email = await fetch(`${FEEDHUB}/admin/dispatch-blast`, {
    method: "POST",
    headers: auth,
    body: JSON.stringify({
      canonical_url: CANONICAL,
      title: SUBJECT,
      summary: SUMMARY,
      html: HTML,
    }),
  });
  const emailBody = await email.json();
  if (!email.ok) throw new Error(`dispatch-blast failed: ${JSON.stringify(emailBody)}`);
  console.log("email broadcast:", emailBody);

  const xmtp = await fetch(`${XMTP_BOT}/fanout`, {
    method: "POST",
    headers: auth,
    body: JSON.stringify({
      canonical_url: CANONICAL,
      url: CANONICAL,
      title: TITLE,
      excerpt: SUMMARY,
      quote: '"Organs crawl like aphids upon the immobile motor of becoming" — Nick Land',
      deck: "https://ishtar.numetal.xyz/deck/not-raising-a-preseed/ishtar-deck-not-a-preseed.pdf",
    }),
  });
  const xmtpBody = await xmtp.json();
  if (!xmtp.ok) throw new Error(`xmtp fanout failed: ${JSON.stringify(xmtpBody)}`);
  console.log("xmtp fanout:", xmtpBody);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
