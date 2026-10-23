import { describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createWhisperrCatalog, WhisperrCatalogError, WhisperrConfigurationError } from "./catalog.js";
import type { CatalogFetch } from "./catalog.js";
import { toMinorUnits } from "./money.js";

// The catalog push fixture. whisperr-spec conformance/catalog_push.json wins
// when WHISPERR_CATALOG_SPEC_PATH points at it; until the spec publishes it,
// the copy bundled here is the contract.
const here = dirname(fileURLToPath(import.meta.url));
const fixturePath = process.env.WHISPERR_CATALOG_SPEC_PATH || resolve(here, "../fixtures/catalog_push.json");
const spec = JSON.parse(readFileSync(fixturePath, "utf8"));

// Keys whose children are data (locales, extras attributes), not field names.
const MAP_KEYS = new Set(["extras", "localizations"]);

function camel(key: string): string {
  return key.replace(/_([a-z0-9])/g, (_, c: string) => c.toUpperCase());
}

function camelize(v: any, mapValues = false): any {
  if (Array.isArray(v)) return v.map((x) => camelize(x));
  if (v && typeof v === "object") {
    const out: any = {};
    for (const [k, val] of Object.entries(v)) {
      if (mapValues) out[k] = camelize(val);
      else if (k === "extras") out.extras = val;
      else out[camel(k)] = camelize(val, MAP_KEYS.has(k));
    }
    return out;
  }
  return v;
}

function generatedItems(g: any): any[] {
  return Array.from({ length: g.count }, (_, i) => ({ ...g.template, source_item_id: `${g.source_item_id_prefix}${i}` }));
}

async function run(c: any, sent: any[]) {
  let n = 0;
  const fetchImpl: CatalogFetch = async (url, init) => {
    const x = c.exchanges[n++];
    if (!x) throw new Error(`${c.name}: unexpected request ${init.method} ${url}`);
    sent.push({ url, init, body: init.body === undefined ? undefined : JSON.parse(init.body) });
    const r = x.response;
    return {
      ok: r.status >= 200 && r.status < 300,
      status: r.status,
      headers: new Headers(r.headers ?? {}),
      text: async () => (r.body === undefined ? "" : JSON.stringify(r.body)),
    };
  };
  const catalog = createWhisperrCatalog({
    apiKey: c.api_key ?? "wrk_test",
    baseUrl: "https://api.test",
    fetch: fetchImpl,
    sleep: async () => {},
  });
  const a = c.args;
  switch (c.op) {
    case "upsert":
      return catalog.upsert(camelize(a.items ?? generatedItems(a.generate_items)));
    case "delete": {
      if (a.items) return catalog.delete(camelize(a.items));
      const ids = a.ids ?? Array.from({ length: a.generate_ids.count }, (_, i) => `${a.generate_ids.prefix}${i}`);
      return catalog.delete(ids, a.deleted_at);
    }
    case "begin_snapshot":
      return catalog.beginSnapshot();
    case "complete_snapshot":
      return catalog.completeSnapshot(a.snapshot_id, a.item_count);
    case "heartbeat":
      return catalog.heartbeat(a.item_count);
    case "status":
      return catalog.status();
  }
  throw new Error(`unknown op ${c.op}`);
}

describe("catalog push conformance", () => {
  for (const c of spec.cases) {
    it(c.name, async () => {
      const sent: any[] = [];
      let result: any;
      let error: any;
      try {
        result = await run(c, sent);
      } catch (e) {
        error = e;
      }
      expect(sent.length, "request count").toBe(c.exchanges.length);
      c.exchanges.forEach((x: any, i: number) => {
        const req = x.request;
        const got = sent[i];
        expect(got.init.method).toBe(req.method);
        expect(new URL(got.url).pathname).toBe(req.path);
        expect(got.init.headers["X-API-Key"]).toBe(c.api_key ?? "wrk_test");
        if (req.method === "GET") expect(got.init.body).toBeUndefined();
        else expect(got.init.headers["Content-Type"]).toBe("application/json");
        if (req.body) expect(got.body).toEqual(req.body);
        if (req.item_ids) expect(got.body.items.map((it: any) => it.source_item_id)).toEqual(req.item_ids);
        if (req.item_count !== undefined) {
          expect(got.body.items.length).toBe(req.item_count);
          expect(got.body.items[0].source_item_id).toBe(req.first_item_id);
          expect(got.body.items.at(-1).source_item_id).toBe(req.last_item_id);
        }
        if (req.same_body_as_previous) expect(got.init.body).toBe(sent[i - 1].init.body);
      });
      if (c.error) {
        expect(error, "expected an error").toBeTruthy();
        if (c.error.configuration || c.error.local) {
          expect(error).toBeInstanceOf(WhisperrConfigurationError);
        } else {
          expect(error).toBeInstanceOf(WhisperrCatalogError);
          expect(error.status).toBe(c.error.status);
          expect(error.code).toBe(c.error.code);
          expect(error.retryable).toBe(c.error.retryable);
        }
      } else {
        if (error) throw error;
        expect(result).toEqual(camelize(c.result));
      }
    });
  }
});

describe("toMinorUnits conformance", () => {
  for (const m of spec.minor_units) {
    it(`${m.amount} ${m.currency}`, () => {
      if (m.error) expect(() => toMinorUnits(m.amount, m.currency)).toThrow(RangeError);
      else expect(toMinorUnits(m.amount, m.currency)).toBe(m.minor);
    });
  }
});

it("the bundled fixture exists", () => {
  expect(existsSync(fixturePath)).toBe(true);
});
