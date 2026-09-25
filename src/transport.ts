import type { IdentifyOp, TrackOp, WhisperrFetch } from "./types.js";

export type SendResult = "ok" | "retry" | "auth" | "drop";

export interface SendOutcome {
  result: SendResult;
  /** Server-requested wait before the next attempt (a 429/503 `Retry-After`), already capped. */
  retryAfterMs?: number;
}

/** Longest `Retry-After` we honor; a larger value waits this long, then retries. */
export const MAX_RETRY_AFTER_MS = 60000;

/**
 * Parses a `Retry-After` value — delay-seconds or an HTTP-date (RFC 9110
 * §10.2.3) — into milliseconds from `now`, capped at MAX_RETRY_AFTER_MS.
 * Returns undefined when absent or unparseable (the caller falls back to backoff).
 */
export function parseRetryAfter(value: string | null | undefined, now = Date.now()): number | undefined {
  if (!value) return undefined;
  const v = value.trim();
  let ms: number;
  if (/^\d+$/.test(v)) ms = Number(v) * 1000;
  else {
    // An HTTP-date always names its day/month; requiring a letter keeps
    // Date.parse's lenient guessing ("1.5", "-5") from reading numbers as dates.
    const at = /[a-z]/i.test(v) ? Date.parse(v) : NaN;
    if (Number.isNaN(at)) return undefined;
    ms = Math.max(0, at - now);
  }
  return Math.min(ms, MAX_RETRY_AFTER_MS);
}

/**
 * Network transport for the Whisperr ingestion API. Mirrors the wire contract
 * of the browser SDK: events post to /v1/events/batch, identities to
 * /v1/identify, authenticated with the X-API-Key header. Result classification
 * drives the client's retry loop:
 *   ok    — delivered
 *   retry — transient (429, 5xx, network/timeout); a 429/503 `Retry-After`
 *           rides along as retryAfterMs
 *   auth  — key rejected (401/403); stop and surface
 *   drop  — other 4xx (malformed); discard to avoid an infinite retry loop
 */
export class Transport {
  constructor(
    private readonly baseUrl: string,
    private readonly apiKey: string,
    private readonly timeoutMs: number,
    private readonly fetchImpl: WhisperrFetch,
    private readonly warn: (msg: string) => void,
  ) {}

  async sendBatch(events: TrackOp[]): Promise<SendOutcome> {
    const body = {
      events: events.map((e) => ({
        external_user_id: e.externalUserId,
        event_type: e.eventType,
        occurred_at: e.occurredAt,
        properties: e.properties ?? {},
        // $message_id is an idempotency key for backend dedup (nested in the
        // free-form context so the strict ingestion accepts it).
        context: { ...(e.context ?? {}), $message_id: e.messageId },
      })),
    };
    if (body.events.length === 0) return { result: "ok" };
    return this.post("/v1/events/batch", body);
  }

  async sendIdentify(op: IdentifyOp): Promise<SendOutcome> {
    const body: Record<string, unknown> = {
      external_user_id: op.externalUserId,
    };
    if (op.traits && Object.keys(op.traits).length) body.traits = op.traits;
    if (op.preferredChannel) body.preferred_channel = op.preferredChannel;
    if (op.channels && op.channels.length) {
      body.channels = op.channels.map((c) => ({
        channel: c.type,
        address: c.address,
        opted_in: c.optedIn ?? true,
        ...(c.verified !== undefined ? { verified: c.verified } : {}),
      }));
    }
    return this.post("/v1/identify", body);
  }

  private async post(path: string, body: unknown): Promise<SendOutcome> {
    const url = `${this.baseUrl}${path}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const res = await this.fetchImpl(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-API-Key": this.apiKey,
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      if (res.ok) return { result: "ok" };
      if (res.status === 401 || res.status === 403) {
        this.warn(`auth rejected (${res.status}) — check your Whisperr API key`);
        return { result: "auth" };
      }
      if (res.status === 429 || res.status >= 500) {
        // Rate limited / temporarily unavailable: the server says when to come back.
        const retryAfterMs =
          res.status === 429 || res.status === 503
            ? parseRetryAfter(res.headers?.get?.("Retry-After"))
            : undefined;
        return retryAfterMs === undefined ? { result: "retry" } : { result: "retry", retryAfterMs };
      }
      this.warn(`request to ${path} dropped (${res.status})`);
      return { result: "drop" };
    } catch {
      // Network error / timeout / abort — retry later.
      return { result: "retry" };
    } finally {
      clearTimeout(timer);
    }
  }
}
