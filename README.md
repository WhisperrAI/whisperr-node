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

// Associate traits / contact channels with a user:
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
| `sdk_version` | The SDK version, for example `0.2.0` |
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
Stripe connection), send billing changes yourself. Use the reserved names in
`BillingEvent`:

| Constant | Event name |
|---|---|
| `BillingEvent.trialStarted` | `trial_started` |
| `BillingEvent.subscriptionStarted` | `subscription_started` |
| `BillingEvent.subscriptionRenewed` | `subscription_renewed` |
| `BillingEvent.paymentFailed` | `payment_failed` |
| `BillingEvent.subscriptionCancelled` | `subscription_cancelled` |
| `BillingEvent.purchaseCompleted` | `purchase_completed` |

```ts
import { BillingEvent, type BillingEventProperties } from "@whisperr/node";

const props: BillingEventProperties = {
  product_id: "pro_monthly",
  price: 9.99, // major units, not cents
  currency: "USD", // ISO 4217, upper case
  period: "P1M", // ISO 8601 duration
  transaction_id: "1000000912345678",
  store: "app_store",
};
whisperr.track("user_8842", BillingEvent.subscriptionStarted, props);
```

> **Register these names first.** Today the server stores these events only
> after your app registers them (the Whisperr MCP does this during setup). Until
> the server accepts them without registration, an unregistered name is not
> stored.

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

---

Whisperr — predict churn, automate interventions, recover revenue.
[whisperr.net](https://whisperr.net)
