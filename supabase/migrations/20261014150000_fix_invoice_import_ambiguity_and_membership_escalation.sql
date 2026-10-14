-- Forward-only corrective migration.
--
-- 1. persist_invoice_import: parameters named source_id / content_hash collided with the
--    same-named columns in its ON CONFLICT targets, so PostgreSQL raised
--    "42702 column reference is ambiguous" and no invoice import could succeed.
--    The RPC signature (parameter names and types) is unchanged because the web client
--    calls it with named arguments. Parameters are copied into v_* locals and
--    #variable_conflict use_column makes column names win inside SQL statements.
--
-- 2. memberships: the admin RLS policies allowed an admin to grant or take the owner role
--    (including to themselves) and to delete owners. A guard trigger now enforces:
--      - only owners may create, change or remove owner/admin memberships;
--      - nobody may change their own role or membership row;
--      - the last owner of a workspace cannot be removed or demoted;
--      - a user may only create a membership for themselves while bootstrapping an
--        empty workspace as its owner.
--    Maintenance via service role / direct SQL (auth.uid() is null) is unaffected.

create or replace function public.persist_invoice_import(
  org_id text, source_id text, source_name text, content_hash text, rows jsonb, rejected_rows integer default 0
) returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
#variable_conflict use_column
declare
  v_org_id text := persist_invoice_import.org_id;
  v_source_id text := persist_invoice_import.source_id;
  v_source_name text := persist_invoice_import.source_name;
  v_content_hash text := persist_invoice_import.content_hash;
  v_rows jsonb := persist_invoice_import.rows;
  v_rejected integer := persist_invoice_import.rejected_rows;
  v_actor text;
  v_import_id text;
  v_accepted integer;
  v_total integer;
  v_status text;
  v_row jsonb;
begin
  if auth.uid() is null then
    raise exception 'Authentication required' using errcode = '28000';
  end if;
  if not private.has_org_role(v_org_id, array['owner', 'admin', 'operator']) then
    raise exception 'Workspace permission denied' using errcode = '42501';
  end if;
  if v_source_id is null or length(trim(v_source_id)) not between 1 and 240
     or v_source_name is null or length(trim(v_source_name)) not between 1 and 240 then
    raise exception 'A valid source identifier and file name are required' using errcode = '22023';
  end if;
  if v_content_hash is null or v_content_hash !~ '^[a-f0-9]{64}$' then
    raise exception 'A SHA-256 content hash is required' using errcode = '22023';
  end if;
  if jsonb_typeof(v_rows) is distinct from 'array' or jsonb_array_length(v_rows) > 50000 then
    raise exception 'Invoice rows must be an array with at most 50000 records' using errcode = '22023';
  end if;
  if v_rejected is null or v_rejected < 0 or v_rejected > 50000 then
    raise exception 'Rejected row count is invalid' using errcode = '22023';
  end if;

  select u.id into v_actor from public.users as u where u.auth_subject = auth.uid() limit 1;
  if v_actor is null then
    raise exception 'Workspace membership is not initialized' using errcode = '42501';
  end if;

  v_accepted := jsonb_array_length(v_rows);
  v_total := v_accepted + v_rejected;
  v_status := case when v_rejected > 0 then 'completed_with_errors' else 'completed' end;

  insert into public.data_sources (organization_id, id, name, kind, created_by)
  values (v_org_id, v_source_id, left(trim(v_source_name), 160), 'csv_import', v_actor)
  on conflict (organization_id, id) do nothing;

  v_import_id := 'import_' || pg_catalog.gen_random_uuid()::text;
  insert into public.imports (
    organization_id, id, source_id, status, content_hash,
    total_rows, accepted_rows, rejected_rows, created_by
  )
  values (v_org_id, v_import_id, v_source_id, v_status, v_content_hash, v_total, v_accepted, v_rejected, v_actor)
  on conflict (organization_id, source_id, content_hash) do nothing;

  if not found then
    select i.id into v_import_id
      from public.imports as i
     where i.organization_id = v_org_id and i.source_id = v_source_id and i.content_hash = v_content_hash
     limit 1;
    return pg_catalog.jsonb_build_object(
      'duplicate', true, 'import_id', v_import_id, 'accepted_rows', 0, 'rejected_rows', v_rejected
    );
  end if;

  for v_row in select value from pg_catalog.jsonb_array_elements(v_rows)
  loop
    insert into public.invoices (
      organization_id, id, source_id, import_id, external_record_id,
      customer_id, customer_name, invoice_number, currency,
      total_minor, paid_minor, issued_at, due_at, imported_at
    )
    values (
      v_org_id, v_row ->> 'id', v_source_id, v_import_id, v_row ->> 'invoiceNumber',
      v_row ->> 'customerId', v_row ->> 'customerName', v_row ->> 'invoiceNumber', v_row ->> 'currency',
      (v_row ->> 'totalMinor')::bigint, (v_row ->> 'paidMinor')::bigint,
      (v_row ->> 'issuedAt')::timestamptz, (v_row ->> 'dueAt')::timestamptz, (v_row ->> 'importedAt')::timestamptz
    )
    on conflict (organization_id, source_id, external_record_id) do update set
      import_id = excluded.import_id,
      customer_id = excluded.customer_id,
      customer_name = excluded.customer_name,
      invoice_number = excluded.invoice_number,
      currency = excluded.currency,
      total_minor = excluded.total_minor,
      paid_minor = excluded.paid_minor,
      issued_at = excluded.issued_at,
      due_at = excluded.due_at,
      imported_at = excluded.imported_at;
  end loop;

  return pg_catalog.jsonb_build_object(
    'duplicate', false, 'import_id', v_import_id, 'accepted_rows', v_accepted, 'rejected_rows', v_rejected
  );
