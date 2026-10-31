# notecardhq

The official Node.js and TypeScript SDK for the [notecardHQ](https://notecardhq.com) handwritten notes API. Send a real handwritten card from code: a robot writes it with a real pen, then it is stamped and mailed.

- Zero runtime dependencies. Node 18+, Bun, Deno and edge runtimes (anything with `fetch`).
- ESM and CommonJS, with TypeScript types.
- Typed errors, safe retries with idempotency keys, and a webhook signature verifier.

## Install

```sh
npm install notecardhq
```

## Send a card

```ts
import { NotecardHQ } from "notecardhq";

const notecard = new NotecardHQ({ apiKey: process.env.NOTECARDHQ_API_KEY! });

const note = await notecard.notes.create(
  {
    recipient: { firstName: "Brandy", lastName: "Lee", address1: "123 Main St", city: "Austin", state: "TX", postalCode: "78701", country: "US" },
    content: "Hi Brandy, congrats on your first sale! Cheering you on from Austin.",
    externalId: "user_123",
  },
  { idempotencyKey: "first-sale:user_123" },
);
console.log(note.id, note.status); // "created": queued for the robots
```

`content` is written on the card exactly as sent: 1 to 500 characters, greeting and sign-off included. US addresses are verified; an undeliverable one is refused with a 422 and nothing is created.

CommonJS works too: `const { NotecardHQ } = require("notecardhq");`

## Test keys never mail a card

Create keys under Integrations in your notecardHQ portal. A live key looks like `mos_...`; a test key looks like `mos_test_...`.

A test key runs exactly the same validation as a live key (address verification included) and returns the same errors, but the note is never written, mailed or billed. It comes back with `"test": true` and moves through `created`, `card_printed` and `card_dispatched` a minute apart, firing the same webhooks. Use the test key in development and CI.

```ts
const notecard = new NotecardHQ({ apiKey: process.env.NOTECARDHQ_TEST_KEY! });
notecard.isTest; // true
```

With a live key, every accepted `notes.create` mails a real card, so never use it as a connectivity check.

## Idempotency

Pass one stable `idempotencyKey` per event, such as `first-sale:${userId}`. Repeating the same key and body returns the same note instead of mailing a second card; the same key with a different body throws `IdempotencyConflictError` (409). Standard workspaces require the key.

The client retries network errors, 429 and 5xx (twice by default, `maxRetries`) only when that is safe: reads, redactions, and `notes.create` calls that carry an `idempotencyKey`.

## Reading notes

```ts
const note = await notecard.notes.get("k57abc123");
note.status; // "created" | "card_printed" | "card_dispatched" | "cancelled" | ...

// Poll for status changes, newest first:
const page = await notecard.notes.listRecent({ updatedSince: new Date(Date.now() - 86_400_000), limit: 100 });
for await (const n of notecard.notes.iterateRecent({ limit: 100 })) console.log(n.id, n.status, n.updatedAt);
```

| Method | Endpoint |
| --- | --- |
| `notes.create(params, { idempotencyKey })` | `POST /notes` |
| `notes.get(id)` | `GET /notes/{id}` |
| `notes.listRecent({ limit, updatedSince, cursor })` | `GET /notes/recent` |
| `notes.iterateRecent(params)` | `GET /notes/recent`, every page |
| `notes.proof(id)` | `GET /notes/{id}/proof` (SVG; workspaces with proof images) |
| `redactions.create({ noteIds, idempotencyKeys, externalId })` | `POST /redactions` (workspaces with retention on) |
| `holdout.report({ from, to })` | `GET /holdout` |
| `describe()` | `GET /notes` (machine-readable API summary) |

There is no cancel endpoint: cancel a note before it is written under Activity in the portal.

## Webhooks

Add an HTTPS endpoint under Integrations and notecardHQ POSTs every status change: `note.created`, `note.needs_review`, `note.card_printed`, `note.card_dispatched`, `note.cancelled` (plus `note.rendered`, `note.scheduled`, `note.released` and `note.redacted` where those features are on). Each request carries a `notecardHQ-Signature: t=<unix seconds>,v1=<hex HMAC-SHA256>` header signed with your webhook secret (`whsec_...`).

Verify it against the raw body:

```ts
import { verifyWebhook, SIGNATURE_HEADER } from "notecardhq";

// Next.js App Router: app/api/webhooks/notecardhq/route.ts
export async function POST(request: Request) {
  const raw = await request.text();
  try {
    const event = await verifyWebhook(raw, request.headers.get(SIGNATURE_HEADER), process.env.NOTECARDHQ_WEBHOOK_SECRET!);
    // event.id is unique: skip repeats. event.test is true for test-key notes.
    console.log(event.type, event.data.id, event.data.status);
    return new Response("ok");
  } catch {
    return new Response("bad signature", { status: 400 });
  }
}
```

`verifyWebhook` throws `WebhookVerificationError` for a missing, malformed or wrong signature, or one older than five minutes (`toleranceSeconds`). `verifyWebhookSignature` returns a boolean instead. With Express, read the body with `express.raw({ type: "application/json" })` and pass the Buffer. Answer 2xx within 10 seconds; failures are retried for about two days, and order is not guaranteed.

## Errors

Every failed request throws a `NotecardHQError` with `status`, `code`, `body` and the API's own `message`:

| Class | Status | `code` |
| --- | --- | --- |
| `InvalidRequestError` | 400, 413, 415, 422 | `invalid_request`, `request_too_large`, `unsupported_media_type`, `validation_failed` |
| `AuthenticationError` | 401 | `authentication_failed` |
| `NotFoundError` | 404 | `not_found` |
| `IdempotencyConflictError` | 409 | `idempotency_conflict` |
| `RateLimitError` | 429 | `rate_limited` |
| `APIError` | 5xx, other | `server_error`, `http_error` |
| `APIConnectionError` | none | `connection_error`, `timeout` |

```ts
import { InvalidRequestError } from "notecardhq";

try {
  await notecard.notes.create(params, { idempotencyKey });
} catch (e) {
  if (e instanceof InvalidRequestError) console.error(e.status, e.message); // e.g. 422 undeliverable address
  else throw e;
}
```

## Options

```ts
new NotecardHQ({
  apiKey: "mos_...",
  baseUrl: "https://app.notecardhq.com/api/v1", // or your workspace's host, as shown in your docs
  maxRetries: 2,
  timeoutMs: 30_000,
  fetch: customFetch,
});
```

## Links

- Developers: https://notecardhq.com/developers
- API reference: https://app.notecardhq.com/docs
- OpenAPI: https://app.notecardhq.com/api/v1/openapi.json

MIT licensed.
