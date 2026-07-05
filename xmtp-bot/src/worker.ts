// feedhub-xmtp-bot — Container Worker.
//  - XmtpBot: the Container DO that runs the Node/XMTP process (see app/), fed secrets via envVars.
//  - default fetch: routes admin-gated control endpoints into the container. Persistence via R2 was
//    retired (send-only bot re-registers + revokes each cold start), so there is NO public /r2 door
//    and NO PERSIST_TOKEN in the container — nothing to leak or poison.
import { Container, getContainer } from "@cloudflare/containers";

interface Env {
  XMTP_BOT: DurableObjectNamespace<XmtpBot>;
  ADMIN_TOKEN: string;
  XMTP_WALLET_KEY: string;
  XMTP_DB_ENCRYPTION_KEY: string;
  XMTP_ENV: string;
  FEEDHUB_ADMIN_URL: string;
  FEEDHUB_ADMIN_TOKEN: string;
  LAUNCH_ARMED: string;
}

// Constant-time bearer check: SHA-256 both sides to a fixed 32 bytes, then XOR-compare — no length
// branch, no value oracle.
async function bearerOk(req: Request, token: string): Promise<boolean> {
  const enc = new TextEncoder();
  const got = req.headers.get("Authorization") || "";
  const [a, b] = await Promise.all([
    crypto.subtle.digest("SHA-256", enc.encode(got)),
    crypto.subtle.digest("SHA-256", enc.encode("Bearer " + token)),
  ]);
  const x = new Uint8Array(a), y = new Uint8Array(b);
  let d = 0;
  for (let i = 0; i < 32; i++) d |= x[i] ^ y[i];
  return d === 0;
}

export class XmtpBot extends Container<Env> {
  defaultPort = 8080;
  sleepAfter = "10m";

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx as any, env);
    this.envVars = {
      XMTP_WALLET_KEY: env.XMTP_WALLET_KEY ?? "",
      XMTP_DB_ENCRYPTION_KEY: env.XMTP_DB_ENCRYPTION_KEY ?? "",
      XMTP_ENV: env.XMTP_ENV ?? "production",
      FEEDHUB_ADMIN_URL: env.FEEDHUB_ADMIN_URL ?? "",
      FEEDHUB_ADMIN_TOKEN: env.FEEDHUB_ADMIN_TOKEN ?? "",
      LAUNCH_ARMED: env.LAUNCH_ARMED ?? "0",
    };
  }
}

const CONTROL = new Set(["/launch-blast", "/canmessage-dryrun", "/fanout"]);

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const p = new URL(req.url).pathname;

    // Minimal, unauthenticated liveness — worker-level only (does NOT wake the container or leak the
    // bot's inboxId/env).
    if (p === "/health") return Response.json({ ok: true, service: "feedhub-xmtp-bot" });

    // Force-cycle the container so a new image rolls (a running max_instances:1 instance otherwise
    // keeps serving the old image until it sleeps).
    if (p === "/_restart") {
      if (!(await bearerOk(req, env.ADMIN_TOKEN))) return new Response("unauthorized", { status: 401 });
      const c = getContainer(env.XMTP_BOT, "singleton") as any;
      try { await c.destroy(); } catch (_) { try { await c.stop(); } catch (_) {} }
      return new Response("restarting");
    }

    // Control (admin-gated) → forward into the container.
    if (CONTROL.has(p)) {
      if (!(await bearerOk(req, env.ADMIN_TOKEN))) return new Response("unauthorized", { status: 401 });
      const body = await req.text();
      return getContainer(env.XMTP_BOT, "singleton").fetch(
        new Request("http://c" + p, { method: "POST", headers: { "content-type": "application/json" }, body: body || "{}" })
      );
    }

    return new Response("feedhub-xmtp-bot", { status: 200 });
  },
};
