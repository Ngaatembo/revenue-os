-- Source reconciliation schema safety. Synthetic schema assertions only.
-- Runs after all migrations in the disposable database test harness.
\set ON_ERROR_STOP on

select t.ok(
  'source sync runs: RLS enabled and forced',
  $q$select c.relrowsecurity and c.relforcerowsecurity
      from pg_class c join pg_namespace n on n.oid=c.relnamespace
     where n.nspname='public' and c.relname='source_sync_runs'$q$
);
select t.ok(
  'source memberships: RLS enabled and forced',
  $q$select c.relrowsecurity and c.relforcerowsecurity
      from pg_class c join pg_namespace n on n.oid=c.relnamespace
     where n.nspname='public' and c.relname='source_sync_memberships'$q$
);
select t.eq(
  'source sync runs: authenticated has no table privileges',
  $q$select has_table_privilege('authenticated','public.source_sync_runs','select')::text
      || '/' || has_table_privilege('authenticated','public.source_sync_runs','insert')::text
      || '/' || has_table_privilege('authenticated','public.source_sync_runs','update')::text$q$,
  'false/false/false'
);
select t.eq(
  'source memberships: authenticated has no table privileges',
  $q$select has_table_privilege('authenticated','public.source_sync_memberships','select')::text
      || '/' || has_table_privilege('authenticated','public.source_sync_memberships','insert')::text
      || '/' || has_table_privilege('authenticated','public.source_sync_memberships','update')::text$q$,
  'false/false/false'
);
select t.ok(
  'source sync runs: service_role has insert/update access',
  $q$select has_table_privilege('service_role','public.source_sync_runs','insert')
      and has_table_privilege('service_role','public.source_sync_runs','update')$q$
);
select t.ok(
  'source memberships: composite scope key exists',
  $q$select exists (
    select 1 from pg_constraint
     where conrelid='public.source_sync_memberships'::regclass
       and contype='p'
       and pg_get_constraintdef(oid) like '%organization_id, source_key, source_range, invoice_id%'
  )$q$
);
select t.ok(
  'source memberships: invoice foreign key is organization-scoped',
  $q$select exists (
    select 1 from pg_constraint
     where conrelid='public.source_sync_memberships'::regclass
       and contype='f'
       and pg_get_constraintdef(oid) like '%FOREIGN KEY (organization_id, invoice_id)%'
  )$q$
);
