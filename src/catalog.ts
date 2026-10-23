import { parseRetryAfter } from "./transport.js";
import { SDK_NAME, SDK_VERSION } from "./version.js";

/*
 * Catalog push client (whisperr-go catalog v2 contract, section 6).
 *
 * Calls are synchronous request/response, not queued like track(): the
 * promise resolves once Whisperr has answered. Upserts are chunked at 500 items
 * (and 2 MiB), deletes at 1000. 429 and 5xx answers and network errors are
 * retried with backoff, honoring Retry-After. Every retry resends the same
 * body, and the server orders writes by `updated_at` / `deleted_at`, so a
 * retried upsert or delete can never apply twice or overwrite a newer write.
 */

export type CatalogItemType = "product" | "plan" | "content" | "location" | "offer";
export type CatalogKind = "product" | "content" | "course" | "plan" | "location" | "offer";
export type CatalogAvailability = "available" | "limited" | "unavailable" | "unknown";
/** An RFC 3339 timestamp. A Date is sent in UTC with a `Z` suffix. */
export type CatalogTime = Date | string;

export interface CatalogPrice {
  /** Integer minor units, e.g. 1999 for 19.99 USD. See `toMinorUnits`. */
  amountMinor: number;
  /** ISO 4217, upper case. */
  currency: string;
  meaning?: string;
}

export interface CatalogCollection {
  /** Your stable collection or category id. */
  id: string;
  name: string;
  handle?: string;
  url?: string;
}

export interface CatalogVariant {
  variantId: string;
  title?: string;
  availability: CatalogAvailability;
  priceMinor?: number;
  compareAtMinor?: number;
}

export interface CatalogLocalization {
  name: string;
  description?: string;
}

export interface CatalogAction {
  version: number;
  type: string;
  target: { kind: CatalogItemType; id: string; locationId?: string };
}

export interface CatalogOfferTerms {
  kind: string;
  buyQuantity: number;
  freeQuantity: number;
  requiresMembership: boolean;
  eligibility: string;
  summary?: string;
}

export interface CatalogReference {
  relation: string;
  sourceItemId: string;
}

/**
 * One catalog item (whisperr-spec `schemas/catalog-item-v2.schema.json`).
 * Use the same `sourceItemId` you send as `product_id` in tracked events.
 */
export interface CatalogItem {
  /** Your stable item id, at most 512 characters. */
  sourceItemId: string;
  type: CatalogItemType;
  name: string;
  availability: CatalogAvailability;
  /** When this item last changed in your system. Required for push; the newest write wins. */
  updatedAt?: CatalogTime;
  url?: string;
  price?: CatalogPrice;
  category?: string;
  location?: string;
  localizations?: Record<string, CatalogLocalization>;
  references?: CatalogReference[];
  action?: CatalogAction;
  offerTerms?: CatalogOfferTerms;
  sourceVersion?: string;
  kind?: CatalogKind;
  /** https only. */
  imageUrl?: string;
  compareAtMinor?: number;
  priceMinMinor?: number;
  priceMaxMinor?: number;
  currency?: string;
  anyVariantInStock?: boolean;
  productType?: string;
  brand?: string;
  /** At most 32. */
  collections?: CatalogCollection[];
  /** At most 32, each at most 64 characters. */
  tags?: string[];
  /** Only size, color, material, pattern, gender, age_group, condition, google_product_category, unit, flavor, scent; 512 bytes in total. */
  extras?: Record<string, string>;
  publishedAt?: CatalogTime;
  giftCard?: boolean;
  /** At most 100. */
  variants?: CatalogVariant[];
}

export interface CatalogDeletion {
  sourceItemId: string;
  /** When the item was removed in your system. Defaults to the time of the call. */
  deletedAt?: CatalogTime;
}

export interface CatalogRejection {
  /** Index into the array you passed (not into one chunk). */
  index: number;
  sourceItemId: string;
  code: string;
  message: string;
}

export interface CatalogUpsertResult {
  accepted: number;
  applied: number;
  unchanged: number;
  ignoredOlder: number;
  rejected: CatalogRejection[];
}

export interface CatalogDeleteResult {
  deleted: number;
  ignoredOlder: number;
  notFound: number;
  rejected: CatalogRejection[];
}

export interface CatalogSnapshot {
  snapshotId: string;
  startedAt: string;
}

export interface CatalogSnapshotCompleteResult {
  tombstoned: number;
  itemCount: number;
  state: string;
}

