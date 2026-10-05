import type { TransactionCandidate } from "@brake/core";
import { counterpartyKey } from "./user-model";

export { counterpartyKey };

/**
 * The single key every module learns and looks up under: the merchant's
 * normalized key, else the *hashed* counterparty key. Payee handles and
 * people's names never appear in models in clear text, and questions,
 * reconciliation and the user model must agree on the key or labels are lost.
 */
export function learningKey(c: TransactionCandidate): string | null {
  const merchant = c.merchant.normalized?.trim().toLowerCase();
  return merchant ? merchant : counterpartyKey(c.counterparty);
}
