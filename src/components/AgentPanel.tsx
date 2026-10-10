import { useEffect, useRef, useState } from "react";
import { decideApprovalFn } from "~/server/fns";
import { ConnectionView } from "./ConnectionView";
import type { StreamItem, useAgent } from "./useAgent";

type Agent = ReturnType<typeof useAgent>;

const SUGGESTIONS = [
  "Book the best-rated hotel that fits my mandate",
  "Book the Duomo Grand Palazzo",
  "Try to book Porta Nuova Sky Suites",
  "Find the cheapest compliant option and book it",
];

export function AgentPanel({ agent, warning }: { agent: Agent; warning?: string | null }) {
  const [input, setInput] = useState("");
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [agent.items]);

  const submit = (text: string) => {
    if (!text.trim() || agent.running) return;
    agent.send(text);
    setInput("");
  };

  return (
    <div className="flex h-full min-h-0 flex-col gap-3">
      <ConnectionView hops={agent.hops} nodeState={agent.nodeState} />

      <div className="flex min-h-0 flex-1 flex-col rounded-xl border border-white/5 bg-white/[0.02]">
        <div className="flex items-center justify-between border-b border-white/5 px-4 py-2.5">
          <div className="flex items-center gap-2 text-sm">
            <span className={`h-2 w-2 rounded-full ${agent.running ? "animate-pulse bg-indigo-400" : "bg-zinc-600"}`} />
            <span className="font-medium">Atlas</span>
            <span className="font-mono text-xs text-zinc-500">agt_atlas_001</span>
          </div>
          <div className="flex gap-2 text-xs">
            {agent.running && (
              <button onClick={agent.stop} className="rounded-md px-2 py-1 text-zinc-400 hover:bg-white/5 hover:text-zinc-100">
                Stop
              </button>
            )}
            <button onClick={agent.reset} className="rounded-md px-2 py-1 text-zinc-400 hover:bg-white/5 hover:text-zinc-100">
              New session
            </button>
          </div>
        </div>

        <div ref={scrollRef} className="scrollbar-thin min-h-0 flex-1 space-y-2 overflow-y-auto px-4 py-3 text-sm">
          {warning && <div className="rounded-lg border border-amber-500/20 bg-amber-500/5 px-3 py-2 text-xs text-amber-200">{warning}</div>}
          {agent.items.length === 0 && (
            <div className="py-6 text-center text-zinc-500">
              <p className="mb-1 text-zinc-300">Tell Atlas what to book.</p>
              <p className="text-xs">Every payment intent is Ed25519-signed and checked by KYA against Alex's mandate.</p>
            </div>
          )}
          {agent.items.map((item) => (
            <Item key={item.id} item={item} agent={agent} />
          ))}
          {agent.running && <div className="animate-pulse text-xs text-zinc-500">Atlas is working…</div>}
        </div>

        <div className="border-t border-white/5 p-3">
          <div className="mb-2 flex flex-wrap gap-1.5">
            {SUGGESTIONS.map((s) => (
              <button
                key={s}
                disabled={agent.running}
                onClick={() => submit(s)}
                className="rounded-full border border-white/10 px-2.5 py-1 text-xs text-zinc-400 hover:border-white/20 hover:text-zinc-100 disabled:opacity-40"
              >
                {s}
              </button>
            ))}
          </div>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              submit(input);
            }}
            className="flex gap-2"
          >
            <input
              value={input}
              onChange={(e) => setInput(e.target.value)}
              placeholder="Free-form instructions, e.g. “somewhere quiet near Brera, breakfast included”"
              className="min-w-0 flex-1 rounded-lg border border-white/10 bg-black/30 px-3 py-2 text-sm outline-none placeholder:text-zinc-600 focus:border-indigo-400/60"
            />
            <button disabled={agent.running || !input.trim()} className="rounded-lg bg-indigo-500 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-400 disabled:opacity-40">
              Send
            </button>
          </form>
        </div>
      </div>
    </div>
  );
}

function Item({ item, agent }: { item: StreamItem; agent: Agent }) {
  switch (item.kind) {
    case "user":
      return (
        <div className="flex justify-end">
          <div className="max-w-[85%] rounded-lg bg-indigo-500/15 px-3 py-2 text-indigo-100">{item.text}</div>
        </div>
      );
    case "text":
      return <div className="whitespace-pre-wrap leading-relaxed text-zinc-200">{item.text}</div>;
    case "thinking":
      return (
        <details className="text-xs text-zinc-500">
          <summary className="cursor-pointer select-none">thinking</summary>
          <div className="mt-1 whitespace-pre-wrap border-l border-white/10 pl-3">{item.text}</div>
        </details>
      );
    case "error":
      return <div className="rounded-lg border border-red-500/20 bg-red-500/5 px-3 py-2 text-xs text-red-300">{item.message}</div>;
    case "ledger":
      return (
        <div className="flex items-center gap-2 font-mono text-[11px] text-zinc-500">
          <span className="text-zinc-600">#{item.entry.seq}</span>
          <span className="rounded bg-white/5 px-1.5 text-zinc-400">{item.entry.actor}</span>
          <span className="truncate">{item.entry.event_type}</span>
          <span className="ml-auto shrink-0 text-zinc-600" title={item.entry.hash}>
            {item.entry.hash.slice(0, 10)}
          </span>
        </div>
      );
    case "tool":
      return <ToolCard item={item} agent={agent} />;
  }
}

const DECISION_STYLE: Record<string, string> = {
  ALLOW: "bg-emerald-500/15 text-emerald-300 border-emerald-500/30",
  STEP_UP_APPROVAL: "bg-amber-500/15 text-amber-300 border-amber-500/30",
  DENY: "bg-red-500/15 text-red-300 border-red-500/30",
};

