-- Agent Marketplace: initial schema for Supabase Postgres.
--
-- Everything lives in a private `marketplace` schema that is NOT exposed through the Supabase
-- Data API. Only the backend talks to it, through a direct Postgres connection as a login role
-- that is a member of `marketplace_app`. Bots never reach the database.
--
-- The hardest marketplace invariants are enforced here, not only in application code:
--   * one order per offer and per request; a request closes once
--   * both parties must accept the exact current offer revision; offers are immutable
--   * supplier capacity cannot be oversold
--   * mandates stay within operator grants
--   * one payment attempt per order; buyer run-total cannot be exceeded under concurrency
--   * participant events are gap-free per participant for cursor polling
--
-- Apply with `supabase db push`, or with `psql --single-transaction -f <this file>`.
-- No secrets belong in this file. Login roles and passwords are created separately (see the end).

create schema if not exists marketplace;
revoke all on schema marketplace from public;

do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'marketplace_app') then
    create role marketplace_app nologin;
  end if;
end $$;
grant usage on schema marketplace to marketplace_app;

-- ---------------------------------------------------------------------------------------------
-- 1. Authority: operator grants, participants, credentials, mandates
-- ---------------------------------------------------------------------------------------------

-- Ceilings provisioned by an operator before the run. The backend only reads them.
create table marketplace.operator_grants (
  id                          text primary key default gen_random_uuid()::text,
  role                        text not null check (role in ('buyer', 'supplier')),
  currency                    text not null check (currency ~ '^[A-Z]{3}$'),
  expires_at                  timestamptz not null,
  allowed_categories          text[],             -- buyer: categories the bot may buy
  max_order_total_minor       bigint check (max_order_total_minor > 0),
  max_run_total_minor         bigint check (max_run_total_minor > 0),
  min_delivered_total_minor   bigint check (min_delivered_total_minor >= 0),  -- supplier: lowest floor allowed
  max_available_quantity      integer check (max_available_quantity > 0),     -- supplier: most capacity allowed
  created_by                  text not null,      -- operator name, for audit
  created_at                  timestamptz not null default now(),
  demo                        boolean not null default true check (demo),
  unique (id, role),
  check (role <> 'buyer' or (max_order_total_minor is not null and max_run_total_minor is not null
                             and max_order_total_minor <= max_run_total_minor)),
  check (role <> 'supplier' or (min_delivered_total_minor is not null and max_available_quantity is not null))
);

-- The operator creates the row and credential; the bot's registration fills in the company identity.
create table marketplace.participants (
  id                text primary key default gen_random_uuid()::text,
  grant_id          text not null unique,
  role              text not null check (role in ('buyer', 'supplier')),
  company_name      text,
  official_domain   text check (official_domain = lower(official_domain)),
  public_org_id     text,                         -- VAT/registry number, when known
  registered_at     timestamptz,
  created_at        timestamptz not null default now(),
  demo              boolean not null default true check (demo),
  unique (id, role),
  foreign key (grant_id, role) references marketplace.operator_grants (id, role),
  check ((registered_at is null) = (company_name is null) and (company_name is null) = (official_domain is null))
);

-- Only a hash of each bot's bearer token is stored.
create table marketplace.api_credentials (
  token_hash        text primary key check (token_hash ~ '^[0-9a-f]{64}$'),  -- hex SHA-256
  participant_id    text not null references marketplace.participants (id),
  created_at        timestamptz not null default now(),
  revoked_at        timestamptz
);

