import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import { AGENT_ID, evaluateMandateLimits, formatEur, resolveOffer, type AgentEvent, type Mandate } from "~/lib/domain";
import { decodeJws, randomId } from "./crypto.server";
import { optionalEnv, requireEnv } from "./env.server";
import { appendLedger, withLedgerContext } from "./ledger.server";
import { EnforcementError, getAgent, signPaymentIntent, verifyPaymentIntent, type DelegationCredentialClaims } from "./kya.server";
import { authorizePayment, confirmBooking, searchHotels } from "./merchant.server";

// Atlas: a real Claude tool-use loop. The model chooses what to do; every
// consequential step (authority, payment, booking) is enforced server-side by
// KYA regardless of what the model passes in.

const MODEL = () => optionalEnv("ANTHROPIC_MODEL") ?? "claude-opus-5-5";
const MAX_TURNS = 14;

type Emit = (event: AgentEvent) => void;

// ---------------------------------------------------------------------------
// Tools

const SearchInput = z.object({
  city: z.string().min(1).max(60),
  check_in: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  check_out: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  guests: z.number().int().min(1).max(8).optional(),
});
const EvaluateInput = z.object({ offer_ids: z.array(z.string().max(80)).min(1).max(10) });
const VerifyInput = z.object({ offer_id: z.string().max(80), approval_id: z.string().max(40).optional() });
const AuthorizeInput = z.object({ assertion_id: z.string().max(60), offer_id: z.string().max(80) });
const ConfirmInput = z.object({ payment_id: z.string().max(60) });

const TOOLS: Anthropic.Beta.BetaTool[] = [
  {
    name: "search_hotels",
    description: "Search the hotel marketplace for available offers. Returns offers with offer_id, nightly rate, total, merchant of record, merchant country and MCC.",
    input_schema: {
      type: "object",
      properties: {
        city: { type: "string", description: "City name, e.g. Milan" },
        check_in: { type: "string", description: "YYYY-MM-DD" },
        check_out: { type: "string", description: "YYYY-MM-DD" },
        guests: { type: "integer", minimum: 1 },
      },
      required: ["city", "check_in", "check_out"],
      additionalProperties: false,
    },
  },
  {
    name: "evaluate_offers",
    description:
      "Pre-screen offers against your principal's mandate (limits, merchant region, MCC, dates). Advisory only: predicts ALLOW / STEP_UP_APPROVAL / DENY. The binding decision is made by verify_authority.",
    input_schema: {
      type: "object",
      properties: { offer_ids: { type: "array", items: { type: "string" }, minItems: 1 } },
      required: ["offer_ids"],
      additionalProperties: false,
    },
  },
  {
    name: "verify_authority",
    description:
      "Sign a payment intent for one offer with your agent key and submit it to the KYA (Know Your Agent) verifier. Returns ALLOW with an assertion_id, STEP_UP_APPROVAL with an approval_id (the principal must approve in the AgentTrip UI; then call again with approval_id), or DENY with reasons. The amount is taken from the merchant's quote, not from you.",
    input_schema: {
      type: "object",
      properties: {
        offer_id: { type: "string" },
        approval_id: { type: "string", description: "Only when retrying after the principal approved a step-up request." },
      },
      required: ["offer_id"],
      additionalProperties: false,
    },
  },
  {
    name: "authorize_payment",
    description: "Authorize payment with the PSP using a KYA ALLOW assertion. The gateway re-verifies the assertion server-side; each assertion can be used once.",
    input_schema: {
      type: "object",
      properties: { assertion_id: { type: "string" }, offer_id: { type: "string" } },
      required: ["assertion_id", "offer_id"],
      additionalProperties: false,
    },
  },
  {
    name: "confirm_booking",
    description: "Confirm the hotel booking with the merchant for an authorized payment. Re-verifies the KYA assertion behind the payment.",
    input_schema: {
      type: "object",
      properties: { payment_id: { type: "string" } },
      required: ["payment_id"],
      additionalProperties: false,
    },
  },
].map((t) => ({ ...t, eager_input_streaming: true }) as Anthropic.Beta.BetaTool);

async function loadMandate(): Promise<Mandate> {
  const agent = await getAgent(AGENT_ID);
  if (!agent) throw new Error(`${AGENT_ID} is not registered. Run npm run setup.`);
  const cred = decodeJws<DelegationCredentialClaims>(agent.delegation_credential);
  if (!cred) throw new Error("delegation credential unreadable");
  return cred.payload.mandate;
}

