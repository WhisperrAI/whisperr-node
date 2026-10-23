# @whisperr/node

The Whisperr **server-side** SDK — reliable churn-signal event tracking for any
Node.js backend. The backend is where the highest-signal churn events live
(payment failures, cancellations, trial expiry, usage drops), so this is where
Whisperr gets its most valuable signal.

```bash
npm install @whisperr/node
```

## Quick start

```ts
import { createWhisperr } from "@whisperr/node";

const whisperr = createWhisperr({ apiKey: process.env.WHISPERR_API_KEY! });

// A server-side churn signal:
whisperr.track("user_8842", "payment_failed", { amount_cents: 4900, reason: "card_declined" });

// Associate traits / contact channels with a user.
// The email shortcut marks the address opted in. Send it only for a user
// who agreed to email, according to your own records.
whisperr.identify("user_8842", { email: "ada@example.com", traits: { plan: "pro" } });

// Deliver everything before the process exits:
await whisperr.shutdown();
```

The user id (`externalUserId`) is **always explicit** here — unlike the browser
SDK, the server has no persisted session to infer it from. Pass the same id you
use everywhere else for that user, and frontend + backend events land on one
timeline automatically.

## Design

- **Same wire contract as the web SDK.** Events post to `/v1/events/batch`,
  identities to `/v1/identify`, authenticated with `X-API-Key`.
- **Reliable while the process is alive.** In-memory queue, batching, retry with
  backoff (429/5xx; a 429/503 `Retry-After` is honored, capped at 60s),
  malformed-4xx drop, per-event idempotency key. On `401/403` or exhausted
  retries, delivery pauses and the batch stays queued for the next flush. The
  queue is **not** crash-durable — in serverless or before exit, call
  `await flush()` / `shutdown()` so unsent events aren't lost.
- **Non-blocking.** `track()`/`identify()` enqueue and return immediately;
  delivery happens in the background. `await flush()` when you need a barrier.
- **Process-friendly.** The flush timer is `unref`'d so it never keeps your
  process alive; call `shutdown()` for a clean exit.
- **Zero runtime dependencies.** Uses the global `fetch` (Node 18+).

## Express

```ts
import { createWhisperr } from "@whisperr/node";
import { whisperrExpress } from "@whisperr/node/express";

const whisperr = createWhisperr({ apiKey: process.env.WHISPERR_API_KEY! });

app.use(whisperrExpress(whisperr)); // after your auth middleware

app.post("/billing/webhook", (req, res) => {
  req.whisperr.track("payment_failed", { amount_cents: 4900 });
  res.sendStatus(200);
});
```

`req.whisperr.track()` is bound to the request's user (resolved from common auth
shapes by default, or via `resolveUser`). For events with no request — Stripe
webhooks, cron jobs — call `whisperr.track(userId, …)` directly with the id from
your domain data.

## Traits: `app_language`

`app_language` is a reserved trait. It is the language the user picked in your
product, not the device or browser locale. Use a BCP 47 tag (`de`, `pt-BR`).
Whisperr writes messages in this language. When it is not set, Whisperr uses
the event `context.locale`, then the `locale` trait.

The server SDK has no special API for it. Pass it in `traits`:

```ts
whisperr.identify("user_8842", { traits: { app_language: "pt-BR" } });
```

The server keeps the last value you send. A server SDK never guesses the
language: the process locale is not the user's language.

## Context the SDK adds

Every event carries these keys in `context`:

| Key | Value |
|---|---|
| `sdk_name` | `whisperr-node` |
| `sdk_version` | The SDK version, for example `0.3.0` |
| `app_version` | The `appVersion` option. Not set: no key. |

A key that you pass in the `context` argument of `track()` wins over the SDK
value. The SDK always sets `$message_id`.

```ts
const whisperr = createWhisperr({
  apiKey: process.env.WHISPERR_API_KEY!,
  appVersion: process.env.RELEASE_VERSION, // for example "2026.10.1" or a git SHA
});
```

## Billing events

If Whisperr has no billing source for your app (for example no RevenueCat or
Stripe connection), send billing changes from your backend yourself. Use the
reserved names in `BillingEvent`:

