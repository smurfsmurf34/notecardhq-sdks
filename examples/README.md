# notecardHQ examples

Each one mails a real handwritten card with the [`notecardhq`](../node) SDK. Run them with a test key (`mos_test_...`) first: a test key validates everything a live key does but never writes, mails or bills a card.

| Example | Trigger |
| --- | --- |
| [stripe-first-payment.mjs](stripe-first-payment.mjs) | Stripe `invoice.paid` for a subscription's first payment |
| [shopify-orders-create.mjs](shopify-orders-create.mjs) | Shopify `orders/create` webhook |
| [nextjs/app/api/send-card/route.js](nextjs/app/api/send-card/route.js) | A Next.js App Router route your app calls |

Every example passes an idempotency key derived from the event (`shopify-order:<order id>`, `stripe-first-payment:<customer>`), so a webhook retried by Stripe or Shopify never mails a second card.

Environment: `NOTECARDHQ_API_KEY`, plus `STRIPE_SECRET_KEY` and `STRIPE_WEBHOOK_SECRET`, or `SHOPIFY_API_SECRET`.

Docs: https://app.notecardhq.com/docs
