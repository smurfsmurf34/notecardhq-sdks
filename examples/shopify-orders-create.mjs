// Shopify: mail a handwritten thank-you card for every new order (orders/create webhook).
// npm install notecardhq express
import { createHmac, timingSafeEqual } from "node:crypto";
import express from "express";
import { NotecardHQ } from "notecardhq";

const notecard = new NotecardHQ({ apiKey: process.env.NOTECARDHQ_API_KEY }); // mos_test_... in development
const app = express();

const fromShopify = (req) => {
  const expected = createHmac("sha256", process.env.SHOPIFY_API_SECRET).update(req.body).digest();
  const given = Buffer.from(req.get("x-shopify-hmac-sha256") ?? "", "base64");
  return given.length === expected.length && timingSafeEqual(given, expected);
};

app.post("/webhooks/shopify/orders-create", express.raw({ type: "application/json" }), async (req, res) => {
  if (!fromShopify(req)) return res.sendStatus(401);
  const order = JSON.parse(req.body.toString("utf8"));
  const s = order.shipping_address ?? order.billing_address;
  if (!s?.address1) return res.sendStatus(200); // digital order: nothing to mail
  await notecard.notes.create(
    {
      recipient: { firstName: s.first_name || "Friend", lastName: s.last_name ?? "", businessName: s.company ?? "", address1: s.address1, address2: s.address2 ?? "", city: s.city, state: s.province_code ?? "", postalCode: s.zip ?? "", country: s.country_code },
      content: `Hi ${s.first_name || "there"}, thank you for your order ${order.name}! It means a lot to our small team.`,
      externalId: String(order.customer?.id ?? order.id),
      context: { source: "shopify", order: order.name },
    },
    { idempotencyKey: `shopify-order:${order.id}` }, // Shopify retries; this never mails twice
  );
  res.sendStatus(200);
});

app.listen(3000);
