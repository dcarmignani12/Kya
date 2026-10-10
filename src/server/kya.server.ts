import type { KeyObject } from "node:crypto";
import {
  AGENT_ID,
  AGENT_KEY_ID,
  KYA_ISSUER,
  evaluateMandateLimits,
  resolveOffer,
  type LedgerEntryView,
  type LimitCheck,
  type Mandate,
  type Offer,
  type PolicyOutcome,
} from "~/lib/domain";
import {
  decodeJws,
  privateKeyFromEnvJwk,
  publicJwkOf,
  publicKeyFromJwk,
  randomId,
  sha256Hex,
  signJws,
  verifyJwsSignature,
} from "./crypto.server";
import { db, withTx } from "./db.server";
import { requireEnv } from "./env.server";
import { appendLedger, appendLedgerTx, emitLedger } from "./ledger.server";

// ===========================================================================
// KYA — Know Your Agent.
//
//  * The agent (Atlas) signs payment intents with its Ed25519 private key,
//    held only in the AGENT_PRIVATE_KEY env secret.
//  * The verifier never sees that secret: it resolves the agent's *registered*
//    public key from kya_agents and checks signature, freshness / replay, agent
//    status, the principal-signed delegation credential, mandate binding, the
//    amount against the merchant's own offer, and the mandate's limits.
//  * ALLOW returns an assertion signed by the KYA service key. The payment and
//    booking steps re-verify that assertion server-side before acting.
// ===========================================================================

export const INTENT_AUDIENCE = "kya.agenttrip.demo/verify";
export const ASSERTION_AUDIENCE = "agenttrip.gateway";
export const KYA_KEY_ID = "kya#key-1";
const INTENT_MAX_AGE_S = 60;
const INTENT_MAX_LIFETIME_S = 120;
const CLOCK_SKEW_S = 5;
const ASSERTION_TTL_S = 600;
const APPROVAL_TTL_S = 30 * 60;

const nowS = () => Math.floor(Date.now() / 1000);

// ---------------------------------------------------------------------------
// Types

export interface PaymentIntentClaims {
  iss: string; // agent id
  sub: string; // principal id
  aud: string;
  jti: string;
  iat: number;
  exp: number;
  mandate_id: string;
  approval_id?: string;
  offer: Pick<
    Offer,
    "offer_id" | "merchant_id" | "merchant_country" | "mcc" | "check_in" | "check_out" | "nights" | "nightly_cents" | "amount_cents" | "currency"
  >;
}

export interface DelegationCredentialClaims {
  iss: string; // principal id
  sub: string; // agent id
  iat: number;
  exp: number;
  typ: "AgentDelegationCredential";
  mandate: Mandate;
}

export interface AssertionClaims {
  iss: string;
  sub: string; // agent id
  aud: string;
  jti: string; // assertion id
  iat: number;
  exp: number;
  decision: "ALLOW";
  principal_id: string;
  mandate_id: string;
  intent_jti: string;
  intent_hash: string;
  offer_id: string;
  merchant_id: string;
  amount_cents: number;
  currency: string;
  approval_id: string | null;
}

export type CheckStatus = "pass" | "fail" | "skipped";
export interface VerificationCheck {
  name: string;
  status: CheckStatus;
  detail: string;
}

export interface KyaDecision {
  decision: PolicyOutcome;
  reason: string;
  intent_jti: string | null;
  intent_hash: string;
  checks: VerificationCheck[];
  offer_id: string | null;
  amount_cents: number | null;
  approval_id?: string;
  assertion_id?: string;
  assertion?: string;
  assertion_expires_at?: string;
  ledger_seq: number;
}

export interface AgentRow {
  agent_id: string;
  display_name: string;
  operator: string;
  principal_id: string;
  principal_name: string;
  key_id: string;
  public_key_jwk: JsonWebKey;
  principal_public_key_jwk: JsonWebKey;
  delegation_credential: string;
  status: "active" | "suspended" | "revoked";
  status_reason: string | null;
  created_at: string;
  updated_at: string;
}

// ---------------------------------------------------------------------------
// Keys

let agentKey: KeyObject | null = null;
let kyaKey: KeyObject | null = null;