end;
$function$;

-- ---------------------------------------------------------------------------------------------
-- Membership escalation guard
-- ---------------------------------------------------------------------------------------------
create or replace function private.guard_membership_change()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_actor_user text;
  v_actor_role text;
  v_org text := coalesce(new.organization_id, old.organization_id);
  v_existing integer;
  v_other_owners integer;
begin
  -- Service role / maintenance SQL has no end-user identity and is not restricted here.
  if auth.uid() is null then
    return coalesce(new, old);
  end if;

  select u.id into v_actor_user from public.users as u where u.auth_subject = auth.uid();
  select m.role into v_actor_role
    from public.memberships as m
   where m.organization_id = v_org and m.user_id = v_actor_user;

  if tg_op = 'INSERT' then
    select count(*) into v_existing from public.memberships as m where m.organization_id = new.organization_id;
    if v_existing = 0 then
      -- Workspace bootstrap: the creator becomes the first owner, and only themselves.
      if new.user_id is distinct from v_actor_user or new.role <> 'owner' then
        raise exception 'The first member of a workspace must be its creator as owner' using errcode = '42501';
      end if;
      return new;
    end if;
    if new.user_id is not distinct from v_actor_user then
      raise exception 'You cannot add yourself to a workspace' using errcode = '42501';
    end if;
    if new.role in ('owner', 'admin') and v_actor_role is distinct from 'owner' then
      raise exception 'Only an owner can grant the owner or admin role' using errcode = '42501';
    end if;
    return new;

  elsif tg_op = 'UPDATE' then
    if new.organization_id is distinct from old.organization_id or new.user_id is distinct from old.user_id then
      raise exception 'A membership cannot be moved to another workspace or user' using errcode = '42501';
    end if;
    if old.user_id is not distinct from v_actor_user and new.role is distinct from old.role then
      raise exception 'You cannot change your own role' using errcode = '42501';
    end if;
    if new.role is distinct from old.role
       and (old.role in ('owner', 'admin') or new.role in ('owner', 'admin'))
       and v_actor_role is distinct from 'owner' then
      raise exception 'Only an owner can change the owner or admin role' using errcode = '42501';
    end if;
    return new;

  else -- DELETE
    if old.role in ('owner', 'admin') and v_actor_role is distinct from 'owner'
       and old.user_id is distinct from v_actor_user then
      raise exception 'Only an owner can remove an owner or admin' using errcode = '42501';
    end if;
    if old.role = 'owner' then
      select count(*) into v_other_owners
        from public.memberships as m
       where m.organization_id = old.organization_id and m.role = 'owner' and m.user_id <> old.user_id;
      if v_other_owners = 0 then
        raise exception 'A workspace must keep at least one owner' using errcode = '42501';
      end if;
    end if;
    return old;
  end if;
end;
$function$;

revoke all on function private.guard_membership_change() from public, anon, authenticated;

drop trigger if exists memberships_escalation_guard on public.memberships;
create trigger memberships_escalation_guard
  before insert or update or delete on public.memberships
  for each row execute function private.guard_membership_change();