-- The bot's working limits. Must stay within its grant (enforced by trigger below).
create table marketplace.mandates (
  participant_id              text primary key,
  role                        text not null check (role in ('buyer', 'supplier')),
  currency                    text not null check (currency ~ '^[A-Z]{3}$'),
  expires_at                  timestamptz not null,
  sandbox_only                boolean not null default true check (sandbox_only),
  -- buyer
  max_order_total_minor       bigint check (max_order_total_minor > 0),
  max_run_total_minor         bigint check (max_run_total_minor > 0),
  allowed_categories          text[],
  destination                 text,
  -- supplier. PRIVATE: never include these columns in a response to the other party.
  min_delivered_total_minor   bigint check (min_delivered_total_minor >= 0),
  available_quantity          integer check (available_quantity >= 0),
  allocated_quantity          integer not null default 0 check (allocated_quantity >= 0),
  unit                        text,
  earliest_delivery_at        timestamptz,
  updated_at                  timestamptz not null default now(),
  foreign key (participant_id, role) references marketplace.participants (id, role),
  check (role <> 'buyer' or (max_order_total_minor is not null and max_run_total_minor is not null
                             and max_order_total_minor <= max_run_total_minor
                             and allowed_categories is not null and destination is not null)),
  check (role <> 'supplier' or (min_delivered_total_minor is not null and available_quantity is not null
                                and unit is not null and earliest_delivery_at is not null)),
  -- Overselling is impossible: allocation happens in the same statement that would exceed this.
  check (allocated_quantity <= coalesce(available_quantity, 0))
);

-- Server-side only. Written by the operator setup, never returned to any participant.
create table marketplace.payment_credentials (
  participant_id              text primary key,
  participant_role            text generated always as ('buyer') stored,
  stripe_customer_id          text not null check (stripe_customer_id like 'cus\_%'),
  stripe_payment_method_id    text not null check (stripe_payment_method_id like 'pm\_%'),
  sandbox_only                boolean not null default true check (sandbox_only),
  created_at                  timestamptz not null default now(),
  foreign key (participant_id, participant_role) references marketplace.participants (id, role)
);

-- ---------------------------------------------------------------------------------------------
-- 2. Demand and live sourcing evidence
-- ---------------------------------------------------------------------------------------------

create table marketplace.sourcing_requests (
  id                            text primary key default gen_random_uuid()::text,
  buyer_id                      text not null,
  buyer_role                    text generated always as ('buyer') stored,
  category                      text not null,
  description                   text not null,
  quantity                      integer not null check (quantity > 0),
  unit                          text not null,
  destination                   text not null,
  max_delivered_total_minor     bigint not null check (max_delivered_total_minor > 0),
  currency                      text not null check (currency ~ '^[A-Z]{3}$'),
  deliver_by                    timestamptz not null,
  status                        text not null default 'open' check (status in ('open', 'closed', 'cancelled')),
  closed_at                     timestamptz,
  created_at                    timestamptz not null default now(),
  demo                          boolean not null default true check (demo),
  unique (id, buyer_id),
  foreign key (buyer_id, buyer_role) references marketplace.participants (id, role),
  check ((status = 'open') = (closed_at is null))
);

create table marketplace.discovery_runs (
  id              text primary key default gen_random_uuid()::text,
  request_id      text not null references marketplace.sourcing_requests (id),
  status          text not null default 'pending' check (status in ('pending', 'running', 'complete', 'failed')),
  started_at      timestamptz,
  completed_at    timestamptz,
  error           text,
  created_at      timestamptz not null default now()
);

-- One row per source fetched during THIS run. Proves live retrieval; never imported in bulk.
create table marketplace.evidence (
  id              text primary key default gen_random_uuid()::text,
  discovery_id    text not null references marketplace.discovery_runs (id),
  url             text not null check (url ~ '^https?://'),
  retrieved_at    timestamptz not null,
  content_hash    text not null,                -- hash of the fetched content
  quotation       text not null                 -- exact supporting text from the page
);

create table marketplace.source_errors (
  id              text primary key default gen_random_uuid()::text,
  discovery_id    text not null references marketplace.discovery_runs (id),
  url             text not null,
  message         text not null,
  occurred_at     timestamptz not null default now()
);

create table marketplace.request_requirements (
  request_id      text not null references marketplace.sourcing_requests (id),
  key             text not null,                -- stable name, e.g. 'fire_rating_en1021'
  description     text not null,
  mandatory       boolean not null,
  evidence_id     text references marketplace.evidence (id),
  primary key (request_id, key)
);

-- Deliberately has NO participant column: platform membership must not influence ranking.
create table marketplace.candidates (
  id                text primary key default gen_random_uuid()::text,
  discovery_id      text not null references marketplace.discovery_runs (id),
  company_name      text not null,
  official_domain   text not null check (official_domain = lower(official_domain)),
  public_org_id     text,
  eligible          text not null check (eligible in ('yes', 'conditional', 'no')),
  rank              integer not null check (rank > 0),
  explanation       text not null,
  unique (discovery_id, rank),
  unique (discovery_id, official_domain)
);

