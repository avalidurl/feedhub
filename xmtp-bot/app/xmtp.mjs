// XMTP v6 (node-sdk 6.0.0) helpers for the feedhub newsletter bot.
// Grounded in the verified v6 API: EOA Signer.signMessage returns Uint8Array (viem toBytes);
// env defaults to 'dev' so we pass it explicitly; conversation methods are createDm* / sendText;
// addressing is by Identifier {identifier, identifierKind}. dbEncryptionKey = 0x-hex 32 bytes.
import { Client, IdentifierKind } from "@xmtp/node-sdk";
import { privateKeyToAccount } from "viem/accounts";
import { toBytes, createPublicClient, http } from "viem";
import { mainnet } from "viem/chains";
import { normalize } from "viem/ens";

// Some imported "wallets" are ENS names, not 0x addresses. Resolve .eth → address (mainnet) so we
// reach those subscribers; return null for anything unresolvable/invalid so it can be skipped.
const ethClient = createPublicClient({ chain: mainnet, transport: http() });
export async function resolveWallet(w) {
  const s = String(w || "").trim();
  if (/^0x[a-fA-F0-9]{40}$/.test(s)) return s.toLowerCase();
  if (/\.eth$/i.test(s)) {
    try { const a = await ethClient.getEnsAddress({ name: normalize(s) }); return a ? a.toLowerCase() : null; }
    catch { return null; }
  }
  return null;
}

/** Build an EOA Signer from a raw private key. signMessage MUST return raw bytes, not hex. */
export function makeSigner(privateKey) {
  const account = privateKeyToAccount(privateKey);
  return {
    type: "EOA",
    getIdentifier: () => ({ identifier: account.address.toLowerCase(), identifierKind: IdentifierKind.Ethereum }),
    signMessage: async (message) => toBytes(await account.signMessage({ message })),
  };
}

/** Create (or rehydrate from dbPath) the XMTP client. Same dbPath+dbEncryptionKey => same installation.
 *  Pass the 0x-hex key through as-is — the form proven to persist across restarts in the dev test. */
export async function createClient({ privateKey, env, dbPath, dbEncryptionKey }) {
  const signer = makeSigner(privateKey);
  return Client.create(signer, {
    env, // 'dev' | 'production' — NOT interchangeable
    dbPath,
    dbEncryptionKey,
    appVersion: "feedhub-xmtp/0.1.0",
  });
}

const idOf = (wallet) => ({ identifier: String(wallet).toLowerCase(), identifierKind: IdentifierKind.Ethereum });

/** Returns Map<lowercased address, boolean reachable-on-this-network>. */
export async function reachable(client, wallets) {
  if (!wallets.length) return new Map();
  return client.canMessage(wallets.map(idOf));
}

/** Create/open a DM to a wallet and send text. Returns the XMTP message id. */
export async function sendDm(client, wallet, text) {
  const dm = await client.conversations.createDmWithIdentifier(idOf(wallet));
  return dm.sendText(text);
}

/** Introspect our own inbox: installation count etc. (ops / persistence verification). */
export async function inboxSummary(client) {
  let installations = null;
  try {
    const state = await client.preferences.inboxState(true);
    installations = state?.installations?.length ?? null;
  } catch { /* older/newer shape — best effort */ }
  return { inboxId: client.inboxId, installationId: client.installationId ?? null, installations };
}
