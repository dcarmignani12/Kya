// Integration tests against the real Postgres database and real Ed25519 keys
// (run `npm run setup` first). No LLM involved: these drive the same server
// functions the agent's tools call.
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { AGENT_ID, MANDATE, makeOfferId, resolveOffer } from "../src/lib/domain";
import { runAttackSuite } from "../src/server/attacks.server";
import { db } from "../src/server/db.server";
import { EnforcementError, decideApproval, setAgentStatus, signPaymentIntent, verifyPaymentIntent } from "../src/server/kya.server";
import { verifyChain } from "../src/server/ledger.server";
import { authorizePayment, confirmBooking } from "../src/server/merchant.server";

const base = { mandateId: MANDATE.mandate_id, principalId: MANDATE.principal_id };
const offer = (id: string) => resolveOffer(makeOfferId(id, MANDATE.check_in, MANDATE.check_out))!;

after(async () => {
  await setAgentStatus(AGENT_ID, "active", "test teardown");
  await db().end();
});

test("compliant offer: ALLOW → payment → booking, assertion is single-use", async () => {
  await setAgentStatus(AGENT_ID, "active", "test setup");
  const d = await verifyPaymentIntent(signPaymentIntent(offer("brera-lumen"), base).jws);
  assert.equal(d.decision, "ALLOW", d.reason);
  assert.ok(d.assertion_id && d.assertion);
  assert.ok(d.checks.every((c) => c.status === "pass"));

  const pay = await authorizePayment(d.assertion_id!, offer("brera-lumen").offer_id);
  assert.equal(pay.amount_cents, 58000);
  const booking = await confirmBooking(pay.payment_id);
  assert.equal(booking.status, "confirmed");
  assert.match(String(booking.confirmation_code), /^MIL-/);

  await assert.rejects(authorizePayment(d.assertion_id!), (e: unknown) => e instanceof EnforcementError && e.code === "assertion_spent");
});

test("model-passed offer id that differs from the assertion is blocked", async () => {
  const d = await verifyPaymentIntent(signPaymentIntent(offer("navigli-canal-house"), base).jws);
  assert.equal(d.decision, "ALLOW");
  await assert.rejects(authorizePayment(d.assertion_id!, offer("duomo-grand-palazzo").offer_id), (e: unknown) => e instanceof EnforcementError && e.code === "offer_mismatch");
});

test("€750 offer requires step-up; approval is bound and consumed once", async () => {
  const duomo = offer("duomo-grand-palazzo");
  const first = await verifyPaymentIntent(signPaymentIntent(duomo, base).jws);
  assert.equal(first.decision, "STEP_UP_APPROVAL");
  assert.ok(first.approval_id);
  assert.equal(first.assertion, undefined);

  const stillPending = await verifyPaymentIntent(signPaymentIntent(duomo, { ...base, approvalId: first.approval_id }).jws);
  assert.equal(stillPending.decision, "STEP_UP_APPROVAL");

  // An approval for Duomo cannot be used for another offer
  const wrongOffer = await verifyPaymentIntent(signPaymentIntent(offer("brera-lumen"), { ...base, approvalId: first.approval_id }).jws);
  assert.equal(wrongOffer.decision, "ALLOW"); // under the autonomous limit: approval irrelevant, not consumed

  await decideApproval(first.approval_id!, "approved");
  const approved = await verifyPaymentIntent(signPaymentIntent(duomo, { ...base, approvalId: first.approval_id }).jws);
  assert.equal(approved.decision, "ALLOW", approved.reason);
  assert.equal(approved.approval_id, first.approval_id);

  const reused = await verifyPaymentIntent(signPaymentIntent(duomo, { ...base, approvalId: first.approval_id }).jws);
  assert.equal(reused.decision, "DENY");
});

test("rejected approval → DENY", async () => {
  const duomo = offer("duomo-grand-palazzo");
  const req = await verifyPaymentIntent(signPaymentIntent(duomo, base).jws);
  assert.equal(req.decision, "STEP_UP_APPROVAL");
  await decideApproval(req.approval_id!, "rejected");
  const after = await verifyPaymentIntent(signPaymentIntent(duomo, { ...base, approvalId: req.approval_id }).jws);
  assert.equal(after.decision, "DENY");
});

test("suspension: new intents denied and previously issued assertions blocked", async () => {
  const d = await verifyPaymentIntent(signPaymentIntent(offer("brera-lumen"), base).jws);
  assert.equal(d.decision, "ALLOW");
  await setAgentStatus(AGENT_ID, "suspended", "test");
  try {
    const denied = await verifyPaymentIntent(signPaymentIntent(offer("brera-lumen"), base).jws);
    assert.equal(denied.decision, "DENY");
    assert.equal(denied.checks.find((c) => c.name === "agent_status")?.status, "fail");
    await assert.rejects(authorizePayment(d.assertion_id!), (e: unknown) => e instanceof EnforcementError && e.code === "agent_inactive");
  } finally {
    await setAgentStatus(AGENT_ID, "active", "test");
  }
});

test("attack suite: every forged/tampered/stale/replayed/out-of-mandate request is stopped", async () => {
  const results = await runAttackSuite();
  for (const r of results) assert.ok(r.pass, `${r.name}: expected ${r.expected}, got ${r.got} (${r.reason})`);
  const byName = Object.fromEntries(results.map((r) => [r.name, r]));
  assert.match(byName.forged_key.reason, /^signature/);
  assert.match(byName.tampered_payload.reason, /^signature/);
  assert.match(byName.amount_mismatch.reason, /^offer_match/);
  assert.match(byName.stale_intent.reason, /^freshness/);
  assert.match(byName.replay.reason, /replay/);
  assert.match(byName.wrong_mandate.reason, /^mandate_binding/);
  assert.match(byName.non_eu_merchant.reason, /CH/);
  assert.match(byName.prohibited_mcc.reason, /7012/);
});

test("ledger is append-only and the hash chain verifies", async () => {
  await assert.rejects(db().query("UPDATE kya_ledger SET actor = 'evil' WHERE seq = (SELECT min(seq) FROM kya_ledger)"), /append-only/);
  await assert.rejects(db().query("DELETE FROM kya_ledger"), /append-only/);
  const chain = await verifyChain();
  assert.ok(chain.ok, chain.error ?? "");
  assert.ok(chain.entries > 0);
  const first = await db().query("SELECT prev_hash FROM kya_ledger ORDER BY seq ASC LIMIT 1");
  assert.equal(first.rows[0].prev_hash, "GENESIS");
});
