import { WebhookVerificationError } from "./errors.js";
import type { WebhookEvent } from "./types.js";

/** The header carrying the signature: `t=<unix seconds>,v1=<hex HMAC-SHA256>`. */
export const SIGNATURE_HEADER = "notecardHQ-Signature";
/** The header carrying the event id (also in the body as `id`). */
export const EVENT_ID_HEADER = "notecardHQ-Event-Id";
/** Events older (or newer) than this many seconds are refused by default. */
export const DEFAULT_TOLERANCE_SECONDS = 300;

export interface VerifyWebhookOptions {
  /** Maximum age of the signature in seconds. Default 300 (five minutes). */
  toleranceSeconds?: number;
}

type Payload = string | Uint8Array | ArrayBuffer;

const encoder = new TextEncoder();

async function subtle(): Promise<SubtleCrypto> {
  if (globalThis.crypto?.subtle) return globalThis.crypto.subtle;
  // Node 18 has Web Crypto, but not on globalThis by default.
  const nodeCrypto = await import("node:crypto");
  return nodeCrypto.webcrypto.subtle as SubtleCrypto;
}

function bytesOf(payload: Payload): Uint8Array {
  if (typeof payload === "string") return encoder.encode(payload);
  return payload instanceof Uint8Array ? payload : new Uint8Array(payload);
}

function hex(buffer: ArrayBuffer): string {
  return Array.from(new Uint8Array(buffer), (b) => b.toString(16).padStart(2, "0")).join("");
}

function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function parseHeader(header: string): { t: number; v1: string[] } | null {
  let t = NaN;
  const v1: string[] = [];
  for (const part of header.split(",")) {
    const i = part.indexOf("=");
    if (i < 0) continue;
    const key = part.slice(0, i).trim();
    const value = part.slice(i + 1).trim();
    if (key === "t") t = /^\d+$/.test(value) ? Number(value) : NaN;
    else if (key === "v1") v1.push(value.toLowerCase());
  }
  return Number.isSafeInteger(t) && v1.length ? { t, v1 } : null;
}

/** `t=<t>,v1=<hex HMAC-SHA256 of "<t>.<payload>">`: the header the server sends. Useful in your own tests. */
export async function signWebhookPayload(payload: Payload, secret: string, timestamp = Math.floor(Date.now() / 1000)): Promise<string> {
  const s = await subtle();
  const key = await s.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const body = bytesOf(payload);
  const prefix = encoder.encode(`${timestamp}.`);
  const message = new Uint8Array(prefix.length + body.length);
  message.set(prefix);
  message.set(body, prefix.length);
  return `t=${timestamp},v1=${hex(await s.sign("HMAC", key, message))}`;
}

async function check(payload: Payload, header: string | null | undefined, secret: string, options: VerifyWebhookOptions) {
  if (!secret) throw new WebhookVerificationError("No webhook secret given.");
  if (!header) throw new WebhookVerificationError(`Missing ${SIGNATURE_HEADER} header.`);
  const parsed = parseHeader(header);
  if (!parsed) throw new WebhookVerificationError(`Malformed ${SIGNATURE_HEADER} header.`);
  const tolerance = options.toleranceSeconds ?? DEFAULT_TOLERANCE_SECONDS;
  if (Math.abs(Date.now() / 1000 - parsed.t) > tolerance)
    throw new WebhookVerificationError("Signature timestamp is outside the tolerance.");
  const expected = (await signWebhookPayload(payload, secret, parsed.t)).split("v1=")[1]!;
  if (!parsed.v1.some((v) => safeEqual(v, expected))) throw new WebhookVerificationError("Signature does not match.");
}

/**
 * Verifies a webhook and returns its event. Throws WebhookVerificationError
 * when the signature is missing, malformed, wrong, or older than the tolerance.
 *
 * `payload` must be the raw request body exactly as received (a string, Buffer
 * or Uint8Array), not JSON that was parsed and serialized again.
 */
export async function verifyWebhook(
  payload: Payload,
  header: string | null | undefined,
  secret: string,
  options: VerifyWebhookOptions = {},
): Promise<WebhookEvent> {
  await check(payload, header, secret, options);
  const text = typeof payload === "string" ? payload : new TextDecoder().decode(bytesOf(payload));
  try {
    return JSON.parse(text) as WebhookEvent;
  } catch {
    throw new WebhookVerificationError("Payload is not JSON.");
  }
}

/** True when the signature is valid and recent; false otherwise. Does not parse the payload. */
export async function verifyWebhookSignature(
  payload: Payload,
  header: string | null | undefined,
  secret: string,
  options: VerifyWebhookOptions = {},
): Promise<boolean> {
  try {
    await check(payload, header, secret, options);
    return true;
  } catch (e) {
    if (e instanceof WebhookVerificationError) return false;
    throw e;
  }
}