export interface CatalogHeartbeatResult {
  refreshed: boolean;
  reason?: string;
  storedCount?: number;
}

export interface CatalogSourceHealth {
  connectionId: string;
  provider: string;
  mode: string;
  state: string;
  itemCount: number;
  availableCount: number;
  unclassifiedCount: number;
  excludedCount: number;
  freshnessSeconds: number;
  newestFreshAsOf: string | null;
  lastSuccessAt: string | null;
  lastPushAt: string | null;
  lastHeartbeatAt: string | null;
  lastError: string | null;
  issueCount: number;
  rejectedHost: string | null;
  repair: string;
  repairPath: string;
}

/** The catalog client: `whisperr.catalog`. */
export interface WhisperrCatalog {
  /** Create or update items. Chunks at 500. Rejected items are listed, not thrown. */
  upsert(items: CatalogItem[]): Promise<CatalogUpsertResult>;
  /** Delete items by id (all get `deletedAt`, default now) or by `{ sourceItemId, deletedAt }`. Chunks at 1000. */
  delete(items: Array<string | CatalogDeletion>, deletedAt?: CatalogTime): Promise<CatalogDeleteResult>;
  /** Start a full sync. Upsert every item, then call `completeSnapshot`. */
  beginSnapshot(): Promise<CatalogSnapshot>;
  /** End a full sync: items not upserted since `beginSnapshot` are removed. */
  completeSnapshot(snapshotId: string, itemCount: number): Promise<CatalogSnapshotCompleteResult>;
  /** Tell Whisperr the catalog is still current. Send every 30 minutes with your live item count. */
  heartbeat(itemCount: number): Promise<CatalogHeartbeatResult>;
  /** The health of your pushed catalog. */
  status(): Promise<CatalogSourceHealth>;
}

/** Thrown for a key or argument the catalog API can never accept. Nothing was sent. */
export class WhisperrConfigurationError extends Error {
  constructor(message: string) {
    super(`[whisperr] ${message}`);
    this.name = "WhisperrConfigurationError";
  }
}

/** Thrown when Whisperr refuses a catalog call or cannot be reached. */
export class WhisperrCatalogError extends Error {
  /** HTTP status; 0 for a network error or timeout. */
  readonly status: number;
  /** The server's error code (e.g. `server_key_required`, `catalog_push_disabled`, `snapshot_not_open`), or `network_error`. */
  readonly code: string;
  /** True when the retries ran out on a transient failure; calling again later can succeed. */
  readonly retryable: boolean;
  /** For upsert and delete: what earlier chunks already did before this failure. */
  readonly partial?: CatalogUpsertResult | CatalogDeleteResult;

  constructor(
    message: string,
    init: { status: number; code: string; retryable: boolean; partial?: CatalogUpsertResult | CatalogDeleteResult },
  ) {
    super(`[whisperr] ${message}`);
    this.name = "WhisperrCatalogError";
    this.status = init.status;
    this.code = init.code;
    this.retryable = init.retryable;
    this.partial = init.partial;
  }
}

/** The fetch shape the catalog client needs. The global fetch fits. */
export type CatalogFetch = (
  url: string,
  init: { method: string; headers: Record<string, string>; body?: string; signal?: AbortSignal },
) => Promise<{
  ok: boolean;
  status: number;
  headers?: { get(name: string): string | null };
  text?: () => Promise<string>;
}>;

export interface WhisperrCatalogOptions {
  /** A server key (`wrk_…`). A publishable key (`wpk_…`) is refused. */
  apiKey: string;
  baseUrl?: string;
  /** Retries after the first attempt on 429, 5xx and network errors. Default 5. */
  maxRetries?: number;
  /** Per-request timeout (ms). Default 30000. */
  requestTimeoutMs?: number;
  fetch?: CatalogFetch;
  /** Wait between retries. Injectable for tests. */
  sleep?: (ms: number) => Promise<void>;
  /** Every call throws a WhisperrConfigurationError (set by a disabled Whisperr client). */
  disabled?: boolean;
}

export const CATALOG_UPSERT_BATCH = 500;
export const CATALOG_DELETE_BATCH = 1000;
export const CATALOG_MAX_BODY_BYTES = 2 * 1024 * 1024;
export const CATALOG_FEED_PAGE_ITEMS = 200;

const DEFAULT_BASE = "https://api.whisperr.net";
const SNAPSHOT_ID = /^[A-Za-z0-9_-]{1,64}$/;
// Room for {"items":[ ... ]} and the commas between items.
const ENVELOPE_BYTES = 16;

