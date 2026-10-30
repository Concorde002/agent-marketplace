-- Additive API persistence. Apply explicitly as migration owner, not automatically at server startup.
-- Supabase CLI generation was attempted locally but the executable exited 137; authored/reviewed SQL follows the existing migration format.
alter table marketplace.sourcing_requests add column buyer_notice_number text
  check (buyer_notice_number ~ '^\d{1,7}-(19|20)\d{2}$');
alter table marketplace.discovery_runs
  add column evidence_bundle jsonb,
  add column result jsonb;
grant update (evidence_bundle, result) on marketplace.discovery_runs to marketplace_app;

-- A retry may read a finalized result, but neither its evidence nor ranking may be rewritten.
create function marketplace.discovery_immutable_result() returns trigger
language plpgsql set search_path = '' as $$
begin
  if old.evidence_bundle is not null and new.evidence_bundle is distinct from old.evidence_bundle then
    raise exception 'discovery evidence is immutable' using errcode = 'check_violation';
  end if;
  if old.result is not null and new.result is distinct from old.result then
    raise exception 'discovery ranking is immutable' using errcode = 'check_violation';
  end if;
  if old.status in ('complete','failed') and new.status <> old.status then
    raise exception 'discovery is terminal' using errcode = 'check_violation';
  end if;
  return new;
end $$;
revoke execute on function marketplace.discovery_immutable_result() from public;
create trigger discovery_result_frozen before update on marketplace.discovery_runs
  for each row execute function marketplace.discovery_immutable_result();
create index discovery_request_latest on marketplace.discovery_runs (request_id, created_at desc, id);

-- Candidate rows are written during one locked finalization, before the result becomes immutable.
create function marketplace.candidate_requires_running_discovery() returns trigger
language plpgsql set search_path = '' as $$
begin
  if not exists (select 1 from marketplace.discovery_runs where id=new.discovery_id and status='running' and result is null) then
    raise exception 'candidate ranking is frozen or discovery is not running' using errcode = 'check_violation';
  end if;
  return new;
end $$;
revoke execute on function marketplace.candidate_requires_running_discovery() from public;
create trigger candidate_before_ranking_only before insert on marketplace.candidates
  for each row execute function marketplace.candidate_requires_running_discovery();
