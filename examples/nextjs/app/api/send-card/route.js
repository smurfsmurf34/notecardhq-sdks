// Next.js App Router: POST /api/send-card mails a handwritten card.
// npm install notecardhq. Server-only: the API key never reaches the browser.
import { NotecardHQ, InvalidRequestError } from "notecardhq";

const notecard = new NotecardHQ({ apiKey: process.env.NOTECARDHQ_API_KEY }); // mos_test_... in development

export async function POST(request) {
  // Authenticate your own user here before mailing anything on their behalf.
  // sendId: made once per send in the browser (crypto.randomUUID()), so a retried request never mails twice.
  const { userId, sendId, recipient, message } = await request.json();
  if (!sendId) return Response.json({ error: "sendId is required" }, { status: 400 });
  try {
    const note = await notecard.notes.create(
      { recipient, content: message, externalId: userId },
      { idempotencyKey: `send-card:${userId}:${sendId}` },
    );
    return Response.json({ id: note.id, status: note.status });
  } catch (e) {
    // 422: undeliverable US address or unwritable character; nothing was created.
    if (e instanceof InvalidRequestError) return Response.json({ error: e.message }, { status: e.status });
    throw e;
  }
}

// GET /api/send-card?id=...: the card's status (created, card_printed, card_dispatched, cancelled).
export async function GET(request) {
  const id = new URL(request.url).searchParams.get("id");
  if (!id) return Response.json({ error: "id is required" }, { status: 400 });
  const note = await notecard.notes.get(id);
  return Response.json({ id: note.id, status: note.status, sentAt: note.sentAt });
}
