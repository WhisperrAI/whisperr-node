import { dirname, join } from "node:path";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { WhisperrClient } from "./client.js";
import type { WhisperrError, WhisperrFetch } from "./types.js";

const SPEC_URL =
  "https://raw.githubusercontent.com/WhisperrAI/whisperr-spec/main/conformance/behavior.json";

interface BehaviorCase {
  name: string;
  op: "track";
  scenario: {
    externalUserId: string;
    eventType: string;
    properties?: Record<string, unknown>;
  };
  clientOptions?: { maxRetries?: number };
  firstResponse: { status: number; classification: "ok" | "auth" | "retry" | "drop" };
  recoveryResponse: { status: number };
  expect: {
    errorType: "auth" | "retry_exhausted" | "dropped";
    retainedAfterFirstFlush: boolean;
    deliveredAfterRecovery: boolean;
    retriesAfterRecovery: boolean;
    stableMessageIdOnRetry?: boolean;
  };
}

async function loadSpec(): Promise<{ cases: BehaviorCase[] }> {
  const local = process.env.WHISPERR_BEHAVIOR_SPEC_PATH ?? siblingBehaviorPath();
  if (local) return JSON.parse(readFileSync(local, "utf8"));
  const res = await fetch(SPEC_URL);
  if (!res.ok) throw new Error(`fetch behavior spec: ${res.status}`);
  return res.json() as Promise<{ cases: BehaviorCase[] }>;
}

function siblingBehaviorPath(): string | undefined {
  const wire = process.env.WHISPERR_SPEC_PATH;
  return wire ? join(dirname(wire), "behavior.json") : undefined;
}

describe("behavior conformance (whisperr-spec)", () => {
  it("honors shared delivery semantics", async () => {
    const spec = await loadSpec();
    expect(spec.cases.length).toBeGreaterThan(0);

    for (const c of spec.cases) {
      let status = c.firstResponse.status;
      const errors: WhisperrError[] = [];
      const calls: Array<{ url: string; body: any }> = [];
      const fetchImpl: WhisperrFetch = async (url, init) => {
        calls.push({ url, body: JSON.parse(init.body) });
        return { ok: status >= 200 && status < 300, status };
      };
      const client = new WhisperrClient({
        apiKey: "wrk_test",
        flushIntervalMs: 0,
        maxRetries: c.clientOptions?.maxRetries ?? 0,
        fetch: fetchImpl,
        onError: (e) => errors.push(e),
      });

      client.track(c.scenario.externalUserId, c.scenario.eventType, c.scenario.properties);
      await client.flush();

      expect(errors.some((e) => e.type === c.expect.errorType), c.name).toBe(true);
      const afterFirst = batchCalls(calls);
      expect(afterFirst.length, `${c.name}: first delivery attempt`).toBe(1);
      expect(pendingCount(client), `${c.name}: retained after first flush`).toBe(
        c.expect.retainedAfterFirstFlush ? 1 : 0,
      );

      status = c.recoveryResponse.status;
      await client.flush();

      const afterRecovery = batchCalls(calls);
      const retried = afterRecovery.length > afterFirst.length;
      expect(retried, `${c.name}: retried after recovery`).toBe(c.expect.retriesAfterRecovery);
      const recoveryDelivered =
        retried && afterRecovery.at(-1)?.body.events?.[0]?.event_type === c.scenario.eventType;
      expect(
        recoveryDelivered,
        `${c.name}: delivered after recovery`,
      ).toBe(c.expect.deliveredAfterRecovery);

      if (c.expect.stableMessageIdOnRetry) {
        expect(afterRecovery[1]!.body.events[0].context.$message_id).toBe(
          afterRecovery[0]!.body.events[0].context.$message_id,
        );
      }

      await client.shutdown();
    }
  });
});

function batchCalls(calls: Array<{ url: string; body: any }>): Array<{ url: string; body: any }> {
  return calls.filter((c) => c.url.endsWith("/v1/events/batch"));
}

function pendingCount(client: WhisperrClient): number {
  return (client as unknown as { queue: { size: number } }).queue.size;
}