function agentPrivateKey(): KeyObject {
  return (agentKey ??= privateKeyFromEnvJwk(requireEnv("AGENT_PRIVATE_KEY")));
}
function kyaPrivateKey(): KeyObject {
  return (kyaKey ??= privateKeyFromEnvJwk(requireEnv("KYA_PRIVATE_KEY")));
}
export function kyaPublicJwk(): JsonWebKey {
  return publicJwkOf(kyaPrivateKey());
}

// ---------------------------------------------------------------------------
// Agent side: sign a payment intent (this is Atlas's wallet, not the verifier)

export function signPaymentIntent(
  offer: Offer,
  opts: { mandateId: string; principalId: string; approvalId?: string; agentId?: string; keyId?: string; privateKey?: KeyObject; iat?: number },
): { jws: string; claims: PaymentIntentClaims } {
  const iat = opts.iat ?? nowS();
  const claims: PaymentIntentClaims = {
    iss: opts.agentId ?? AGENT_ID,
    sub: opts.principalId,
    aud: INTENT_AUDIENCE,
    jti: randomId("int"),
    iat,
    exp: iat + INTENT_MAX_LIFETIME_S,
    mandate_id: opts.mandateId,
    ...(opts.approvalId ? { approval_id: opts.approvalId } : {}),
    offer: {
      offer_id: offer.offer_id,
      merchant_id: offer.merchant_id,
      merchant_country: offer.merchant_country,
      mcc: offer.mcc,
      check_in: offer.check_in,
      check_out: offer.check_out,
      nights: offer.nights,
      nightly_cents: offer.nightly_cents,
      amount_cents: offer.amount_cents,
      currency: offer.currency,
    },
  };
  const jws = signJws({ alg: "EdDSA", typ: "kya-intent+jws", kid: opts.keyId ?? AGENT_KEY_ID }, claims, opts.privateKey ?? agentPrivateKey());
  return { jws, claims };
}

// ---------------------------------------------------------------------------
// Registry

function rowToAgent(r: any): AgentRow {
  return { ...r, created_at: new Date(r.created_at).toISOString(), updated_at: new Date(r.updated_at).toISOString() };
}

export async function getAgent(agentId: string): Promise<AgentRow | null> {
  const res = await db().query("SELECT * FROM kya_agents WHERE agent_id = $1", [agentId]);
  return res.rows[0] ? rowToAgent(res.rows[0]) : null;
}

export async function listAgents(): Promise<(AgentRow & { mandate: Mandate | null })[]> {
  const res = await db().query("SELECT * FROM kya_agents ORDER BY agent_id");
  return res.rows.map((r) => {
    const agent = rowToAgent(r);
    const cred = decodeJws<DelegationCredentialClaims>(agent.delegation_credential);
    return { ...agent, mandate: cred?.payload.mandate ?? null };
  });
}

export async function setAgentStatus(agentId: string, status: "active" | "suspended", reason: string): Promise<AgentRow> {
  const res = await db().query(
    "UPDATE kya_agents SET status = $2, status_reason = $3, updated_at = now() WHERE agent_id = $1 AND status <> 'revoked' RETURNING *",
    [agentId, status, reason || null],
  );
  if (!res.rows[0]) throw new Error(`agent ${agentId} not found or revoked`);
  await appendLedger({
    event_type: status === "active" ? "kya.agent.reactivated" : "kya.agent.suspended",
    actor: "kya",
    agent_id: agentId,
    payload: { status, reason: reason || null, by: "kya-console-operator" },
  });
  return rowToAgent(res.rows[0]);
}

// ---------------------------------------------------------------------------
// Verifier

class Checks {
  list: VerificationCheck[] = [];
  add(name: string, ok: boolean, detail: string): boolean {
    this.list.push({ name, status: ok ? "pass" : "fail", detail });
    return ok;
  }
  skip(name: string, detail = "not evaluated (earlier check failed)") {
    this.list.push({ name, status: "skipped", detail });
  }
  get failed() {
    return this.list.filter((c) => c.status === "fail");
  }
}