type Wire = Record<string, unknown>;

/** Creates a standalone catalog client. `createWhisperr(...).catalog` is the same client. */
export function createWhisperrCatalog(options: WhisperrCatalogOptions): WhisperrCatalog {
  return new CatalogClient(options);
}

export class CatalogClient implements WhisperrCatalog {
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly maxRetries: number;
  private readonly timeoutMs: number;
  private readonly fetchImpl?: CatalogFetch;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly disabled: boolean;

  constructor(options: WhisperrCatalogOptions) {
    this.disabled = !!options.disabled;
    this.apiKey = (options.apiKey ?? "").trim();
    this.baseUrl = (options.baseUrl ?? DEFAULT_BASE).replace(/\/+$/, "");
    this.maxRetries = Math.max(0, options.maxRetries ?? 5);
    this.timeoutMs = options.requestTimeoutMs ?? 30000;
    this.fetchImpl = options.fetch ?? (globalThis.fetch as unknown as CatalogFetch | undefined);
    this.sleep = options.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  async upsert(items: CatalogItem[]): Promise<CatalogUpsertResult> {
    this.checkKey();
    if (!Array.isArray(items)) throw new WhisperrConfigurationError("upsert takes an array of items");
    const result: CatalogUpsertResult = { accepted: 0, applied: 0, unchanged: 0, ignoredOlder: 0, rejected: [] };
    const encoded = items.map((item, index) => {
      const wire = itemToWire(item);
      return { index, id: String(item?.sourceItemId ?? ""), json: JSON.stringify(wire) };
    });
    const chunks: (typeof encoded)[] = [];
    let chunk: typeof encoded = [];
    let bytes = ENVELOPE_BYTES;
    for (const e of encoded) {
      const size = utf8Length(e.json) + 1;
      if (size + ENVELOPE_BYTES > CATALOG_MAX_BODY_BYTES) {
        result.rejected.push({ index: e.index, sourceItemId: e.id, code: "item_too_large", message: "the item is larger than the 2 MiB request limit" });
        continue;
      }
      if (chunk.length === CATALOG_UPSERT_BATCH || bytes + size > CATALOG_MAX_BODY_BYTES) {
        chunks.push(chunk);
        chunk = [];
        bytes = ENVELOPE_BYTES;
      }
      chunk.push(e);
      bytes += size;
    }
    if (chunk.length) chunks.push(chunk);

    const send = async (part: typeof encoded): Promise<void> => {
      const body = `{"items":[${part.map((e) => e.json).join(",")}]}`;
      let res: Wire;
      try {
        res = await this.request("POST", "/v1/catalog/items/batch", body);
      } catch (err) {
        // The server measures the body; split and resend rather than fail.
        if (err instanceof WhisperrCatalogError && err.status === 413 && part.length > 1) {
          const half = Math.ceil(part.length / 2);
          await send(part.slice(0, half));
          await send(part.slice(half));
          return;
        }
        if (err instanceof WhisperrCatalogError && err.status === 413) {
          result.rejected.push({ index: part[0]!.index, sourceItemId: part[0]!.id, code: "item_too_large", message: err.message });
          return;
        }
        throw withPartial(err, result);
      }
      result.accepted += num(res.accepted);
      result.applied += num(res.applied);
      result.unchanged += num(res.unchanged);
      result.ignoredOlder += num(res.ignored_older);
      result.rejected.push(...rejections(res.rejected, part));
    };
    for (const part of chunks) await send(part);
    result.rejected.sort((a, b) => a.index - b.index);
    return result;
  }

  async delete(items: Array<string | CatalogDeletion>, deletedAt?: CatalogTime): Promise<CatalogDeleteResult> {
    this.checkKey();
    if (!Array.isArray(items)) throw new WhisperrConfigurationError("delete takes an array of ids or items");
    // One timestamp for the whole call, so a retry resends the same body.
    const fallback = formatTime(deletedAt ?? new Date(), "deletedAt");
    const encoded = items.map((item, index) => {
      const id = typeof item === "string" ? item : String(item?.sourceItemId ?? "");
      const at = typeof item === "string" || item?.deletedAt === undefined ? fallback : formatTime(item.deletedAt, "deletedAt");
      return { index, id, json: JSON.stringify({ source_item_id: id, deleted_at: at }) };
    });
    const result: CatalogDeleteResult = { deleted: 0, ignoredOlder: 0, notFound: 0, rejected: [] };
    for (let i = 0; i < encoded.length; i += CATALOG_DELETE_BATCH) {
      const part = encoded.slice(i, i + CATALOG_DELETE_BATCH);
      let res: Wire;
      try {
        res = await this.request("POST", "/v1/catalog/items/delete", `{"items":[${part.map((e) => e.json).join(",")}]}`);
      } catch (err) {
        throw withPartial(err, result);
      }
      result.deleted += num(res.deleted);
      result.ignoredOlder += num(res.ignored_older);
      result.notFound += num(res.not_found);
      result.rejected.push(...rejections(res.rejected, part));
    }
    result.rejected.sort((a, b) => a.index - b.index);
    return result;
  }

  async beginSnapshot(): Promise<CatalogSnapshot> {
    this.checkKey();
    const res = await this.request("POST", "/v1/catalog/snapshots", "{}");
    return { snapshotId: str(res.snapshot_id), startedAt: str(res.started_at) };
  }

  async completeSnapshot(snapshotId: string, itemCount: number): Promise<CatalogSnapshotCompleteResult> {
    this.checkKey();
    if (typeof snapshotId !== "string" || !SNAPSHOT_ID.test(snapshotId)) {
      throw new WhisperrConfigurationError("snapshotId must be the id beginSnapshot returned");
    }
    checkCount(itemCount);
    const res = await this.request("POST", `/v1/catalog/snapshots/${snapshotId}/complete`, JSON.stringify({ item_count: itemCount }));
    return { tombstoned: num(res.tombstoned), itemCount: num(res.item_count), state: str(res.state) };
  }

  async heartbeat(itemCount: number): Promise<CatalogHeartbeatResult> {
    this.checkKey();
    checkCount(itemCount);
    const res = await this.request("POST", "/v1/catalog/heartbeat", JSON.stringify({ item_count: itemCount }));
    const out: CatalogHeartbeatResult = { refreshed: res.refreshed === true };
    if (typeof res.reason === "string") out.reason = res.reason;
    if (typeof res.stored_count === "number") out.storedCount = res.stored_count;
    return out;
  }

  async status(): Promise<CatalogSourceHealth> {
    this.checkKey();
    const res = await this.request("GET", "/v1/catalog/status");
    return camelKeys(res) as unknown as CatalogSourceHealth;
  }

  // ---- internals ----

  private checkKey(): void {
    if (this.disabled) throw new WhisperrConfigurationError("the Whisperr client is disabled; catalog calls are not sent");
    if (!this.apiKey) throw new WhisperrConfigurationError("catalog calls need a server key (wrk_…)");
    if (this.apiKey.startsWith("wpk_")) {
      throw new WhisperrConfigurationError(
        "catalog push needs a server key (wrk_…); a publishable key (wpk_…) ships in apps and browsers and is refused",
      );
    }
    if (!this.fetchImpl) throw new WhisperrConfigurationError("no fetch available — use Node 18+ or pass options.fetch");
  }

  private async request(method: "GET" | "POST", path: string, body?: string): Promise<Wire> {
    const headers: Record<string, string> = {
      Accept: "application/json",
      "X-API-Key": this.apiKey,
      "User-Agent": `${SDK_NAME}/${SDK_VERSION}`,
    };
    if (body !== undefined) headers["Content-Type"] = "application/json";
    let attempt = 0;
    for (;;) {
      let status = 0;
      let code = "network_error";
      let message = "network error or timeout";
      let retryAfterMs: number | undefined;
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.timeoutMs);
      try {
        const res = await this.fetchImpl!(`${this.baseUrl}${path}`, { method, headers, body, signal: controller.signal });
        status = res.status;
        const text = res.text ? await res.text() : "";
        const parsed = parseJSON(text);
        if (res.ok && status >= 200 && status < 300) {
          if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
            throw new WhisperrCatalogError(`unreadable response from ${path}`, { status, code: "invalid_response", retryable: false });
          }
          return parsed as Wire;
        }
        ({ code, message } = errorOf(parsed, status));
        if (status === 429 || status === 503) retryAfterMs = parseRetryAfter(res.headers?.get?.("Retry-After"));
        if (!(status === 429 || status >= 500)) {
          throw new WhisperrCatalogError(`${path} refused (${status} ${code}): ${message}`, { status, code, retryable: false });
        }
      } catch (err) {
        if (err instanceof WhisperrCatalogError) throw err;
        // network error or timeout: fall through to retry
      } finally {
        clearTimeout(timer);
      }
      if (attempt >= this.maxRetries) {
        throw new WhisperrCatalogError(`${path} failed after ${attempt + 1} attempts (${status || "network"} ${code}): ${message}`, {
          status,
          code,
          retryable: true,
        });
      }
      attempt++;
      await this.sleep(retryAfterMs ?? backoff(attempt));
    }
  }
}

