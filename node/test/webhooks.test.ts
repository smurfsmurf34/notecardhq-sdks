import { existsSync, readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  NotecardHQ,
  SIGNATURE_HEADER,
  WebhookVerificationError,
  signWebhookPayload,
  verifyWebhook,
  verifyWebhookSignature,
} from "../src/index.js";
import { VECTOR_INPUTS } from "./vector-inputs.js";

// The server's own signing code (what notecardHQ uses to sign every delivery)
// exists only inside the notecardHQ app repository. In the public SDK repo
// these cross-checks are skipped and the server-made vectors in
// python/tests/fixtures/webhook_vectors.json stand in for them.
const SERVER_SIGNER = new URL("../../../lib/webhooks.ts", import.meta.url);
const server: { SIGNATURE_HEADER: string; signatureHeader: (secret: string, t: number, body: string) => Promise<string> } | null =
  existsSync(SERVER_SIGNER) ? await import(/* @vite-ignore */ SERVER_SIGNER.href) : null;
const signatureHeader = server?.signatureHeader ?? ((s: string, t: number, b: string) => signWebhookPayload(b, s, t));
const fixture = JSON.parse(readFileSync(new URL("../../python/tests/fixtures/webhook_vectors.json", import.meta.url), "utf8"));

const secret = "whsec_" + "ab".repeat(24);
const now = 1792900000;
const body = JSON.stringify({
  id: "evt_1",
  type: "note.card_dispatched",
  created: now,
  test: false,
  data: { id: "n_1", status: "card_dispatched", content: "Merci, Zoë!" },
});

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(now * 1000);
});
afterEach(() => vi.useRealTimers());

describe("verifyWebhook against the server's signer", () => {
  it("verifies every server-made vector in the fixture", async () => {
    expect(fixture.vectors.length).toBeGreaterThan(0);
    for (const v of fixture.vectors) {
      vi.setSystemTime(v.t * 1000);
      expect(await verifyWebhookSignature(v.body, v.header, v.secret)).toBe(true);
    }
  });

  it.skipIf(!server)("uses the server's header name", () => {
    expect(SIGNATURE_HEADER).toBe(server!.SIGNATURE_HEADER);
  });

  it.skipIf(!server)("accepts a signature made by lib/webhooks.ts (string, Buffer and Uint8Array bodies)", async () => {
    const header = await signatureHeader(secret, now, body);
    expect((await verifyWebhook(body, header, secret)).type).toBe("note.card_dispatched");
    expect((await verifyWebhook(Buffer.from(body), header, secret)).data.id).toBe("n_1");
    expect(await verifyWebhookSignature(new TextEncoder().encode(body), header, secret)).toBe(true);
  });

  it.skipIf(!server)("signs exactly as the server does", async () => {
    for (const v of VECTOR_INPUTS) expect(await signWebhookPayload(v.body, v.secret, v.t)).toBe(await signatureHeader(v.secret, v.t, v.body));
  });

  it.skipIf(!server)("the Python fixture still matches the server", async () => {
    expect(fixture.vectors).toHaveLength(VECTOR_INPUTS.length);
    for (const [i, v] of VECTOR_INPUTS.entries())
      expect(fixture.vectors[i]).toEqual({ ...v, header: await signatureHeader(v.secret, v.t, v.body) });
  });

  it("accepts a timestamp within the tolerance", async () => {
    const header = await signatureHeader(secret, now - 299, body);
    expect(await verifyWebhookSignature(body, header, secret)).toBe(true);
  });
});

describe("verifyWebhook rejects", () => {
  const rejects = async (payload: string, header: string | null | undefined, key = secret, tolerance?: number) => {
    await expect(verifyWebhook(payload, header, key, { toleranceSeconds: tolerance })).rejects.toBeInstanceOf(WebhookVerificationError);
    expect(await verifyWebhookSignature(payload, header, key, { toleranceSeconds: tolerance })).toBe(false);
  };

  it("a wrong secret", async () => rejects(body, await signatureHeader(secret, now, body), "whsec_other"));
  it("a tampered body", async () => rejects(body.replace("n_1", "n_2"), await signatureHeader(secret, now, body)));
  it("a tampered signature", async () => {
    const header = await signatureHeader(secret, now, body);
    await rejects(body, header.slice(0, -1) + (header.endsWith("0") ? "1" : "0"));
  });
  it("an expired timestamp (older than five minutes)", async () => rejects(body, await signatureHeader(secret, now - 301, body)));
  it("a timestamp far in the future", async () => rejects(body, await signatureHeader(secret, now + 301, body)));
  it("a timestamp outside a custom tolerance", async () => rejects(body, await signatureHeader(secret, now - 61, body), secret, 60));
  it("a missing header", async () => {
    await rejects(body, undefined);
    await rejects(body, null);
    await rejects(body, "");
  });
  it("a malformed header", async () => {
    await rejects(body, "garbage");
    await rejects(body, `t=${now}`);
    await rejects(body, "v1=abcd");
    await rejects(body, `t=abc,v1=${"0".repeat(64)}`);
  });
  it("an empty secret", async () => rejects(body, await signatureHeader(secret, now, body), ""));
  it("a valid signature over a non-JSON body (verifyWebhook only)", async () => {
    const header = await signatureHeader(secret, now, "not json");
    await expect(verifyWebhook("not json", header, secret)).rejects.toThrow("not JSON");
    expect(await verifyWebhookSignature("not json", header, secret)).toBe(true);
  });
});

it("accepts any of several v1 signatures (secret rotation)", async () => {
  const good = (await signatureHeader(secret, now, body)).split("v1=")[1];
  expect(await verifyWebhookSignature(body, `t=${now},v1=${"0".repeat(64)},v1=${good}`, secret)).toBe(true);
});

it("is reachable from the client as notecard.webhooks", async () => {
  const notecard = new NotecardHQ({ apiKey: "mos_test_x", fetch: vi.fn() });
  const header = await signatureHeader(secret, now, body);
  expect((await notecard.webhooks.verify(body, header, secret)).id).toBe("evt_1");
  expect(await notecard.webhooks.verifySignature(body, "t=1,v1=00", secret)).toBe(false);
});
