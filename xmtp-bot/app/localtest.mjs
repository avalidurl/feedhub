// Local validation harness — runs the XMTP v6 client on the DEV network (isolated from prod,
// no real users touched). Proves: (1) the isolated EOA registers, (2) canMessage works,
// (3) a 2nd run against the same dbPath REUSES the installation (persistence model is sound).
import { createClient, reachable, inboxSummary } from "./xmtp.mjs";
import { readFileSync } from "node:fs";

const txt = readFileSync(process.env.SECRETS, "utf8");
const E = {};
for (const line of txt.split("\n")) {
  if (!line || line.startsWith("#") || !line.includes("=")) continue;
  const i = line.indexOf("=");
  E[line.slice(0, i).trim()] = line.slice(i + 1).trim();
}

const NETWORK = process.env.NETWORK || "dev";
const dbPath = process.env.DBPATH || "./xmtp-dev.db3";

console.log(`[${NETWORK}] Client.create (dbPath=${dbPath}) ...`);
const client = await createClient({
  privateKey: E.XMTP_WALLET_KEY,
  env: NETWORK,
  dbPath,
  dbEncryptionKey: E.XMTP_DB_ENCRYPTION_KEY,
});
const s = await inboxSummary(client);
console.log("inboxId=", s.inboxId);
console.log("installationId=", s.installationId);
console.log("installations=", s.installations);

const selfAddr = E.XMTP_ADDRESS;
const m = await reachable(client, [selfAddr]);
console.log("canMessage(self)=", m.get(selfAddr.toLowerCase()));

if (process.env.PROBE) {
  const pm = await reachable(client, [process.env.PROBE]);
  console.log(`canMessage(${process.env.PROBE})=`, pm.get(process.env.PROBE.toLowerCase()));
}
process.exit(0);
