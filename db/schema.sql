-- AgentTrip / KYA schema. Idempotent: safe to run repeatedly.
--
-- Access model ("public read, server-only writes"):
--   * The app server connects as the database owner and is the only writer.
--   * `kya_public` is a read-only role (e.g. for a dashboard or PostgREST);
--     RLS grants it SELECT and nothing else.
--   * kya_ledger is append-only: UPDATE / DELETE / TRUNCATE are rejected by
--     triggers, for every role including the owner.

CREATE TABLE IF NOT EXISTS kya_agents (
  agent_id                text PRIMARY KEY,
  display_name            text NOT NULL,
  operator                text NOT NULL,
  principal_id            text NOT NULL,
  principal_name          text NOT NULL,
  key_id                  text NOT NULL,
  public_key_jwk          jsonb NOT NULL,           -- Ed25519 OKP JWK (public half only)
  principal_public_key_jwk jsonb NOT NULL,          -- verifies the delegation credential
  delegation_credential   text NOT NULL,            -- compact JWS signed by the principal
  status                  text NOT NULL DEFAULT 'active'
                          CHECK (status IN ('active', 'suspended', 'revoked')),
  status_reason           text,
  created_at              timestamptz NOT NULL DEFAULT now(),
  updated_at              timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS kya_ledger (
  seq         bigserial PRIMARY KEY,
  ts          timestamptz NOT NULL,
  event_type  text NOT NULL,
  actor       text NOT NULL,
  agent_id    text,
  run_id      text,
  payload     jsonb NOT NULL,
  prev_hash   text NOT NULL,
  hash        text NOT NULL UNIQUE
);
CREATE INDEX IF NOT EXISTS kya_ledger_event_idx ON kya_ledger (event_type);
CREATE INDEX IF NOT EXISTS kya_ledger_assertion_idx ON kya_ledger ((payload->>'assertion_id'));
CREATE INDEX IF NOT EXISTS kya_ledger_intent_jti_idx ON kya_ledger ((payload->>'intent_jti'));

CREATE TABLE IF NOT EXISTS kya_approvals (
  approval_id   text PRIMARY KEY,
  agent_id      text NOT NULL REFERENCES kya_agents(agent_id),
  principal_id  text NOT NULL,
  mandate_id    text NOT NULL,
  offer_id      text NOT NULL,
  hotel_name    text NOT NULL,
  amount_cents  integer NOT NULL,
  currency      text NOT NULL,
  intent_jti    text NOT NULL,
  reason        text NOT NULL,
  status        text NOT NULL DEFAULT 'pending'
                CHECK (status IN ('pending', 'approved', 'rejected', 'consumed', 'expired')),
  created_at    timestamptz NOT NULL DEFAULT now(),
  expires_at    timestamptz NOT NULL,
  decided_at    timestamptz,
  decided_by    text,
  consumed_at   timestamptz
);

CREATE TABLE IF NOT EXISTS kya_bookings (
  booking_id        text PRIMARY KEY,
  payment_id        text NOT NULL UNIQUE,
  assertion_id      text NOT NULL UNIQUE,     -- an ALLOW assertion can be spent exactly once
  agent_id          text NOT NULL REFERENCES kya_agents(agent_id),
  principal_id      text NOT NULL,
  mandate_id        text NOT NULL,
  approval_id       text REFERENCES kya_approvals(approval_id),
  offer_id          text NOT NULL,
  hotel_name        text NOT NULL,
  merchant_id       text NOT NULL,
  check_in          date NOT NULL,
  check_out         date NOT NULL,
  nights            integer NOT NULL,
  amount_cents      integer NOT NULL,
  currency          text NOT NULL,
  psp_auth_code     text NOT NULL,
  network_ref       text NOT NULL,
  confirmation_code text,
  status            text NOT NULL CHECK (status IN ('payment_authorized', 'confirmed')),
  created_at        timestamptz NOT NULL DEFAULT now(),
  confirmed_at      timestamptz
);

-- Append-only ledger.
CREATE OR REPLACE FUNCTION kya_ledger_immutable() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'kya_ledger is append-only (% rejected)', TG_OP;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS kya_ledger_no_update ON kya_ledger;
CREATE TRIGGER kya_ledger_no_update BEFORE UPDATE OR DELETE ON kya_ledger
  FOR EACH ROW EXECUTE FUNCTION kya_ledger_immutable();
DROP TRIGGER IF EXISTS kya_ledger_no_truncate ON kya_ledger;
CREATE TRIGGER kya_ledger_no_truncate BEFORE TRUNCATE ON kya_ledger
  FOR EACH STATEMENT EXECUTE FUNCTION kya_ledger_immutable();

-- Public read, server-only writes.
-- Creating the role needs CREATEROLE; if the app user lacks it, have a DBA run
-- `CREATE ROLE kya_public NOLOGIN;` once. RLS and write revocation apply regardless.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'kya_public') THEN
    CREATE ROLE kya_public NOLOGIN;
  END IF;
EXCEPTION WHEN insufficient_privilege THEN
  RAISE NOTICE 'kya_public role not created (no CREATEROLE privilege)';
END $$;

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['kya_agents', 'kya_ledger', 'kya_approvals', 'kya_bookings'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('REVOKE ALL ON %I FROM PUBLIC', t);
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'kya_public') THEN
      EXECUTE format('GRANT SELECT ON %I TO kya_public', t);
      EXECUTE format('DROP POLICY IF EXISTS %I ON %I', t || '_public_read', t);
      EXECUTE format('CREATE POLICY %I ON %I FOR SELECT TO kya_public USING (true)', t || '_public_read', t);
    END IF;
  END LOOP;
END $$;
