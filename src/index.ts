import { WhisperrClient } from "./client.js";
import type { WhisperrApi, WhisperrOptions } from "./types.js";

export * from "./types.js";
export { BillingEvent } from "./billing.js";
export type { BillingEventName, BillingEventProperties } from "./billing.js";
export { SDK_NAME, SDK_VERSION } from "./version.js";
export { WhisperrClient };

/**
 * Create a Whisperr client for a Node backend. Hold the returned instance for
 * the lifetime of your process and call `shutdown()` before exit.
 *
 * ```ts
 * import { createWhisperr } from "@whisperr/node";
 *
 * const whisperr = createWhisperr({ apiKey: process.env.WHISPERR_API_KEY! });
 *
 * // a server-side churn signal:
 * whisperr.track("user_8842", "payment_failed", { amount_cents: 4900, reason: "card_declined" });
 *
 * // on graceful shutdown:
 * await whisperr.shutdown();
 * ```
 */
export function createWhisperr(options: WhisperrOptions): WhisperrApi {
  return new WhisperrClient(options);
}
