-- VAR corrective: Contract DNA cannot be marked complete without explicit
-- requirements plus a named procurement contact and at least one contact method.
create or replace function public.natcorp_contract_dna_completion_guard()
returns trigger
language plpgsql
security invoker
set search_path = public
as $$
begin
  if new.natcorp_contract_dna_status = 'complete'
     and (
       coalesce(new.requirements,'{}'::jsonb) = '{}'::jsonb
       or nullif(btrim(coalesce(new.contact_name,'')),'') is null
       or (nullif(btrim(coalesce(new.contact_email,'')),'') is null and nullif(btrim(coalesce(new.contact_phone,'')),'') is null)
     ) then
    new.natcorp_contract_dna_status := 'enrichment_required';
    new.natcorp_contract_dna_updated_at := now();
    if coalesce(new.qa_status,'') not in ('verified','rejected') then
      new.qa_status := 'enrichment_required';
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists natcorp_contract_dna_completion_guard_trg on public.state_contract_opportunities;
create trigger natcorp_contract_dna_completion_guard_trg
before insert or update of natcorp_contract_dna_status,requirements,contact_name,contact_email,contact_phone
on public.state_contract_opportunities
for each row execute function public.natcorp_contract_dna_completion_guard();

update public.state_contract_opportunities
set natcorp_contract_dna_status='enrichment_required',
    natcorp_contract_dna_updated_at=now(),
    qa_status=case when coalesce(qa_status,'') not in ('verified','rejected') then 'enrichment_required' else qa_status end,
    updated_at=now()
where natcorp_contract_dna_status='complete'
  and (
    coalesce(requirements,'{}'::jsonb)='{}'::jsonb
    or nullif(btrim(coalesce(contact_name,'')),'') is null
    or (nullif(btrim(coalesce(contact_email,'')),'') is null and nullif(btrim(coalesce(contact_phone,'')),'') is null)
  );
