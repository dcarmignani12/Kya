import { createFileRoute, useRouter } from "@tanstack/react-router";
import { useEffect, useState, type ReactNode } from "react";
import { formatEur } from "~/lib/domain";
import { decideApprovalFn, getConsoleData, runAttackSuiteFn, setAgentStatusFn, verifyChainFn } from "~/server/fns";

export const Route = createFileRoute("/console")({
  loader: () => getConsoleData(),
  component: Console,
});

type Data = Awaited<ReturnType<typeof getConsoleData>>;
type ChainResult = Awaited<ReturnType<typeof verifyChainFn>>;
type AttackResults = Awaited<ReturnType<typeof runAttackSuiteFn>>;

function Console() {
  const data = Route.useLoaderData();
  const router = useRouter();

  useEffect(() => {
    const t = setInterval(() => router.invalidate(), 3000);
    return () => clearInterval(t);
  }, [router]);

  const pending = data.approvals.filter((a) => a.status === "pending");

  return (
    <main className="mx-auto max-w-[1500px] space-y-6 px-4 py-6 sm:px-6">
      <div className="grid gap-6 lg:grid-cols-2">
        <Panel title="Agent registry" subtitle={`KYA service key x=${data.kya_public_key_x.slice(0, 16)}…`}>
          {data.agents.map((a) => (
            <AgentRow key={a.agent_id} agent={a} />
          ))}
        </Panel>
        <Panel title="Pending approvals" subtitle={`${pending.length} awaiting principal`}>
          {data.approvals.length === 0 && <Empty>No step-up requests yet.</Empty>}
          <div className="space-y-2">
            {data.approvals.slice(0, 8).map((a) => (
              <ApprovalRow key={a.approval_id} approval={a} />
            ))}
          </div>
        </Panel>
      </div>

      <AttackSuite />

      <Panel title="Bookings" subtitle={`${data.bookings.length} total`}>
        {data.bookings.length === 0 ? (
          <Empty>No bookings yet.</Empty>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs">
              <thead className="text-zinc-500">
                <tr>
                  {["Booking", "Hotel", "Stay", "Amount", "Payment", "Assertion", "Approval", "Status"].map((h) => (
                    <th key={h} className="px-2 py-1.5 font-normal">
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody className="font-mono text-[11px] text-zinc-300">
                {data.bookings.map((b: any) => (
                  <tr key={b.booking_id} className="border-t border-white/5">
                    <td className="px-2 py-1.5">{b.confirmation_code ?? b.booking_id}</td>
                    <td className="px-2 py-1.5 font-sans text-xs">{b.hotel_name}</td>
                    <td className="px-2 py-1.5">
                      {b.check_in} → {b.check_out}
                    </td>
                    <td className="px-2 py-1.5">{formatEur(b.amount_cents)}</td>
                    <td className="px-2 py-1.5 text-zinc-500">{b.payment_id}</td>
                    <td className="px-2 py-1.5 text-zinc-500">{b.assertion_id}</td>
                    <td className="px-2 py-1.5 text-zinc-500">{b.approval_id ?? "—"}</td>
                    <td className="px-2 py-1.5">
                      <span className={b.status === "confirmed" ? "text-emerald-400" : "text-amber-300"}>{b.status}</span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Panel>

      <Ledger ledger={data.ledger} />
    </main>
  );
}

function Panel({ title, subtitle, children, action }: { title: string; subtitle?: string; children: ReactNode; action?: ReactNode }) {
  return (
    <section className="rounded-xl border border-white/5 bg-white/[0.02]">
      <header className="flex items-center gap-3 border-b border-white/5 px-4 py-3">
        <h2 className="text-sm font-medium">{title}</h2>
        {subtitle && <span className="truncate text-xs text-zinc-500">{subtitle}</span>}
        <div className="ml-auto">{action}</div>
      </header>
      <div className="p-4">{children}</div>
    </section>
  );
}

const Empty = ({ children }: { children: ReactNode }) => <p className="text-xs text-zinc-500">{children}</p>;

function AgentRow({ agent }: { agent: Data["agents"][number] }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const active = agent.status === "active";
  const toggle = async () => {
    setBusy(true);
    try {
      await setAgentStatusFn({
        data: { agent_id: agent.agent_id, status: active ? "suspended" : "active", reason: active ? "Suspended by KYA operator" : "Reinstated by KYA operator" },
      });
      await router.invalidate();
    } finally {
      setBusy(false);
    }
  };
  const m = agent.mandate;
  return (
    <div className="space-y-3">
      <div className="flex items-start gap-3">
        <div className="grid h-9 w-9 place-items-center rounded-lg bg-indigo-500/15 text-xs font-semibold text-indigo-300">AT</div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="font-medium">{agent.display_name}</span>
            <span className="font-mono text-xs text-zinc-500">{agent.agent_id}</span>
            <span className={`rounded px-1.5 py-0.5 text-[10px] font-semibold ${active ? "bg-emerald-500/15 text-emerald-300" : "bg-red-500/15 text-red-300"}`}>{agent.status.toUpperCase()}</span>
          </div>
          <div className="text-xs text-zinc-500">
            Operator {agent.operator} · principal {agent.principal_name} ({agent.principal_id})
          </div>
          {agent.status_reason && <div className="text-xs text-zinc-500">Reason: {agent.status_reason}</div>}
        </div>
        <button
          disabled={busy}
          onClick={toggle}
          className={`rounded-md px-3 py-1.5 text-xs font-medium disabled:opacity-50 ${active ? "border border-red-500/30 text-red-300 hover:bg-red-500/10" : "bg-emerald-500 text-black hover:bg-emerald-400"}`}
        >
          {active ? "Suspend" : "Reactivate"}
        </button>
      </div>
      <dl className="grid grid-cols-[110px_1fr] gap-x-3 gap-y-1 font-mono text-[11px]">
        <dt className="text-zinc-500">key</dt>
        <dd className="truncate text-zinc-300">
          {agent.key_id} · Ed25519 x={agent.public_key_x}
        </dd>
        <dt className="text-zinc-500">delegation</dt>
        <dd className="truncate text-zinc-400">{agent.credential_preview}</dd>
        {m && (
          <>
            <dt className="text-zinc-500">mandate</dt>
            <dd className="text-zinc-300">
              {m.mandate_id} · ≤{formatEur(m.max_total_cents)} · ≤{formatEur(m.max_nightly_cents)}/night · auto ≤{formatEur(m.autonomous_limit_cents)} · MCC {m.allowed_mccs.join(",")} · EU
            </dd>
          </>
        )}
      </dl>
    </div>
  );
}

const APPROVAL_STYLE: Record<string, string> = {
  pending: "text-amber-300",
  approved: "text-emerald-300",
  consumed: "text-zinc-400",
  rejected: "text-red-300",
  expired: "text-zinc-500",
};

function ApprovalRow({ approval }: { approval: Data["approvals"][number] }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const decide = async (decision: "approved" | "rejected") => {
    setBusy(true);
    try {
      await decideApprovalFn({ data: { approval_id: approval.approval_id, decision } });
      await router.invalidate();
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="flex items-center gap-3 rounded-lg border border-white/5 px-3 py-2">
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2 text-sm">
          <span>{approval.hotel_name}</span>
          <span className="text-zinc-400">{formatEur(approval.amount_cents)}</span>
          <span className={`text-[11px] ${APPROVAL_STYLE[approval.status]}`}>{approval.status}</span>
        </div>
        <div className="truncate font-mono text-[11px] text-zinc-500">
          {approval.approval_id} · {approval.reason}
        </div>
      </div>
      {approval.status === "pending" && (
        <div className="flex shrink-0 gap-1.5">
          <button disabled={busy} onClick={() => decide("approved")} className="rounded-md bg-amber-400 px-2.5 py-1 text-xs font-medium text-black hover:bg-amber-300 disabled:opacity-50">
            Approve
          </button>
          <button disabled={busy} onClick={() => decide("rejected")} className="rounded-md border border-white/10 px-2.5 py-1 text-xs text-zinc-300 hover:bg-white/5 disabled:opacity-50">
            Reject
          </button>
        </div>
      )}
    </div>
  );
}

function AttackSuite() {
  const router = useRouter();
  const [results, setResults] = useState<AttackResults | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = async () => {
    setBusy(true);
    setError(null);
    try {
      setResults(await runAttackSuiteFn());
      await router.invalidate();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const passed = results?.filter((r) => r.pass).length ?? 0;
  return (
    <Panel
      title="Adversarial checks"
      subtitle="Sends genuinely forged, tampered, stale and replayed intents to the live verifier"
      action={
        <button onClick={run} disabled={busy} className="rounded-md border border-white/10 px-3 py-1.5 text-xs hover:bg-white/5 disabled:opacity-50">
          {busy ? "Running…" : "Run attack suite"}
        </button>
      }
    >
      {error && <p className="text-xs text-red-300">{error}</p>}
      {!results ? (
        <Empty>Not run yet. Each case is recorded in the ledger.</Empty>
      ) : (
        <>
          <p className="mb-2 text-xs text-zinc-400">
            {passed}/{results.length} attacks stopped as expected
          </p>
          <div className="grid gap-1.5 md:grid-cols-2">
            {results.map((r) => (
              <div key={r.name} className="flex items-start gap-2 rounded-md border border-white/5 px-3 py-2 text-xs">
                <span className={r.pass ? "text-emerald-400" : "text-red-400"}>{r.pass ? "✓" : "✗"}</span>
                <div className="min-w-0 flex-1">
                  <div className="flex gap-2">
                    <span className="font-mono text-zinc-200">{r.name}</span>
                    <span className="text-zinc-500">→ {r.got}</span>
                  </div>
                  <div className="text-zinc-500">{r.description}</div>
                  <div className="truncate font-mono text-[11px] text-zinc-600" title={r.reason}>
                    {r.reason}
                  </div>
                </div>
              </div>
            ))}
          </div>
        </>
      )}
    </Panel>
  );
}

function Ledger({ ledger }: { ledger: Data["ledger"] }) {
  const [chain, setChain] = useState<ChainResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState<number | null>(null);
  const verify = async () => {
    setBusy(true);
    try {
      setChain(await verifyChainFn());
    } finally {
      setBusy(false);
    }
  };
  return (
    <Panel
      title="Audit ledger"
      subtitle="SHA-256 hash chain from GENESIS · append-only"
      action={
        <div className="flex items-center gap-3">
          {chain && (
            <span className={`text-xs ${chain.ok ? "text-emerald-400" : "text-red-400"}`}>
              {chain.ok ? `✓ chain intact · ${chain.entries} entries · head ${chain.head.slice(0, 12)}` : `✗ ${chain.error}`}
            </span>
          )}
          <button onClick={verify} disabled={busy} className="rounded-md border border-white/10 px-3 py-1.5 text-xs hover:bg-white/5 disabled:opacity-50">
            {busy ? "Verifying…" : "Verify chain"}
          </button>
        </div>
      }
    >
      {ledger.length === 0 ? (
        <Empty>Empty ledger.</Empty>
      ) : (
        <div className="scrollbar-thin max-h-[520px] overflow-y-auto">
          <table className="w-full text-left font-mono text-[11px]">
            <thead className="sticky top-0 bg-[#0e0f12] text-zinc-500">
              <tr>
                {["#", "time", "actor", "event", "prev_hash", "hash"].map((h) => (
                  <th key={h} className="px-2 py-1.5 font-normal">
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {ledger.map((e) => (
                <LedgerRow key={e.seq} e={e} open={open === e.seq} onToggle={() => setOpen(open === e.seq ? null : e.seq)} />
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Panel>
  );
}

function LedgerRow({ e, open, onToggle }: { e: Data["ledger"][number]; open: boolean; onToggle: () => void }) {
  const decision = (e.payload as any)?.decision as string | undefined;
  return (
    <>
      <tr onClick={onToggle} className="cursor-pointer border-t border-white/5 text-zinc-300 hover:bg-white/[0.03]">
        <td className="px-2 py-1.5 text-zinc-500">{e.seq}</td>
        <td className="px-2 py-1.5 text-zinc-500">{new Date(e.ts).toLocaleTimeString()}</td>
        <td className="px-2 py-1.5">{e.actor}</td>
        <td className="px-2 py-1.5">
          {e.event_type}
          {decision && <span className={`ml-2 ${decision === "ALLOW" ? "text-emerald-400" : decision === "DENY" ? "text-red-400" : "text-amber-300"}`}>{decision}</span>}
        </td>
        <td className="px-2 py-1.5 text-zinc-600">{e.prev_hash.slice(0, 12)}</td>
        <td className="px-2 py-1.5 text-zinc-400">{e.hash.slice(0, 12)}</td>
      </tr>
      {open && (
        <tr className="bg-black/20">
          <td colSpan={6} className="px-3 py-2">
            <pre className="scrollbar-thin max-h-72 overflow-auto whitespace-pre-wrap break-all text-[10.5px] text-zinc-400">{JSON.stringify(e.payload, null, 2)}</pre>
          </td>
        </tr>
      )}
    </>
  );
}
