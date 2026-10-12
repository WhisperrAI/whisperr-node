import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { BillingEvent, SDK_NAME, SDK_VERSION, WhisperrClient } from "./index.js";
import type { WhisperrFetch, WhisperrOptions } from "./types.js";

async function sendOne(
  options: Partial<WhisperrOptions>,
  context?: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const bodies: any[] = [];
  const fetchImpl: WhisperrFetch = async (_url, init) => {
    bodies.push(JSON.parse(init.body));
    return { ok: true, status: 200 };
  };
  const client = new WhisperrClient({
    apiKey: "wrk_test",
    flushIntervalMs: 0,
    fetch: fetchImpl,
    ...options,
  });
  client.track("user_1", "feature_used", {}, context);
  await client.shutdown();
  return bodies[0].events[0].context;
}

describe("environment context (spec C5)", () => {
  it("sends sdk_name and sdk_version on every event and no app_version by default", async () => {
    const ctx = await sendOne({});
    expect(ctx.sdk_name).toBe("whisperr-node");
    expect(ctx.sdk_version).toBe(SDK_VERSION);
    expect(ctx).not.toHaveProperty("app_version");
    expect(typeof ctx.$message_id).toBe("string");
  });

  it("sends app_version when the caller configures a release version", async () => {
    const ctx = await sendOne({ appVersion: "2026.10.1" });
    expect(ctx.app_version).toBe("2026.10.1");
  });

  it("omits app_version when the configured value is blank", async () => {
    const ctx = await sendOne({ appVersion: "  " });
    expect(ctx).not.toHaveProperty("app_version");
  });

  it("lets a caller-supplied context key win, but never $message_id", async () => {
    const ctx = await sendOne(
      { appVersion: "1.0.0" },
      { app_version: "relay-9", plan: "pro", $message_id: "caller" },
    );
    expect(ctx.app_version).toBe("relay-9");
    expect(ctx.plan).toBe("pro");
    expect(ctx.sdk_name).toBe(SDK_NAME);
    expect(ctx.$message_id).not.toBe("caller");
  });

  it("keeps SDK_VERSION equal to the package version", () => {
    const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
    expect(SDK_VERSION).toBe(pkg.version);
  });
});

describe("billing fallback names (spec C6)", () => {
  it("exposes the reserved event names", () => {
    expect(Object.values(BillingEvent).sort()).toEqual(
      [
        "payment_failed",
        "purchase_completed",
        "subscription_cancelled",
        "subscription_renewed",
        "subscription_started",
        "trial_started",
      ],
    );
  });
});
