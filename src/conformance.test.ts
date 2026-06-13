import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { WhisperrClient } from "./client.js";
import type { WhisperrFetch } from "./types.js";

const SPEC_URL =
  "https://raw.githubusercontent.com/WhisperrAI/whisperr-spec/main/conformance/wire.json";
const RFC3339_Z = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

interface WireCase {
  name: string;
  op: "track" | "identify";
  scenario: any;
  endpoint: string;
  expectedEvent?: Record<string, unknown>;
  expectedBody?: Record<string, unknown>;
  contextMustContain?: string[];
  occurredAtRfc3339Z?: boolean;
}

async function loadSpec(): Promise<{ cases: WireCase[] }> {
  const local = process.env.WHISPERR_SPEC_PATH;
  if (local) return JSON.parse(readFileSync(local, "utf8"));
  const res = await fetch(SPEC_URL);
  if (!res.ok) throw new Error(`fetch wire spec: ${res.status}`);
  return res.json() as Promise<{ cases: WireCase[] }>;
}

function applyCase(client: WhisperrClient, c: WireCase): void {
  const s = c.scenario;
  if (c.op === "track") {
    client.track(s.externalUserId, s.eventType, s.properties);
  } else {
    client.identify(s.externalUserId, {
      traits: s.traits,
      email: s.email,
      phone: s.phone,
      pushToken: s.pushToken,
      preferredChannel: s.preferredChannel,
      channels: s.channels?.map((ch: any) => ({
        type: ch.type,
        address: ch.address,
        optedIn: ch.optedIn,
        verified: ch.verified,
      })),
    });
  }
}

describe("wire conformance (whisperr-spec)", () => {
  it("serializes every case to the canonical wire shape", async () => {
    const spec = await loadSpec();
    expect(spec.cases.length).toBeGreaterThan(0);

    for (const c of spec.cases) {
      const captured: { url: string; body: any }[] = [];
      const fetchImpl: WhisperrFetch = async (url, init) => {
        captured.push({ url, body: JSON.parse(init.body) });
        return { ok: true, status: 200 };
      };
      const client = new WhisperrClient({ apiKey: "wrk_test", flushIntervalMs: 0, fetch: fetchImpl });
      applyCase(client, c);
      await client.flush();
      await client.shutdown();

      const call = captured.find((x) => x.url.endsWith(c.endpoint));
      expect(call, `${c.name}: expected POST ${c.endpoint}`).toBeTruthy();

      if (c.op === "track") {
        const ev = call!.body.events[0];
        for (const [k, v] of Object.entries(c.expectedEvent ?? {})) {
          expect(ev[k], `${c.name}.${k}`).toEqual(v);
        }
        for (const key of c.contextMustContain ?? []) {
          expect(ev.context?.[key], `${c.name} context.${key}`).toBeTruthy();
        }
        if (c.occurredAtRfc3339Z) expect(ev.occurred_at).toMatch(RFC3339_Z);
      } else {
        for (const [k, v] of Object.entries(c.expectedBody ?? {})) {
          expect(call!.body[k], `${c.name}.${k}`).toEqual(v);
        }
      }
    }
  }, 20000);
});