create table marketplace.candidate_claims (
  candidate_id      text not null references marketplace.candidates (id),
  requirement_key   text not null,
  outcome           text not null check (outcome in ('match', 'mismatch', 'unknown')),
  evidence_id       text references marketplace.evidence (id),
  primary key (candidate_id, requirement_key),
  check (outcome = 'unknown' or evidence_id is not null)   -- a claim needs a cited source
);

-- Filled only AFTER ranking. NULL participant means a public lead with no connected account.
create table marketplace.candidate_accounts (
  candidate_id      text primary key references marketplace.candidates (id),
  participant_id    text references marketplace.participants (id),
  resolved_at       timestamptz not null default now()
);

-- ---------------------------------------------------------------------------------------------
-- 3. Negotiation and agreement
-- ---------------------------------------------------------------------------------------------

create table marketplace.quote_requests (
  id                text primary key default gen_random_uuid()::text,
  request_id        text not null references marketplace.sourcing_requests (id),
  supplier_id       text not null,
  supplier_role     text generated always as ('supplier') stored,
  candidate_id      text references marketplace.candidates (id),
  created_at        timestamptz not null default now(),
  unique (request_id, supplier_id),
  foreign key (supplier_id, supplier_role) references marketplace.participants (id, role)
);

-- Immutable revisions. Only `status` ever changes, and only away from 'current'.
create table marketplace.offers (
  id                            text primary key default gen_random_uuid()::text,
  request_id                    text not null,
  buyer_id                      text not null,
  supplier_id                   text not null,
  supplier_role                 text generated always as ('supplier') stored,
  previous_offer_id             text,
  revision                      integer not null check (revision between 1 and 3),
  created_by                    text not null references marketplace.participants (id),
  quantity                      integer not null check (quantity > 0),
  unit                          text not null,
  destination                   text not null,
  delivered_total_minor         bigint not null check (delivered_total_minor > 0),
  currency                      text not null check (currency ~ '^[A-Z]{3}$'),
  tax_minor                     bigint not null check (tax_minor >= 0),
  delivery_minor                bigint not null check (delivery_minor >= 0),
  delivery_at                   timestamptz not null,
  expires_at                    timestamptz not null,
  confirmed_requirement_keys    text[] not null default '{}',
  terms_origin                  text not null default 'demo-supplier-declaration'
                                check (terms_origin = 'demo-supplier-declaration'),
  status                        text not null default 'current'
                                check (status in ('current', 'superseded', 'accepted', 'expired')),
  created_at                    timestamptz not null default now(),
  demo                          boolean not null default true check (demo),
  unique (id, request_id, buyer_id, supplier_id),
  unique (id, request_id, supplier_id),
  unique (request_id, supplier_id, revision),
  -- The offer's buyer must be the request's buyer.
  foreign key (request_id, buyer_id) references marketplace.sourcing_requests (id, buyer_id),
  foreign key (supplier_id, supplier_role) references marketplace.participants (id, role),
  -- A counteroffer continues the same negotiation.
  foreign key (previous_offer_id, request_id, supplier_id) references marketplace.offers (id, request_id, supplier_id),
  check ((previous_offer_id is null) = (revision = 1)),
  check (created_by in (buyer_id, supplier_id)),
  -- Tax and delivery are included in the total, not added to it.
  check (tax_minor + delivery_minor <= delivered_total_minor)
);
-- At most one live offer per negotiation.
create unique index offers_one_current on marketplace.offers (request_id, supplier_id) where status = 'current';

create table marketplace.offer_acceptances (
  offer_id          text not null references marketplace.offers (id),
  participant_id    text not null references marketplace.participants (id),
  accepted_at       timestamptz not null default now(),
  primary key (offer_id, participant_id)
);

-- Inserting an order closes the request, allocates capacity, and marks the offer accepted (trigger).
create table marketplace.orders (
  id                  text primary key default gen_random_uuid()::text,
  offer_id            text not null unique,
  request_id          text not null unique,
  buyer_id            text not null,
  supplier_id         text not null,
  agreement_status    text not null default 'agreed' check (agreement_status = 'agreed'),
  agreed_at           timestamptz not null default now(),
  demo                boolean not null default true check (demo),
  unique (id, buyer_id, supplier_id),
  foreign key (offer_id, request_id, buyer_id, supplier_id)
    references marketplace.offers (id, request_id, buyer_id, supplier_id)
);

