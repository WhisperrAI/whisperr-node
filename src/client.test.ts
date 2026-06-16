import { describe, it, expect, vi } from "vitest";
import { WhisperrClient } from "./client.js";
import type { WhisperrError, WhisperrFetch } from "./types.js";

interface Captured {
  url: string;
  body: any;
  headers: Record<string, string>;
}

/** A fetch mock that records calls and returns a scripted status. */
function mockFetch(status = 200) {
  const calls: Captured[] = [];
  let nextStatus = status;
  const fn: WhisperrFetch = async (url, init) => {
    calls.push({ url, body: JSON.parse(init.body), headers: init.headers });
    return { ok: nextStatus >= 200 && nextStatus < 300, status: nextStatus };
  };
  return {
    fn,
    calls,
    setStatus(s: number) {
      nextStatus = s;
    },
  };
}

function client(fetchImpl: WhisperrFetch, onError?: (e: WhisperrError) => void) {
  return new WhisperrClient({
    apiKey: "wrk_test",
    fetch: fetchImpl,
    flushIntervalMs: 0, // no background timer in tests
    onError,
  });
}

describe("WhisperrClient", () => {
  it("batches track events to /v1/events/batch with the explicit user id and idempotency key", async () => {
    const m = mockFetch();
    const w = client(m.fn);

    w.track("user_8842", "payment_failed", { amount_cents: 4900 });
    w.track("user_8842", "subscription_cancelled");
    await w.flush();

    expect(m.calls).toHaveLength(1);
    const call = m.calls[0]!;
    expect(call.url).toBe("https://api.whisperr.net/v1/events/batch");
    expect(call.headers["X-API-Key"]).toBe("wrk_test");
    expect(call.body.events).toHaveLength(2);

    const [first, second] = call.body.events;
    expect(first.external_user_id).toBe("user_8842");
    expect(first.event_type).toBe("payment_failed");
    expect(first.properties).toEqual({ amount_cents: 4900 });
    expect(typeof first.context.$message_id).toBe("string");
    expect(first.context.$message_id).not.toBe(second.context.$message_id);
  });

  it("maps identify channels to the server contract", async () => {
    const m = mockFetch();
    const w = client(m.fn);

    w.identify("user_8842", { email: "a@b.com", traits: { plan: "pro" }, preferredChannel: "email" });
    await w.flush();

    expect(m.calls).toHaveLength(1);
    const call = m.calls[0]!;
    expect(call.url).toBe("https://api.whisperr.net/v1/identify");
    expect(call.body.external_user_id).toBe("user_8842");
    expect(call.body.traits).toEqual({ plan: "pro" });
    expect(call.body.preferred_channel).toBe("email");
    expect(call.body.channels).toEqual([{ channel: "email", address: "a@b.com", opted_in: true }]);
  });

  it("requires a user id and event type on track", async () => {
    const m = mockFetch();
    const w = client(m.fn);
    w.track("", "payment_failed");
    w.track("user_1", "");
    await w.flush();
    expect(m.calls).toHaveLength(0);
  });

  it("drops invalid event types before they can poison a batch", async () => {
    const m = mockFetch();
    const errors: WhisperrError[] = [];
    const w = client(m.fn, (e) => errors.push(e));

    w.track("user_1", "User Signed Up");
    w.track("user_1", "checkout_completed");
    await w.flush();

    expect(errors.some((e) => e.type === "dropped")).toBe(true);
    expect(m.calls).toHaveLength(1);
    expect(m.calls[0]!.body.events).toHaveLength(1);
    expect(m.calls[0]!.body.events[0].event_type).toBe("checkout_completed");
  });

  it("stops on auth rejection and keeps the queue for a later flush", async () => {
    const m = mockFetch(401);
    const errors: WhisperrError[] = [];
    const w = client(m.fn, (e) => errors.push(e));

    w.track("user_1", "feature_used");
    await w.flush();
    expect(errors.some((e) => e.type === "auth")).toBe(true);

    // Key fixed → the retained event delivers on the next flush.
    m.setStatus(200);
    await w.flush();
    const batchCalls = m.calls.filter((c) => c.url.endsWith("/v1/events/batch"));
    expect(batchCalls.at(-1)!.body.events).toHaveLength(1);
  });

  it("drops malformed (4xx) events instead of retrying forever", async () => {
    const m = mockFetch(400);
    const errors: WhisperrError[] = [];
    const w = client(m.fn, (e) => errors.push(e));

    w.track("user_1", "feature_used");
    await w.flush();

    expect(errors.some((e) => e.type === "dropped")).toBe(true);
    // Queue drained → a second flush sends nothing.
    m.setStatus(200);
    await w.flush();
    expect(m.calls.filter((c) => c.url.endsWith("/v1/events/batch"))).toHaveLength(1);
  });

  it("is a no-op when disabled", async () => {
    const m = mockFetch();
    const w = new WhisperrClient({ apiKey: "wrk_test", fetch: m.fn, disabled: true });
    expect(w.ready).toBe(false);
    w.track("user_1", "feature_used");
    await w.flush();
    expect(m.calls).toHaveLength(0);
  });

  it("flushes remaining events on shutdown", async () => {
    const m = mockFetch();
    const w = client(m.fn);
    w.track("user_1", "feature_used");
    await w.shutdown();
    expect(m.calls).toHaveLength(1);
  });
});
