// feedhub-xmtp-bot — Container Worker.
//  - XmtpBot: the Container DO that runs the Node/XMTP process (see app/), fed secrets via envVars.
//  - default fetch: mediates R2 persistence for the container (/r2/<key>, shared-secret) and routes
//    admin-gated control endpoints (/launch-blast, /canmessage-dryrun, /fanout) into the container.
import { Container, getContainer } from "@cloudflare/containers";

interface Env {
  XMTP_BOT: DurableObjectNamespace<XmtpBot>;
  DB_BUCKET: R2Bucket;
  ADMIN_TOKEN: string;
  PERSIST_TOKEN: string;
  XMTP_WALLET_KEY: string;
  XMTP_DB_ENCRYPTION_KEY: string;
  XMTP_ENV: string;
  FEEDHUB_ADMIN_URL: string;
  FEEDHUB_ADMIN_TOKEN: string;
  SELF_URL: string;
  LAUNCH_ARMED: string;
}

export class XmtpBot extends Container<Env> {
  defaultPort = 8080;
  sleepAfter = "10m";

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx as any, env);
    // Surface secrets + config to the container process as env vars.
    this.envVars = {
      XMTP_WALLET_KEY: env.XMTP_WALLET_KEY ?? "",
      XMTP_DB_ENCRYPTION_KEY: env.XMTP_DB_ENCRYPTION_KEY ?? "",
      XMTP_ENV: env.XMTP_ENV ?? "production",
      FEEDHUB_ADMIN_URL: env.FEEDHUB_ADMIN_URL ?? "",
      FEEDHUB_ADMIN_TOKEN: env.FEEDHUB_ADMIN_TOKEN ?? "",
      SELF_URL: env.SELF_URL ?? "",
      PERSIST_TOKEN: env.PERSIST_TOKEN ?? "",
      LAUNCH_ARMED: env.LAUNCH_ARMED ?? "0",
    };
  }
}

const CONTROL = new Set(["/launch-blast", "/canmessage-dryrun", "/fanout"]);

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    const p = url.pathname;

    // ---- persistence: container <-> R2 MLS-DB backup (shared-secret) ----
    if (p.startsWith("/r2/")) {
      if (req.headers.get("X-Persist-Token") !== env.PERSIST_TOKEN) return new Response("unauthorized", { status: 401 });
      const key = decodeURIComponent(p.slice("/r2/".length));
      if (!key) return new Response("bad key", { status: 400 });
      if (req.method === "GET") {
        const o = await env.DB_BUCKET.get(key);
        return o ? new Response(o.body, { headers: { "content-type": "application/octet-stream" } }) : new Response(null, { status: 404 });
      }
      if (req.method === "PUT") { await env.DB_BUCKET.put(key, req.body); return new Response("ok"); }
      if (req.method === "DELETE") { await env.DB_BUCKET.delete(key); return new Response("ok"); }
      return new Response("method not allowed", { status: 405 });
    }

    // ---- force-cycle the container so a new image rolls (a running max_instances:1 instance
    //      otherwise keeps serving the old image until it sleeps) ----
    if (p === "/_restart") {
      if (req.headers.get("Authorization") !== "Bearer " + env.ADMIN_TOKEN) return new Response("unauthorized", { status: 401 });
      const c = getContainer(env.XMTP_BOT, "singleton") as any;
      try { await c.destroy(); } catch (_) { try { await c.stop(); } catch (_) {} }
      return new Response("restarting");
    }

    // ---- health (also confirms the container is up) ----
    if (p === "/health") {
      try {
        return await getContainer(env.XMTP_BOT, "singleton").fetch(new Request("http://c/health"));
      } catch (e) {
        return Response.json({ ok: false, error: String((e as any)?.message ?? e) }, { status: 503 });
      }
    }

    // ---- control (admin-gated) → forward into the container ----
    if (CONTROL.has(p)) {
      if (req.headers.get("Authorization") !== "Bearer " + env.ADMIN_TOKEN) return new Response("unauthorized", { status: 401 });
      const body = await req.text();
      return getContainer(env.XMTP_BOT, "singleton").fetch(
        new Request("http://c" + p, { method: "POST", headers: { "content-type": "application/json" }, body: body || "{}" })
      );
    }

    return new Response("feedhub-xmtp-bot", { status: 200 });
  },
};
