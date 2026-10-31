# notecardHQ SDKs

Client libraries for the [notecardHQ](https://notecardhq.com) handwritten notes API: a robot writes your note with a real pen, then it is stamped and mailed. API reference: https://app.notecardhq.com/docs.

| Package | Folder | Install | Tests |
| --- | --- | --- | --- |
| Node.js / TypeScript | [node](node) | `npm install notecardhq` | `cd node && npm install && npm test` |
| Python | [python](python) | `pip install notecardhq` | `cd python && pip install -e '.[dev]' && pytest` |

[examples](examples): send a card from a Stripe first payment, a Shopify order, or a Next.js route.

Get a free test key at https://app.notecardhq.com/signup. Test notes run every check a live note does, but nothing is written, mailed or billed.

## Webhook signatures

`python/tests/fixtures/webhook_vectors.json` holds signature headers made by notecardHQ's own server signer. Both test suites verify them, so the SDKs stay in step with what the server sends.

## Development

These SDKs are developed inside the notecardHQ app repository and mirrored here; there, the Node suite also cross-checks against the server's signer directly and `node node/scripts/webhook-vectors.mjs` regenerates the vectors. Issues and pull requests are welcome here.

MIT licensed, © 2026 Canary Canary LLC.
