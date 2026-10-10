import { createFileRoute } from "@tanstack/react-router";
import { AgentPanel } from "~/components/AgentPanel";
import { useAgent } from "~/components/useAgent";
import { HOTELS, MANDATE, buildOffer, evaluateMandateLimits, formatEur, type Hotel } from "~/lib/domain";
import { getAgentStatusFn } from "~/server/fns";

export const Route = createFileRoute("/")({
  loader: () => getAgentStatusFn(),
  component: Home,
});

function Home() {
  const status = Route.useLoaderData();
  const agent = useAgent();
  const warning = !status.llm_configured
    ? "ANTHROPIC_API_KEY is not set on the server — add it to .env and restart to run Atlas."
    : status.status !== "active"
      ? `Atlas is ${status.status} in the KYA registry. Payment intents will be denied until it is reactivated in the KYA Console.`
      : null;

  return (
    <main className="mx-auto grid max-w-[1500px] gap-6 px-4 py-6 sm:px-6 lg:h-[calc(100vh-3.5rem)] lg:grid-cols-[minmax(0,1fr)_minmax(0,560px)]">
      <section className="min-h-0 lg:overflow-y-auto lg:pr-1 scrollbar-thin">
        <MandateCard />
        <div className="mt-5 mb-3 flex items-baseline justify-between">
          <h2 className="text-sm font-medium text-zinc-300">Milan · 15–17 Nov 2026 · 2 nights</h2>
          <span className="text-xs text-zinc-500">6 offers · badges are a client-side preview; KYA decides</span>
        </div>
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
          {HOTELS.map((h) => (
            <HotelCard key={h.id} hotel={h} disabled={agent.running} onBook={() => agent.send(`Book ${h.name} for my Milan trip.`)} />
          ))}
        </div>
      </section>
      <section className="order-first h-[85vh] min-h-[600px] lg:order-none lg:h-auto lg:min-h-0">
        <AgentPanel agent={agent} warning={warning} />
      </section>
    </main>
  );
}

function MandateCard() {
  const m = MANDATE;
  const items = [
    ["Max total", formatEur(m.max_total_cents)],
    ["Max / night", formatEur(m.max_nightly_cents)],
    ["Autonomous", `≤ ${formatEur(m.autonomous_limit_cents)}`],
    ["Merchants", "EU only"],
    ["MCC", m.allowed_mccs.join(", ") + " · Hotels"],
  ];
  return (
    <div className="rounded-xl border border-white/5 bg-gradient-to-br from-indigo-500/[0.07] to-transparent p-4">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <span className="text-xs uppercase tracking-wider text-zinc-500">Mandate</span>
        <span className="font-mono text-xs text-zinc-300">{m.mandate_id}</span>
        <span className="text-xs text-zinc-500">
          {m.principal_name} → Atlas (agt_atlas_001)
        </span>
      </div>
      <div className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-5">
        {items.map(([k, v]) => (
          <div key={k}>
            <div className="text-[11px] text-zinc-500">{k}</div>
            <div className="text-sm font-medium text-zinc-100">{v}</div>
          </div>
        ))}
      </div>
      <p className="mt-3 text-xs text-zinc-500">Above {formatEur(m.autonomous_limit_cents)} Atlas needs Alex's step-up approval. Anything outside the mandate is denied.</p>
    </div>
  );
}

const BADGE = {
  ALLOW: { label: "Within mandate", cls: "text-emerald-300 bg-emerald-500/10 border-emerald-500/25" },
  STEP_UP_APPROVAL: { label: "Needs approval", cls: "text-amber-300 bg-amber-500/10 border-amber-500/25" },
  DENY: { label: "Prohibited", cls: "text-red-300 bg-red-500/10 border-red-500/25" },
} as const;

function HotelCard({ hotel, onBook, disabled }: { hotel: Hotel; onBook: () => void; disabled: boolean }) {
  const offer = buildOffer(hotel, MANDATE.check_in, MANDATE.check_out)!;
  const policy = evaluateMandateLimits(offer, MANDATE);
  const badge = BADGE[policy.outcome];
  const why = policy.outcome === "DENY" ? policy.checks.filter((c) => !c.ok && c.name !== "autonomous_limit").map((c) => c.detail)[0] : null;
  return (
    <article className="flex flex-col overflow-hidden rounded-xl border border-white/5 bg-white/[0.02]">
      <div
        className="relative h-24"
        style={{ background: `linear-gradient(135deg, hsl(${hotel.hue} 45% 22%), hsl(${(hotel.hue + 40) % 360} 35% 10%))` }}
      >
        <span className={`absolute right-2 top-2 rounded border px-1.5 py-0.5 text-[10px] font-medium ${badge.cls}`}>{badge.label}</span>
        <span className="absolute bottom-2 left-3 text-xs text-white/70">{"★".repeat(hotel.stars)}</span>
      </div>
      <div className="flex flex-1 flex-col p-3">
        <div className="flex items-start justify-between gap-2">
          <div>
            <h3 className="text-sm font-medium text-zinc-100">{hotel.name}</h3>
            <p className="text-xs text-zinc-500">
              {hotel.neighborhood} · {hotel.rating.toFixed(1)}
            </p>
          </div>
          <div className="text-right">
            <div className="text-sm font-medium">{formatEur(offer.amount_cents)}</div>
            <div className="text-[11px] text-zinc-500">{formatEur(hotel.nightly_cents)} / night</div>
          </div>
        </div>
        <p className="mt-2 text-xs leading-relaxed text-zinc-400">{hotel.blurb}</p>
        <div className="mt-2 font-mono text-[10.5px] text-zinc-500">
          {hotel.merchant.legal_name} · {hotel.merchant.country} · MCC {hotel.merchant.mcc}
        </div>
        {why && <div className="mt-1 text-[11px] text-red-300/80">{why}</div>}
        <button
          onClick={onBook}
          disabled={disabled}
          className="mt-3 rounded-md border border-white/10 py-1.5 text-xs text-zinc-300 hover:border-indigo-400/50 hover:text-white disabled:opacity-40"
        >
          Ask Atlas to book
        </button>
      </div>
    </article>
  );
}
