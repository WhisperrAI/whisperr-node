import { dirname, join } from "node:path";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { WhisperrClient } from "./client.js";
import { SDK_NAME, SDK_VERSION } from "./version.js";
import type { WhisperrFetch } from "./types.js";

// Contract v2 flows (whisperr-spec conformance/v2.json). This harness runs
// every section whose appliesTo names "server".
const SPEC_URL =
  "https://raw.githubusercontent.com/WhisperrAI/whisperr-spec/main/conformance/v2.json";
const GOVERNED_CONTEXT_KEYS = ["app_version", "app_build", "platform", "sdk_name", "sdk_version", "locale"];
const PLACEHOLDERS: Record<string, string> = { $sdk_name: SDK_NAME, $sdk_version: SDK_VERSION };

interface V2Case {
  name: string;
  config?: { release?: string };
  steps: Array<Record<string, any>>;
  expectedRequests: Array<{ endpoint: string; body?: any; events?: any[] }>;
}

interface V2Section {
  appliesTo: string[];
  cases: V2Case[];
}

async function loadSpec(): Promise<{ sections: Record<string, V2Section> }> {
  const local = process.env.WHISPERR_V2_SPEC_PATH ?? siblingPath();
  if (local) return JSON.parse(readFileSync(local, "utf8"));
  const res = await fetch(SPEC_URL);
  if (!res.ok) throw new Error(`fetch v2 spec: ${res.status}`);
  return res.json() as Promise<{ sections: Record<string, V2Section> }>;
}

function siblingPath(): string | undefined {
  const wire = process.env.WHISPERR_SPEC_PATH;
  return wire ? join(dirname(wire), "v2.json") : undefined;
}

function resolve(value: unknown): unknown {
  if (typeof value === "string" && value in PLACEHOLDERS) return PLACEHOLDERS[value];
  if (Array.isArray(value)) return value.map(resolve);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, resolve(v)]));
  }
  return value;
}

function applyStep(client: WhisperrClient, step: Record<string, any>, label: string): void {
  if (step.track) {
    const t = step.track;
    client.track(t.externalUserId, t.eventType, t.properties);
  } else if (step.identify) {
    const s = step.identify;
    client.identify(s.externalUserId, { traits: s.traits, pushToken: s.pushToken });
  } else {
    throw new Error(`${label}: step ${JSON.stringify(step)} is not supported by a server SDK`);
  }
}

function assertEvent(actual: any, expected: any, label: string): void {
  const { context: expectedContext, ...rest } = resolve(expected) as Record<string, any>;
  const { occurred_at: _ignored, context: actualContext, ...actualRest } = actual;
  expect(actualRest, label).toEqual(rest);
  expect(typeof actualContext?.$message_id, `${label} context.$message_id`).toBe("string");
  if (!expectedContext) return;
  for (const key of GOVERNED_CONTEXT_KEYS) {
    if (key in expectedContext) {
      expect(actualContext[key], `${label} context.${key}`).toEqual(expectedContext[key]);
    } else {
      expect(actualContext, `${label} context.${key} must be absent`).not.toHaveProperty(key);
    }
  }
}

describe("contract v2 conformance (whisperr-spec v2.json, server sections)", () => {
  it("runs every server section", async () => {
    const spec = await loadSpec();
    const sections = Object.entries(spec.sections).filter(([, s]) => s.appliesTo.includes("server"));
    expect(sections.length, "v2.json has no server section").toBeGreaterThan(0);

    for (const [sectionName, section] of sections) {
      for (const c of section.cases) {
        const label = `${sectionName}/${c.name}`;
        const calls: Array<{ url: string; body: any }> = [];
        const fetchImpl: WhisperrFetch = async (url, init) => {
          calls.push({ url, body: JSON.parse(init.body) });
          return { ok: true, status: 200 };
        };
        const client = new WhisperrClient({
          apiKey: "wrk_test",
          flushIntervalMs: 0,
          fetch: fetchImpl,
          appVersion: c.config?.release,
        });
        for (const step of c.steps) {
          applyStep(client, step, label);
          await client.flush();
        }
        await client.shutdown();

        expect(calls.length, `${label}: request count`).toBe(c.expectedRequests.length);
        c.expectedRequests.forEach((want, i) => {
          const got = calls[i]!;
          expect(got.url.endsWith(want.endpoint), `${label}[${i}] endpoint`).toBe(true);
          if (want.endpoint === "/v1/identify") {
            expect(got.body, `${label}[${i}] body`).toEqual(resolve(want.body));
          } else {
            const events = got.body.events ?? [got.body];
            expect(events.length, `${label}[${i}] event count`).toBe(want.events!.length);
            want.events!.forEach((e, j) => assertEvent(events[j], e, `${label}[${i}].events[${j}]`));
          }
        });
      }
    }
  });
});