const ALL_CHECKS = [
  "format",
  "agent_registered",
  "signature",
  "freshness",
  "agent_status",
  "delegation_credential",
  "mandate_binding",
  "offer_match",
  "mandate_limits",
] as const;

/**
 * Verify a signed payment intent. Pure inputs: the compact JWS only. Every
 * fact used for the decision comes from the registry, the verified delegation
 * credential, or the merchant's own price list.
 */
export async function verifyPaymentIntent(jws: string): Promise<KyaDecision> {
  const intentHash = sha256Hex(String(jws));
  const checks = new Checks();
  const finishEarly = (reason: string, jti: string | null, offerId: string | null = null, amount: number | null = null) => {
    for (const name of ALL_CHECKS) if (!checks.list.some((c) => c.name === name)) checks.skip(name);
    const failed = checks.failed[0];
    if (failed) reason = `${failed.name}: ${failed.detail}`;
    return record({ decision: "DENY", reason, intent_jti: jti, intent_hash: intentHash, checks: checks.list, offer_id: offerId, amount_cents: amount }, null);
  };

  // 1. format
  const decoded = decodeJws<PaymentIntentClaims>(jws);
  const c = decoded?.payload;
  const wellFormed =
    !!decoded &&
    decoded.header.alg === "EdDSA" &&
    decoded.header.typ === "kya-intent+jws" &&
    typeof c?.iss === "string" &&
    typeof c?.jti === "string" &&
    typeof c?.iat === "number" &&
    typeof c?.exp === "number" &&
    typeof c?.offer?.offer_id === "string" &&
    Number.isInteger(c?.offer?.amount_cents);
  if (!checks.add("format", wellFormed, wellFormed ? "compact JWS, alg=EdDSA, typ=kya-intent+jws" : "malformed intent or unsupported algorithm")) {
    return finishEarly("Malformed payment intent", null);
  }
  const claims = c!;

  // 2. agent registered
  const agent = await getAgent(claims.iss);
  if (!checks.add("agent_registered", !!agent, agent ? `${agent.agent_id} (${agent.display_name}), operator ${agent.operator}` : `unknown agent "${claims.iss}"`)) {
    return finishEarly("Agent is not registered with KYA", claims.jti, claims.offer.offer_id, claims.offer.amount_cents);
  }

  // 3. signature — only with the registered public key
  let sigOk = false;
  if (decoded!.header.kid === agent!.key_id) {
    try {
      sigOk = verifyJwsSignature(decoded!, publicKeyFromJwk(agent!.public_key_jwk));
    } catch {
      sigOk = false;
    }
  }
  if (
    !checks.add(
      "signature",
      sigOk,
      sigOk ? `Ed25519 signature valid for registered key ${agent!.key_id}` : decoded!.header.kid !== agent!.key_id ? `unknown key id "${decoded!.header.kid}"` : "Ed25519 signature does not verify against the registered public key",
    )
  ) {
    return finishEarly("Invalid agent signature", claims.jti, claims.offer.offer_id, claims.offer.amount_cents);
  }

  // From here on the claims are authentic (signed by the registered agent key).

  // 4. freshness (+ audience). Replay is checked atomically when recording.
  const now = nowS();
  const age = now - claims.iat;
  const fresh =
    claims.aud === INTENT_AUDIENCE && claims.iat <= now + CLOCK_SKEW_S && age <= INTENT_MAX_AGE_S && claims.exp > now && claims.exp - claims.iat <= INTENT_MAX_LIFETIME_S;
  checks.add(
    "freshness",
    fresh,
    fresh ? `issued ${Math.max(age, 0)}s ago (max ${INTENT_MAX_AGE_S}s), nonce ${claims.jti}` : claims.aud !== INTENT_AUDIENCE ? `wrong audience "${claims.aud}"` : `stale or expired intent (age ${age}s, max ${INTENT_MAX_AGE_S}s)`,
  );

  // 5. agent status
  checks.add("agent_status", agent!.status === "active", `status=${agent!.status}${agent!.status_reason ? ` (${agent!.status_reason})` : ""}`);

  // 6. delegation credential (principal → agent), verified with the principal's registered key
  const cred = decodeJws<DelegationCredentialClaims>(agent!.delegation_credential);
  let credOk = false;
  let credDetail = "missing or malformed delegation credential";
  if (cred) {
    let credSig = false;
    try {
      credSig = verifyJwsSignature(cred, publicKeyFromJwk(agent!.principal_public_key_jwk));
    } catch {
      credSig = false;
    }
    const p = cred.payload;
    if (!credSig) credDetail = "credential signature invalid";
    else if (p.typ !== "AgentDelegationCredential") credDetail = "not a delegation credential";
    else if (p.sub !== agent!.agent_id) credDetail = `credential issued to ${p.sub}, not ${agent!.agent_id}`;
    else if (p.iss !== agent!.principal_id || p.iss !== claims.sub) credDetail = `credential principal ${p.iss} does not match intent principal ${claims.sub}`;
    else if (p.exp <= now) credDetail = "credential expired";
    else {
      credOk = true;
      credDetail = `signed by ${p.mandate.principal_name} (${p.iss}), valid until ${new Date(p.exp * 1000).toISOString().slice(0, 10)}`;
    }
  }
  checks.add("delegation_credential", credOk, credDetail);
  const mandate = credOk ? cred!.payload.mandate : null;

  // 7. mandate binding
  if (mandate) {
    const bound = claims.mandate_id === mandate.mandate_id && mandate.agent_id === agent!.agent_id && Date.parse(mandate.valid_until) > Date.now();
    checks.add(
      "mandate_binding",
      bound,
      bound ? `intent bound to ${mandate.mandate_id}` : claims.mandate_id !== mandate.mandate_id ? `intent cites ${claims.mandate_id}, credential grants ${mandate.mandate_id}` : "mandate expired or not granted to this agent",
    );
  } else checks.skip("mandate_binding", "no verified credential");

  // 8. amount matches the merchant's offer (never trust the agent's numbers)
  const offer = resolveOffer(claims.offer.offer_id);
  if (offer) {
    const mismatches = (["merchant_id", "merchant_country", "mcc", "check_in", "check_out", "nights", "nightly_cents", "amount_cents", "currency"] as const).filter(
      (k) => claims.offer[k] !== offer[k],
    );
    checks.add(
      "offer_match",
      mismatches.length === 0,
      mismatches.length === 0
        ? `${offer.hotel_name}: €${(offer.amount_cents / 100).toFixed(2)} matches merchant quote`
        : `intent differs from merchant quote on ${mismatches.join(", ")} (quote €${(offer.amount_cents / 100).toFixed(2)}, intent €${(claims.offer.amount_cents / 100).toFixed(2)})`,
    );
  } else checks.add("offer_match", false, `offer ${claims.offer.offer_id} does not exist`);

  // 9. mandate limits
  let limitOutcome: PolicyOutcome | null = null;
  let limitChecks: LimitCheck[] = [];
  if (mandate && offer) {
    const r = evaluateMandateLimits(offer, mandate);
    limitOutcome = r.outcome;
    limitChecks = r.checks;
    const failed = r.checks.filter((x) => !x.ok && x.name !== "autonomous_limit");
    checks.add(
      "mandate_limits",
      r.outcome !== "DENY",
      r.outcome === "DENY" ? failed.map((x) => x.detail).join("; ") : r.checks.find((x) => x.name === "autonomous_limit")!.detail,
    );
  } else checks.skip("mandate_limits", "requires a verified mandate and a valid offer");

  const base = {
    intent_jti: claims.jti,
    intent_hash: intentHash,
    offer_id: claims.offer.offer_id,
    amount_cents: offer?.amount_cents ?? claims.offer.amount_cents,
  };

  if (checks.failed.length > 0) {
    const first = checks.failed[0];
    return record({ ...base, decision: "DENY", reason: `${first.name}: ${first.detail}`, checks: checks.list }, { agent: agent!, claims, offer, limitChecks });
  }

  if (limitOutcome === "STEP_UP_APPROVAL") {
    return record({ ...base, decision: "STEP_UP_APPROVAL", reason: "Amount exceeds the autonomous limit", checks: checks.list }, { agent: agent!, claims, offer: offer!, mandate: mandate!, limitChecks });
  }

  return record({ ...base, decision: "ALLOW", reason: "All KYA checks passed", checks: checks.list }, { agent: agent!, claims, offer: offer!, mandate: mandate!, limitChecks });
}