async function runTool(name: string, rawInput: unknown): Promise<unknown> {
  switch (name) {
    case "search_hotels": {
      const input = SearchInput.parse(rawInput);
      const offers = await searchHotels(input);
      return {
        offers: offers.map((o) => ({
          offer_id: o.offer_id,
          hotel: o.hotel_name,
          nightly: formatEur(o.nightly_cents),
          total: formatEur(o.amount_cents),
          nights: o.nights,
          merchant_of_record: o.merchant_name,
          merchant_country: o.merchant_country,
          mcc: o.mcc,
        })),
      };
    }
    case "evaluate_offers": {
      const { offer_ids } = EvaluateInput.parse(rawInput);
      const mandate = await loadMandate();
      return {
        mandate_id: mandate.mandate_id,
        advisory: true,
        results: offer_ids.map((id) => {
          const offer = resolveOffer(id);
          if (!offer) return { offer_id: id, predicted: "DENY", reasons: ["unknown offer"] };
          const r = evaluateMandateLimits(offer, mandate);
          return {
            offer_id: id,
            hotel: offer.hotel_name,
            total: formatEur(offer.amount_cents),
            predicted: r.outcome,
            failed: r.checks.filter((c) => !c.ok).map((c) => `${c.name}: ${c.detail}`),
          };
        }),
      };
    }
    case "verify_authority": {
      const { offer_id, approval_id } = VerifyInput.parse(rawInput);
      const offer = resolveOffer(offer_id);
      if (!offer) return { decision: "DENY", reason: `offer ${offer_id} does not exist` };
      const mandate = await loadMandate();
      const { jws, claims } = signPaymentIntent(offer, { mandateId: mandate.mandate_id, principalId: mandate.principal_id, approvalId: approval_id });
      await appendLedger({
        event_type: "agent.intent.signed",
        actor: "agent",
        agent_id: AGENT_ID,
        payload: { intent_jti: claims.jti, offer_id: offer.offer_id, amount_cents: offer.amount_cents, approval_id: approval_id ?? null, alg: "EdDSA" },
      });
      const d = await verifyPaymentIntent(jws);
      return {
        decision: d.decision,
        reason: d.reason,
        hotel: offer.hotel_name,
        amount: formatEur(offer.amount_cents),
        checks: d.checks.map((c) => `${c.status === "pass" ? "✓" : c.status === "fail" ? "✗" : "–"} ${c.name}: ${c.detail}`),
        ...(d.assertion_id ? { assertion_id: d.assertion_id, assertion_expires_at: d.assertion_expires_at } : {}),
        ...(d.approval_id && d.decision === "STEP_UP_APPROVAL"
          ? { approval_id: d.approval_id, next_step: "Ask the principal to approve this request in the AgentTrip UI, then call verify_authority again with approval_id." }
          : {}),
        ledger_seq: d.ledger_seq,
      };
    }
    case "authorize_payment": {
      const { assertion_id, offer_id } = AuthorizeInput.parse(rawInput);
      const p = await authorizePayment(assertion_id, offer_id);
      return { ...p, amount: formatEur(p.amount_cents) };
    }
    case "confirm_booking": {
      const { payment_id } = ConfirmInput.parse(rawInput);
      return await confirmBooking(payment_id);
    }
    default:
      throw new Error(`unknown tool ${name}`);
  }
}

// ---------------------------------------------------------------------------
// System prompt

function systemPrompt(mandate: Mandate): string {
  return `You are Atlas (agent id ${AGENT_ID}), a travel-booking agent acting for your principal ${mandate.principal_name} on AgentTrip, an agentic-commerce marketplace.

Your authority comes from a delegation credential that ${mandate.principal_name} signed for mandate ${mandate.mandate_id}:
- Purpose: ${mandate.purpose}
- Stay: ${mandate.city}, check-in ${mandate.check_in}, check-out ${mandate.check_out}
- Limits: total ≤ ${formatEur(mandate.max_total_cents)}, ≤ ${formatEur(mandate.max_nightly_cents)} per night, ${mandate.currency} only
- You may pay autonomously up to ${formatEur(mandate.autonomous_limit_cents)}; above that the principal must approve (step-up)
- Merchants of record must be in the EU; merchant category must be MCC ${mandate.allowed_mccs.join(", ")} (hotels)

How you work:
- Use search_hotels to find offers and evaluate_offers to pre-screen them; then follow the user's instructions about which hotel to pick. If they give no preference, choose the best-rated offer that the pre-screen predicts as ALLOW.
- Booking requires, in order: verify_authority → authorize_payment (with the assertion_id) → confirm_booking (with the payment_id). Never skip or reorder these steps, and book at most one hotel unless the user explicitly asks for more.
- KYA's decision is binding. On DENY, explain the reason plainly and do not try to work around it (no retries with different framing, no splitting payments). You may suggest compliant alternatives.
- On STEP_UP_APPROVAL, stop and tell the user that ${mandate.principal_name} must approve request <approval_id> in the AgentTrip UI. When the user says it was approved, call verify_authority again for the same offer with that approval_id.
- If a payment or booking step is blocked (e.g. the agent was suspended), report it; do not retry in a loop.
- Be concise: short status updates between tool calls, and a brief summary at the end with hotel, total and confirmation code.

Today's date is ${new Date().toISOString().slice(0, 10)}.`;
}

