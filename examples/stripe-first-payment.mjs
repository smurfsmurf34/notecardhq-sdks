// Stripe: mail a handwritten thank-you card on a customer's first payment.
// npm install notecardhq stripe express
import express from "express";
import Stripe from "stripe";
import { NotecardHQ } from "notecardhq";

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
const notecard = new NotecardHQ({ apiKey: process.env.NOTECARDHQ_API_KEY }); // mos_test_... in development
const app = express();

app.post("/webhooks/stripe", express.raw({ type: "application/json" }), async (req, res) => {
  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, req.get("stripe-signature"), process.env.STRIPE_WEBHOOK_SECRET);
  } catch {
    return res.sendStatus(400);
  }
  const invoice = event.data.object;
  // invoice.paid with billing_reason subscription_create = the first payment of a subscription.
  if (event.type !== "invoice.paid" || invoice.billing_reason !== "subscription_create") return res.sendStatus(200);
  const a = invoice.customer_shipping?.address ?? invoice.customer_address;
  const name = invoice.customer_shipping?.name ?? invoice.customer_name ?? "";
  if (!a?.line1) return res.sendStatus(200); // no mailing address collected
  const [firstName, ...rest] = name.trim().split(/\s+/);
  await notecard.notes.create(
    {
      recipient: { firstName: firstName || "Friend", lastName: rest.join(" "), address1: a.line1, address2: a.line2 ?? "", city: a.city, state: a.state ?? "", postalCode: a.postal_code ?? "", country: a.country },
      content: `Hi ${firstName || "there"}, thank you for becoming a customer! We are so glad you are here.`,
      externalId: String(invoice.customer),
    },
    { idempotencyKey: `stripe-first-payment:${invoice.customer}` }, // Stripe retries; this never mails twice
  );
  res.sendStatus(200);
});

app.listen(3000);