type DecisionDraft = Omit<KyaDecision, "ledger_seq">;
interface DecisionContext {
  agent: AgentRow;
  claims: PaymentIntentClaims;
  offer: Offer | null;
  mandate?: Mandate;
  limitChecks: LimitCheck[];
}

/**
 * Atomically: replay-check the nonce, resolve step-up approvals, issue the
 * assertion and write the decision to the ledger. Runs under the ledger lock
 * so two concurrent submissions of the same intent cannot both succeed.
 */
async function record(draft: DecisionDraft, ctx: DecisionContext | null): Promise<KyaDecision> {
  const emitted: LedgerEntryView[] = [];
  const decision = await withTx(async (tx) => {
    const d: DecisionDraft = { ...draft, checks: [...draft.checks] };

    if (ctx && d.intent_jti) {
      // Lock first so the replay check and the decision write are atomic.
      await tx.query("SELECT pg_advisory_xact_lock($1)", [0x4b5941]);
      const seen = await tx.query("SELECT 1 FROM kya_ledger WHERE event_type = 'kya.decision' AND payload->>'intent_jti' = $1 LIMIT 1", [d.intent_jti]);
      if (seen.rowCount) {
        const fresh = d.checks.find((x) => x.name === "freshness");
        if (fresh) {
          fresh.status = "fail";
          fresh.detail = `replay: nonce ${d.intent_jti} was already presented`;
        }
        d.decision = "DENY";
        d.reason = "freshness: intent nonce replayed";
        delete d.approval_id;
      }
    }

    // Step-up handling
    if (ctx && ctx.offer && ctx.mandate && d.decision !== "DENY" && ctx.offer.amount_cents > ctx.mandate.autonomous_limit_cents) {
      const requested = ctx.claims.approval_id;
      if (requested) {
        const ap = await tx.query("SELECT * FROM kya_approvals WHERE approval_id = $1 FOR UPDATE", [requested]);
        const row = ap.rows[0];
        const bindingOk =
          row &&
          row.agent_id === ctx.agent.agent_id &&
          row.mandate_id === ctx.mandate.mandate_id &&
          row.offer_id === ctx.offer.offer_id &&
          row.amount_cents === ctx.offer.amount_cents;
        if (!row || !bindingOk) {
          d.decision = "DENY";
          d.reason = `approval ${requested} does not match this agent / offer / amount`;
          d.checks.push({ name: "step_up_approval", status: "fail", detail: d.reason });
        } else if (row.status === "approved" && new Date(row.expires_at) > new Date()) {
          await tx.query("UPDATE kya_approvals SET status = 'consumed', consumed_at = now() WHERE approval_id = $1", [requested]);
          d.decision = "ALLOW";
          d.reason = `Principal step-up approval ${requested} verified`;
          d.approval_id = requested;
          d.checks.push({ name: "step_up_approval", status: "pass", detail: `approved by ${row.decided_by} at ${new Date(row.decided_at).toISOString()}` });
        } else if (row.status === "pending" && new Date(row.expires_at) > new Date()) {
          d.decision = "STEP_UP_APPROVAL";
          d.reason = `Approval ${requested} is still pending with the principal`;
          d.approval_id = requested;
          d.checks.push({ name: "step_up_approval", status: "fail", detail: "pending principal decision" });
        } else {
          d.decision = "DENY";
          d.reason = `approval ${requested} is ${row.status === "pending" ? "expired" : row.status}`;
          d.checks.push({ name: "step_up_approval", status: "fail", detail: d.reason });
        }
      } else {
        // Reuse an open request for the same offer instead of spamming the principal.
        const existing = await tx.query(
          `SELECT approval_id FROM kya_approvals WHERE agent_id = $1 AND offer_id = $2 AND amount_cents = $3 AND status = 'pending' AND expires_at > now()
           ORDER BY created_at DESC LIMIT 1`,
          [ctx.agent.agent_id, ctx.offer.offer_id, ctx.offer.amount_cents],
        );
        let approvalId: string = existing.rows[0]?.approval_id;
        if (!approvalId) {
          approvalId = randomId("apr", 6);
          await tx.query(
            `INSERT INTO kya_approvals (approval_id, agent_id, principal_id, mandate_id, offer_id, hotel_name, amount_cents, currency, intent_jti, reason, expires_at)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, now() + make_interval(secs => $11))`,
            [
              approvalId,
              ctx.agent.agent_id,
              ctx.agent.principal_id,
              ctx.mandate.mandate_id,
              ctx.offer.offer_id,
              ctx.offer.hotel_name,
              ctx.offer.amount_cents,
              ctx.offer.currency,
              ctx.claims.jti,
              `€${(ctx.offer.amount_cents / 100).toFixed(2)} exceeds autonomous limit €${(ctx.mandate.autonomous_limit_cents / 100).toFixed(2)}`,
              APPROVAL_TTL_S,
            ],
          );
          emitted.push(
            await appendLedgerTx(tx, {
              event_type: "kya.approval.requested",
              actor: "kya",
              agent_id: ctx.agent.agent_id,
              payload: { approval_id: approvalId, offer_id: ctx.offer.offer_id, hotel: ctx.offer.hotel_name, amount_cents: ctx.offer.amount_cents, principal_id: ctx.agent.principal_id },
            }),
          );
        }
        d.decision = "STEP_UP_APPROVAL";
        d.approval_id = approvalId;
      }
    }

    // Issue the signed assertion
    if (d.decision === "ALLOW" && ctx && ctx.offer && ctx.mandate) {
      const iat = nowS();
      const assertion: AssertionClaims = {
        iss: KYA_ISSUER,
        sub: ctx.agent.agent_id,
        aud: ASSERTION_AUDIENCE,
        jti: randomId("asr"),
        iat,
        exp: iat + ASSERTION_TTL_S,
        decision: "ALLOW",
        principal_id: ctx.agent.principal_id,
        mandate_id: ctx.mandate.mandate_id,
        intent_jti: ctx.claims.jti,
        intent_hash: d.intent_hash,
        offer_id: ctx.offer.offer_id,
        merchant_id: ctx.offer.merchant_id,
        amount_cents: ctx.offer.amount_cents,
        currency: ctx.offer.currency,
        approval_id: d.approval_id ?? null,
      };
      d.assertion = signJws({ alg: "EdDSA", typ: "kya-assertion+jws", kid: KYA_KEY_ID }, assertion, kyaPrivateKey());
      d.assertion_id = assertion.jti;
      d.assertion_expires_at = new Date(assertion.exp * 1000).toISOString();
    }

    const entry = await appendLedgerTx(tx, {
      event_type: "kya.decision",
      actor: "kya",
      agent_id: ctx?.agent.agent_id ?? null,
      payload: {
        decision: d.decision,
        reason: d.reason,
        intent_jti: d.intent_jti,
        intent_hash: d.intent_hash,
        offer_id: d.offer_id,
        amount_cents: d.amount_cents,
        approval_id: d.approval_id ?? null,
        assertion_id: d.assertion_id ?? null,
        assertion: d.assertion ?? null,
        checks: d.checks,
      },
    });
    emitted.push(entry);
    return { ...d, ledger_seq: entry.seq };
  });
  emitLedger(...emitted);
  return decision;
}

