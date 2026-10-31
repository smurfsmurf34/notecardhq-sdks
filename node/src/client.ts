import { APIConnectionError, NotecardHQError, errorFromResponse } from "./errors.js";
import type {
  ApiDescription,
  CreateNoteOptions,
  CreateNoteParams,
  HoldoutReport,
  HoldoutReportParams,
  ListRecentParams,
  Note,
  RecentNote,
  RecentNotesPage,
  RedactionParams,
  RedactionResult,
  RequestOptions,
} from "./types.js";
import { verifyWebhook, verifyWebhookSignature, type VerifyWebhookOptions } from "./webhooks.js";

export const DEFAULT_BASE_URL = "https://app.notecardhq.com/api/v1";
export const VERSION = "0.1.0";

export interface ClientOptions {
  /** Your workspace API key: mos_... (live) or mos_test_... (test; never mails a card). */
  apiKey: string;
  /** Default https://app.notecardhq.com/api/v1. Use your workspace's host if your docs show another one. */
  baseUrl?: string;
  /** Retries for network errors, 429 and 5xx on requests that are safe to repeat. Default 2. */
  maxRetries?: number;
  /** Per-attempt timeout in milliseconds. Default 30000. */
  timeoutMs?: number;
  /** A fetch implementation. Default: the global fetch (Node 18+, Bun, Deno, edge runtimes). */
  fetch?: typeof fetch;
}

interface Call {
  method: "GET" | "POST";
  path: string;
  query?: Record<string, string | undefined>;
  body?: unknown;
  headers?: Record<string, string>;
  /** Safe to send again after a network error or 5xx. */
  retryable: boolean;
  /** "text" for non-JSON responses (the proof SVG). */
  as?: "json" | "text";
  signal?: AbortSignal;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * The notecardHQ API client.
 *
 * ```ts
 * const notecard = new NotecardHQ({ apiKey: process.env.NOTECARDHQ_API_KEY! });
 * const note = await notecard.notes.create({ recipient, content }, { idempotencyKey: `welcome:${userId}` });
 * ```
 */
export class NotecardHQ {
  readonly baseUrl: string;
  readonly maxRetries: number;
  readonly timeoutMs: number;
  /** True for a test key (mos_test_...): notes are validated and stored but never written, mailed or billed. */
  readonly isTest: boolean;
  readonly notes: Notes;
  readonly redactions: Redactions;
  readonly holdout: Holdout;
  readonly webhooks: Webhooks;
  readonly #apiKey: string;
  readonly #fetch: typeof fetch;

  constructor(options: ClientOptions) {
    if (!options?.apiKey) throw new TypeError("NotecardHQ: apiKey is required (mos_... or mos_test_...).");
    this.#apiKey = options.apiKey;
    this.baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
    this.maxRetries = Math.max(0, options.maxRetries ?? 2);
    this.timeoutMs = options.timeoutMs ?? 30_000;
    this.isTest = options.apiKey.startsWith("mos_test_");
    const f = options.fetch ?? globalThis.fetch;
    if (typeof f !== "function") throw new TypeError("NotecardHQ: no fetch available; use Node 18+ or pass options.fetch.");
    this.#fetch = f;
    this.notes = new Notes(this);
    this.redactions = new Redactions(this);
    this.holdout = new Holdout(this);
    this.webhooks = new Webhooks();
  }

  /** GET /notes: a machine-readable summary of the API for this host. Needs no key, but sends it. */
  describe(options: RequestOptions = {}): Promise<ApiDescription> {
    return this.request({ method: "GET", path: "/notes", retryable: true, signal: options.signal });
  }