create table marketplace.demo_documents (
  id            text primary key default gen_random_uuid()::text,
  order_id      text not null unique references marketplace.orders (id),
  body          text not null check (body ilike '%demo%'),
  created_at    timestamptz not null default now(),
  demo          boolean not null default true check (demo)
);

-- ---------------------------------------------------------------------------------------------
-- 4. Payments (matches src/payments/)
-- ---------------------------------------------------------------------------------------------

-- Created only through marketplace.claim_payment_attempt().
create table marketplace.payment_attempts (
  order_id              text primary key,             -- one payment attempt per order
  buyer_id              text not null,
  supplier_id           text not null,
  amount_minor          bigint not null check (amount_minor > 0),
  currency              text not null check (currency ~ '^[A-Z]{3}$'),
  idempotency_key       text not null unique,          -- sent to Stripe, e.g. 'order:{id}:v1'
  status                text not null default 'creating'
                        check (status in ('creating', 'pending', 'requires_action', 'succeeded', 'failed')),
  provider_payment_id   text unique check (provider_payment_id like 'pi\_%'),
  failure_code          text,                          -- e.g. 'generic_decline'
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),
  foreign key (order_id, buyer_id, supplier_id) references marketplace.orders (id, buyer_id, supplier_id),
  check (status <> 'failed' or failure_code is not null)
);
create index payment_attempts_buyer_spend on marketplace.payment_attempts (buyer_id, currency) where status <> 'failed';

-- Stripe event IDs already processed, so duplicate deliveries apply once.
create table marketplace.webhook_events (
  stripe_event_id   text primary key check (stripe_event_id like 'evt\_%'),
  type              text not null,
  processed_at      timestamptz not null default now()
);

-- ---------------------------------------------------------------------------------------------
-- 5. Participant events and request idempotency
-- ---------------------------------------------------------------------------------------------

-- Bots poll `cursor > :after` for their own participant. Written only through
-- marketplace.emit_participant_events(), which keeps cursors gap-free per participant.
create table marketplace.participant_events (
  cursor            bigint generated always as identity primary key,
  participant_id    text not null references marketplace.participants (id),
  type              text not null check (type in ('quote_requested', 'offer_received', 'agreement_created', 'payment_updated')),
  request_id        text not null references marketplace.sourcing_requests (id),
  resource_id       text not null,
  dedup_key         text not null unique,
  created_at        timestamptz not null default now()
);
create index participant_events_poll on marketplace.participant_events (participant_id, cursor);

create table marketplace.idempotency_keys (
  participant_id    text not null references marketplace.participants (id),
  key               text not null check (length(key) between 8 and 255),
  route             text not null,
  request_hash      text not null,            -- same key with a different body is rejected
  response_status   integer,
  response_body     jsonb,
  created_at        timestamptz not null default now(),
  primary key (participant_id, key)
);

-- ---------------------------------------------------------------------------------------------
-- 6. Invariant triggers
-- ---------------------------------------------------------------------------------------------

create function marketplace.touch_updated_at() returns trigger
language plpgsql set search_path = '' as $$
begin
  new.updated_at := now();
  return new;
end $$;

create trigger mandates_touch before update on marketplace.mandates
  for each row execute function marketplace.touch_updated_at();
create trigger payment_attempts_touch before update on marketplace.payment_attempts
  for each row execute function marketplace.touch_updated_at();

-- A mandate may sit anywhere inside its operator grant, never outside it.
create function marketplace.check_mandate_within_grant() returns trigger
language plpgsql set search_path = '' as $$
declare
  g marketplace.operator_grants;
