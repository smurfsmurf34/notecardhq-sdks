// Inputs for the cross-language webhook vectors (see scripts/webhook-vectors.ts).
const event = (type: string, extra: Record<string, unknown> = {}) =>
  JSON.stringify({
    id: "evt_0123456789abcdef",
    type,
    created: 1792900000,
    test: false,
    data: {
      id: "k57abc123",
      status: type.slice("note.".length),
      externalId: "user_123",
      recipient: { firstName: "Zoë", lastName: "Åström", address1: "123 MAIN ST", city: "AUSTIN", state: "TX", postalCode: "78701", country: "US" },
      content: "Hi Zoë, congrats on your first dollar!",
      ...extra,
    },
  });

export const VECTOR_INPUTS = [
  { secret: "whsec_" + "0123456789abcdef".repeat(3), t: 1792900000, body: event("note.card_printed") },
  { secret: "whsec_" + "fedcba9876543210".repeat(3), t: 1792900123, body: event("note.card_dispatched", { sentAt: 1792900100000 }) },
  { secret: "whsec_" + "a1b2c3d4e5f60718".repeat(3), t: 1700000000, body: '{"id":"evt_x","type":"note.created","created":1700000000,"test":true,"data":{}}' },
];