/** Maps a camelCase item to the snake_case wire shape. Undefined and null keys are left out. */
export function itemToWire(item: CatalogItem): Wire {
  if (!item || typeof item !== "object") throw new WhisperrConfigurationError("each catalog item must be an object");
  const w: Wire = {};
  put(w, "source_item_id", item.sourceItemId);
  put(w, "type", item.type);
  put(w, "kind", item.kind);
  put(w, "name", item.name);
  put(w, "url", item.url);
  put(w, "availability", item.availability);
  if (item.updatedAt != null) w.updated_at = formatTime(item.updatedAt, "updatedAt");
  if (item.price != null) {
    const p: Wire = {};
    put(p, "amount_minor", item.price.amountMinor);
    put(p, "currency", item.price.currency);
    put(p, "meaning", item.price.meaning);
    w.price = p;
  }
  put(w, "category", item.category);
  put(w, "location", item.location);
  put(w, "source_version", item.sourceVersion);
  if (item.localizations != null) {
    const l: Wire = {};
    for (const [locale, v] of Object.entries(item.localizations)) {
      if (v == null) continue;
      const o: Wire = {};
      put(o, "name", v.name);
      put(o, "description", v.description);
      l[locale] = o;
    }
    w.localizations = l;
  }
  if (item.references != null) {
    w.references = item.references.map((r) => {
      const o: Wire = {};
      put(o, "relation", r.relation);
      put(o, "source_item_id", r.sourceItemId);
      return o;
    });
  }
  if (item.action != null) {
    const t: Wire = {};
    put(t, "kind", item.action.target?.kind);
    put(t, "id", item.action.target?.id);
    put(t, "location_id", item.action.target?.locationId);
    const a: Wire = {};
    put(a, "version", item.action.version);
    put(a, "type", item.action.type);
    a.target = t;
    w.action = a;
  }
  if (item.offerTerms != null) {
    const o: Wire = {};
    put(o, "kind", item.offerTerms.kind);
    put(o, "buy_quantity", item.offerTerms.buyQuantity);
    put(o, "free_quantity", item.offerTerms.freeQuantity);
    put(o, "requires_membership", item.offerTerms.requiresMembership);
    put(o, "eligibility", item.offerTerms.eligibility);
    put(o, "summary", item.offerTerms.summary);
    w.offer_terms = o;
  }
  put(w, "image_url", item.imageUrl);
  put(w, "compare_at_minor", item.compareAtMinor);
  put(w, "price_min_minor", item.priceMinMinor);
  put(w, "price_max_minor", item.priceMaxMinor);
  put(w, "currency", item.currency);
  put(w, "any_variant_in_stock", item.anyVariantInStock);
  put(w, "product_type", item.productType);
  put(w, "brand", item.brand);
  if (item.collections != null) {
    w.collections = item.collections.map((c) => {
      const o: Wire = {};
      put(o, "id", c.id);
      put(o, "name", c.name);
      put(o, "handle", c.handle);
      put(o, "url", c.url);
      return o;
    });
  }
  if (item.tags != null) w.tags = [...item.tags];
  if (item.extras != null) w.extras = { ...item.extras };
  if (item.publishedAt != null) w.published_at = formatTime(item.publishedAt, "publishedAt");
  put(w, "gift_card", item.giftCard);
  if (item.variants != null) {
    w.variants = item.variants.map((v) => {
      const o: Wire = {};
      put(o, "variant_id", v.variantId);
      put(o, "title", v.title);
      put(o, "availability", v.availability);
      put(o, "price_minor", v.priceMinor);
      put(o, "compare_at_minor", v.compareAtMinor);
      return o;
    });
  }
  return w;
}