begin
  select og.* into g
    from marketplace.participants p
    join marketplace.operator_grants og on og.id = p.grant_id
   where p.id = new.participant_id;

  if new.currency <> g.currency then
    raise exception 'mandate currency % differs from grant currency %', new.currency, g.currency using errcode = 'check_violation';
  end if;
  if new.expires_at > g.expires_at then
    raise exception 'mandate expires after its grant' using errcode = 'check_violation';
  end if;
  if new.role = 'buyer' and (new.max_order_total_minor > g.max_order_total_minor
                             or new.max_run_total_minor > g.max_run_total_minor
                             or (g.allowed_categories is not null and not new.allowed_categories <@ g.allowed_categories)) then
    raise exception 'buyer mandate exceeds its operator grant' using errcode = 'check_violation';
  end if;
  if new.role = 'supplier' and (new.min_delivered_total_minor < g.min_delivered_total_minor
                                or new.available_quantity > g.max_available_quantity) then
    raise exception 'supplier mandate exceeds its operator grant' using errcode = 'check_violation';
  end if;
  return new;
end $$;

create trigger mandates_within_grant before insert or update on marketplace.mandates
  for each row execute function marketplace.check_mandate_within_grant();

-- A new revision must continue the current one and supersedes it.
create function marketplace.offers_before_insert() returns trigger
language plpgsql set search_path = '' as $$
declare
  cur marketplace.offers;
begin
  if not exists (select 1 from marketplace.sourcing_requests where id = new.request_id and status = 'open') then
    raise exception 'request % is not open', new.request_id using errcode = 'check_violation';
  end if;
  select * into cur from marketplace.offers
   where request_id = new.request_id and supplier_id = new.supplier_id and status = 'current'
   for update;
  if found then
    if new.previous_offer_id is distinct from cur.id or new.revision <> cur.revision + 1 then
      raise exception 'offer must continue current revision % (%)', cur.revision, cur.id using errcode = 'check_violation';
    end if;
    update marketplace.offers set status = 'superseded' where id = cur.id;
  elsif new.previous_offer_id is not null then
    raise exception 'previous offer % is no longer current', new.previous_offer_id using errcode = 'check_violation';
  end if;
  return new;
end $$;

create trigger offers_continue_current before insert on marketplace.offers
  for each row execute function marketplace.offers_before_insert();

-- Commercial terms never change; status only moves away from 'current'.
create function marketplace.offers_before_update() returns trigger
language plpgsql set search_path = '' as $$
begin
  -- Generated columns are not yet computed in NEW inside a BEFORE trigger, so they are excluded.
  if (to_jsonb(new) - 'status' - 'supplier_role') is distinct from (to_jsonb(old) - 'status' - 'supplier_role') then
    raise exception 'offer revisions are immutable' using errcode = 'check_violation';
  end if;
  if old.status <> 'current' and new.status <> old.status then
    raise exception 'offer % is already %', old.id, old.status using errcode = 'check_violation';
  end if;
  return new;
end $$;

create trigger offers_immutable before update on marketplace.offers
  for each row execute function marketplace.offers_before_update();

-- Only a party to the offer may accept, and only the live, unexpired revision.
create function marketplace.offer_acceptances_before_insert() returns trigger
language plpgsql set search_path = '' as $$
declare
  o marketplace.offers;
begin
  select * into o from marketplace.offers where id = new.offer_id for share;
  if new.participant_id not in (o.buyer_id, o.supplier_id) then
    raise exception 'participant % is not a party to offer %', new.participant_id, new.offer_id using errcode = 'insufficient_privilege';
  end if;
  if o.status <> 'current' then
    raise exception 'offer % is % and can no longer be accepted', new.offer_id, o.status using errcode = 'check_violation';
  end if;
  if o.expires_at <= now() then
    raise exception 'offer % has expired', new.offer_id using errcode = 'check_violation';
  end if;
  return new;
end $$;

create trigger offer_acceptances_valid before insert on marketplace.offer_acceptances
  for each row execute function marketplace.offer_acceptances_before_insert();

