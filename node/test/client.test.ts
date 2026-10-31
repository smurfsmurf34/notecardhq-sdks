import { describe, expect, it, vi } from "vitest";
import {
  APIConnectionError,
  APIError,
  AuthenticationError,
  DEFAULT_BASE_URL,
  IdempotencyConflictError,
  InvalidRequestError,
  NotFoundError,
  NotecardHQ,
  NotecardHQError,
  RateLimitError,
  type CreateNoteParams,
} from "../src/index.js";

const KEY = "mos_test_" + "a".repeat(64);

type Reply = Response | Error | (() => Response | Promise<Response>);
interface Sent {
  url: URL;
  method: string;
  headers: Record<string, string>;
  body: unknown;
}

/** A client whose fetch answers from `replies`, recording what was sent. */
function setup(replies: Reply[], options: { maxRetries?: number; baseUrl?: string; timeoutMs?: number } = {}) {
  const sent: Sent[] = [];
  const fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    sent.push({
      url: new URL(String(input)),
      method: init?.method ?? "GET",
      headers: Object.fromEntries(Object.entries((init?.headers ?? {}) as Record<string, string>).map(([k, v]) => [k.toLowerCase(), v])),
      body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
    });
    const reply = replies.shift();
    if (!reply) throw new Error("no reply queued");
    if (reply instanceof Error) throw reply;
    return typeof reply === "function" ? reply() : reply;
  });
  const client = new NotecardHQ({ apiKey: KEY, fetch: fetch as typeof globalThis.fetch, maxRetries: 0, ...options });
  return { client, sent, fetch };
}

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", ...headers } });

const note = { id: "n_1", status: "created", test: true, externalId: "user_123", content: "Hi Brandy!" };
const params: CreateNoteParams = {
  recipient: { firstName: "Brandy", lastName: "Lee", address1: "123 Main St", city: "Austin", state: "TX", postalCode: "78701", country: "US" },
  content: "Hi Brandy, congrats on your first dollar!",
  externalId: "user_123",
};

describe("constructor", () => {
  it("defaults the base URL and detects test keys", () => {
    const c = new NotecardHQ({ apiKey: KEY, fetch: vi.fn() });
    expect(c.baseUrl).toBe("https://app.notecardhq.com/api/v1");
    expect(DEFAULT_BASE_URL).toBe(c.baseUrl);
    expect(c.isTest).toBe(true);
    expect(new NotecardHQ({ apiKey: "mos_" + "b".repeat(64), fetch: vi.fn() }).isTest).toBe(false);
  });

  it("requires an API key", () => {
    expect(() => new NotecardHQ({ apiKey: "" })).toThrow(/apiKey is required/);
  });

  it("trims a trailing slash from baseUrl", async () => {
    const { client, sent } = setup([json(note)], { baseUrl: "https://whop.notecardhq.com/api/v1/" });
    await client.notes.get("n_1");
    expect(sent[0]!.url.toString()).toBe("https://whop.notecardhq.com/api/v1/notes/n_1");
  });
});

