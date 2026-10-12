# Changelog

## 0.2.0

- Every event now carries `context.sdk_name` (`whisperr-node`) and
  `context.sdk_version`.
- New `appVersion` option. When set, every event carries it as
  `context.app_version`. Not set: no key.
- A key that the caller passes in `track()` context wins over these SDK keys.
  `$message_id` is always the SDK value.
- New `BillingEvent` constants and the `BillingEventProperties` type for the
  reserved billing fallback events (`trial_started`, `subscription_started`,
  `subscription_renewed`, `payment_failed`, `subscription_cancelled`,
  `purchase_completed`).
- README: the `app_language` trait, the context keys, and billing events.

## 0.1.3

- Honor `Retry-After` on 429/503.
