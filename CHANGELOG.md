# Changelog

## 0.2.0

- Every event now carries `context.sdk_name` (`whisperr-node`) and
  `context.sdk_version`.
- New `appVersion` option. When set, every event carries it as
  `context.app_version`. Not set: no key.
- A key that the caller passes in `track()` context wins over these SDK keys.
  `$message_id` is always the SDK value.
- New `BillingEvent` constants and the `BillingEventProperties` type for the
  reserved billing fallback events (playbook engine spec section 3.8):
  `trial_started`, `trial_converted`, `trial_auto_renew_disabled`,
  `membership_started`, `renewal_succeeded`, `auto_renew_disabled`,
  `auto_renew_enabled`, `membership_ended`, `billing_issue_started`,
  `billing_recovered`, `refund_granted`. Money properties: `plan_id`, `price`,
  `currency`, `plan_period`, `transaction_id`, `store`.
- README: the `app_language` trait, the context keys, and billing events.

## 0.1.3

- Honor `Retry-After` on 429/503.