-- Creating an order is the single atomic close: both acceptances present, request closes once,
-- supplier capacity is allocated (the mandate CHECK refuses overselling), offer becomes accepted.
-- SECURITY DEFINER because the backend role may not touch allocation or request status directly.
create function marketplace.orders_before_insert() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  o marketplace.offers;
begin
  select * into o from marketplace.offers where id = new.offer_id for update;
  if o.status <> 'current' then
    raise exception 'offer % is %, not current', new.offer_id, o.status using errcode = 'check_violation';
  end if;
  if o.expires_at <= now() then
    raise exception 'offer % has expired', new.offer_id using errcode = 'check_violation';
  end if;
  if (select count(*) from marketplace.offer_acceptances
       where offer_id = o.id and participant_id in (o.buyer_id, o.supplier_id)) <> 2 then
    raise exception 'both parties must accept offer % before an order exists', o.id using errcode = 'check_violation';
  end if;

  update marketplace.sourcing_requests set status = 'closed', closed_at = now()
   where id = new.request_id and status = 'open';
  if not found then
    raise exception 'request % is not open', new.request_id using errcode = 'check_violation';
  end if;

  update marketplace.mandates set allocated_quantity = allocated_quantity + o.quantity
   where participant_id = o.supplier_id and unit = o.unit;
  if not found then
    raise exception 'supplier % has no mandate for unit %', o.supplier_id, o.unit using errcode = 'check_violation';
  end if;

  update marketplace.offers set status = 'accepted' where id = o.id;
  return new;
end $$;

create trigger orders_atomic_close before insert on marketplace.orders
  for each row execute function marketplace.orders_before_insert();

-- Terminal payment states are final, matching SettlementService.
create function marketplace.payment_attempts_before_update() returns trigger
language plpgsql set search_path = '' as $$
begin
  if old.status in ('succeeded', 'failed') and new.status <> old.status then
    raise exception 'payment for order % is already %', old.order_id, old.status using errcode = 'check_violation';
  end if;
  if new.status = 'creating' and old.status <> 'creating' then
    raise exception 'payment status cannot return to creating' using errcode = 'check_violation';
  end if;
  return new;
end $$;

create trigger payment_attempts_monotonic before update on marketplace.payment_attempts
  for each row execute function marketplace.payment_attempts_before_update();

-- ---------------------------------------------------------------------------------------------
-- 7. Functions the backend calls
-- ---------------------------------------------------------------------------------------------

-- Backs PaymentStore.claimAttempt(). Returns 'claimed', 'exists', or 'run_total_exceeded'.
-- Locking the buyer's mandate row serialises claims per buyer: under READ COMMITTED, two plain
-- INSERT ... SELECT SUM(...) statements running at once would both see the old total and both pass.
create function marketplace.claim_payment_attempt(
  p_order_id text,
  p_idempotency_key text,
  p_max_committed_minor bigint
) returns text
language plpgsql security definer set search_path = '' as $$
declare
  m marketplace.mandates;
  ord marketplace.orders;
  o marketplace.offers;
  committed bigint;
begin
  select * into ord from marketplace.orders where id = p_order_id;
  if not found then
    raise exception 'order % does not exist', p_order_id using errcode = 'foreign_key_violation';
  end if;
  select * into o from marketplace.offers where id = ord.offer_id;

  select * into m from marketplace.mandates where participant_id = ord.buyer_id for update;
  if not found or m.role <> 'buyer' then
    raise exception 'buyer % has no mandate', ord.buyer_id using errcode = 'check_violation';
  end if;

  if exists (select 1 from marketplace.payment_attempts where order_id = p_order_id) then
    return 'exists';
  end if;

  -- The amount is always the accepted offer's total, never a caller-supplied number.
  if o.currency <> m.currency or m.expires_at <= now() or o.delivered_total_minor > m.max_order_total_minor then
    raise exception 'order % is outside the buyer mandate', p_order_id using errcode = 'check_violation';
  end if;

  select coalesce(sum(amount_minor), 0) into committed
    from marketplace.payment_attempts
   where buyer_id = ord.buyer_id and currency = o.currency and status <> 'failed';
  if committed + o.delivered_total_minor > least(p_max_committed_minor, m.max_run_total_minor) then
    return 'run_total_exceeded';
  end if;

  insert into marketplace.payment_attempts (order_id, buyer_id, supplier_id, amount_minor, currency, idempotency_key)
  values (ord.id, ord.buyer_id, ord.supplier_id, o.delivered_total_minor, o.currency, p_idempotency_key);
  return 'claimed';
end $$;