| Constant | Event name | When | Event properties |
|---|---|---|---|
| `BillingEvent.trialStarted` | `trial_started` | A free trial starts. | `trial_length_days`, `trial_ends_at`, `plan_period` |
| `BillingEvent.trialConverted` | `trial_converted` | The trial converts to the first paid period. | `plan_period`, `current_period_ends_at` |
| `BillingEvent.trialAutoRenewDisabled` | `trial_auto_renew_disabled` | The user cancels during the trial. | `trial_ends_at`, `store_cancel_reason` |
| `BillingEvent.membershipStarted` | `membership_started` | A paid membership starts (never a renewal or a plan change). | `plan_period`, `is_resubscribe`, `is_first_ever`, `access_source`, `entitlements`, `current_period_ends_at` |
| `BillingEvent.renewalSucceeded` | `renewal_succeeded` | A paid period renews. | `paid_periods_count`, `current_period_ends_at` |
| `BillingEvent.autoRenewDisabled` | `auto_renew_disabled` | The user cancels; access continues to the period end. | `access_ends_at`, `store_cancel_reason` |
| `BillingEvent.autoRenewEnabled` | `auto_renew_enabled` | The user turns auto-renew back on. | — |
| `BillingEvent.membershipEnded` | `membership_ended` | Access ends. | `end_reason`, `plan_period`, `paid_periods_count` |
| `BillingEvent.billingIssueStarted` | `billing_issue_started` | A payment fails and a billing issue starts. | `has_access`, `grace_ends_at` |
| `BillingEvent.billingRecovered` | `billing_recovered` | The billing issue is resolved. | — |
| `BillingEvent.refundGranted` | `refund_granted` | The store grants a refund. | — |

Money properties, where they apply: `plan_id`, `price` (number, major units,
for example `9.99`), `currency` (ISO 4217, upper case), `plan_period` (ISO 8601
duration, for example `P1M`), `transaction_id`, `store`.

Closed lists:

- `store_cancel_reason`: `unsubscribe`, `billing_error`, `developer_initiated`,
  `price_increase`, `customer_support`, `unknown`.
- `end_reason`: `voluntary`, `billing`, `price_increase`, `product_unavailable`,
  `developer_initiated`, `refund`, `other`.
- `access_source`: `self_subscription`, `lifetime`, `family_share`,
  `promotional`, `sponsored`, `web_other`.

Send these events from your backend only, never from the front end.

```ts
import { BillingEvent, type BillingEventProperties } from "@whisperr/node";

const props: BillingEventProperties = {
  plan_id: "pro_monthly",
  price: 9.99, // major units, not cents
  currency: "USD", // ISO 4217, upper case
  plan_period: "P1M", // ISO 8601 duration
  transaction_id: "1000000912345678",
  store: "app_store",
};
whisperr.track("user_8842", BillingEvent.membershipStarted, {
  ...props,
  is_first_ever: true,
  access_source: "self_subscription",
  current_period_ends_at: "2026-11-12T10:00:00Z",
});
```

> **Register these names first.** Today the server stores these events only
> after your app registers them (the Whisperr MCP does this during setup). Until
> the server accepts them without registration, an unregistered name is not
> stored.

## Catalog push

Send your product catalog (or courses, content, plans) to Whisperr from your
server, so messages can name real, in-stock items. Use a **server key**
(`wrk_…`, Settings > API keys) from an environment variable such as
`WHISPERR_SERVER_KEY`. Never commit or log it. A publishable key (`wpk_…`) is
refused with a `WhisperrConfigurationError` before anything is sent.

```ts
import { createWhisperr, toMinorUnits } from "@whisperr/node";

const whisperr = createWhisperr({ apiKey: process.env.WHISPERR_SERVER_KEY! });

// When a product is created or changes:
const result = await whisperr.catalog.upsert([
  {
    sourceItemId: "sku-1", // the same id you send as product_id in tracked events
    type: "product",
    name: "Trail Runner 2",
    url: "https://shop.example.com/products/trail-runner-2",
    availability: "available", // available | limited | unavailable | unknown
    updatedAt: product.updatedAt, // when it last changed in your system
    price: { amountMinor: toMinorUnits("89.00", "USD"), currency: "USD" },
    imageUrl: "https://cdn.example.com/trail-runner-2.jpg",
    compareAtMinor: toMinorUnits("110.00", "USD"),
    productType: "Running shoes",
    brand: "Acme",
    collections: [{ id: "running", name: "Running", url: "https://shop.example.com/collections/running" }],
    tags: ["summer"],
    extras: { color: "blue" },
  },
]);
// result: { accepted, applied, unchanged, ignoredOlder, rejected: [{ index, sourceItemId, code, message }] }

// When products are removed:
await whisperr.catalog.delete(["sku-1", "sku-2"]);

// Full sync (daily, or after a bulk import): items you do not upsert between
// begin and complete are removed.
const { snapshotId } = await whisperr.catalog.beginSnapshot();
for (const page of allProductPages()) await whisperr.catalog.upsert(page);
await whisperr.catalog.completeSnapshot(snapshotId, totalCount);

// Every 30 minutes, so Whisperr knows the catalog is still current:
await whisperr.catalog.heartbeat(totalCount);

// Health of the pushed catalog:
const health = await whisperr.catalog.status(); // { state: "ready", itemCount, lastPushAt, ... }
```

