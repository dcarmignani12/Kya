# AgentTrip

An agentic-commerce demo with real **KYA (Know Your Agent)** enforcement. Atlas
(`agt_atlas_001`) is an LLM agent that books a Milan hotel (15–17 Nov 2026, 2
nights) for its principal **Alex Morgan** under mandate `mdt_alex_milan_1115`:

| Rule | Value |
| --- | --- |
| Max total | €800 |
| Max per night | €400 |
| Autonomous limit | €700 (above this, Alex must approve a step-up) |
| Merchants | EU merchants of record only |
| MCC | 7011 (hotels) |

Hotels, the PSP and the card network are simulated. The LLM loop, the
Ed25519 cryptography, the KYA checks and the hash-chained audit ledger are real.

## Run it

Needs Node 22+ and Postgres 14+.

```bash
npm install
# create a database, e.g.
#   createuser -P agenttrip && createdb -O agenttrip agenttrip
npm run setup          # writes .env (keys), applies db/schema.sql, registers Atlas
# add ANTHROPIC_API_KEY=... to .env
npm run dev            # http://localhost:3000
```

`npm run setup -- --reset` drops and recreates the KYA tables (the ledger is
append-only, so this is the only way to clear it). `npm test` runs integration
tests against the configured database; they add bookings and ledger entries.

## How it works

```
Principal ─► Agent ─► Gateway ─► KYA ─► Merchant ─► PSP ─► Network ─► Audit
 (Alex)     (Atlas)  (tools)   (verifier)  (hotel)                  (ledger)
```

**Agent (`src/server/agent.server.ts`).** A streaming Claude tool-use loop with
five tools: `search_hotels`, `evaluate_offers`, `verify_authority`,
`authorize_payment`, `confirm_booking`. Users can type any instruction. `POST
/api/agent` streams NDJSON events (`text`, `thinking`, `tool-call`,
`tool-result`, `ledger`, `error`, `done`). The browser keeps the conversation and
sends it back each turn. Enforcement never relies on the conversation, so a
tampered history gains nothing.

**KYA (`src/server/kya.server.ts`).**
1. `verify_authority` builds a payment intent from the merchant's own quote and
   signs it as a compact JWS (`alg: EdDSA`). The signing key is in the
   `AGENT_PRIVATE_KEY` env secret.
2. The verifier gets only the JWS. It looks up the agent's *registered* public
   key in `kya_agents`, then checks, in order:
   - format
   - agent registered
   - signature
   - freshness: age ≤ 60s, audience, and the nonce has not been seen before
   - agent status
   - the delegation credential, signed by the principal and checked with
     Alex's registered key
   - mandate binding
   - the offer matches the merchant's quote, field by field (amount included)
   - mandate limits
3. The verifier returns one of:
   - **ALLOW**: an assertion signed by the KYA key (`KYA_PRIVATE_KEY`), valid
     for 10 minutes.
   - **STEP_UP_APPROVAL**: a pending row in `kya_approvals`. Alex approves it in
     the UI, then the agent retries with `approval_id`. The approval is bound to
     the agent, offer and amount, and can be used once.
   - **DENY**: with the checks that failed.
4. `authorize_payment` and `confirm_booking` take only ids. Each re-verifies
   the assertion from scratch: KYA signature, issuer, audience and expiry, that
   the agent is *still* active, and the merchant quote. An assertion can pay
   only once (a `UNIQUE` constraint on `kya_bookings.assertion_id`).

**Audit ledger (`src/server/ledger.server.ts`).** Every step is appended to
`kya_ledger`. Each entry is `sha256(canonical_json(entry, prev_hash))`, and the
first entry's `prev_hash` is `"GENESIS"`. Appends are serialised with an
advisory lock. Database triggers reject `UPDATE`/`DELETE`/`TRUNCATE`.
`verifyChain()` recomputes every hash and every link.

**Tables.** `kya_agents`, `kya_ledger`, `kya_approvals` and `kya_bookings` have
RLS enabled. They grant `SELECT` only to the read-only `kya_public` role and
revoke everything from `PUBLIC`. The app server is the only writer.

## UI

- **Marketplace** (`/`): six Milan hotels with the mandate shown. Two fit the
  mandate, one needs approval, and three are prohibited (over the limit, a
  Swiss merchant of record, a timeshare MCC). The agent panel shows the live
  event stream, step-up approval buttons and the 8-actor connection view.
- **KYA Console** (`/console`): the agent registry (suspend/reactivate),
  approvals, bookings, the ledger with chain verification, and an
  **adversarial suite**. The suite sends real forged, tampered, stale,
  replayed and out-of-mandate requests to the live verifier.

## Demo notes

The console's suspend/approve actions have no login. In this demo, anyone who
can reach the app acts as both the KYA operator and the principal.