export interface CatalogFeedPageInput {
  /** Stable for every page of one export, at most 128 characters. */
  snapshotId: string;
  /** When this export was generated. The same on every page. */
  generatedAt: CatalogTime;
  /** Items across all pages of this export. */
  totalItems: number;
  /** At most 200 per page. `updatedAt` is optional in a feed. */
  items: CatalogItem[];
  /** The cursor for the next page; omit or null on the last page. */
  nextCursor?: string | null;
  issues?: Array<{ code: string; sourceItemId?: string; message: string }>;
}

/**
 * Builds one page of a Whisperr catalog feed (`schema_version` 1.1) for a feed
 * endpoint you host. Whisperr fetches it with `?cursor=` for the next pages.
 * Serve it as JSON: `res.json(catalogFeedPage({...}))`.
 */
export function catalogFeedPage(input: CatalogFeedPageInput): Wire {
  if (!input || !Array.isArray(input.items)) throw new WhisperrConfigurationError("catalogFeedPage needs items");
  if (input.items.length > CATALOG_FEED_PAGE_ITEMS) {
    throw new WhisperrConfigurationError(`a feed page holds at most ${CATALOG_FEED_PAGE_ITEMS} items`);
  }
  if (typeof input.snapshotId !== "string" || input.snapshotId.trim() === "" || input.snapshotId.length > 128) {
    throw new WhisperrConfigurationError("snapshotId must be 1 to 128 characters");
  }
  checkCount(input.totalItems);
  const next = input.nextCursor ?? null;
  return {
    schema_version: "1.1",
    snapshot_id: input.snapshotId,
    generated_at: formatTime(input.generatedAt, "generatedAt"),
    total_items: input.totalItems,
    items: input.items.map(itemToWire),
    complete: next === null,
    next_cursor: next,
    issues: (input.issues ?? []).map((i) => {
      const o: Wire = {};
      put(o, "code", i.code);
      put(o, "source_item_id", i.sourceItemId);
      put(o, "message", i.message);
      return o;
    }),
  };
}