How it behaves:

- **Sent right away, not queued.** Each call resolves once Whisperr has
  answered. You do not need `flush()` for catalog calls.
- **Chunked.** Upserts go in batches of 500 items (and at most 2 MiB per
  request), deletes in batches of 1000. A `rejected[].index` is the index in
  the array you passed.
- **Retried.** 429, 5xx and network errors are retried with backoff (default 5
  retries), honoring `Retry-After`. When retries run out, the call throws a
  `WhisperrCatalogError` with `retryable: true`; for upsert and delete,
  `error.partial` holds what earlier chunks already did.
- **Safe to repeat.** A retry sends the same body. Whisperr keeps the newest
  write per item by `updatedAt` (deletes by `deletedAt`), so a repeated or late
  call never overwrites newer data. `delete` uses one `deletedAt` for the whole
  call (default: now). Always set `updatedAt` from your own data, not from the
  time of the call.
- **Refusals throw.** A refused call throws a `WhisperrCatalogError` with the
  HTTP `status` and the server `code`, for example `server_key_required`,
  `catalog_push_disabled` (the owner turned push off in the dashboard) or
  `snapshot_not_open`.
- Only send what is listed in the item type: no descriptions, no image bytes.
  Prices are integer minor units; `toMinorUnits(amount, currency)` converts
  using the ISO 4217 exponent and throws rather than round.

### A feed endpoint instead of push

If you would rather have Whisperr fetch your catalog, serve pages built with
`catalogFeedPage` (schema 1.1, at most 200 items per page) and register the
endpoint with the Whisperr MCP tool `register_catalog_feed`. An owner confirms
it in the dashboard before Whisperr calls it.

```ts
import { catalogFeedPage } from "@whisperr/node";

app.get("/whisperr/catalog", requireBearer(process.env.WHISPERR_CATALOG_FEED_TOKEN), async (req, res) => {
  const page = await loadPage(req.query.cursor); // your pagination
  res.json(
    catalogFeedPage({
      snapshotId: exportId, // the same on every page of one export
      generatedAt: exportStartedAt,
      totalItems: exportCount,
      items: page.items,
      nextCursor: page.nextCursor, // null on the last page
    }),
  );
});
```

## Serverless

In short-lived environments (Lambda, Vercel functions), `await whisperr.flush()`
before returning so queued events aren't lost when the runtime freezes.

## Options

| Option | Default | Notes |
|---|---|---|
| `apiKey` | — | App ingestion key (`wrk_…`). Required. |
| `baseUrl` | `https://api.whisperr.net` | Ingestion base URL. |
| `appVersion` | — | Your release version. Sent as `context.app_version`. |
| `flushAt` | `20` | Flush when this many events are queued. |
| `flushIntervalMs` | `10000` | Background flush cadence. `0` disables the timer. |
| `maxQueueSize` | `10000` | Oldest events drop on overflow. |
| `maxBatchSize` | `500` | Events per batch (hard backend cap is 500). |
| `maxRetries` | `6` | Consecutive retries before backing off. |
| `requestTimeoutMs` | `10000` | Per-request timeout. |
| `disabled` | `false` | No-op client (useful in tests). |
| `debug` | `false` | Verbose logging. |
| `onError` | — | `(error) => void` for delivery/drop observability. |
| `fetch` | global `fetch` | Inject for tests or custom runtimes. |
| `catalog.maxRetries` | `5` | Catalog call retries on 429, 5xx and network errors. |
| `catalog.requestTimeoutMs` | `30000` | Per-request timeout for catalog calls. |
| `catalog.fetch` | `fetch` | A fetch for catalog calls; the response needs `text()`. |

`createWhisperrCatalog({ apiKey, baseUrl?, maxRetries?, requestTimeoutMs?, fetch? })`
creates a catalog client on its own, without the event queue.

---

Whisperr — predict churn, automate interventions, recover revenue.
[whisperr.net](https://whisperr.net)
