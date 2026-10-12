/**
 * Event names the Whisperr spec reserves for membership billing (the
 * playbook engine spec, section 3.8). Send them from your backend with track()
 * when Whisperr has no billing source connected (for example a store webhook
 * handler). Never send them from the front end. Today the server stores these
 * events only after the app registers them.
 */
export const BillingEvent = {
  /** A free trial starts. */
  trialStarted: "trial_started",
  /** The trial converts to the first paid period. */
  trialConverted: "trial_converted",
  /** The user cancels during the trial. */
  trialAutoRenewDisabled: "trial_auto_renew_disabled",
  /** A paid membership starts (never a renewal or a plan change). */
  membershipStarted: "membership_started",
  /** A paid period renews. */
  renewalSucceeded: "renewal_succeeded",
  /** The user cancels; access continues to the period end. */
  autoRenewDisabled: "auto_renew_disabled",
  /** The user turns auto-renew back on. */
  autoRenewEnabled: "auto_renew_enabled",
  /** Access ends. */
  membershipEnded: "membership_ended",
  /** A payment fails and a billing issue starts. */
  billingIssueStarted: "billing_issue_started",
  /** The billing issue is resolved. */
  billingRecovered: "billing_recovered",
  /** The store grants a refund. */
  refundGranted: "refund_granted",
} as const;

export type BillingEventName = (typeof BillingEvent)[keyof typeof BillingEvent];

/**
 * The money properties the spec defines for billing events, where they apply.
 * Event-specific properties (for example `current_period_ends_at`) can be
 * added next to them.
 */
export interface BillingEventProperties {
  /** Store or billing plan id, for example `pro_monthly`. */
  plan_id?: string;
  /** Price in major units, for example `9.99` (not cents). */
  price?: number;
  /** ISO 4217 currency code, upper case, for example `USD`. */
  currency?: string;
  /** ISO 8601 billing period, for example `P1M` or `P1Y`. */
  plan_period?: string;
  /** The store's transaction id. */
  transaction_id?: string;
  /** Where the purchase happened, for example `app_store`, `play_store`, `stripe`. */
  store?: string;
}