// ---------------------------------------------------------------------------
// Assertion re-verification (used by the payment and booking steps)

export class EnforcementError extends Error {
  constructor(
    public code: string,
    message: string,
  ) {
    super(message);
  }
}

/**
 * Look up an assertion by id and re-verify it from scratch: KYA signature,
 * issuer, audience, expiry, that the agent is *still* active, and that the
 * merchant's current quote still matches the asserted amount.
 */
export async function verifyAssertionForUse(assertionId: string): Promise<{ claims: AssertionClaims; offer: Offer; agent: AgentRow; jws: string }> {
  if (typeof assertionId !== "string" || !/^asr_[A-Za-z0-9_-]{6,40}$/.test(assertionId)) {
    throw new EnforcementError("assertion_invalid", "assertion_id is malformed");
  }
  const res = await db().query(
    "SELECT payload->>'assertion' AS jws FROM kya_ledger WHERE event_type = 'kya.decision' AND payload->>'assertion_id' = $1 AND payload->>'decision' = 'ALLOW' LIMIT 1",
    [assertionId],
  );
  const jws: string | undefined = res.rows[0]?.jws;
  if (!jws) throw new EnforcementError("assertion_unknown", `no KYA ALLOW assertion ${assertionId} exists`);

  const decoded = decodeJws<AssertionClaims>(jws);
  if (!decoded || decoded.header.kid !== KYA_KEY_ID || !verifyJwsSignature(decoded, publicKeyFromJwk(kyaPublicJwk()))) {
    throw new EnforcementError("assertion_signature", "KYA assertion signature invalid");
  }
  const claims = decoded.payload;
  if (claims.iss !== KYA_ISSUER || claims.aud !== ASSERTION_AUDIENCE || claims.decision !== "ALLOW" || claims.jti !== assertionId) {
    throw new EnforcementError("assertion_claims", "KYA assertion issuer/audience/decision mismatch");
  }
  if (claims.exp <= nowS()) throw new EnforcementError("assertion_expired", "KYA assertion expired — re-run verify_authority");

  const agent = await getAgent(claims.sub);
  if (!agent || agent.status !== "active") {
    throw new EnforcementError("agent_inactive", `agent ${claims.sub} is ${agent?.status ?? "unknown"}; KYA no longer vouches for it`);
  }
  const offer = resolveOffer(claims.offer_id);
  if (!offer || offer.amount_cents !== claims.amount_cents || offer.merchant_id !== claims.merchant_id || offer.currency !== claims.currency) {
    throw new EnforcementError("amount_mismatch", "merchant quote no longer matches the asserted amount");
  }
  return { claims, offer, agent, jws };
}

