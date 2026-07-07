/**
 * OpenAPI 3.1 discovery document for api.gokhan.vc — read by x402scan, MPPscan, and
 * @agentcash/discovery validators. Served at GET /openapi.json.
 */
import type { Env } from "../payments/env.ts";
import { AGENT_EMAIL_SKU, type Sku } from "../payments/x402.ts";
import { mppCurrency, mppEnabled, mppRecipient, MPP_NETWORK } from "../payments/mpp.ts";

const apiBase = (env: Env): string => (env.PUBLIC_API_URL || "https://api.gokhan.vc").replace(/\/+$/, "");
const usd = (sku: Sku): string => Number(sku.priceUsd.replace("$", "")).toFixed(6);

function protocolsFor(env: Env, sku: Sku): unknown[] {
  const p: unknown[] = [{ x402: {} }];
  if (mppEnabled(env)) {
    p.push({
      mpp: {
        method: "tempo",
        intent: "charge",
        network: MPP_NETWORK,
        currency: mppCurrency(env),
        recipient: mppRecipient(env),
        supportedModes: ["push"],
      },
    });
  }
  return p;
}

function securityFor(env: Env, sku: Sku): Array<Record<string, string[]>> {
  const s: Array<Record<string, string[]>> = [{ x402: [] }];
  if (mppEnabled(env)) s.push({ mpp: [] });
  return s;
}

