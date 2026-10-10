import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

// Server functions: the only way the UI reads or changes KYA state. Handler
// bodies (and the .server modules they import) never ship to the client.

export const getConsoleData = createServerFn({ method: "GET" }).handler(async () => {
  const { listAgents, listApprovals, kyaPublicJwk } = await import("./kya.server");
  const { listLedger } = await import("./ledger.server");
  const { listBookings } = await import("./merchant.server");
  const [agents, approvals, ledger, bookings] = await Promise.all([listAgents(), listApprovals(), listLedger(300), listBookings()]);
  return {
    agents: agents.map((a) => ({
      agent_id: a.agent_id,
      display_name: a.display_name,
      operator: a.operator,
      principal_id: a.principal_id,
      principal_name: a.principal_name,
      key_id: a.key_id,
      public_key_x: String(a.public_key_jwk.x),
      status: a.status,
      status_reason: a.status_reason,
      updated_at: a.updated_at,
      mandate: a.mandate,
      credential_preview: a.delegation_credential.slice(0, 48) + "…",
    })),
    approvals,
    ledger,
    bookings,
    kya_public_key_x: String(kyaPublicJwk().x),
  };
});

export const setAgentStatusFn = createServerFn({ method: "POST" })
  .validator(z.object({ agent_id: z.string().max(60), status: z.enum(["active", "suspended"]), reason: z.string().max(200).default("") }))
  .handler(async ({ data }) => {
    const { setAgentStatus } = await import("./kya.server");
    const a = await setAgentStatus(data.agent_id, data.status, data.reason);
    return { agent_id: a.agent_id, status: a.status };
  });

export const decideApprovalFn = createServerFn({ method: "POST" })
  .validator(z.object({ approval_id: z.string().max(40), decision: z.enum(["approved", "rejected"]) }))
  .handler(async ({ data }) => {
    const { decideApproval } = await import("./kya.server");
    return decideApproval(data.approval_id, data.decision);
  });

export const verifyChainFn = createServerFn({ method: "POST" }).handler(async () => {
  const { verifyChain } = await import("./ledger.server");
  return verifyChain();
});

export const runAttackSuiteFn = createServerFn({ method: "POST" }).handler(async () => {
  const { runAttackSuite } = await import("./attacks.server");
  return runAttackSuite();
});

export const getAgentStatusFn = createServerFn({ method: "GET" }).handler(async () => {
  const { getAgent } = await import("./kya.server");
  const { optionalEnv } = await import("./env.server");
  const { AGENT_ID } = await import("~/lib/domain");
  const a = await getAgent(AGENT_ID);
  return { status: a?.status ?? "unregistered", llm_configured: !!optionalEnv("ANTHROPIC_API_KEY") };
});
