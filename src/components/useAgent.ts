import { useCallback, useRef, useState } from "react";
import type { Actor, AgentEvent, LedgerEntryView } from "~/lib/domain";

export type StreamItem =
  | { kind: "user"; id: string; text: string }
  | { kind: "text"; id: string; text: string }
  | { kind: "thinking"; id: string; text: string }
  | { kind: "tool"; id: string; name: string; input: unknown; output?: unknown; is_error?: boolean }
  | { kind: "ledger"; id: string; entry: LedgerEntryView }
  | { kind: "error"; id: string; message: string };

export interface Hop {
  id: number;
  from: Actor;
  to: Actor;
  at: number;
  tone: "neutral" | "ok" | "warn" | "bad";
}

const TOOL_PATHS: Record<string, Actor[]> = {
  search_hotels: ["agent", "gateway", "merchant"],
  evaluate_offers: ["agent", "agent"],
  verify_authority: ["agent", "gateway", "kya"],
  authorize_payment: ["agent", "gateway", "psp", "network"],
  confirm_booking: ["agent", "gateway", "merchant"],
};

let seq = 0;
const nid = () => `i${++seq}`;

export function useAgent() {
  const [items, setItems] = useState<StreamItem[]>([]);
  const [running, setRunning] = useState(false);
  const [hops, setHops] = useState<Hop[]>([]);
  const [nodeState, setNodeState] = useState<Partial<Record<Actor, "ok" | "warn" | "bad">>>({});
  const history = useRef<unknown[]>([]);
  const abortRef = useRef<AbortController | null>(null);
  const hopSeq = useRef(0);

  const pulse = useCallback((path: Actor[], tone: Hop["tone"] = "neutral") => {
    const at = Date.now();
    const next: Hop[] = [];
    for (let i = 0; i < path.length - 1; i++) {
      if (path[i] === path[i + 1]) continue;
      next.push({ id: ++hopSeq.current, from: path[i], to: path[i + 1], at: at + i * 180, tone });
    }
    setHops((h) => [...h.filter((x) => Date.now() - x.at < 4000), ...next]);
  }, []);

  const onEvent = useCallback(
    (ev: AgentEvent) => {
      switch (ev.type) {
        case "text":
        case "thinking":
          setItems((prev) => {
            const last = prev[prev.length - 1];
            if (last && last.kind === ev.type) return [...prev.slice(0, -1), { ...last, text: last.text + ev.delta }];
            return [...prev, { kind: ev.type, id: nid(), text: ev.delta }];
          });
          break;
        case "tool-call":
          setItems((prev) => [...prev, { kind: "tool", id: ev.id, name: ev.name, input: ev.input }]);
          pulse(TOOL_PATHS[ev.name] ?? ["agent", "gateway"]);
          break;
        case "tool-result": {
          setItems((prev) => prev.map((it) => (it.kind === "tool" && it.id === ev.id ? { ...it, output: ev.output, is_error: ev.is_error } : it)));
          const out = ev.output as Record<string, unknown>;
          const path = [...(TOOL_PATHS[ev.name] ?? ["agent"])].reverse();
          if (ev.name === "verify_authority") {
            const tone = out?.decision === "ALLOW" ? "ok" : out?.decision === "STEP_UP_APPROVAL" ? "warn" : "bad";
            setNodeState((s) => ({ ...s, kya: tone }));
            pulse(path, tone);
            if (out?.decision === "STEP_UP_APPROVAL") pulse(["kya", "principal"], "warn");
          } else if (ev.is_error) {
            setNodeState((s) => ({ ...s, gateway: "bad" }));
            pulse(path, "bad");
          } else {
            if (ev.name === "authorize_payment") setNodeState((s) => ({ ...s, psp: "ok", network: "ok" }));
            if (ev.name === "confirm_booking") setNodeState((s) => ({ ...s, merchant: "ok" }));
            pulse(path, "ok");
          }
          break;
        }
        case "ledger":
          setItems((prev) => [...prev, { kind: "ledger", id: nid(), entry: ev.entry }]);
          pulse([ev.entry.actor, "audit"]);
          break;
        case "error":
          setItems((prev) => [...prev, { kind: "error", id: nid(), message: ev.message }]);
          break;
        case "done":
          history.current = ev.messages;
          break;
      }
    },
    [pulse],
  );

  const send = useCallback(
    async (text: string) => {
      const trimmed = text.trim();
      if (!trimmed || abortRef.current) return;
      setItems((prev) => [...prev, { kind: "user", id: nid(), text: trimmed }]);
      setNodeState({});
      pulse(["principal", "agent"]);
      setRunning(true);
      const controller = new AbortController();
      abortRef.current = controller;
      const messages = [...history.current, { role: "user", content: trimmed }];
      try {
        const res = await fetch("/api/agent", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ messages }),
          signal: controller.signal,
        });
        if (!res.ok || !res.body) {
          const err = await res.json().catch(() => ({ error: res.statusText }));
          throw new Error(err.error ?? `HTTP ${res.status}`);
        }
        const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
        let buf = "";
        let sawDone = false;
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          buf += value;
          let nl: number;
          while ((nl = buf.indexOf("\n")) >= 0) {
            const line = buf.slice(0, nl).trim();
            buf = buf.slice(nl + 1);
            if (!line) continue;
            const ev = JSON.parse(line) as AgentEvent;
            if (ev.type === "done") sawDone = true;
            onEvent(ev);
          }
        }
        // If the run failed before finishing, keep the user's turn so context isn't lost.
        if (!sawDone) history.current = messages;
      } catch (err) {
        if ((err as Error).name !== "AbortError") onEvent({ type: "error", message: (err as Error).message });
        history.current = messages;
      } finally {
        abortRef.current = null;
        setRunning(false);
      }
    },
    [onEvent, pulse],
  );

  const stop = useCallback(() => abortRef.current?.abort(), []);
  const reset = useCallback(() => {
    abortRef.current?.abort();
    history.current = [];
    setItems([]);
    setHops([]);
    setNodeState({});
  }, []);

  return { items, running, hops, nodeState, send, stop, reset, pulse };
}
