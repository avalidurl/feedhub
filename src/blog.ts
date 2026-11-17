/** Unified blog reader — resolve posts across the estate. */

import { ESTATE_SITES, resolveSiteId, type EstateSite } from "./estate.ts";

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

const ALLOWED_TAGS = new Set([
  "a", "p", "br", "hr", "em", "strong", "b", "i", "u", "s", "ul", "ol", "li",
  "h1", "h2", "h3", "h4", "h5", "h6", "blockquote", "code", "pre",
  "span", "div", "figure", "figcaption", "img", "sup", "sub", "section",
  "table", "thead", "tbody", "tr", "th", "td", "del", "ins", "mark", "kbd",
  "cite", "q", "small", "abbr", "time", "dl", "dt", "dd",
]);
const DROP_WITH_CONTENT = new Set(["script", "style", "noscript", "iframe", "object", "embed", "template", "svg", "math"]);

function isSpace(c: string | undefined): boolean {
  return c === " " || c === "\t" || c === "\n" || c === "\r" || c === "\f";
}
function isNameStart(c: string | undefined): boolean {
  if (!c) return false;
  const x = c.charCodeAt(0);
  return (x >= 65 && x <= 90) || (x >= 97 && x <= 122);
}
function isNameChar(c: string): boolean {
  const x = c.charCodeAt(0);
  return isNameStart(c) || (x >= 48 && x <= 57) || c === "-";
}
function skipSpace(s: string, i: number): number {
  while (isSpace(s[i])) i++;
  return i;
}
function readName(s: string, i: number): { name: string; end: number } | null {
  if (!isNameStart(s[i])) return null;
  const start = i;
  i++;
  while (i < s.length && isNameChar(s[i])) i++;
  return { name: s.slice(start, i).toLowerCase(), end: i };
}
function parseTag(raw: string): { name: string; closing: boolean } | null {
  let i = skipSpace(raw, 0);
  let closing = false;
  if (raw[i] === "/") {
    closing = true;
    i = skipSpace(raw, i + 1);
  }
  const info = readName(raw, i);
  if (!info) return null;
  return { name: info.name, closing };
}
function entityLen(s: string, i: number): number {
  if (s[i] !== "&") return 0;
  let j = i + 1;
  if (s[j] === "#") {
    j++;
    const hex = s[j] === "x" || s[j] === "X";
    if (hex) j++;
    const start = j;
    while (j < s.length && (hex ? isHex(s[j]) : s[j] >= "0" && s[j] <= "9")) j++;
    if (j === start || j - start > 6 || s[j] !== ";") return 0;
    return j + 1 - i;
  }
  const start = j;
  while (j < s.length && isNameStart(s[j])) j++;
  if (j === start || j - start > 12 || s[j] !== ";") return 0;
  return j + 1 - i;
}
function isHex(c: string): boolean {
  const x = c.charCodeAt(0);
  return (x >= 48 && x <= 57) || (x >= 65 && x <= 70) || (x >= 97 && x <= 102);
}
function escapeText(s: string, quote = false): string {
  let out = "";
  let i = 0;
  while (i < s.length) {
    const c = s[i];
    if (c === "&") {
      const n = entityLen(s, i);
      if (n > 0) { out += s.slice(i, i + n); i += n; continue; }
      out += "&amp;";
      i++;
      continue;
    }
    if (c === "<") { out += "&lt;"; i++; continue; }
    if (c === ">") { out += "&gt;"; i++; continue; }
    if (quote && c === '"') { out += "&quot;"; i++; continue; }
    out += c;
    i++;
  }
  return out;
}
function entityChar(body: string): string | null {
  const named: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };
  if (named[body] !== undefined) return named[body];
  if (body[0] !== "#") return null;
  const hex = body[1] === "x" || body[1] === "X";
  const digits = hex ? body.slice(2) : body.slice(1);
  if (!digits || digits.length > 6) return null;
  for (const c of digits) if (hex ? !isHex(c) : c < "0" || c > "9") return null;
  const cp = parseInt(digits, hex ? 16 : 10);
  if (!Number.isFinite(cp) || cp < 0 || cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff)) return null;
  if (cp === 0xa0 || cp === 9 || cp === 10 || cp === 13) return " ";
  return String.fromCodePoint(cp);
}
function decodeEntitiesOnce(s: string): string {
  let out = "";
  let i = 0;
  while (i < s.length) {
    if (s[i] !== "&") { out += s[i]; i++; continue; }
    const semi = s.indexOf(";", i + 1);
    if (semi === -1 || semi - i > 16) { out += "&"; i++; continue; }
    const ch = entityChar(s.slice(i + 1, semi));
    if (ch === null) { out += "&"; i++; continue; }
    out += ch;
    i = semi + 1;
  }
  return out;
}
function attrValue(tagBody: string, attr: string): string | null {
  let i = skipSpace(tagBody, 0);
  if (tagBody[i] === "/") i++;
  const name = readName(tagBody, i);
  i = name ? name.end : i;
  const lower = tagBody.toLowerCase();
  while (i < tagBody.length) {
    i = skipSpace(lower, i);
    if (i >= lower.length || lower[i] === "/" || lower[i] === ">") break;
    const attrName = readName(lower, i);
    if (!attrName) { i++; continue; }
    i = skipSpace(lower, attrName.end);
    if (lower[i] !== "=") continue;
    i = skipSpace(lower, i + 1);
    let value = "";
    if (tagBody[i] === '"' || tagBody[i] === "'") {
      const q = tagBody[i];
      i++;
      const start = i;
      while (i < tagBody.length && tagBody[i] !== q) i++;
      value = tagBody.slice(start, i);
      if (tagBody[i] === q) i++;
    } else {
      const start = i;
      while (i < tagBody.length && !isSpace(tagBody[i]) && tagBody[i] !== "/" && tagBody[i] !== ">") i++;
      value = tagBody.slice(start, i);
    }
    if (attrName.name === attr) return value;
  }
  return null;
}
function safeUrl(raw: string): string | null {
  const decoded = decodeEntitiesOnce(raw).trim();
  if (!decoded) return null;
  for (let i = 0; i < decoded.length; i++) {
    const c = decoded.charCodeAt(i);
    if (c <= 32 || c === 127) return null;
    const ch = decoded[i];
    if (ch === "<" || ch === ">" || ch === '"' || ch === "'" || ch === "`" || ch === "\\") return null;
  }
  const lower = decoded.toLowerCase();
  const ok = lower.startsWith("https://") || lower.startsWith("http://") || lower.startsWith("mailto:") || (decoded.startsWith("/") && !decoded.startsWith("//"));
  if (!ok) return null;
  return escapeText(decoded, true);
}
function skipElement(input: string, i: number, name: string): number {
  const lower = input.toLowerCase();
  const endTag = "</" + name;
  while (i < lower.length) {
    const j = lower.indexOf(endTag, i);
    if (j === -1) return input.length;
    let k = skipSpace(lower, j + endTag.length);
    if (lower[k] === "/") k = skipSpace(lower, k + 1);
    if (lower[k] === ">") return k + 1;
    i = j + 1;
  }
  return input.length;
}
function sanitizeArticle(input: string): string {
  let out = "";
  let i = 0;
  while (i < input.length) {
    const lt = input.indexOf("<", i);
    if (lt === -1) { out += escapeText(input.slice(i)); break; }
    out += escapeText(input.slice(i, lt));
    if (input.startsWith("<![CDATA[", lt)) {
      const end = input.indexOf("]]>", lt + 9);
      if (end === -1) break;
      out += escapeText(input.slice(lt + 9, end));
      i = end + 3;
      continue;
    }
    if (input.startsWith("<!--", lt)) {
      const end = input.indexOf("-->", lt + 4);
      i = end === -1 ? input.length : end + 3;
      continue;
    }
    if (input.startsWith("<?", lt) || input.startsWith("<!", lt)) {
      const gt = input.indexOf(">", lt + 2);
      i = gt === -1 ? input.length : gt + 1;
      continue;
    }
    const next = input[lt + 1];
    if (!isNameStart(next) && next !== "/") { out += "&lt;"; i = lt + 1; continue; }
    const gt = input.indexOf(">", lt + 1);
    if (gt === -1) break;
    const raw = input.slice(lt + 1, gt);
    const parsed = parseTag(raw);
    i = gt + 1;
    if (!parsed) continue;
    if (!parsed.closing && DROP_WITH_CONTENT.has(parsed.name)) {
      i = skipElement(input, i, parsed.name);
      continue;
    }
    if (!ALLOWED_TAGS.has(parsed.name)) continue;
    if (parsed.closing) { out += `</${parsed.name}>`; continue; }
    if (parsed.name === "a") {
      const href = safeUrl(attrValue(raw, "href") ?? "");
      out += href ? `<a href="${href}">` : "<a>";
      continue;
    }
    if (parsed.name === "img") {
      const src = safeUrl(attrValue(raw, "src") ?? "");
      if (!src) continue;
      const alt = escapeText(attrValue(raw, "alt") ?? "", true);
      out += `<img src="${src}" alt="${alt}">`;
      continue;
    }
    out += `<${parsed.name}>`;
  }
  return out.trim();
}
function htmlToText(html: string): string {
  let out = "";
  let i = 0;
  while (i < html.length) {
    const lt = html.indexOf("<", i);
    if (lt === -1) { out += html.slice(i); break; }
    out += html.slice(i, lt);
    const gt = html.indexOf(">", lt + 1);
    if (gt === -1) { out += html.slice(lt); break; }
    const parsed = parseTag(html.slice(lt + 1, gt));
    if (parsed && !parsed.closing && parsed.name === "br") out += "\n";
    else if (parsed && parsed.closing && parsed.name === "p") out += "\n";
    else out += " ";
    i = gt + 1;
  }
  return out;
}
function normalizePlain(s: string): string {
  let out = "";
  let i = 0;
  while (i < s.length) {
    const c = s[i];
    if (isSpace(c) || c === "\v") {
      let nl = false;
      while (i < s.length && (isSpace(s[i]) || s[i] === "\v")) {
        if (s[i] === "\n" || s[i] === "\r") nl = true;
        i++;
      }
      out += nl ? "\n" : " ";
      continue;
    }
    out += c;
    i++;
  }
  return out.trim();
}
function stripEdgeSlashes(s: string): string {
  let start = 0;
  let end = s.length;
  while (start < end && s.charCodeAt(start) === 47) start++;
  while (end > start && s.charCodeAt(end - 1) === 47) end--;
  return s.slice(start, end);
}

export function extractArticle(html: string): { title: string; published?: string; summary?: string; content_html: string; content_text: string } {
  const title = metaContent(html, "og:title") ?? html.match(/<title[^>]*>([^<]+)<\/title>/i)?.[1]?.replace(/\s*\|.*$/, "").trim() ?? "Untitled";
  const published = metaContent(html, "article:published_time") ?? html.match(/<time[^>]+datetime=["']([^"']+)["']/i)?.[1];
  const summary = html.match(/<meta[^>]+name=["']description["'][^>]+content=["']([^"']+)["']/i)?.[1] ?? metaContent(html, "og:description");
  const article = html.match(/<article[^>]*>([\s\S]*?)<\/article>/i)?.[1]
    ?? html.match(/<main[^>]*>([\s\S]*?)<\/main>/i)?.[1]
    ?? "";
  const content_html = sanitizeArticle(article);
  const content_text = normalizePlain(decodeEntitiesOnce(htmlToText(content_html)));
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
  const slug = stripEdgeSlashes(slugRaw);
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
