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
- **Reliable by default.** In-memory queue, batching, retry with backoff,
  429/5xx retry, 401/403 stop, malformed-4xx drop, per-event idempotency key.
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

## Serverless

In short-lived environments (Lambda, Vercel functions), `await whisperr.flush()`
before returning so queued events aren't lost when the runtime freezes.

## Options

| Option | Default | Notes |
|---|---|---|
| `apiKey` | — | App ingestion key (`wrk_…`). Required. |
| `baseUrl` | `https://api.whisperr.net` | Ingestion base URL. |
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
