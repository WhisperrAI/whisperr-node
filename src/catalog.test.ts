import { describe, expect, it } from "vitest";
import { catalogFeedPage, createWhisperrCatalog, WhisperrCatalogError, WhisperrConfigurationError } from "./catalog.js";
import type { CatalogFetch, CatalogItem } from "./catalog.js";
import { createWhisperr } from "./index.js";
import { toMinorUnits } from "./money.js";

type Reply = { status: number; body?: unknown; headers?: Record<string, string> } | Error;

function scripted(replies: Reply[] | ((body: any) => Reply)) {
  const calls: { url: string; method: string; headers: Record<string, string>; body: any; raw?: string }[] = [];
  const fetchImpl: CatalogFetch = async (url, init) => {
    const body = init.body === undefined ? undefined : JSON.parse(init.body);
    calls.push({ url, method: init.method, headers: init.headers, body, raw: init.body });
    const r = typeof replies === "function" ? replies(body) : replies[calls.length - 1];
    if (!r) throw new Error("no scripted reply");
    if (r instanceof Error) throw r;
    return {
      ok: r.status >= 200 && r.status < 300,
      status: r.status,
      headers: new Headers(r.headers ?? {}),
      text: async () => (r.body === undefined ? "" : JSON.stringify(r.body)),
    };
  };
  return { calls, fetchImpl };
}

const ok = (n: number) => ({ status: 200, body: { accepted: n, applied: n, unchanged: 0, ignored_older: 0, rejected: [] } });
const item = (id: string, extra: Partial<CatalogItem> = {}): CatalogItem => ({
  sourceItemId: id,
  type: "product",
  name: "Item " + id,
  availability: "available",
  updatedAt: "2026-10-23T09:00:00Z",
  ...extra,
});