  /** @internal */
  async request<T>(call: Call): Promise<T> {
    const url = new URL(this.baseUrl + call.path);
    for (const [k, v] of Object.entries(call.query ?? {})) if (v !== undefined) url.searchParams.set(k, v);
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.#apiKey}`,
      Accept: call.as === "text" ? "*/*" : "application/json",
      "User-Agent": `notecardhq-node/${VERSION}`,
      ...call.headers,
    };
    let body: string | undefined;
    if (call.body !== undefined) {
      headers["Content-Type"] = "application/json";
      body = JSON.stringify(call.body);
    }
    for (let attempt = 0; ; attempt++) {
      const last = !call.retryable || attempt >= this.maxRetries;
      let response: Response;
      const timeout = new AbortController();
      const timer = setTimeout(() => timeout.abort(), this.timeoutMs);
      const onAbort = () => timeout.abort();
      call.signal?.addEventListener("abort", onAbort, { once: true });
      try {
        response = await this.#fetch(url.toString(), { method: call.method, headers, body, signal: timeout.signal });
      } catch (cause) {
        if (call.signal?.aborted) throw cause;
        const timedOut = timeout.signal.aborted;
        const error = new APIConnectionError(timedOut ? `No response within ${this.timeoutMs} ms.` : "Could not reach notecardHQ.", {
          code: timedOut ? "timeout" : "connection_error",
          cause,
        });
        if (last) throw error;
        await sleep(this.#backoff(attempt));
        continue;
      } finally {
        clearTimeout(timer);
        call.signal?.removeEventListener("abort", onAbort);
      }
      if (response.ok) {
        if (call.as === "text") return (await response.text()) as T;
        return (await response.json()) as T;
      }
      const text = await response.text();
      let parsed: unknown = text;
      try {
        parsed = text ? JSON.parse(text) : undefined;
      } catch {}
      const error = errorFromResponse(response.status, parsed, response.headers);
      if (last || !(response.status === 429 || response.status >= 500)) throw error;
      await sleep(this.#backoff(attempt, response.headers.get("retry-after")));
    }
  }

  #backoff(attempt: number, retryAfter?: string | null): number {
    const seconds = retryAfter == null ? NaN : Number(retryAfter);
    if (Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds, 60) * 1000;
    return Math.min(8000, 500 * 2 ** attempt) * (0.75 + Math.random() * 0.5);
  }
}

const path = (id: string) => {
  if (!id) throw new TypeError("NotecardHQ: a note id is required.");
  return encodeURIComponent(id);
};

export class Notes {
  constructor(private readonly client: NotecardHQ) {}

  /**
   * POST /notes: create a note. With a live key this mails a real card; with a
   * test key (mos_test_...) nothing is written, mailed or billed.
   * Retried on network errors and 5xx only when `idempotencyKey` is set.
   */
  create(params: CreateNoteParams, options: CreateNoteOptions = {}): Promise<Note> {
    const headers: Record<string, string> = {};
    if (options.idempotencyKey !== undefined) headers["Idempotency-Key"] = options.idempotencyKey;
    return this.client.request({
      method: "POST",
      path: "/notes",
      body: params,
      headers,
      retryable: options.idempotencyKey !== undefined,
      signal: options.signal,
    });
  }

  /** GET /notes/{id}: a note and its current status. */
  get(id: string, options: RequestOptions = {}): Promise<Note> {
    return this.client.request({ method: "GET", path: `/notes/${path(id)}`, retryable: true, signal: options.signal });
  }

  /** GET /notes/recent: one page of your notes, newest status change first. */
  listRecent(params: ListRecentParams = {}, options: RequestOptions = {}): Promise<RecentNotesPage> {
    const since = params.updatedSince instanceof Date ? params.updatedSince.toISOString() : params.updatedSince;
    return this.client.request({
      method: "GET",
      path: "/notes/recent",
      query: { limit: params.limit?.toString(), updatedSince: since, cursor: params.cursor },
      retryable: true,
      signal: options.signal,
    });
  }

  /** Every note from GET /notes/recent, following nextCursor page by page. */
  async *iterateRecent(params: ListRecentParams = {}, options: RequestOptions = {}): AsyncGenerator<RecentNote> {
    let cursor = params.cursor;
    do {
      const page = await this.listRecent({ ...params, cursor }, options);
      yield* page.notes;
      cursor = page.nextCursor ?? undefined;
    } while (cursor);
  }

  /** GET /notes/{id}/proof: the card's proof as SVG (workspaces with proof images; not for test notes). */
  proof(id: string, options: RequestOptions = {}): Promise<string> {
    return this.client.request({ method: "GET", path: `/notes/${path(id)}/proof`, retryable: true, as: "text", signal: options.signal });
  }
}

export class Redactions {
  constructor(private readonly client: NotecardHQ) {}

  /**
   * POST /redactions (workspaces with retention on): delete recipients' personal
   * data. Notes not yet written are cancelled and never mailed. Safe to repeat.
   */
  create(params: RedactionParams, options: RequestOptions = {}): Promise<RedactionResult> {
    return this.client.request({ method: "POST", path: "/redactions", body: params, retryable: true, signal: options.signal });
  }
}

export class Holdout {
  constructor(private readonly client: NotecardHQ) {}

  /** GET /holdout: cards vs holdout per month, with externalIds. */
  report(params: HoldoutReportParams = {}, options: RequestOptions = {}): Promise<HoldoutReport> {
    return this.client.request({
      method: "GET",
      path: "/holdout",
      query: { from: params.from, to: params.to },
      retryable: true,
      signal: options.signal,
    });
  }
}

export class Webhooks {
  /** See verifyWebhook. */
  verify(payload: string | Uint8Array | ArrayBuffer, header: string | null | undefined, secret: string, options?: VerifyWebhookOptions) {
    return verifyWebhook(payload, header, secret, options);
  }

  /** See verifyWebhookSignature. */
  verifySignature(payload: string | Uint8Array | ArrayBuffer, header: string | null | undefined, secret: string, options?: VerifyWebhookOptions) {
    return verifyWebhookSignature(payload, header, secret, options);
  }
}

export { NotecardHQError };
