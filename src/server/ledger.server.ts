import { AsyncLocalStorage } from "node:async_hooks";
import type pg from "pg";
import type { Actor, LedgerEntryView } from "~/lib/domain";
import { canonicalJson, sha256Hex } from "./crypto.server";
import { db, withTx } from "./db.server";

// Hash-chained, append-only audit ledger. Every entry commits to the previous
// entry's hash; the first entry's prev_hash is "GENESIS". Only server code
// writes here (and the table rejects UPDATE/DELETE at the database level).

export const GENESIS = "GENESIS";
const LEDGER_LOCK_KEY = 0x4b5941; // "KYA" – serialises appends so the chain never forks

interface LedgerContext {
  runId?: string;
  onEntry?: (entry: LedgerEntryView) => void;
}
const ledgerContext = new AsyncLocalStorage<LedgerContext>();

/** Run `fn` with a listener that sees every ledger entry appended inside it. */
export function withLedgerContext<T>(ctx: LedgerContext, fn: () => Promise<T>): Promise<T> {
  return ledgerContext.run(ctx, fn);
}

export interface LedgerInput {
  event_type: string;
  actor: Actor;
  agent_id?: string | null;
  payload: Record<string, unknown>;
}

export function computeEntryHash(e: {
  seq: number;
  ts: string;
  event_type: string;
  actor: string;
  agent_id: string | null;
  run_id: string | null;
  payload: unknown;
  prev_hash: string;
}): string {
  return sha256Hex(
    canonicalJson({
      seq: e.seq,
      ts: e.ts,
      event_type: e.event_type,
      actor: e.actor,
      agent_id: e.agent_id,
      run_id: e.run_id,
      payload: e.payload,
      prev_hash: e.prev_hash,
    }),
  );
}

function rowToView(r: any): LedgerEntryView {
  return {
    seq: Number(r.seq),
    ts: new Date(r.ts).toISOString(),
    event_type: r.event_type,
    actor: r.actor,
    agent_id: r.agent_id,
    run_id: r.run_id,
    payload: r.payload,
    prev_hash: r.prev_hash,
    hash: r.hash,
  };
}

async function appendWith(client: pg.PoolClient, input: LedgerInput, runId: string | null): Promise<LedgerEntryView> {
  await client.query("SELECT pg_advisory_xact_lock($1)", [LEDGER_LOCK_KEY]);
  const last = await client.query("SELECT seq, hash FROM kya_ledger ORDER BY seq DESC LIMIT 1");
  const prevHash: string = last.rows[0]?.hash ?? GENESIS;
  const seqRow = await client.query("SELECT nextval(pg_get_serial_sequence('kya_ledger', 'seq')) AS seq");
  const seq = Number(seqRow.rows[0].seq);
  const ts = new Date().toISOString();
  // Round-trip the payload through JSON so the hash covers exactly what jsonb stores.
  const payload = JSON.parse(JSON.stringify(input.payload));
  const entry = {
    seq,
    ts,
    event_type: input.event_type,
    actor: input.actor,
    agent_id: input.agent_id ?? null,
    run_id: runId,
    payload,
    prev_hash: prevHash,
  };
  const hash = computeEntryHash(entry);
  const res = await client.query(
    `INSERT INTO kya_ledger (seq, ts, event_type, actor, agent_id, run_id, payload, prev_hash, hash)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING *`,
    [seq, ts, entry.event_type, entry.actor, entry.agent_id, entry.run_id, JSON.stringify(payload), prevHash, hash],
  );
  return rowToView(res.rows[0]);
}

/** Append an entry in its own transaction and notify the run's listener. */
export async function appendLedger(input: LedgerInput): Promise<LedgerEntryView> {
  const runId = ledgerContext.getStore()?.runId ?? null;
  const entry = await withTx((c) => appendWith(c, input, runId));
  emitLedger(entry);
  return entry;
}

/**
 * Append inside a caller's transaction (e.g. together with a booking insert).
 * The caller must pass the returned entries to emitLedger() after COMMIT.
 */
export async function appendLedgerTx(client: pg.PoolClient, input: LedgerInput): Promise<LedgerEntryView> {
  return appendWith(client, input, ledgerContext.getStore()?.runId ?? null);
}

export function emitLedger(...entries: LedgerEntryView[]): void {
  const ctx = ledgerContext.getStore();
  for (const e of entries) ctx?.onEntry?.(e);
}

export async function listLedger(limit = 200): Promise<LedgerEntryView[]> {
  const res = await db().query("SELECT * FROM kya_ledger ORDER BY seq DESC LIMIT $1", [limit]);
  return res.rows.map(rowToView);
}

export interface ChainVerification {
  ok: boolean;
  entries: number;
  head: string;
  checked_at: string;
  first_bad_seq: number | null;
  error: string | null;
}

/** Recompute every hash from GENESIS and check each link. */
export async function verifyChain(): Promise<ChainVerification> {
  const res = await db().query("SELECT * FROM kya_ledger ORDER BY seq ASC");
  let prev = GENESIS;
  let count = 0;
  for (const raw of res.rows) {
    const e = rowToView(raw);
    count++;
    if (e.prev_hash !== prev) {
      return { ok: false, entries: count, head: prev, checked_at: new Date().toISOString(), first_bad_seq: e.seq, error: `seq ${e.seq}: prev_hash does not link to the previous entry` };
    }
    const recomputed = computeEntryHash(e);
    if (recomputed !== e.hash) {
      return { ok: false, entries: count, head: prev, checked_at: new Date().toISOString(), first_bad_seq: e.seq, error: `seq ${e.seq}: content hash mismatch (entry was altered)` };
    }
    prev = e.hash;
  }
  return { ok: true, entries: count, head: prev, checked_at: new Date().toISOString(), first_bad_seq: null, error: null };
}
