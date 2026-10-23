# Changelog

## 0.3.0 - 2026-10-23

- New `whisperr.catalog` client for catalog push (whisperr-go catalog v2):
  `upsert(items)`, `delete(ids | items, deletedAt?)`, `beginSnapshot()`,
  `completeSnapshot(id, itemCount)`, `heartbeat(itemCount)` and `status()`.
  Server key only: a `wpk_` key throws `WhisperrConfigurationError` before any
  request. Calls are sent right away, not queued.
- Upserts are chunked at 500 items and 2 MiB, deletes at 1000. Rejected items
  come back with their index in the array you passed. A 413 splits the chunk.
- 429, 5xx and network errors are retried with backoff, honoring
  `Retry-After`. Retries resend the same body; `delete` uses one `deletedAt`
  per call. Refusals and exhausted retries throw `WhisperrCatalogError` with
  `status`, `code`, `retryable` and, for upsert and delete, `partial`.
- `createWhisperrCatalog(options)` for a catalog client without the event
  queue. New option `catalog` (`maxRetries`, `requestTimeoutMs`, `fetch`).
- `toMinorUnits(amount, currency)` and `currencyExponent(currency)` with the
  ISO 4217 exponents the server uses. They throw instead of rounding.
- `catalogFeedPage(...)` builds a schema 1.1 catalog feed page.
- Tests run `fixtures/catalog_push.json`, the catalog push conformance cases
  (or `WHISPERR_CATALOG_SPEC_PATH`, once whisperr-spec publishes
  `conformance/catalog_push.json`).

## 0.2.0 - 2026-10-12

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