-- Emits one event per participant, ignoring duplicates by dedup key ('<base>:<participant>').
-- Identity values are handed out before commit, so without a lock a poller could read cursor 11
-- while cursor 10 is still uncommitted, then skip 10 forever. A per-participant transaction lock
-- makes each participant's events commit in cursor order. Locks are taken in sorted order to avoid deadlocks.
create function marketplace.emit_participant_events(
  p_participant_ids text[],
  p_type text,
  p_request_id text,
  p_resource_id text,
  p_dedup_base text
) returns integer
language plpgsql security definer set search_path = '' as $$
declare
  pid text;
  inserted integer := 0;
  n integer;
begin
  for pid in select distinct unnest(p_participant_ids) order by 1 loop
    perform pg_advisory_xact_lock(hashtextextended('marketplace.participant_events:' || pid, 0));
    insert into marketplace.participant_events (participant_id, type, request_id, resource_id, dedup_key)
    values (pid, p_type, p_request_id, p_resource_id, p_dedup_base || ':' || pid)
    on conflict (dedup_key) do nothing;
    get diagnostics n = row_count;
    inserted := inserted + n;
  end loop;
  return inserted;
end $$;

-- ---------------------------------------------------------------------------------------------
-- 8. Privileges and row-level security
-- ---------------------------------------------------------------------------------------------

revoke all on all tables in schema marketplace from public;
revoke all on all sequences in schema marketplace from public;
revoke execute on all functions in schema marketplace from public;

-- Supabase's API roles get nothing. Guarded so the file also runs on plain Postgres.
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    execute 'revoke all on schema marketplace from anon, authenticated';
    execute 'revoke all on all tables in schema marketplace from anon, authenticated';
    execute 'revoke execute on all functions in schema marketplace from anon, authenticated';
  end if;
end $$;

-- The backend reads everything it is allowed to and never deletes.
grant select on all tables in schema marketplace to marketplace_app;

grant insert on
  marketplace.mandates, marketplace.sourcing_requests, marketplace.request_requirements,
  marketplace.discovery_runs, marketplace.evidence, marketplace.source_errors,
  marketplace.candidates, marketplace.candidate_claims, marketplace.candidate_accounts,
  marketplace.quote_requests, marketplace.offers, marketplace.offer_acceptances,
  marketplace.orders, marketplace.demo_documents, marketplace.webhook_events,
  marketplace.idempotency_keys
to marketplace_app;

-- Column-level updates only. Offers, orders, evidence, and accepted terms cannot be rewritten.
grant update (company_name, official_domain, public_org_id, registered_at) on marketplace.participants to marketplace_app;
grant update (currency, expires_at, max_order_total_minor, max_run_total_minor, allowed_categories,
              destination, min_delivered_total_minor, available_quantity, unit, earliest_delivery_at)
  on marketplace.mandates to marketplace_app;
grant update (status, closed_at) on marketplace.sourcing_requests to marketplace_app;
grant update (status, started_at, completed_at, error) on marketplace.discovery_runs to marketplace_app;
grant update (status) on marketplace.offers to marketplace_app;
grant update (status, provider_payment_id, failure_code) on marketplace.payment_attempts to marketplace_app;
grant update (response_status, response_body) on marketplace.idempotency_keys to marketplace_app;

grant execute on function marketplace.claim_payment_attempt(text, text, bigint) to marketplace_app;
grant execute on function marketplace.emit_participant_events(text[], text, text, text, text) to marketplace_app;

-- Defence in depth: RLS on every table. Only the backend role has a policy; API roles see nothing
-- even if a grant is added by mistake. The migration owner (postgres) bypasses RLS for operator setup.
do $$
declare
  t text;
begin
  for t in select tablename from pg_tables where schemaname = 'marketplace' loop
    execute format('alter table marketplace.%I enable row level security', t);
    execute format('create policy backend_access on marketplace.%I to marketplace_app using (true) with check (true)', t);
  end loop;
end $$;

-- ---------------------------------------------------------------------------------------------
-- After applying (run once in the SQL editor, never commit the password):
--   create role marketplace_backend login password '<generated>' in role marketplace_app;
-- Then connect the backend with that role, through Supavisor in session mode or directly.
-- Operator setup (grants, participants, credentials, payment_credentials) runs as postgres.
-- ---------------------------------------------------------------------------------------------
