// Writes sdks/python/tests/fixtures/webhook_vectors.json: signature headers
// made by the server's own signing code (lib/webhooks.ts signatureHeader).
// test/webhooks.test.ts checks the file still matches the server.
// Regenerate with: node scripts/webhook-vectors.mjs (Node 22.6+)
// Runs only inside the notecardHQ app repository, where the server's signer lives.
import { existsSync, writeFileSync } from "node:fs";
const SERVER_SIGNER = new URL("../../../lib/webhooks.ts", import.meta.url);
if (!existsSync(SERVER_SIGNER)) {
  console.error("lib/webhooks.ts not found: regenerate the vectors from the notecardHQ app repository.");
  process.exit(1);
}
const { signatureHeader } = await import(SERVER_SIGNER.href);
import { VECTOR_INPUTS } from "../test/vector-inputs.ts";

const vectors = [];
for (const v of VECTOR_INPUTS) vectors.push({ ...v, header: await signatureHeader(v.secret, v.t, v.body) });
writeFileSync(
  new URL("../../python/tests/fixtures/webhook_vectors.json", import.meta.url),
  JSON.stringify({ source: "lib/webhooks.ts signatureHeader", vectors }, null, 2) + "\n",
);
console.log(`wrote ${vectors.length} vectors`);
