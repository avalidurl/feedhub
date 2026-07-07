/** Published inboxes for POST /agent/email — keys only in public OpenAPI; full map at GET /agent. */
export const AGENT_EMAIL_RECIPIENTS = {
  contact: "contact@numetal.xyz",
  investments: "investments@gokhan.vc",
  gokhanvc: "contact@gokhan.vc",
  numetal: "contact@numetal.xyz",
  ishtar: "contact@numetal.xyz",
} as const;

export type AgentEmailRecipientKey = keyof typeof AGENT_EMAIL_RECIPIENTS;

export const AGENT_EMAIL_RECIPIENT_KEYS = Object.keys(AGENT_EMAIL_RECIPIENTS) as AgentEmailRecipientKey[];

export function resolveAgentEmailRecipient(key: string): string | undefined {
  const k = key.trim().toLowerCase() as AgentEmailRecipientKey;
  return AGENT_EMAIL_RECIPIENTS[k];
}

/** Unique destination addresses (for operator reference). */
export function agentEmailRecipientMap(): Record<AgentEmailRecipientKey, string> {
  return { ...AGENT_EMAIL_RECIPIENTS };
}