function ToolCard({ item, agent }: { item: Extract<StreamItem, { kind: "tool" }>; agent: Agent }) {
  const out = item.output as Record<string, any> | undefined;
  const pending = item.output === undefined;
  return (
    <div className="rounded-lg border border-white/5 bg-black/20">
      <div className="flex items-center gap-2 px-3 py-2">
        <span className="font-mono text-xs text-indigo-300">{item.name}</span>
        <span className="truncate font-mono text-[11px] text-zinc-500">{JSON.stringify(item.input)}</span>
        <span className="ml-auto shrink-0">
          {pending ? (
            <span className="text-[11px] text-zinc-500">running…</span>
          ) : out?.decision ? (
            <span className={`rounded border px-1.5 py-0.5 text-[10px] font-semibold ${DECISION_STYLE[out.decision]}`}>{out.decision}</span>
          ) : item.is_error ? (
            <span className="rounded border border-red-500/30 bg-red-500/15 px-1.5 py-0.5 text-[10px] font-semibold text-red-300">{out?.error ?? "ERROR"}</span>
          ) : (
            <span className="text-[11px] text-emerald-400">ok</span>
          )}
        </span>
      </div>
      {!pending && <ToolBody name={item.name} out={out!} isError={!!item.is_error} agent={agent} />}
    </div>
  );
}

function ToolBody({ name, out, isError, agent }: { name: string; out: Record<string, any>; isError: boolean; agent: Agent }) {
  if (isError) return <div className="border-t border-white/5 px-3 py-2 text-xs text-red-300">{out.reason ?? out.error ?? JSON.stringify(out)}</div>;
  if (name === "search_hotels")
    return <div className="border-t border-white/5 px-3 py-2 text-xs text-zinc-400">{out.offers?.length ?? 0} offers returned</div>;
  if (name === "evaluate_offers")
    return (
      <div className="space-y-0.5 border-t border-white/5 px-3 py-2 text-xs">
        {out.results?.map((r: any) => (
          <div key={r.offer_id} className="flex gap-2">
            <span className="w-40 shrink-0 truncate text-zinc-300">{r.hotel ?? r.offer_id}</span>
            <span className={r.predicted === "ALLOW" ? "text-emerald-400" : r.predicted === "DENY" ? "text-red-400" : "text-amber-400"}>{r.predicted}</span>
          </div>
        ))}
      </div>
    );
  if (name === "verify_authority")
    return (
      <div className="border-t border-white/5 px-3 py-2 text-xs">
        <div className="mb-1 text-zinc-300">
          {out.hotel} · {out.amount} — <span className="text-zinc-400">{out.reason}</span>
        </div>
        <ul className="space-y-0.5 font-mono text-[11px]">
          {out.checks?.map((c: string) => (
            <li key={c} className={c.startsWith("✓") ? "text-emerald-400/90" : c.startsWith("✗") ? "text-red-400" : "text-zinc-600"}>
              {c}
            </li>
          ))}
        </ul>
        {out.assertion_id && <div className="mt-1.5 font-mono text-[11px] text-zinc-500">assertion {out.assertion_id}</div>}
        {out.decision === "STEP_UP_APPROVAL" && out.approval_id && <ApprovalPrompt approvalId={out.approval_id} amount={out.amount} hotel={out.hotel} agent={agent} />}
      </div>
    );
  if (name === "authorize_payment")
    return (
      <div className="border-t border-white/5 px-3 py-2 font-mono text-[11px] text-zinc-400">
        {out.payment_id} · {out.amount} · auth {out.psp_auth_code} · {out.network_ref}
      </div>
    );
  if (name === "confirm_booking")
    return (
      <div className="border-t border-white/5 px-3 py-2 text-xs text-emerald-300">
        Confirmed {out.hotel} · <span className="font-mono">{out.confirmation_code}</span>
      </div>
    );
  return null;
}

function ApprovalPrompt({ approvalId, amount, hotel, agent }: { approvalId: string; amount: string; hotel: string; agent: Agent }) {
  const [state, setState] = useState<"idle" | "busy" | "approved" | "rejected" | "error">("idle");
  const [error, setError] = useState<string | null>(null);
  const decide = async (decision: "approved" | "rejected") => {
    setState("busy");
    try {
      await decideApprovalFn({ data: { approval_id: approvalId, decision } });
      setState(decision);
      agent.pulse(["principal", "kya"], decision === "approved" ? "ok" : "bad");
      agent.send(
        decision === "approved"
          ? `I approved step-up request ${approvalId}. Please continue with the booking.`
          : `I rejected step-up request ${approvalId}. Do not book that hotel.`,
      );
    } catch (err) {
      setState("error");
      setError((err as Error).message);
    }
  };
  return (
    <div className="mt-2 rounded-md border border-amber-500/25 bg-amber-500/5 p-2.5">
      <div className="mb-2 text-amber-200">
        Step-up required: approve {hotel} for {amount}? <span className="font-mono text-[11px] text-amber-300/70">{approvalId}</span>
      </div>
      {state === "idle" || state === "busy" ? (
        <div className="flex gap-2">
          <button disabled={state === "busy" || agent.running} onClick={() => decide("approved")} className="rounded-md bg-amber-400 px-3 py-1 text-xs font-medium text-black hover:bg-amber-300 disabled:opacity-50">
            Approve as Alex
          </button>
          <button disabled={state === "busy" || agent.running} onClick={() => decide("rejected")} className="rounded-md border border-white/10 px-3 py-1 text-xs text-zinc-300 hover:bg-white/5 disabled:opacity-50">
            Reject
          </button>
        </div>
      ) : (
        <div className="text-xs text-zinc-400">{state === "error" ? error : `You ${state} this request.`}</div>
      )}
    </div>
  );
}