describe("catalog client", () => {
  it("refuses a publishable key from createWhisperr().catalog without sending", async () => {
    const { calls, fetchImpl } = scripted([]);
    const w = createWhisperr({ apiKey: "wpk_live_x", flushIntervalMs: 0, catalog: { fetch: fetchImpl } });
    await expect(w.catalog.upsert([item("a")])).rejects.toBeInstanceOf(WhisperrConfigurationError);
    await expect(w.catalog.status()).rejects.toBeInstanceOf(WhisperrConfigurationError);
    expect(calls).toHaveLength(0);
  });

  it("refuses every call on a disabled client", async () => {
    const w = createWhisperr({ apiKey: "", disabled: true });
    await expect(w.catalog.heartbeat(1)).rejects.toBeInstanceOf(WhisperrConfigurationError);
  });

  it("uses the client's fetch, base URL and key through createWhisperr().catalog", async () => {
    const { calls, fetchImpl } = scripted([{ status: 200, body: { refreshed: true } }]);
    const w = createWhisperr({
      apiKey: "wrk_live_k",
      baseUrl: "https://eu.api.test/",
      flushIntervalMs: 0,
      fetch: fetchImpl as never,
    });
    expect(w.catalog).toBe(w.catalog);
    await expect(w.catalog.heartbeat(3)).resolves.toEqual({ refreshed: true });
    expect(calls[0]!.url).toBe("https://eu.api.test/v1/catalog/heartbeat");
    expect(calls[0]!.headers["X-API-Key"]).toBe("wrk_live_k");
    expect(calls[0]!.headers["User-Agent"]).toMatch(/^whisperr-node\//);
  });

  it("retries a 500 with exponential backoff, then a network error, and resends the same body", async () => {
    const waits: number[] = [];
    const { calls, fetchImpl } = scripted([{ status: 500 }, new TypeError("fetch failed"), ok(1)]);
    const c = createWhisperrCatalog({ apiKey: "wrk_x", fetch: fetchImpl, sleep: async (ms) => void waits.push(ms) });
    await expect(c.upsert([item("a")])).resolves.toMatchObject({ accepted: 1 });
    expect(calls).toHaveLength(3);
    expect(new Set(calls.map((x) => x.raw)).size).toBe(1);
    expect(waits[0]).toBeGreaterThanOrEqual(1000);
    expect(waits[1]).toBeGreaterThanOrEqual(2000);
  });

  it("throws a retryable error with the partial result once retries run out", async () => {
    const replies: Reply[] = [ok(500), { status: 503 }, { status: 503 }, { status: 503 }];
    const { calls, fetchImpl } = scripted(replies);
    const c = createWhisperrCatalog({ apiKey: "wrk_x", fetch: fetchImpl, maxRetries: 2, sleep: async () => {} });
    const items = Array.from({ length: 501 }, (_, i) => item(`s${i}`));
    const err = await c.upsert(items).catch((e) => e);
    expect(err).toBeInstanceOf(WhisperrCatalogError);
    expect(err.retryable).toBe(true);
    expect(err.status).toBe(503);
    expect(err.partial).toMatchObject({ accepted: 500, applied: 500 });
    expect(calls).toHaveLength(4);
  });

  it("does not retry a 4xx", async () => {
    const { calls, fetchImpl } = scripted([{ status: 400, body: { error: { code: "invalid_request", message: "bad" } } }]);
    const c = createWhisperrCatalog({ apiKey: "wrk_x", fetch: fetchImpl, sleep: async () => {} });
    const err = await c.upsert([item("a")]).catch((e) => e);
    expect(err).toMatchObject({ status: 400, code: "invalid_request", retryable: false });
    expect(calls).toHaveLength(1);
  });

  it("splits a chunk the server answers 413, and rejects a lone item that is still too large", async () => {
    const { calls, fetchImpl } = scripted((body) =>
      body.items.length > 1 || body.items[0].source_item_id === "big"
        ? { status: 413, body: { error: { code: "batch_too_large", message: "too large" } } }
        : ok(1),
    );
    const c = createWhisperrCatalog({ apiKey: "wrk_x", fetch: fetchImpl, sleep: async () => {} });
    const res = await c.upsert([item("a"), item("big"), item("c")]);
    expect(res.accepted).toBe(2);
    expect(res.rejected).toEqual([{ index: 1, sourceItemId: "big", code: "item_too_large", message: expect.any(String) }]);
    expect(calls.length).toBeGreaterThan(3);
  });

  it("chunks by body size before 500 items", async () => {
    const { calls, fetchImpl } = scripted((body) => ok(body.items.length));
    const c = createWhisperrCatalog({ apiKey: "wrk_x", fetch: fetchImpl });
    const long = "x".repeat(200);
    // ~12 KiB per item: 2 MiB holds about 170 of them.
    const items = Array.from({ length: 400 }, (_, i) => item(`s${i}`, { tags: Array(60).fill(long) }));
    const res = await c.upsert(items);
    expect(res.accepted).toBe(400);
    expect(calls.length).toBeGreaterThan(1);
    for (const call of calls) expect(Buffer.byteLength(call.raw!)).toBeLessThanOrEqual(2 * 1024 * 1024);
  });

  it("sends Dates as UTC RFC 3339 and leaves out null keys", async () => {
    const { calls, fetchImpl } = scripted([ok(1)]);
    const c = createWhisperrCatalog({ apiKey: "wrk_x", fetch: fetchImpl });
    await c.upsert([
      item("a", {
        updatedAt: new Date("2026-10-23T09:00:00.120+02:00"),
        publishedAt: new Date("2026-09-01T00:00:00Z"),
        url: null as never,
        price: { amountMinor: toMinorUnits("19.99", "USD"), currency: "USD" },
      }),
    ]);
    const sent = calls[0]!.body.items[0];
    expect(sent.updated_at).toBe("2026-10-23T07:00:00.120Z");
    expect(sent.published_at).toBe("2026-09-01T00:00:00Z");
    expect("url" in sent).toBe(false);
    expect(sent.price).toEqual({ amount_minor: 1999, currency: "USD" });
  });

  it("uses one deleted_at for the whole delete call, also across chunks", async () => {
    const { calls, fetchImpl } = scripted((body) => ({ status: 200, body: { deleted: body.items.length, ignored_older: 0, not_found: 0, rejected: [] } }));
    const c = createWhisperrCatalog({ apiKey: "wrk_x", fetch: fetchImpl });
    const ids = Array.from({ length: 1500 }, (_, i) => `s${i}`);
    const res = await c.delete([...ids, { sourceItemId: "own", deletedAt: "2026-01-01T00:00:00Z" }]);
    expect(res.deleted).toBe(1501);
    const stamps = new Set(calls.flatMap((x) => x.body.items.filter((i: any) => i.source_item_id !== "own").map((i: any) => i.deleted_at)));
    expect(stamps.size).toBe(1);
    expect(calls[1]!.body.items.at(-1)).toEqual({ source_item_id: "own", deleted_at: "2026-01-01T00:00:00Z" });
  });

  it("checks counts locally", async () => {
    const c = createWhisperrCatalog({ apiKey: "wrk_x", fetch: scripted([]).fetchImpl });
    await expect(c.heartbeat(-1)).rejects.toBeInstanceOf(WhisperrConfigurationError);
    await expect(c.completeSnapshot("snap_1", 1.5)).rejects.toBeInstanceOf(WhisperrConfigurationError);
  });
});

describe("catalogFeedPage", () => {
  it("builds a schema 1.1 page", () => {
    const page = catalogFeedPage({
      snapshotId: "exp-2026-10-23",
      generatedAt: new Date("2026-10-23T06:00:00Z"),
      totalItems: 2,
      items: [{ sourceItemId: "a", type: "product", name: "A", availability: "available", tags: ["x"] }],
      nextCursor: "page2",
    });
    expect(page).toEqual({
      schema_version: "1.1",
      snapshot_id: "exp-2026-10-23",
      generated_at: "2026-10-23T06:00:00Z",
      total_items: 2,
      items: [{ source_item_id: "a", type: "product", name: "A", availability: "available", tags: ["x"] }],
      complete: false,
      next_cursor: "page2",
      issues: [],
    });
    const last = catalogFeedPage({ snapshotId: "s", generatedAt: "2026-10-23T06:00:00Z", totalItems: 0, items: [] });
    expect(last).toMatchObject({ complete: true, next_cursor: null });
  });

  it("refuses more than 200 items", () => {
    const items = Array.from({ length: 201 }, (_, i) => item(`s${i}`));
    expect(() => catalogFeedPage({ snapshotId: "s", generatedAt: "2026-10-23T06:00:00Z", totalItems: 201, items })).toThrow(
      WhisperrConfigurationError,
    );
  });
});

describe("toMinorUnits with numbers", () => {
  it("reads a number through its shortest decimal form", () => {
    expect(toMinorUnits(19.99, "USD")).toBe(1999);
    expect(toMinorUnits(1500, "JPY")).toBe(1500);
    expect(toMinorUnits(0.5, "eur")).toBe(50);
    expect(toMinorUnits(1.234, "KWD")).toBe(1234);
  });

  it("never rounds money silently", () => {
    expect(() => toMinorUnits(0.1 + 0.2, "USD")).toThrow(RangeError);
    expect(() => toMinorUnits(1e-7, "USD")).toThrow(RangeError);
    expect(() => toMinorUnits(Number.NaN, "USD")).toThrow(RangeError);
    expect(() => toMinorUnits(1e300, "USD")).toThrow(RangeError);
  });
});
