/** Estate sites, llms.txt aggregation, and social/join link catalog. */

export interface EstateSite {
  id: string;
  host: string;
  llms: string;
  llmsFull?: string;
  blogBase: string;
  blogPattern: string;
}

export const ESTATE_SITES: readonly EstateSite[] = [
  { id: "ishtar", host: "ishtar.numetal.xyz", llms: "https://ishtar.numetal.xyz/llms.txt", llmsFull: "https://ishtar.numetal.xyz/llms-full.txt", blogBase: "https://ishtar.numetal.xyz/blog", blogPattern: "/blog/{slug}/" },
  { id: "numetal", host: "numetal.xyz", llms: "https://numetal.xyz/llms.txt", blogBase: "https://numetal.xyz/blog", blogPattern: "/blog/{slug}" },
  { id: "curb", host: "curb.numetal.xyz", llms: "https://curb.numetal.xyz/llms.txt", blogBase: "https://curb.numetal.xyz/blog", blogPattern: "/blog/{slug}" },
  { id: "gokhanvc", host: "gokhan.vc", llms: "https://gokhan.vc/llms.txt", blogBase: "https://gokhan.vc/blog", blogPattern: "/blog/{slug}" },
  { id: "memex", host: "gokhanturhan.com", llms: "https://gokhanturhan.com/llms.txt", blogBase: "https://gokhanturhan.com/journal", blogPattern: "/journal/{slug}/" },
] as const;

const SITE_ALIASES: Record<string, string> = {
  ishtar: "ishtar",
  "ishtar.numetal.xyz": "ishtar",
  numetal: "numetal",
  "numetal.xyz": "numetal",
  curb: "curb",
  "curb.numetal.xyz": "curb",
  "inference-swap": "curb",
  atelier: "gokhanvc",
  "gokhan.vc": "gokhanvc",
  gokhanvc: "gokhanvc",
  memex: "memex",
  personal: "memex",
  "gokhanturhan.com": "memex",
};

export function resolveSiteId(raw: string): EstateSite | null {
  const key = SITE_ALIASES[raw.trim().toLowerCase()];
  if (!key) return null;
  return ESTATE_SITES.find((s) => s.id === key) ?? null;
}

export interface LlmsEntry {
  site: string;
  host: string;
  url: string;
  status: number;
  content?: string;
  error?: string;
  bytes?: number;
}

export async function fetchLlmsAggregate(full = false): Promise<{ fetched_at: string; sites: LlmsEntry[] }> {
  const sites = await Promise.all(
    ESTATE_SITES.map(async (site) => {
      const url = full && site.llmsFull ? site.llmsFull : site.llms;
      try {
        const res = await fetch(url, { headers: { "User-Agent": "api.gokhan.vc/2.0" }, redirect: "follow" });
        const text = res.ok ? await res.text() : undefined;
        return {
          site: site.id,
          host: site.host,
          url,
          status: res.status,
          content: text,
          bytes: text?.length,
          error: res.ok ? undefined : `http_${res.status}`,
        } satisfies LlmsEntry;
      } catch {
        return { site: site.id, host: site.host, url, status: 0, error: "fetch_failed" } satisfies LlmsEntry;
      }
    }),
  );
  return { fetched_at: new Date().toISOString(), sites };
}

export function llmsCombinedText(entries: LlmsEntry[]): string {
  const parts: string[] = ["# Gökhan Turhan estate — combined llms.txt", ""];
  for (const e of entries) {
    parts.push(`## ${e.host}`, `Source: ${e.url}`, "");
    if (e.content) parts.push(e.content.trim(), "");
    else parts.push(`(unavailable: ${e.error ?? e.status})`, "");
  }
  return parts.join("\n");
}

/** Social + join links — verified against atelier links.ts (2026-07-07). */
export const SOCIAL_CATALOG = {
  updated: "2026-07-07",
  properties: [
    {
      id: "ishtar",
      label: "Ishtar",
      domain: "ishtar.numetal.xyz",
      url: "https://ishtar.numetal.xyz",
      follow: [
        { platform: "X", handle: "@numetalxyz", href: "https://x.com/numetalxyz" },
        { platform: "Telegram", handle: "Numetal", href: "https://t.me/numetalxyz" },
        { platform: "Moltbook", handle: "m/courtship", href: "https://www.moltbook.com/m/courtship" },
      ],
      join: [],
      contact: [{ type: "email", href: "mailto:contact@numetal.xyz", address: "contact@numetal.xyz" }],
    },
    {
      id: "numetal",
      label: "Numetal Labs",
      domain: "numetal.xyz",
      url: "https://numetal.xyz",
      follow: [
        { platform: "X", handle: "@numetalxyz", href: "https://x.com/numetalxyz" },
        { platform: "Telegram", handle: "Numetal", href: "https://t.me/numetalxyz" },
        { platform: "Discord", handle: "Numetal", href: "https://discord.gg/MC4DYumPMz" },
      ],
      join: [{ platform: "Discord", href: "https://discord.gg/MC4DYumPMz", note: "builder chat" }],
      contact: [{ type: "email", href: "mailto:contact@numetal.xyz", address: "contact@numetal.xyz" }],
    },
    {
      id: "curb",
      label: "CURB",
      domain: "curb.numetal.xyz",
      url: "https://curb.numetal.xyz",
      follow: [
        { platform: "X", handle: "@numetalxyz", href: "https://x.com/numetalxyz" },
      ],
      join: [],
      contact: [{ type: "email", href: "mailto:contact@numetal.xyz", address: "contact@numetal.xyz" }],
    },
    {
      id: "gokhanvc",
      label: "Gökhan VC",
      domain: "gokhan.vc",
      url: "https://gokhan.vc",
      follow: [{ platform: "X", handle: "@ateliergokhan", href: "https://x.com/ateliergokhan" }],
      join: [],
      contact: [
        { type: "email", href: "mailto:contact@gokhan.vc", address: "contact@gokhan.vc" },
        { type: "email", href: "mailto:investments@gokhan.vc", address: "investments@gokhan.vc", note: "investment outreach" },
      ],
    },
    {
      id: "memex",
      label: "Personal Memex",
      domain: "gokhanturhan.com",
      url: "https://gokhanturhan.com",
      follow: [
        { platform: "X", handle: "@goekhan", href: "https://x.com/goekhan" },
        { platform: "LinkedIn", handle: "in/goekhanturhan", href: "https://www.linkedin.com/in/goekhanturhan/" },
        { platform: "Farcaster", handle: "@gokhan", href: "https://farcaster.xyz/gokhan" },
        { platform: "Bluesky", handle: "gokhan.substack.com", href: "https://bsky.app/profile/gokhan.substack.com" },
        { platform: "Substack", handle: "gokhan.substack.com", href: "https://gokhan.substack.com" },
        { platform: "Telegram", handle: "Research Log", href: "https://t.me/gokhanturhans" },
      ],
      join: [{ platform: "Discord", href: "https://discord.gg/ZcxcwRPT7R", note: "Market Research Unit" }],
      contact: [],
    },
  ],
} as const;
