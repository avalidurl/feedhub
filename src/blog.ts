/** Unified blog reader — resolve posts across the estate. */

import { ESTATE_SITES, resolveSiteId, type EstateSite } from "./estate";

export interface BlogPost {
  site: string;
  host: string;
  slug: string;
  url: string;
  title: string;
  published?: string;
  summary?: string;
  content_html?: string;
  content_text: string;
  source: "html" | "feed";
}

function slugFromUrl(url: string, site: EstateSite): string | null {
  try {
    const u = new URL(url);
    const path = u.pathname.replace(/\/+$/, "");
    if (site.id === "memex" && path.startsWith("/journal/")) return path.slice("/journal/".length);
    if (path.startsWith("/blog/")) return path.slice("/blog/".length);
    if (site.id === "numetal" && path.startsWith("/blog/")) return path.slice("/blog/".length);
    return null;
  } catch {
    return null;
  }
}

function metaContent(html: string, key: string, attr = "property"): string | undefined {
  const re1 = new RegExp(`<meta[^>]+${attr}=["']${key}["'][^>]+content="([^"]+)"`, "i");
  const re2 = new RegExp(`<meta[^>]+content="([^"]+)"[^>]+${attr}=["']${key}["']`, "i");
  const re3 = new RegExp(`<meta[^>]+${attr}=["']${key}["'][^>]+content='([^']+)'`, "i");
  return html.match(re1)?.[1] ?? html.match(re2)?.[1] ?? html.match(re3)?.[1];
}

function extractArticle(html: string): { title: string; published?: string; summary?: string; content_html: string; content_text: string } {
  const title = metaContent(html, "og:title") ?? html.match(/<title[^>]*>([^<]+)<\/title>/i)?.[1]?.replace(/\s*\|.*$/, "").trim() ?? "Untitled";
  const published = metaContent(html, "article:published_time") ?? html.match(/<time[^>]+datetime=["']([^"']+)["']/i)?.[1];
  const summary = html.match(/<meta[^>]+name=["']description["'][^>]+content=["']([^"']+)["']/i)?.[1] ?? metaContent(html, "og:description");
  const article = html.match(/<article[^>]*>([\s\S]*?)<\/article>/i)?.[1]
    ?? html.match(/<main[^>]*>([\s\S]*?)<\/main>/i)?.[1]
    ?? "";
  const content_html = article.replace(/<script[\s\S]*?<\/script>/gi, "").replace(/<style[\s\S]*?<\/style>/gi, "").trim();
  const content_text = content_html
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+\n/g, "\n")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return { title, published, summary, content_html, content_text };
}

async function findInFeed(feedJson: string, site: EstateSite, slug: string): Promise<string | null> {
  try {
    const feed = JSON.parse(feedJson) as { items?: Array<{ url?: string; id?: string }> };
    const needle = slug.toLowerCase();
    for (const item of feed.items ?? []) {
      const url = item.url || item.id || "";
      const itemSlug = slugFromUrl(url, site);
      if (itemSlug?.toLowerCase() === needle) return url;
      if (url.toLowerCase().includes(needle)) return url;
    }
  } catch { /* fall through */ }
  return null;
}

export async function readBlogPost(
  siteRaw: string,
  slugRaw: string,
  feedCache: string | null,
): Promise<BlogPost | { error: string; status: number }> {
  const site = resolveSiteId(siteRaw);
  if (!site) return { error: "unknown_site", status: 400 };
  const slug = slugRaw.replace(/^\/+|\/+$/g, "");
  if (!slug || slug.length > 200) return { error: "bad_slug", status: 400 };

  let url: string | null = null;
  if (feedCache) url = await findInFeed(feedCache, site, slug);
  if (!url) {
    const path = site.blogPattern.replace("{slug}", slug);
    url = `https://${site.host}${path.startsWith("/") ? path : `/${path}`}`;
  }

  const res = await fetch(url, { headers: { "User-Agent": "api.gokhan.vc/2.0", Accept: "text/html" }, redirect: "follow" });
  if (!res.ok) return { error: "post_not_found", status: res.status === 404 ? 404 : 502 };
  const html = await res.text();
  const extracted = extractArticle(html);
  if (!extracted.content_text || extracted.content_text.length < 80) {
    return { error: "content_too_short", status: 502 };
  }
  const canonical = html.match(/<link[^>]+rel=["']canonical["'][^>]+href=["']([^"']+)["']/i)?.[1] ?? url;
  return {
    site: site.id,
    host: site.host,
    slug,
    url: canonical,
    title: extracted.title,
    published: extracted.published,
    summary: extracted.summary,
    content_html: extracted.content_html,
    content_text: extracted.content_text,
    source: feedCache && (await findInFeed(feedCache, site, slug)) ? "feed" : "html",
  };
}

export function listBlogSites(): Array<{ id: string; host: string; blog_base: string; example: string }> {
  return ESTATE_SITES.map((s) => ({
    id: s.id,
    host: s.host,
    blog_base: s.blogBase,
    example: `${s.blogBase}${s.blogPattern.replace("{slug}", "example-slug").replace(s.blogBase, "")}`,
  }));
}