describe("notes.create", () => {
  it("POSTs the note with the key, JSON and Idempotency-Key", async () => {
    const { client, sent } = setup([json(note)]);
    const result = await client.notes.create(params, { idempotencyKey: "first-dollar:user_123" });
    expect(result).toEqual(note);
    expect(sent[0]!.method).toBe("POST");
    expect(sent[0]!.url.toString()).toBe("https://app.notecardhq.com/api/v1/notes");
    expect(sent[0]!.headers.authorization).toBe(`Bearer ${KEY}`);
    expect(sent[0]!.headers["content-type"]).toBe("application/json");
    expect(sent[0]!.headers["idempotency-key"]).toBe("first-dollar:user_123");
    expect(sent[0]!.headers["user-agent"]).toMatch(/^notecardhq-node\//);
    expect(sent[0]!.body).toEqual(params);
  });

  it("sends no Idempotency-Key when none is given", async () => {
    const { client, sent } = setup([json(note)]);
    await client.notes.create(params);
    expect(sent[0]!.headers["idempotency-key"]).toBeUndefined();
  });

  it("returns a 202 (note written from context) like a 200", async () => {
    const { client } = setup([json({ ...note, status: "drafting" }, 202)]);
    expect((await client.notes.create({ recipient: params.recipient, context: { source: "x" } }, { idempotencyKey: "k" })).status).toBe("drafting");
  });

  it("retries a 5xx with the same Idempotency-Key and body", async () => {
    const { client, sent } = setup([json({ error: "Unable to create the note." }, 503, { "Retry-After": "0" }), json(note)], { maxRetries: 2 });
    expect(await client.notes.create(params, { idempotencyKey: "k1" })).toEqual(note);
    expect(sent).toHaveLength(2);
    expect(sent[1]!.headers["idempotency-key"]).toBe("k1");
    expect(sent[1]!.body).toEqual(sent[0]!.body);
  });

  it("never retries a create without an Idempotency-Key", async () => {
    const { client, sent } = setup([json({ error: "down" }, 503), json(note)], { maxRetries: 2 });
    await expect(client.notes.create(params)).rejects.toBeInstanceOf(APIError);
    expect(sent).toHaveLength(1);
  });
});

describe("reads", () => {
  it("notes.get encodes the id", async () => {
    const { client, sent } = setup([json(note)]);
    expect(await client.notes.get("n/1")).toEqual(note);
    expect(sent[0]!.method).toBe("GET");
    expect(sent[0]!.url.pathname).toBe("/api/v1/notes/n%2F1");
    expect(sent[0]!.body).toBeUndefined();
  });

  it("notes.get refuses an empty id", () => {
    const { client } = setup([]);
    expect(() => client.notes.get("")).toThrow(/note id is required/);
  });

  it("notes.listRecent passes limit, updatedSince (Date or string) and cursor", async () => {
    const page = { notes: [{ ...note, updatedAt: 1 }], nextCursor: "c2" };
    const { client, sent } = setup([json(page), json(page)]);
    expect(await client.notes.listRecent({ limit: 50, updatedSince: new Date("2026-10-26T15:00:00Z"), cursor: "c1" })).toEqual(page);
    expect(Object.fromEntries(sent[0]!.url.searchParams)).toEqual({ limit: "50", updatedSince: "2026-10-26T15:00:00.000Z", cursor: "c1" });
    expect(sent[0]!.url.pathname).toBe("/api/v1/notes/recent");
    await client.notes.listRecent({ updatedSince: "2026-10-26T15:00:00Z" });
    expect(sent[1]!.url.search).toBe("?updatedSince=2026-10-26T15%3A00%3A00Z");
  });

  it("notes.listRecent sends no query by default", async () => {
    const { client, sent } = setup([json({ notes: [], nextCursor: null })]);
    await client.notes.listRecent();
    expect(sent[0]!.url.search).toBe("");
  });

  it("notes.iterateRecent follows nextCursor to the last page", async () => {
    const { client, sent } = setup([
      json({ notes: [{ id: "a" }, { id: "b" }], nextCursor: "c1" }),
      json({ notes: [{ id: "c" }], nextCursor: null }),
    ]);
    const ids: string[] = [];
    for await (const n of client.notes.iterateRecent({ limit: 2 })) ids.push(n.id);
    expect(ids).toEqual(["a", "b", "c"]);
    expect(sent.map((s) => s.url.searchParams.get("cursor"))).toEqual([null, "c1"]);
    expect(sent.every((s) => s.url.searchParams.get("limit") === "2")).toBe(true);
  });

  it("notes.proof returns the SVG text", async () => {
    const svg = '<svg xmlns="http://www.w3.org/2000/svg"></svg>';
    const { client, sent } = setup([new Response(svg, { headers: { "Content-Type": "image/svg+xml" } })]);
    expect(await client.notes.proof("n_1")).toBe(svg);
    expect(sent[0]!.url.pathname).toBe("/api/v1/notes/n_1/proof");
  });

  it("notes.proof surfaces the 404 for a test note", async () => {
    const { client } = setup([json({ error: "Test notes are never written, so they have no proof." }, 404)]);
    await expect(client.notes.proof("n_1")).rejects.toMatchObject({ status: 404, code: "not_found", message: /never written/ });
  });

  it("holdout.report passes from and to", async () => {
    const report = { from: "2026-01-01", to: "2026-10-31", totals: { card: 3, holdout: 1 }, months: [] };
    const { client, sent } = setup([json(report), json(report)]);
    expect(await client.holdout.report({ from: "2026-01-01", to: "2026-10-31" })).toEqual(report);
    expect(sent[0]!.url.pathname).toBe("/api/v1/holdout");
    expect(Object.fromEntries(sent[0]!.url.searchParams)).toEqual({ from: "2026-01-01", to: "2026-10-31" });
    await client.holdout.report();
    expect(sent[1]!.url.search).toBe("");
  });

  it("describe reads GET /notes", async () => {
    const summary = { name: "notecardHQ notes API", version: 1, docs: "https://app.notecardhq.com/docs", endpoints: {} };
    const { client, sent } = setup([json(summary)]);
    expect(await client.describe()).toEqual(summary);
    expect(sent[0]!.method).toBe("GET");
    expect(sent[0]!.url.pathname).toBe("/api/v1/notes");
  });

  it("retries a GET after a network error and a 429", async () => {
    const { client, sent } = setup([new TypeError("fetch failed"), json({ error: "slow down" }, 429, { "Retry-After": "0" }), json(note)], {
      maxRetries: 2,
    });
    expect(await client.notes.get("n_1")).toEqual(note);
    expect(sent).toHaveLength(3);
  });

  it("gives up after maxRetries", async () => {
    const { client, sent } = setup(
      [json({ error: "a" }, 500, { "Retry-After": "0" }), json({ error: "b" }, 502, { "Retry-After": "0" }), json({ error: "c" }, 503)],
      { maxRetries: 2 },
    );
    await expect(client.notes.get("n_1")).rejects.toMatchObject({ status: 503, message: "c" });
    expect(sent).toHaveLength(3);
  });
});

describe("redactions.create", () => {
  it("POSTs the ids and returns the counts", async () => {
    const counts = { matched: 3, redacted: 2, cancelled: 1, alreadyRedacted: 0, pendingMailing: 1, notFound: 0 };
    const { client, sent } = setup([json(counts)]);
    const body = { noteIds: ["n_1", "n_2"], idempotencyKeys: ["k1"], externalId: "user_123" };
    expect(await client.redactions.create(body)).toEqual(counts);
    expect(sent[0]!.method).toBe("POST");
    expect(sent[0]!.url.pathname).toBe("/api/v1/redactions");
    expect(sent[0]!.body).toEqual(body);
    expect(sent[0]!.headers["idempotency-key"]).toBeUndefined();
  });

  it("is retried (the server says it is safe to repeat)", async () => {
    const { client, sent } = setup([json({ error: "x" }, 503, { "Retry-After": "0" }), json({ matched: 0 })], { maxRetries: 1 });
    await client.redactions.create({ externalId: "u" });
    expect(sent).toHaveLength(2);
  });
});

describe("errors", () => {
  const cases: Array<[number, Function, string]> = [
    [400, InvalidRequestError, "invalid_request"],
    [401, AuthenticationError, "authentication_failed"],
    [404, NotFoundError, "not_found"],
    [409, IdempotencyConflictError, "idempotency_conflict"],
    [413, InvalidRequestError, "request_too_large"],
    [415, InvalidRequestError, "unsupported_media_type"],
    [422, InvalidRequestError, "validation_failed"],
    [429, RateLimitError, "rate_limited"],
    [500, APIError, "server_error"],
    [503, APIError, "server_error"],
    [418, APIError, "http_error"],
  ];
  for (const [status, type, code] of cases)
    it(`${status} throws ${type.name} with status, code and body`, async () => {
      const body = { error: `problem ${status}` };
      const { client } = setup([json(body, status)]);
      const error = await client.notes.create(params, { idempotencyKey: "k" }).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(type);
      expect(error).toBeInstanceOf(NotecardHQError);
      expect(error).toMatchObject({ status, code, body, message: `problem ${status}`, name: type.name });
    });

  it("keeps a code the server sends", async () => {
    const { client } = setup([json({ error: "nope", code: "custom_code" }, 422)]);
    await expect(client.notes.get("n")).rejects.toMatchObject({ code: "custom_code" });
  });

  it("handles a non-JSON error body", async () => {
    const { client } = setup([new Response("Bad Gateway", { status: 502 })]);
    await expect(client.notes.get("n")).rejects.toMatchObject({ status: 502, body: "Bad Gateway", message: "Bad Gateway" });
  });

  it("handles an empty error body", async () => {
    const { client } = setup([new Response(null, { status: 500 })]);
    await expect(client.notes.get("n")).rejects.toMatchObject({ status: 500, body: undefined, message: "HTTP 500" });
  });

  it("a network failure is an APIConnectionError with no status", async () => {
    const cause = new TypeError("fetch failed");
    const { client } = setup([cause]);
    const error = await client.notes.get("n").catch((e: unknown) => e);
    expect(error).toBeInstanceOf(APIConnectionError);
    expect(error).toMatchObject({ status: undefined, code: "connection_error", cause });
  });

  it("a timeout is an APIConnectionError with code timeout", async () => {
    const fetch = vi.fn(
      (_: unknown, init?: RequestInit) =>
        new Promise<Response>((_, reject) => init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")))),
    );
    const client = new NotecardHQ({ apiKey: KEY, fetch: fetch as typeof globalThis.fetch, maxRetries: 0, timeoutMs: 10 });
    await expect(client.notes.get("n")).rejects.toMatchObject({ name: "APIConnectionError", code: "timeout" });
  });

  it("a caller's abort is rethrown as is, never retried", async () => {
    const fetch = vi.fn(
      (_: unknown, init?: RequestInit) =>
        new Promise<Response>((_, reject) => init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")))),
    );
    const client = new NotecardHQ({ apiKey: KEY, fetch: fetch as typeof globalThis.fetch, maxRetries: 3 });
    const controller = new AbortController();
    const pending = client.notes.get("n", { signal: controller.signal });
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});
