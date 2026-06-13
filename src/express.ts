import type { Request, RequestHandler } from "express";
import type { IdentifyParams, WhisperrApi } from "./types.js";

/**
 * Per-request Whisperr helper attached to `req.whisperr`. `track`/`identify`
 * are bound to the request's resolved user id, so call sites stay one-liners:
 *
 * ```ts
 * req.whisperr.track("plan_upgraded", { plan: "pro" });
 * ```
 */
export interface RequestWhisperr {
  /** The user id resolved for this request, if any. */
  readonly userId: string | undefined;
  /** The underlying client (for advanced use). */
  readonly client: WhisperrApi;
  /** Track an event for this request's user. No-op if no user was resolved. */
  track(
    eventType: string,
    properties?: Record<string, unknown>,
    context?: Record<string, unknown>,
  ): void;
  /** Identify this request's user. No-op if no user was resolved. */
  identify(params?: IdentifyParams): void;
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      whisperr: RequestWhisperr;
    }
  }
}

export interface WhisperrExpressOptions {
  /**
   * How to find the end-user id on a request. Defaults to common auth shapes
   * (`req.user.id`, `req.user.sub`, `req.auth.userId`, `req.userId`). Provide
   * your own when your auth attaches the id elsewhere.
   */
  resolveUser?: (req: Request) => string | null | undefined;
}

/**
 * Express middleware that attaches `req.whisperr` bound to the request's user.
 * Mount it after your auth middleware so the user id is resolvable.
 *
 * ```ts
 * import { createWhisperr } from "@whisperr/node";
 * import { whisperrExpress } from "@whisperr/node/express";
 *
 * const whisperr = createWhisperr({ apiKey: process.env.WHISPERR_API_KEY! });
 * app.use(whisperrExpress(whisperr));
 * ```
 */
export function whisperrExpress(
  client: WhisperrApi,
  options: WhisperrExpressOptions = {},
): RequestHandler {
  const resolve = options.resolveUser ?? defaultResolveUser;
  return (req, _res, next) => {
    const userId = resolve(req) ?? undefined;
    req.whisperr = {
      userId,
      client,
      track(eventType, properties, context) {
        if (!userId) return;
        client.track(userId, eventType, properties, context);
      },
      identify(params) {
        if (!userId) return;
        client.identify(userId, params);
      },
    };
    next();
  };
}

function defaultResolveUser(req: Request): string | undefined {
  const r = req as unknown as {
    user?: { id?: unknown; sub?: unknown };
    auth?: { userId?: unknown };
    userId?: unknown;
  };
  const candidates = [r.user?.id, r.user?.sub, r.auth?.userId, r.userId];
  for (const c of candidates) {
    if (typeof c === "string" && c) return c;
  }
  return undefined;
}
