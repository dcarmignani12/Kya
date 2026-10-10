import { generateKeyPairSync } from "node:crypto";
import { MANDATE, resolveOffer, makeOfferId, type PolicyOutcome } from "~/lib/domain";
import { b64url, b64urlDecode, randomId } from "./crypto.server";
import { withLedgerContext } from "./ledger.server";
import { EnforcementError, signPaymentIntent, verifyPaymentIntent } from "./kya.server";
import { authorizePayment } from "./merchant.server";

// Live adversarial checks against the real verifier and gateway. Each case
// builds a genuinely bad request (forged key, tampered bytes, stale or replayed
// nonce, ...) and records what KYA actually decided.

export interface AttackResult {
  name: string;
  description: string;
  expected: PolicyOutcome | "BLOCKED";
  got: string;
  reason: string;
  pass: boolean;
}

const offerFor = (hotelId: string) => resolveOffer(makeOfferId(hotelId, MANDATE.check_in, MANDATE.check_out))!;
const base = { mandateId: MANDATE.mandate_id, principalId: MANDATE.principal_id };

export async function runAttackSuite(): Promise<AttackResult[]> {
  return withLedgerContext({ runId: randomId("atk", 6) }, async () => {
    const results: AttackResult[] = [];
    const expectDecision = async (name: string, description: string, expected: PolicyOutcome, jws: string) => {
      const d = await verifyPaymentIntent(jws);
      results.push({ name, description, expected, got: d.decision, reason: d.reason, pass: d.decision === expected });
      return d;
    };
    const brera = offerFor("brera-lumen");

    const { privateKey: rogueKey } = generateKeyPairSync("ed25519");
    await expectDecision(
      "forged_key",
      "Intent claims to be agt_atlas_001 but is signed with an attacker's key",
      "DENY",
      signPaymentIntent(brera, { ...base, privateKey: rogueKey }).jws,
    );

    await expectDecision(
      "unregistered_agent",
      "Intent from an agent that is not in the KYA registry",
      "DENY",
      signPaymentIntent(brera, { ...base, agentId: "agt_rogue_999", keyId: "agt_rogue_999#key-1", privateKey: rogueKey }).jws,
    );

    {
      const { jws } = signPaymentIntent(brera, base);
      const [h, p, sig] = jws.split(".");
      const claims = JSON.parse(b64urlDecode(p).toString("utf8"));
      claims.offer.amount_cents = 100;
      await expectDecision("tampered_payload", "Valid signature, but the amount was edited after signing", "DENY", `${h}.${b64url(JSON.stringify(claims))}.${sig}`);
    }

    {
      const duomo = offerFor("duomo-grand-palazzo");
      const lowballed = { ...duomo, nightly_cents: 30000, amount_cents: 60000 };
      await expectDecision(
        "amount_mismatch",
        "Agent signs €600 for an offer the merchant quotes at €750 (dodging step-up)",
        "DENY",
        signPaymentIntent(lowballed, base).jws,
      );
    }

    await expectDecision(
      "stale_intent",
      "Correctly signed intent issued 10 minutes ago",
      "DENY",
      signPaymentIntent(brera, { ...base, iat: Math.floor(Date.now() / 1000) - 600 }).jws,
    );

    {
      const { jws } = signPaymentIntent(brera, base);
      await verifyPaymentIntent(jws);
      await expectDecision("replay", "The same signed intent submitted a second time", "DENY", jws);
    }

    await expectDecision(
      "wrong_mandate",
      "Intent cites a mandate the principal never granted",
      "DENY",
      signPaymentIntent(brera, { ...base, mandateId: "mdt_alex_paris_0101" }).jws,
    );

    await expectDecision("over_limit", "€900 suite: over the €400/night and €800 total caps", "DENY", signPaymentIntent(offerFor("porta-nuova-sky"), base).jws);
    await expectDecision("non_eu_merchant", "Merchant of record is in Switzerland", "DENY", signPaymentIntent(offerFor("centrale-transit-inn"), base).jws);
    await expectDecision("prohibited_mcc", "Timeshare merchant (MCC 7012)", "DENY", signPaymentIntent(offerFor("isola-residences"), base).jws);

    {
      const forged = "asr_" + b64url(Buffer.from("forged-assertion"));
      let got = "PAID";
      let reason = "payment went through";
      try {
        await authorizePayment(forged, brera.offer_id);
      } catch (err) {
        got = "BLOCKED";
        reason = err instanceof EnforcementError ? `${err.code}: ${err.message}` : (err as Error).message;
      }
      results.push({ name: "forged_assertion", description: "Payment attempted with an assertion KYA never issued", expected: "BLOCKED", got, reason, pass: got === "BLOCKED" });
    }

    return results;
  });
}