/** RFC 3339 in UTC with `Z`; milliseconds only when they are not zero. */
export function formatTime(value: CatalogTime, field: string): string {
  if (typeof value === "string") return value;
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    return value.toISOString().replace(".000Z", "Z");
  }
  throw new WhisperrConfigurationError(`${field} must be a Date or an RFC 3339 string`);
}

function put(target: Wire, key: string, value: unknown): void {
  if (value !== undefined && value !== null) target[key] = value;
}

function checkCount(n: number): void {
  if (!Number.isSafeInteger(n) || n < 0) throw new WhisperrConfigurationError("itemCount must be a whole number, at least 0");
}

function rejections(raw: unknown, part: Array<{ index: number; id: string }>): CatalogRejection[] {
  if (!Array.isArray(raw)) return [];
  return raw.map((r: Wire) => {
    const local = typeof r?.index === "number" ? r.index : -1;
    const orig = part[local];
    return {
      index: orig ? orig.index : -1,
      sourceItemId: typeof r?.source_item_id === "string" ? r.source_item_id : (orig?.id ?? ""),
      code: str(r?.code),
      message: str(r?.message),
    };
  });
}

function withPartial(err: unknown, partial: CatalogUpsertResult | CatalogDeleteResult): unknown {
  if (!(err instanceof WhisperrCatalogError)) return err;
  const snapshot = { ...partial, rejected: [...partial.rejected].sort((a, b) => a.index - b.index) };
  const out = new WhisperrCatalogError(err.message.replace(/^\[whisperr\] /, ""), {
    status: err.status,
    code: err.code,
    retryable: err.retryable,
    partial: snapshot,
  });
  return out;
}

function errorOf(body: unknown, status: number): { code: string; message: string } {
  const b = (body ?? {}) as Wire;
  const e = (b.error && typeof b.error === "object" ? b.error : b) as Wire;
  return {
    code: typeof e.code === "string" && e.code ? e.code : `http_${status}`,
    message: typeof e.message === "string" ? e.message : "",
  };
}

function backoff(attempt: number): number {
  return Math.min(30000, 500 * 2 ** attempt) + Math.floor(Math.random() * 250);
}

function camelKeys(o: Wire): Wire {
  const out: Wire = {};
  for (const [k, v] of Object.entries(o)) out[k.replace(/_([a-z0-9])/g, (_, c: string) => c.toUpperCase())] = v;
  return out;
}

function parseJSON(text: string): unknown {
  if (!text) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function num(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

function str(v: unknown): string {
  return typeof v === "string" ? v : "";
}

function utf8Length(s: string): number {
  let n = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 0x80) n += 1;
    else if (c < 0x800) n += 2;
    else if (c >= 0xd800 && c <= 0xdbff) {
      n += 4;
      i++;
    } else n += 3;
  }
  return n;
}