// ---------------------------------------------------------------------------
// Approvals

export interface ApprovalRow {
  approval_id: string;
  agent_id: string;
  principal_id: string;
  mandate_id: string;
  offer_id: string;
  hotel_name: string;
  amount_cents: number;
  currency: string;
  intent_jti: string;
  reason: string;
  status: "pending" | "approved" | "rejected" | "consumed" | "expired";
  created_at: string;
  expires_at: string;
  decided_at: string | null;
  decided_by: string | null;
  consumed_at: string | null;
}

function rowToApproval(r: any): ApprovalRow {
  const iso = (v: any) => (v ? new Date(v).toISOString() : null);
  const expired = r.status === "pending" && new Date(r.expires_at) <= new Date();
  return {
    ...r,
    status: expired ? "expired" : r.status,
    created_at: iso(r.created_at)!,
    expires_at: iso(r.expires_at)!,
    decided_at: iso(r.decided_at),
    consumed_at: iso(r.consumed_at),
  };
}

export async function listApprovals(): Promise<ApprovalRow[]> {
  const res = await db().query("SELECT * FROM kya_approvals ORDER BY created_at DESC LIMIT 100");
  return res.rows.map(rowToApproval);
}

export async function decideApproval(approvalId: string, decision: "approved" | "rejected"): Promise<ApprovalRow> {
  const emitted: LedgerEntryView[] = [];
  const row = await withTx(async (tx) => {
    const res = await tx.query(
      `UPDATE kya_approvals SET status = $2, decided_at = now(), decided_by = $3
       WHERE approval_id = $1 AND status = 'pending' AND expires_at > now() RETURNING *`,
      [approvalId, decision, "principal:prn_alex_morgan"],
    );
    if (!res.rows[0]) throw new Error(`approval ${approvalId} is not pending (already decided or expired)`);
    const r = res.rows[0];
    emitted.push(
      await appendLedgerTx(tx, {
        event_type: decision === "approved" ? "principal.approval.granted" : "principal.approval.rejected",
        actor: "principal",
        agent_id: r.agent_id,
        payload: { approval_id: approvalId, offer_id: r.offer_id, hotel: r.hotel_name, amount_cents: r.amount_cents },
      }),
    );
    return rowToApproval(r);
  });
  emitLedger(...emitted);
  return row;
}
