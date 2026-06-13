/** Public types for the Whisperr Node (server-side) SDK. */

export interface WhisperrChannel {
  /** "email" | "sms" | "push" | custom. */
  type: string;
  /** The address/token for the channel (email address, phone, push token). */
  address: string;
  /** Whether the user has opted in to this channel. Defaults to true. */
  optedIn?: boolean;
  /** Whether the address is verified. */
  verified?: boolean;
}

export interface IdentifyParams {
  /** Arbitrary traits (plan, signup_date, …). Merged server-side. */
  traits?: Record<string, unknown>;
  /** Convenience: expands to an opted-in email channel. */
  email?: string;
  /** Convenience: expands to an opted-in SMS channel. */
  phone?: string;
  /** Convenience: expands to an opted-in push channel. */
  pushToken?: string;
  /** Preferred outreach channel. */
  preferredChannel?: "email" | "sms" | "push";
  /** Full control over channels (overrides the shortcuts when provided). */
  channels?: WhisperrChannel[];
}

/**
 * A structural subset of the global `fetch`. Declared locally so the SDK type-
 * checks without the DOM lib; the default implementation is `globalThis.fetch`
 * (Node 18+). Inject your own for tests or custom runtimes.
 */
export type WhisperrFetch = (
  url: string,
  init: {
    method: string;
    headers: Record<string, string>;
    body: string;
    signal?: AbortSignal;
  },
) => Promise<{ ok: boolean; status: number }>;

export interface WhisperrOptions {
  /** App ingestion key (wrk_…). Required. */
  apiKey: string;
  /** Ingestion base URL. Defaults to https://api.whisperr.net. */
  baseUrl?: string;
  /** Flush when this many events are queued. Default 20. */
  flushAt?: number;
  /** Flush at least this often (ms). Default 10000. Set 0 to disable the timer. */
  flushIntervalMs?: number;
  /** Max events held in the in-memory queue; oldest drop on overflow. Default 10000. */
  maxQueueSize?: number;
  /** Max events per batch request (hard backend cap is 500). Default 500. */
  maxBatchSize?: number;
  /** Max consecutive retries before backing off a drain. Default 6. */
  maxRetries?: number;
  /** Per-request timeout (ms). Default 10000. */
  requestTimeoutMs?: number;
  /** Disable all network + capture (no-op client). Default false. */
  disabled?: boolean;
  /** Verbose logging to the console. Default false. */
  debug?: boolean;
  /** Called when delivery fails (auth/drop/retries exhausted) or events drop. */
  onError?: (error: WhisperrError) => void;
  /** Injectable fetch implementation. Defaults to the global fetch. */
  fetch?: WhisperrFetch;
}

export interface WhisperrError {
  type: "auth" | "dropped" | "retry_exhausted";
  message: string;
  status?: number;
}

/** The public client surface. */
export interface WhisperrApi {
  /**
   * Associate an end-user id with traits/channels. On a backend the user id is
   * always explicit — pass the same id you use in track().
   */
  identify(externalUserId: string, params?: IdentifyParams): void;
  /**
   * Record a product event for a known user. `externalUserId` is required
   * (unlike the browser SDK, the server has no persisted session to infer it).
   */
  track(
    externalUserId: string,
    eventType: string,
    properties?: Record<string, unknown>,
    context?: Record<string, unknown>,
  ): void;
  /** Deliver everything currently queued and resolve once it's sent. */
  flush(): Promise<void>;
  /** Stop the flush timer and deliver anything left. Call before process exit. */
  shutdown(): Promise<void>;
  /** True when the client will capture (i.e. not disabled). */
  readonly ready: boolean;
}

// ---- internal wire/queue shapes ----

export interface IdentifyOp {
  kind: "identify";
  externalUserId: string;
  traits?: Record<string, unknown>;
  preferredChannel?: string;
  channels?: WhisperrChannel[];
  occurredAt: string;
}

export interface TrackOp {
  kind: "track";
  externalUserId: string;
  eventType: string;
  properties?: Record<string, unknown>;
  context?: Record<string, unknown>;
  occurredAt: string;
  /** Idempotency key — lets the backend dedup retries. */
  messageId: string;
}

export type QueuedOp = IdentifyOp | TrackOp;
