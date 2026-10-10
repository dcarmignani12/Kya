import { useEffect, useState } from "react";
import type { Actor } from "~/lib/domain";
import type { Hop } from "./useAgent";

const NODES: { id: Actor; label: string; sub: string }[] = [
  { id: "principal", label: "Principal", sub: "Alex Morgan" },
  { id: "agent", label: "Agent", sub: "Atlas" },
  { id: "gateway", label: "Gateway", sub: "AgentTrip" },
  { id: "kya", label: "KYA", sub: "Verifier" },
  { id: "merchant", label: "Merchant", sub: "Hotels" },
  { id: "psp", label: "PSP", sub: "Acquirer" },
  { id: "network", label: "Network", sub: "Card rails" },
  { id: "audit", label: "Audit", sub: "Ledger" },
];

const W = 800;
const Y = 80;
const x = (i: number) => 50 + i * 100;
const idx = (a: Actor) => NODES.findIndex((n) => n.id === a);

const TONE: Record<Hop["tone"], string> = {
  neutral: "#818cf8",
  ok: "#34d399",
  warn: "#fbbf24",
  bad: "#f87171",
};

export function ConnectionView({ hops, nodeState }: { hops: Hop[]; nodeState: Partial<Record<Actor, "ok" | "warn" | "bad">> }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 120);
    return () => clearInterval(t);
  }, []);

  const live = hops.filter((h) => now >= h.at && now - h.at < 2200);
  const activeNodes = new Set<Actor>();
  for (const h of live) {
    activeNodes.add(h.from);
    activeNodes.add(h.to);
  }

  return (
    <div className="rounded-xl border border-white/5 bg-white/[0.02] p-3">
      <div className="mb-1 flex items-center justify-between px-1">
        <span className="text-[11px] font-medium uppercase tracking-wider text-zinc-500">Connection view</span>
        <span className="text-[11px] text-zinc-600">live hops · last 2s</span>
      </div>
      <svg viewBox={`0 0 ${W} 160`} className="w-full" role="img" aria-label="Principal, Agent, Gateway, KYA, Merchant, PSP, Network and Audit connection graph">
        <line x1={x(0)} y1={Y} x2={x(7)} y2={Y} stroke="#25272c" strokeWidth={1.5} />
        {live.map((h) => {
          const a = idx(h.from);
          const b = idx(h.to);
          if (a < 0 || b < 0) return null;
          const span = Math.abs(b - a);
          const toAudit = h.to === "audit" || h.from === "audit";
          const lift = span <= 1 ? 0 : 18 + span * 7;
          const cy = Y - lift;
          const age = (now - h.at) / 2200;
          return (
            <path
              key={h.id}
              d={`M ${x(a)} ${Y} Q ${(x(a) + x(b)) / 2} ${cy} ${x(b)} ${Y}`}
              fill="none"
              stroke={TONE[h.tone]}
              strokeWidth={toAudit ? 1.25 : 2}
              strokeOpacity={Math.max(0.15, 1 - age)}
              className="edge-active"
            />
          );
        })}
        {NODES.map((n, i) => {
          const state = nodeState[n.id];
          const active = activeNodes.has(n.id);
          const ring = state === "ok" ? "#34d399" : state === "warn" ? "#fbbf24" : state === "bad" ? "#f87171" : active ? "#818cf8" : "#33363d";
          return (
            <g key={n.id}>
              {active && <circle cx={x(i)} cy={Y} r={27} fill={ring} opacity={0.12} />}
              <circle cx={x(i)} cy={Y} r={18} fill="#111317" stroke={ring} strokeWidth={active || state ? 2 : 1.25} />
              <text x={x(i)} y={Y + 5} textAnchor="middle" fontSize={13} fill={active ? "#e4e4e7" : "#a1a1aa"} fontWeight={600}>
                {n.label.slice(0, 2).toUpperCase()}
              </text>
              <text x={x(i)} y={Y + 40} textAnchor="middle" fontSize={15} fill="#d4d4d8">
                {n.label}
              </text>
              <text x={x(i)} y={Y + 58} textAnchor="middle" fontSize={12.5} fill="#71717a">
                {n.sub}
              </text>
            </g>
          );
        })}
      </svg>
    </div>
  );
}
