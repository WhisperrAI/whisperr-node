import { MemoryQueue } from "./queue.js";
import { Transport } from "./transport.js";
import type {
  IdentifyOp,
  IdentifyParams,
  QueuedOp,
  TrackOp,
  WhisperrApi,
  WhisperrChannel,
  WhisperrError,
  WhisperrFetch,
  WhisperrOptions,
} from "./types.js";

/** Terminal outcome of delivering one batch (after any transient retries). */
type DeliverResult = "ok" | "auth" | "drop" | "retry_exhausted";

const DEFAULT_BASE = "https://api.whisperr.net";
// Mirrors the server's accepted event_type shape.
const SNAKE_CASE = /^[a-z0-9]+(?:_[a-z0-9]+)*$/;

export class WhisperrClient implements WhisperrApi {
  readonly ready: boolean;

  private readonly queue: MemoryQueue;
  private readonly transport: Transport;

  private readonly flushAt: number;
  private readonly maxBatchSize: number;
  private readonly maxRetries: number;
  private readonly debug: boolean;
  private readonly onError?: (error: WhisperrError) => void;

  private readonly muted: boolean;
  private drainChain: Promise<void> = Promise.resolve();
  private flushTimer: ReturnType<typeof setInterval> | null = null;

  constructor(options: WhisperrOptions) {
    if (!options.apiKey && !options.disabled) {
      throw new Error("[whisperr] apiKey is required");
    }
    const baseUrl = (options.baseUrl ?? DEFAULT_BASE).replace(/\/+$/, "");
    this.flushAt = options.flushAt ?? 20;
    this.maxBatchSize = Math.min(options.maxBatchSize ?? 500, 500);
    this.maxRetries = options.maxRetries ?? 6;
    this.debug = options.debug ?? false;
    this.onError = options.onError;
    this.muted = !!options.disabled;

    this.queue = new MemoryQueue(options.maxQueueSize ?? 10000);

    const fetchImpl =
      options.fetch ?? (globalThis.fetch as unknown as WhisperrFetch | undefined);
    if (!fetchImpl && !this.muted) {
      throw new Error(
        "[whisperr] no fetch available — use Node 18+ or pass options.fetch",
      );
    }
    this.transport = new Transport(
      baseUrl,
      options.apiKey,
      options.requestTimeoutMs ?? 10000,
      fetchImpl ?? (noopFetch as WhisperrFetch),
      (msg) => this.warn(msg),
    );

    this.ready = !this.muted;

    const intervalMs = options.flushIntervalMs ?? 10000;
    if (!this.muted && intervalMs > 0) this.startTimer(intervalMs);
  }

  identify(externalUserId: string, params: IdentifyParams = {}): void {
    if (this.muted || !externalUserId) return;
    this.enqueue({
      kind: "identify",
      externalUserId,
      traits: params.traits,
      preferredChannel: params.preferredChannel,
      channels: buildChannels(params),
      occurredAt: nowISO(),
    });
    void this.flush();
  }

  track(
    externalUserId: string,
    eventType: string,
    properties?: Record<string, unknown>,
    context?: Record<string, unknown>,
  ): void {
    if (this.muted || !externalUserId || !eventType) return;
    const type = eventType.trim();
    if (!type) return;
    if (!SNAKE_CASE.test(type)) {
      this.emit({
        type: "dropped",
        message: `invalid event_type "${type}" — expected snake_case`,
      });
      this.warn(`invalid event_type "${type}" — event was not queued`);
      return;
    }
    this.enqueue({
      kind: "track",
      externalUserId,
      eventType: type,
      properties,
      context,
      occurredAt: nowISO(),
      messageId: uuid(),
    });
    if (this.queue.size >= this.flushAt) void this.flush();
  }

  async flush(): Promise<void> {
    if (this.muted) return;
    // Serialize drains and guarantee that awaiting flush() waits for a drain
    // pass that runs AFTER this call — so `await client.flush()` actually
    // delivers everything queued, even if a background flush is mid-send.
    const next = this.drainChain.then(() => this.drain()).catch(() => {});
    this.drainChain = next;
    await next;
  }

