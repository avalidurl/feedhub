import test from "node:test";
import assert from "node:assert/strict";
import { extractArticle } from "../src/blog.ts";
import { buildOpenApi } from "../src/discovery/openapi.ts";
import { parseFeed } from "../src/index.ts";
import { AGENT_EMAIL_SKU, x402ResourceInfo } from "../src/payments/x402.ts";

const PAY = "0x36de990133D36d7E3DF9a820aA3eDE5a2320De71";

test("blog html keeps text and drops script, style, and handlers", () => {
  const html = `<article>
    <p>Hello <em>world</em></p>
    <script>alert(1)</script>
    <scr<script>ipt>nope</script>
    <style>body{}</style>
    <p>After</p>
    <a href="javascript:alert(1)" onclick="alert(2)">bad</a>
    <a href="https://example.com/a?x=1&amp;y=2">ok</a>
    <img src="https://example.com/a.png" alt="pic &amp; more" onerror="alert(1)">
  </article>`;
  const got = extractArticle(html);
  assert.equal(got.content_html.includes("<script"), false);
  assert.equal(got.content_html.includes("onclick"), false);
  assert.equal(got.content_html.includes("onerror"), false);
  assert.equal(got.content_html.includes("javascript:"), false);
  assert.equal(got.content_html.includes("alert(1)"), false);
  assert.match(got.content_html, /<a href="https:\/\/example.com\/a\?x=1&amp;y=2">ok<\/a>/);
  assert.match(got.content_html, /<img src="https:\/\/example.com\/a.png" alt="pic &amp; more">/);
  assert.match(got.content_text, /Hello world/);
  assert.match(got.content_text, /After/);
  assert.equal(got.content_text.includes("<script"), false);
  assert.equal(got.content_text.includes("body{}"), false);
});

test("entity decode does not turn &amp;lt; into a tag", () => {
  const got = extractArticle("<article><p>&amp;lt;script&amp;gt;</p></article>");
  assert.equal(got.content_text.includes("<script"), false);
  assert.match(got.content_text, /&lt;script&gt;/);
  assert.equal(got.content_html.includes("<script"), false);
});

test("closing script tags with space before > are removed", () => {
  const got = extractArticle("<article><p>Keep</p><script>alert(1)</script ><p>Yes</p></article>");
  assert.equal(got.content_html.includes("alert"), false);
  assert.match(got.content_text, /Keep/);
  assert.match(got.content_text, /Yes/);
});

test("slug edges are stripped without a slash regex", async () => {
  const { readBlogPost } = await import("../src/blog.ts");
  assert.deepEqual(await readBlogPost("ishtar", "///"), { error: "bad_slug", status: 400 });
  assert.deepEqual(await readBlogPost("ishtar", "/"), { error: "bad_slug", status: 400 });
});

test("api bases drop trailing slashes", () => {
  const env = { PUBLIC_API_URL: "https://api.gokhan.vc///", PAY_TO: PAY, MPP_ENABLED: "false" };
  const doc = buildOpenApi(env) as { servers: Array<{ url: string }> };
  assert.equal(doc.servers[0].url, "https://api.gokhan.vc");
  assert.equal(x402ResourceInfo(env, AGENT_EMAIL_SKU).url, "https://api.gokhan.vc/agent/email");
});

test("feed text unwraps cdata and does not rebuild script tags", () => {
  const items = parseFeed(`<rss><channel><item>
    <title><![CDATA[<b>Hello</b>]]></title>
    <link>https://example.com/a</link>
    <description><scr<script>ipt>alert</description>
  </item></channel></rss>`);
  assert.equal(items.length, 1);
  assert.equal(items[0].title, "Hello");
  assert.equal(items[0].link, "https://example.com/a");
  assert.equal(items[0].summary?.includes("<script"), false);
  assert.equal(items[0].summary, "ipt>alert");
});

test("atom entries read a quoted link href", () => {
  const items = parseFeed(`<feed><entry><title>Atom</title><link href="https://example.com/b" rel="alternate"/></entry></feed>`);
  assert.equal(items.length, 1);
  assert.equal(items[0].title, "Atom");
  assert.equal(items[0].link, "https://example.com/b");
});
