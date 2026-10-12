/**
 * Event names the Whisperr spec reserves for subscription billing. Send them
 * with `track()` when your own backend sees the billing change (for example a
 * store webhook) and Whisperr has no billing source connected.
 *
 * Today the server stores these events only after the app registers them.
 */
export const BillingEvent = {
  trialStarted: "trial_started",
  subscriptionStarted: "subscription_started",
  subscriptionRenewed: "subscription_renewed",
  paymentFailed: "payment_failed",
  subscriptionCancelled: "subscription_cancelled",
  purchaseCompleted: "purchase_completed",
} as const;

export type BillingEventName = (typeof BillingEvent)[keyof typeof BillingEvent];

/** The properties the spec defines for billing events. All are optional. */
export interface BillingEventProperties {
  /** Store or billing product id, for example `pro_monthly`. */
  product_id?: string;
  /** Price in major units, for example `9.99` (not cents). */
  price?: number;
  /** ISO 4217 currency code, upper case, for example `USD`. */
  currency?: string;
  /** ISO 8601 billing period, for example `P1M` or `P1Y`. */
  period?: string;
  /** The store's transaction id. */
  transaction_id?: string;
  /** Where the purchase happened, for example `app_store`, `play_store`, `stripe`. */
  store?: string;
}
