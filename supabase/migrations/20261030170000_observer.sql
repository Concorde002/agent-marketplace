-- Read-only observer for the live demo. Proposed by the dashboard developer; platform owner reviews.
--
-- 1. agent_traces: one bounded row per authenticated API/MCP operation (no bodies, no limits, no
--    tokens). It proves which participant did which step and when; it is not chain-of-thought.
-- 2. client_sightings: the client name/version a participant's MCP client reported in `initialize`,
--    or the HTTP user agent. Observed, not configured.
-- 3. observer_sessions: an operator-issued read-only token scoped to one demo buyer's runs, with an
--    expiry. It can read the observer projection and nothing else.

create table marketplace.agent_traces (
  id              bigint generated always as identity primary key,
  participant_id  text not null references marketplace.participants (id),
  channel         text not null check (channel in ('mcp', 'http')),
  operation       text not null check (operation ~ '^[a-z_]{1,64}$'),
  status          integer not null check (status between 100 and 599),
  error_code      text check (error_code ~ '^[A-Z0-9_]{1,64}$'),
  request_id      text,
  discovery_id    text,
  offer_id        text,
  order_id        text,
  started_at      timestamptz not null,
  finished_at     timestamptz not null,
  check (finished_at >= started_at)
);
create index agent_traces_request on marketplace.agent_traces (request_id, id) where request_id is not null;
create index agent_traces_participant on marketplace.agent_traces (participant_id, id desc);

create table marketplace.client_sightings (
  participant_id    text not null references marketplace.participants (id),
  channel           text not null check (channel in ('mcp', 'http')),
  client_name       text not null check (length(client_name) between 1 and 100),
  client_version    text check (length(client_version) <= 50),
  protocol_version  text check (length(protocol_version) <= 20),
  first_seen_at     timestamptz not null,
  last_seen_at      timestamptz not null,
  primary key (participant_id, channel)
);

create table marketplace.observer_sessions (
  id                    text primary key default gen_random_uuid()::text,
  token_hash            text not null unique check (token_hash ~ '^[0-9a-f]{64}$'),  -- hex SHA-256
  buyer_participant_id  text not null references marketplace.participants (id),
  label                 text not null check (length(label) between 1 and 80),
  created_by            text not null,
  created_at            timestamptz not null default now(),
  expires_at            timestamptz not null,
  revoked_at            timestamptz,
  check (expires_at > created_at and expires_at <= created_at + interval '7 days')
);

revoke all on marketplace.agent_traces, marketplace.client_sightings, marketplace.observer_sessions from public;
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    execute 'revoke all on marketplace.agent_traces, marketplace.client_sightings, marketplace.observer_sessions from anon, authenticated';
  end if;
end $$;

-- The backend appends traces and refreshes sightings. Observer sessions are operator-inserted only.
grant select, insert on marketplace.agent_traces to marketplace_app;
grant select, insert on marketplace.client_sightings to marketplace_app;
grant update (client_name, client_version, protocol_version, last_seen_at) on marketplace.client_sightings to marketplace_app;
grant select on marketplace.observer_sessions to marketplace_app;

alter table marketplace.agent_traces enable row level security;
alter table marketplace.client_sightings enable row level security;
alter table marketplace.observer_sessions enable row level security;
create policy backend_access on marketplace.agent_traces to marketplace_app using (true) with check (true);
create policy backend_access on marketplace.client_sightings to marketplace_app using (true) with check (true);
create policy backend_read on marketplace.observer_sessions for select to marketplace_app using (true);
