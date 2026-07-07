/** Shared env bindings for feedhub payment modules. */
export interface PaymentEnv {
  PUBLIC_API_URL?: string;
  X402_MODE?: string;
  PAY_TO?: string;
  MPP_RECIPIENT?: string;
  MPP_CURRENCY?: string;
  MPP_ENABLED?: string;
  MPP_SECRET_KEY?: string;
  TEMPO_RPC_URL?: string;
  CDP_API_KEY_ID?: string;
  CDP_API_KEY_SECRET?: string;
  AGENTCASH_OWNERSHIP_PROOF?: string;
}

export type Env = PaymentEnv;
