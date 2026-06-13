import type { IdentifyOp, TrackOp, WhisperrFetch } from "./types.js";

export type SendResult = "ok" | "retry" | "auth" | "drop";

/**
 * Network transport for the Whisperr ingestion API. Mirrors the wire contract
 * of the browser SDK: events post to /v1/events/batch, identities to
 * /v1/identify, authenticated with the X-API-Key header. Result classification
 * drives the client's retry loop:
 *   ok    — delivered
 *   retry — transient (429, 5xx, network/timeout)
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

  async sendBatch(events: TrackOp[]): Promise<SendResult> {
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
    if (body.events.length === 0) return "ok";
    return this.post("/v1/events/batch", body);
  }

  async sendIdentify(op: IdentifyOp): Promise<SendResult> {
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

  private async post(path: string, body: unknown): Promise<SendResult> {
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
      if (res.ok) return "ok";
      if (res.status === 401 || res.status === 403) {
        this.warn(`auth rejected (${res.status}) — check your Whisperr API key`);
        return "auth";
      }
      if (res.status === 429 || res.status >= 500) return "retry";
      this.warn(`request to ${path} dropped (${res.status})`);
      return "drop";
    } catch {
      // Network error / timeout / abort — retry later.
      return "retry";
    } finally {
      clearTimeout(timer);
    }
  }
}