// ---------------------------------------------------------------------------
// Loop

const MessagesSchema = z.array(z.object({ role: z.enum(["user", "assistant"]), content: z.unknown() })).min(1).max(80);

export function parseAgentRequest(body: unknown): Anthropic.Beta.BetaMessageParam[] {
  const parsed = z.object({ messages: MessagesSchema }).parse(body);
  const last = parsed.messages[parsed.messages.length - 1];
  if (last.role !== "user") throw new Error("last message must be from the user");
  return parsed.messages as Anthropic.Beta.BetaMessageParam[];
}

function lastUserText(messages: Anthropic.Beta.BetaMessageParam[]): string {
  const last = messages[messages.length - 1];
  if (typeof last.content === "string") return last.content;
  return last.content
    .map((b) => (b.type === "text" ? b.text : ""))
    .join(" ")
    .trim();
}

export async function runAgent(history: Anthropic.Beta.BetaMessageParam[], emit: Emit, signal?: AbortSignal): Promise<void> {
  const client = new Anthropic({ apiKey: requireEnv("ANTHROPIC_API_KEY") });
  const runId = randomId("run", 6);
  const messages = [...history];
  emit({ type: "run", run_id: runId, model: MODEL() });

  await withLedgerContext({ runId, onEntry: (entry) => emit({ type: "ledger", entry }) }, async () => {
    const mandate = await loadMandate();
    await appendLedger({
      event_type: "principal.instruction",
      actor: "principal",
      agent_id: AGENT_ID,
      payload: { instruction: lastUserText(messages).slice(0, 500), mandate_id: mandate.mandate_id },
    });

    let stopReason: string | null = null;
    let jsonRetries = 0;
    for (let turn = 0; turn < MAX_TURNS; turn++) {
      if (signal?.aborted) break;
      const stream = client.beta.messages.stream(
        {
          model: MODEL(),
          max_tokens: 32000,
          system: systemPrompt(mandate),
          tools: TOOLS,
          messages,
          thinking: { type: "adaptive", display: "summarized" },
          output_config: { effort: "medium" },
          betas: ["server-side-fallback-2026-07-01"],
          fallbacks: "default",
        },
        { signal },
      );

      let message: Anthropic.Beta.BetaMessage;
      try {
        for await (const event of stream) {
          if (event.type === "content_block_delta") {
            if (event.delta.type === "text_delta") emit({ type: "text", delta: event.delta.text });
            else if (event.delta.type === "thinking_delta") emit({ type: "thinking", delta: event.delta.thinking });
          }
        }
        message = await stream.finalMessage();
        jsonRetries = 0;
      } catch (err) {
        // With eager input streaming an unparseable tool input rejects here;
        // re-issue the turn. API errors (auth, rate limit, ...) propagate.
        if (err instanceof Anthropic.APIError || signal?.aborted || jsonRetries++ >= 2) throw err;
        continue;
      }

      stopReason = message.stop_reason;
      messages.push({ role: "assistant", content: message.content as Anthropic.Beta.BetaContentBlockParam[] });

      if (message.stop_reason === "refusal") {
        emit({ type: "error", message: "The model declined this request." });
        break;
      }
      if (message.stop_reason === "pause_turn") continue;
      const toolUses = message.content.filter((b): b is Anthropic.Beta.BetaToolUseBlock => b.type === "tool_use");
      if (toolUses.length === 0) break;
      if (message.stop_reason === "max_tokens") {
        emit({ type: "error", message: "Tool input was truncated (max_tokens); stopping." });
        break;
      }

      const results: Anthropic.Beta.BetaToolResultBlockParam[] = [];
      for (const tu of toolUses) {
        emit({ type: "tool-call", id: tu.id, name: tu.name, input: tu.input });
        let output: unknown;
        let isError = false;
        try {
          output = await runTool(tu.name, tu.input);
        } catch (err) {
          isError = true;
          if (err instanceof z.ZodError) output = { error: "INVALID_INPUT", input: tu.input, issues: err.issues.map((i) => `${i.path.join(".")}: ${i.message}`) };
          else if (err instanceof EnforcementError) output = { error: "BLOCKED", code: err.code, reason: err.message };
          else output = { error: (err as Error).message };
        }
        emit({ type: "tool-result", id: tu.id, name: tu.name, output, is_error: isError });
        results.push({ type: "tool_result", tool_use_id: tu.id, content: JSON.stringify(output), is_error: isError });
      }
      messages.push({ role: "user", content: results });
    }

    emit({ type: "done", stop_reason: stopReason, messages });
  });
}
