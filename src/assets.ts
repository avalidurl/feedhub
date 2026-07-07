/** Public studio assets (PDFs, etc.) from R2 — embed-friendly headers for syndicated blog iframes. */

export const DECK_PDF_URL = "https://assets.numetal.xyz/deck/ishtar-deck-not-a-preseed.pdf";
export const DECK_PDF_EMBED_URL = `${DECK_PDF_URL}#toolbar=1&navpanes=1`;

const EMBED_FRAME_ANCESTORS =
  "frame-ancestors 'self' https://ishtar.numetal.xyz https://numetal.xyz https://www.numetal.xyz https://gokhanturhan.com https://www.gokhanturhan.com https://gokhan.vc https://www.gokhan.vc";

const MIME: Record<string, string> = {
  pdf: "application/pdf",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  webp: "image/webp",
  svg: "image/svg+xml",
  md: "text/markdown; charset=utf-8",
  txt: "text/plain; charset=utf-8",
};

/** Map request path → R2 object key under `assets/`. Returns null if not an asset route. */
export function assetR2Key(host: string, pathname: string): string | null {
  const p = pathname.replace(/\/+$/, "") || "/";
  if (host === "assets.numetal.xyz") {
    if (p === "/" || p === "") return null;
    return `assets${p}`;
  }
  if (p.startsWith("/assets/")) return p.slice(1);
  return null;
}

export async function serveAsset(
  req: Request,
  env: { ASSETS: R2Bucket },
  key: string,
  extraHeaders: Record<string, string> = {},
): Promise<Response> {
  if (req.method !== "GET" && req.method !== "HEAD") {
    return new Response("Method not allowed", { status: 405, headers: extraHeaders });
  }

  const obj = await env.ASSETS.get(key);
  if (!obj) return new Response("Not found", { status: 404, headers: extraHeaders });

  const ext = key.split(".").pop()?.toLowerCase() || "";
  const mime = MIME[ext] || "application/octet-stream";
  const inline = ext === "pdf";

  const headers: Record<string, string> = {
    "content-type": mime,
    "content-disposition": `${inline ? "inline" : "attachment"}; filename="${key.split("/").pop()}"`,
    "cache-control": "public, max-age=86400, stale-while-revalidate=604800",
    "x-content-type-options": "nosniff",
    "referrer-policy": "no-referrer",
    ...extraHeaders,
  };

  if (ext === "pdf") {
    headers["content-security-policy"] = `default-src 'none'; ${EMBED_FRAME_ANCESTORS}`;
  }

  if (obj.etag) headers.etag = obj.etag;

  return new Response(req.method === "HEAD" ? null : obj.body, { status: 200, headers });
}