function ownershipDiscovery(env: Env): Record<string, unknown> {
  const proofs = (env.AGENTCASH_OWNERSHIP_PROOF ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  return proofs.length ? { "x-discovery": { ownershipProofs: proofs } } : {};
}

const jsonBody = (schema: unknown) => ({ required: true, content: { "application/json": { schema } } });
const jsonResp = (description: string, schema: unknown) => ({ description, content: { "application/json": { schema } } });

export function buildOpenApi(env: Env) {
  const base = apiBase(env);
  const email = AGENT_EMAIL_SKU;

  const emailInput = {
    type: "object",
    properties: {
      subject: { type: "string", minLength: 1, maxLength: 200, description: "Email subject line (max 200 chars)." },
      body: { type: "string", minLength: 1, maxLength: 8000, description: "Plain-text message body (max 8000 chars)." },
      from_email: { type: "string", format: "email", description: "Optional reply-to address for the founder." },
      recipient: { type: "string", enum: ["contact", "investments"], description: "Inbox: contact@gokhanturhan.com or investments@gokhan.vc." },
      agent: {
        type: "object",
        description: "Optional agent metadata for triage.",
        properties: {
          name: { type: "string" },
          url: { type: "string", format: "uri" },
          wallet: { type: "string", pattern: "^0x[a-fA-F0-9]{40}$" },
        },
      },
    },
    required: ["subject", "body"],
  };

  const emailOutput = {
    type: "object",
    properties: {
      ok: { type: "boolean" },
      order_id: { type: "string" },
      resend_id: { type: "string" },
      recipient: { type: "string" },
      subject: { type: "string" },
      payer: { type: "string" },
      tx: { type: "string", description: "Settlement transaction hash." },
      rail: { type: "string", enum: ["x402", "mpp"] },
      note: { type: "string" },
    },
    required: ["ok", "order_id", "recipient", "payer", "rail"],
  };

  const catalogSchema = {
    type: "object",
    properties: {
      name: { type: "string" },
      description: { type: "string" },
      version: { type: "string" },
      docs: { type: "string", format: "uri" },
      services: { type: "array", items: { type: "object" } },
    },
    required: ["name", "services"],
  };

  const blogPostSchema = {
    type: "object",
    properties: {
      site: { type: "string" },
      host: { type: "string" },
      slug: { type: "string" },
      url: { type: "string", format: "uri" },
      title: { type: "string" },
      published: { type: "string" },
      summary: { type: "string" },
      content_text: { type: "string" },
      content_html: { type: "string" },
      source: { type: "string", enum: ["html", "feed"] },
    },
    required: ["site", "slug", "title", "content_text"],
  };

  return {
    openapi: "3.1.0",
    info: {
      title: "api.gokhan.vc — Gökhan Turhan estate API gateway",
      version: "2.0.0",
      description:
        "Aggregate API front door for Gökhan Turhan's web estate — unified feeds, blog reader, llms.txt index, $NUMETAL status, and paid agent cold email.",
      "x-guidance":
        "Start at GET / or GET /_meta for the full service catalog. Read unified RSS/JSON feeds at GET /feed.xml or GET /feed.json. Fetch blog posts as JSON with GET /blog/{site}/{slug} (sites: ishtar, numetal, gokhanvc, memex). Aggregate llms.txt files at GET /llms or GET /llms.txt. Social/contact links at GET /social. Live $NUMETAL metrics at GET /numetal/fees, /numetal/burns, /numetal/status. To reach the founder by email, POST /agent/email with JSON {subject, body} — $1.00 USDC per message via x402 on Base or MPP on Tempo; a bare POST returns 402 with both payment challenges. Use recipient=contact (default) or investments. Ishtar dating API payments terminate at api.ishtar.numetal.xyz (this gateway links, never proxies paid surfaces).",
      contact: { email: "contact@gokhanturhan.com", url: "https://gokhan.vc" },
    },
    ...ownershipDiscovery(env),
    servers: [{ url: base }],
    paths: {
      "/agent/email": {
        post: {
          operationId: "sendPaidAgentEmail",
          summary: "Paid agent cold email — $1.00 USDC per message to the founder",
          description:
            "Delivers one email to contact@gokhanturhan.com or investments@gokhan.vc after payment settles. A bare POST (no payment header) returns 402 with x402 (PAYMENT-REQUIRED) and, when enabled, MPP (WWW-Authenticate) challenges — payment is checked before body validation. Subject is prefixed [PAID x402] or [PAID MPP].",
          tags: ["Agent Email"],
          "x-payment-info": {
            price: { mode: "fixed", currency: "USD", amount: usd(email) },
            protocols: protocolsFor(env, email),
          },
          security: securityFor(env, email),
          requestBody: jsonBody(emailInput),
          responses: {
            "200": jsonResp("Email queued via Resend.", emailOutput),
            "402": { description: "Payment Required — 402 carries x402 (PAYMENT-REQUIRED) and MPP (WWW-Authenticate) challenges." },
            "409": { description: "Payment or settlement tx already used." },
            "429": { description: "Rate limited." },
          },
        },
      },
      "/health": {
        get: {
          operationId: "healthCheck",
          summary: "Health probe",
          tags: ["Meta"],
          security: [],
          responses: { "200": jsonResp("Service healthy.", { type: "object", properties: { ok: { type: "boolean" }, service: { type: "string" } }, required: ["ok"] }) },
        },
      },
      "/_meta": {
        get: {
          operationId: "serviceCatalog",
          summary: "Machine-readable service catalog (JSON)",
          tags: ["Meta"],
          security: [],
          responses: { "200": jsonResp("Full estate API catalog.", catalogSchema) },
        },
      },
      "/": {
        get: {
          operationId: "rootCatalog",
          summary: "Root catalog — JSON unless Accept: text/html",
          tags: ["Meta"],
          security: [],
          responses: { "200": jsonResp("Service catalog (JSON) or HTML index.", catalogSchema) },
        },
      },
      "/feed": {
        get: {
          operationId: "feedIndex",
          summary: "Unified feed URLs",
          tags: ["Feed"],
          security: [],
          responses: {
            "200": jsonResp("Permanent RSS and JSON Feed URLs.", {
              type: "object",
              properties: { rss: { type: "string", format: "uri" }, json: { type: "string", format: "uri" } },
              required: ["rss", "json"],
            }),
          },
        },
      },
      "/feed.xml": {
        get: {
          operationId: "unifiedRss",
          summary: "Unified RSS 2.0 across all estate sites",
          tags: ["Feed"],
          security: [],
          responses: { "200": { description: "RSS 2.0 XML.", content: { "application/rss+xml": { schema: { type: "string" } } } } },
        },
      },
      "/feed.json": {
        get: {
          operationId: "unifiedJsonFeed",
          summary: "Unified JSON Feed 1.1 across all estate sites",
          tags: ["Feed"],
          security: [],
          responses: { "200": { description: "JSON Feed 1.1.", content: { "application/feed+json": { schema: { type: "object" } } } } },
        },
      },
      "/numetal/fees": {
        get: {
          operationId: "numetalFees",
          summary: "Live $NUMETAL snapshot (price, supply, burned, fdv, mcap)",
          tags: ["Numetal"],
          security: [],
          responses: { "200": jsonResp("Proxied from numetal.xyz/fees/data.", { type: "object" }) },
        },
      },
      "/numetal/burns": {
        get: {
          operationId: "numetalBurns",
          summary: "Fee-engine burn/buyback events",
          tags: ["Numetal"],
          security: [],
          responses: { "200": jsonResp("Proxied from numetal.xyz/fees/events.", { type: "object" }) },
        },
      },
      "/numetal/status": {
        get: {
          operationId: "numetalStatus",
          summary: "Public status.numetal.xyz snapshot",
          tags: ["Numetal"],
          security: [],
          responses: { "200": jsonResp("Proxied status JSON.", { type: "object" }) },
        },
      },
      "/llms": {
        get: {
          operationId: "llmsAggregate",
          summary: "JSON map of llms.txt per estate site (KV-cached 1h)",
          tags: ["Estate"],
          security: [],
          parameters: [{ name: "full", in: "query", schema: { type: "string", enum: ["0", "1"] }, description: "Set full=1 to include llms-full.txt where available." }],
          responses: {
            "200": jsonResp("Per-site llms.txt contents.", {
              type: "object",
              properties: { fetched_at: { type: "string" }, sites: { type: "array", items: { type: "object" } } },
              required: ["sites"],
            }),
          },
        },
      },
      "/llms.txt": {
        get: {
          operationId: "llmsCombinedText",
          summary: "Combined plain-text llms index across the estate",
          tags: ["Estate"],
          security: [],
          responses: { "200": { description: "Combined llms.txt text.", content: { "text/plain": { schema: { type: "string" } } } } },
        },
      },
      "/blog": {
        get: {
          operationId: "blogLookup",
          summary: "Blog post reader (query-string alias)",
          tags: ["Blog"],
          security: [],
          parameters: [
            { name: "site", in: "query", required: true, schema: { type: "string", enum: ["ishtar", "numetal", "gokhanvc", "memex"] } },
            { name: "slug", in: "query", required: true, schema: { type: "string" } },
          ],
          responses: {
            "200": jsonResp("Post body as JSON.", blogPostSchema),
            "404": { description: "Post not found." },
          },
        },
      },
      "/blog/{site}/{slug}": {
        get: {
          operationId: "blogPostByPath",
          summary: "Blog post body as JSON (content_text + metadata)",
          tags: ["Blog"],
          security: [],
          parameters: [
            { name: "site", in: "path", required: true, schema: { type: "string", enum: ["ishtar", "numetal", "gokhanvc", "memex"] } },
            { name: "slug", in: "path", required: true, schema: { type: "string" } },
          ],
          responses: {
            "200": jsonResp("Post body as JSON.", blogPostSchema),
            "404": { description: "Post not found." },
          },
        },
      },
      "/social": {
        get: {
          operationId: "socialCatalog",
          summary: "Structured follow/join/contact links per property",
          tags: ["Estate"],
          security: [],
          responses: {
            "200": jsonResp("Social and contact catalog.", {
              type: "object",
              properties: { updated: { type: "string" }, properties: { type: "array", items: { type: "object" } } },
              required: ["properties"],
            }),
          },
        },
      },
      "/agent": {
        get: {
          operationId: "agentEmailDescriptor",
          summary: "Paid agent email service descriptor (free read)",
          tags: ["Agent Email"],
          security: [],
          responses: { "200": jsonResp("Agent email service metadata.", { type: "object" }) },
        },
      },
    },
    components: {
      securitySchemes: {
        x402: {
          type: "apiKey",
          in: "header",
          name: "payment-signature",
          description:
            "x402 pay-per-call (USDC on Base). Bare POST returns 402 with PAYMENT-REQUIRED; retry with payment-signature or x-payment header after signing.",
        },
        mpp: {
          type: "http",
          scheme: "Payment",
          description:
            "MPP on Tempo (push mode). The 402 carries WWW-Authenticate: Payment; retry with Authorization: Payment <credential>. Success returns Payment-Receipt.",
        },
      },
    },
  };
}