  async shutdown(): Promise<void> {
    if (this.flushTimer) {
      clearInterval(this.flushTimer);
      this.flushTimer = null;
    }
    await this.flush();
  }

  // ---- internals ----

  private enqueue(op: QueuedOp): void {
    const dropped = this.queue.enqueue(op);
    if (dropped > 0) {
      this.emit({
        type: "dropped",
        message: `queue full — dropped ${dropped} oldest event(s)`,
      });
    }
  }

  private async drain(): Promise<void> {
    while (this.queue.size > 0) {
      const front = this.queue.peek()!;
      // Take ownership of this batch before sending, so concurrent enqueues
      // (and overflow drops) can't disturb events that are in flight.
      const batch =
        front.kind === "identify"
          ? this.queue.takeFront(1)
          : this.queue.takeTrackBatchFront(this.maxBatchSize);

      const result = await this.deliver(batch);

      if (result === "ok") continue;
      if (result === "drop") {
        this.emit({
          type: "dropped",
          message: `dropped ${batch.length} event(s) — rejected by server`,
        });
        continue;
      }
      // auth / retry_exhausted: hand the batch back to the front and stop; a
      // later flush (timer or explicit) retries from where we left off.
      this.queue.requeueFront(batch);
      if (result === "auth") {
        this.emit({ type: "auth", message: "delivery paused — API key rejected", status: 401 });
      } else {
        this.emit({
          type: "retry_exhausted",
          message: "delivery failed after retries; will retry on next flush",
        });
      }
      break;
    }
  }

  /** Send one batch, retrying transient failures with backoff. */
  private async deliver(batch: QueuedOp[]): Promise<DeliverResult> {
    let retries = 0;
    for (;;) {
      const result =
        batch[0]!.kind === "identify"
          ? await this.transport.sendIdentify(batch[0] as IdentifyOp)
          : await this.transport.sendBatch(batch as TrackOp[]);

      if (result !== "retry") return result;
      if (++retries > this.maxRetries) return "retry_exhausted";
      await delay(backoff(retries));
    }
  }

  private startTimer(intervalMs: number): void {
    this.flushTimer = setInterval(() => void this.flush(), intervalMs);
    // Don't keep the process alive just for the flush timer.
    (this.flushTimer as unknown as { unref?: () => void }).unref?.();
  }

  private emit(error: WhisperrError): void {
    try {
      this.onError?.(error);
    } catch {
      /* host callback threw — ignore */
    }
  }

  private warn(msg: string): void {
    if (this.debug) {
      // eslint-disable-next-line no-console
      console.warn(`[whisperr] ${msg}`);
    }
  }
}

function buildChannels(params: IdentifyParams): WhisperrChannel[] | undefined {
  if (params.channels && params.channels.length) return params.channels;
  const out: WhisperrChannel[] = [];
  if (params.email) out.push({ type: "email", address: params.email, optedIn: true });
  if (params.phone) out.push({ type: "sms", address: params.phone, optedIn: true });
  if (params.pushToken) out.push({ type: "push", address: params.pushToken, optedIn: true });
  return out.length ? out : undefined;
}

function backoff(attempt: number): number {
  const base = Math.min(30000, 1000 * 2 ** attempt);
  return base + Math.floor(Math.random() * 250);
}

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function nowISO(): string {
  return new Date().toISOString();
}

function uuid(): string {
  // crypto.randomUUID is available in Node 18+ and all modern runtimes.
  const c = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  if (c?.randomUUID) return c.randomUUID();
  // Fallback: RFC4122-ish v4 from Math.random (only if crypto is unavailable).
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (ch) => {
    const r = (Math.random() * 16) | 0;
    const v = ch === "x" ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

function noopFetch(): Promise<{ ok: boolean; status: number }> {
  return Promise.resolve({ ok: true, status: 200 });
}
