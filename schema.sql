-- feedhub — unified newsletter + RSS hub. D1 is the system of record; the two hard
-- invariants (never a dupe, never send twice) are enforced as SQLite constraints, so a
-- poller/queue bug can at worst produce a REJECTED write, never a violation.

-- items — canonical post store AND seen-ledger in one. canonical_url IS the identity, so
-- dedup is the primary key: a syndicated copy collides and never creates a second row.
CREATE TABLE IF NOT EXISTS items (
  canonical_url TEXT PRIMARY KEY,           -- RFC-3986 normalized origin URL = identity
  cluster_id    TEXT,                       -- cross-feed cluster (simhash) when URLs were rewritten
  title         TEXT NOT NULL,
  author        TEXT,
  summary       TEXT,
  content_html  TEXT,
  origin_feed   TEXT,                        -- ishtar | numetal | atelier | personal
  seen_via      TEXT,                        -- JSON: every (feed,url) a copy appeared in
  published     INTEGER,                     -- epoch ms
  first_seen    INTEGER,
  notified_at   INTEGER                      -- NULL until fan-out enqueued = the latch
);
CREATE INDEX IF NOT EXISTS items_published ON items (published DESC);
CREATE INDEX IF NOT EXISTS items_cluster   ON items (cluster_id);
CREATE INDEX IF NOT EXISTS items_pending   ON items (notified_at) WHERE notified_at IS NULL;

-- fingerprints — cross-feed clustering when every URL/id was rewritten.
CREATE TABLE IF NOT EXISTS fingerprints (
  fp         TEXT PRIMARY KEY,               -- simhash of title+body shingle
  cluster_id TEXT NOT NULL
);

-- feed_state — conditional-GET tokens per source blog.
CREATE TABLE IF NOT EXISTS feed_state (
  url       TEXT PRIMARY KEY,
  etag      TEXT,
  last_mod  TEXT,
  last_poll INTEGER
);

-- subscribers — ONE ROW PER PERSON. email+wallet on the same row = a cross-matched person
-- is one subscriber; per-channel unsub is one column.
CREATE TABLE IF NOT EXISTS subscribers (
  id           TEXT PRIMARY KEY,             -- ulid
  email        TEXT UNIQUE,                  -- nullable, lowercased
  wallet       TEXT UNIQUE,                  -- nullable, lowercased 0x
  email_status TEXT NOT NULL DEFAULT 'active', -- active | pending | unsub | bounced
  xmtp_status  TEXT NOT NULL DEFAULT 'active', -- active | unsub | unreachable
  resend_id    TEXT,
  source       TEXT,                          -- import:substack | import:crypto | form:<site>
  unsub_token  TEXT NOT NULL,                 -- per-sub secret salt for HMAC unsub
  created_at   INTEGER,
  confirmed_at INTEGER                        -- NULL for imports (legacy consent)
);
CREATE INDEX IF NOT EXISTS subs_email ON subscribers (email_status) WHERE email IS NOT NULL;
CREATE INDEX IF NOT EXISTS subs_xmtp  ON subscribers (xmtp_status)  WHERE wallet IS NOT NULL;

-- sends — THE exactly-once ledger. The composite PK makes a double-send physically impossible.
CREATE TABLE IF NOT EXISTS sends (
  canonical_url TEXT NOT NULL,
  subscriber_id TEXT NOT NULL,
  channel       TEXT NOT NULL,               -- email | xmtp
  status        TEXT NOT NULL DEFAULT 'queued', -- queued | sent | failed | skipped
  provider_id   TEXT,                         -- Resend id / XMTP msg id
  attempts      INTEGER NOT NULL DEFAULT 0,
  updated_at    INTEGER,
  PRIMARY KEY (canonical_url, subscriber_id, channel)
);

-- broadcasts — exactly ONE Resend broadcast created+sent per post (email is broadcast-grain).
CREATE TABLE IF NOT EXISTS broadcasts (
  canonical_url TEXT NOT NULL,
  channel       TEXT NOT NULL,               -- email
  resend_bcast  TEXT,
  state         TEXT NOT NULL DEFAULT 'pending', -- pending | created | sent
  created_at    INTEGER,
  PRIMARY KEY (canonical_url, channel)
);
