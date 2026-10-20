-- End-to-end tests for source snapshot completion/reconciliation. Synthetic fixtures only.
-- Runs after all migrations in the disposable Postgres test harness.
\set ON_ERROR_STOP off
\set U '00000000-0000-4000-8000-0000000000f9'

insert into auth.users(id, email) values (:'U', 'snapshot-owner@example.test');
select set_config('request.jwt.claim.sub', :'U', false) \gset
set role authenticated;
select organization_id as org from public.bootstrap_revenue_os_organization('Snapshot Test Org') \gset
reset role;
select set_config('t.org', :'org', false) \gset
select set_config('request.jwt.claim.sub', '', false) \gset

-- Persist synthetic invoices through the same import RPC used by the application.
select set_config('request.jwt.claim.sub', :'U', false);
set role authenticated;
select t.ok('snapshot: seed invoices', $q$select public.persist_invoice_import(
  t.o('org'), 'google_sheets:spreadsheet12345', 'sheet.csv', repeat('a',64),
  jsonb_build_array(
    jsonb_build_object('id','snapshot-inv-a','invoiceNumber','S-A','customerId','c-a','customerName','Customer A','currency','USD','totalMinor',10000,'paidMinor',0,'issuedAt',now()-interval '30 days','dueAt',now()-interval '10 days','importedAt',now()),
    jsonb_build_object('id','snapshot-inv-b','invoiceNumber','S-B','customerId','c-b','customerName','Customer B','currency','USD','totalMinor',20000,'paidMinor',0,'issuedAt',now()-interval '30 days','dueAt',now()-interval '10 days','importedAt',now())
  ),0)$q$);
reset role;
select set_config('request.jwt.claim.sub', '', false);

-- Snapshot completion is a service-role-only server operation.
set role service_role;
select set_config('request.jwt.claim.role', 'service_role', false);

-- First complete snapshot should mark both rows present.
insert into public.source_sync_runs(organization_id,id,source_key,provider,spreadsheet_id,source_range,status)
values (t.o('org'),'run-1','google_sheets:spreadsheet12345','google_sheets','spreadsheet12345','Invoices!A1:H3','started');
select t.eq('snapshot: first run reconciles two rows',
  $q$select (public.complete_source_sync_snapshot(t.o('org'),'run-1','google_sheets:spreadsheet12345','Invoices!A1:H3','spreadsheet12345',repeat('b',64),array['snapshot-inv-a','snapshot-inv-b'],2,0))->>'reconciled'$q$,'true');
select t.eq('snapshot: first run has two present memberships',
  $q$select count(*)::text from public.source_sync_memberships where organization_id=t.o('org') and review_state='present'$q$,'2');
select t.eq('snapshot: first run completed',
  $q$select status from public.source_sync_runs where organization_id=t.o('org') and id='run-1'$q$,'completed');

-- Identical successful snapshot is idempotent: no duplicate memberships and no missing rows.
insert into public.source_sync_runs(organization_id,id,source_key,provider,spreadsheet_id,source_range,status)
values (t.o('org'),'run-2','google_sheets:spreadsheet12345','google_sheets','spreadsheet12345','Invoices!A1:H3','started');
select t.eq('snapshot: identical repeat remains safe',
  $q$select (public.complete_source_sync_snapshot(t.o('org'),'run-2','google_sheets:spreadsheet12345','Invoices!A1:H3','spreadsheet12345',repeat('b',64),array['snapshot-inv-a','snapshot-inv-b'],2,0))->>'missing_for_review'$q$,'0');
select t.eq('snapshot: identical repeat keeps exactly two memberships',
  $q$select count(*)::text from public.source_sync_memberships where organization_id=t.o('org')$q$,'2');

-- A fully accepted later snapshot omitting B flags it for review; never deletes or marks it paid.
insert into public.source_sync_runs(organization_id,id,source_key,provider,spreadsheet_id,source_range,status)
values (t.o('org'),'run-3','google_sheets:spreadsheet12345','google_sheets','spreadsheet12345','Invoices!A1:H3','started');
select t.eq('snapshot: omitted invoice enters review',
  $q$select (public.complete_source_sync_snapshot(t.o('org'),'run-3','google_sheets:spreadsheet12345','Invoices!A1:H3','spreadsheet12345',repeat('c',64),array['snapshot-inv-a'],1,0))->>'missing_for_review'$q$,'1');
select t.eq('snapshot: omitted invoice is pending review',
  $q$select review_state from public.source_sync_memberships where organization_id=t.o('org') and invoice_id='snapshot-inv-b'$q$,'missing_from_source_pending_review');
select t.eq('snapshot: omitted invoice still exists and unpaid',
  $q$select (select count(*) from public.invoices where organization_id=t.o('org') and id='snapshot-inv-b')::text || '/' || (select paid_minor::text from public.invoices where organization_id=t.o('org') and id='snapshot-inv-b')$q$,'1/0');

-- A partially rejected snapshot must not change existing membership/reconcile omissions.
insert into public.source_sync_runs(organization_id,id,source_key,provider,spreadsheet_id,source_range,status)
values (t.o('org'),'run-4','google_sheets:spreadsheet12345','google_sheets','spreadsheet12345','Invoices!A1:H3','started');
select t.eq('snapshot: rejected rows prevent reconciliation',
  $q$select (public.complete_source_sync_snapshot(t.o('org'),'run-4','google_sheets:spreadsheet12345','Invoices!A1:H3','spreadsheet12345',repeat('d',64),array['snapshot-inv-a'],1,1))->>'reconciled'$q$,'false');
select t.eq('snapshot: partial run marked completed with errors',
  $q$select status from public.source_sync_runs where organization_id=t.o('org') and id='run-4'$q$,'completed_with_errors');
select t.eq('snapshot: partial run does not change B review state',
  $q$select review_state from public.source_sync_memberships where organization_id=t.o('org') and invoice_id='snapshot-inv-b'$q$,'missing_from_source_pending_review');

-- A failed/unfinalized run cannot reconcile because only started runs may be completed.
insert into public.source_sync_runs(organization_id,id,source_key,provider,spreadsheet_id,source_range,status,completed_at,error_code)
values (t.o('org'),'run-failed','google_sheets:spreadsheet12345','google_sheets','spreadsheet12345','Invoices!A1:H3','failed',now(),'sheet_read_failed');
select t.err('snapshot: failed run cannot be finalized',
  $q$select public.complete_source_sync_snapshot(t.o('org'),'run-failed','google_sheets:spreadsheet12345','Invoices!A1:H3','spreadsheet12345',repeat('e',64),array['snapshot-inv-a'],1,0)$q$,'22023');

-- Browser roles must not be allowed to execute the privileged RPC.
reset role;
select set_config('request.jwt.claim.role', 'authenticated', false);
set role authenticated;
select t.err('snapshot: authenticated cannot execute completion RPC',
  $q$select public.complete_source_sync_snapshot(t.o('org'),'run-2','google_sheets:spreadsheet12345','Invoices!A1:H3','spreadsheet12345',repeat('f',64),array['snapshot-inv-a'],1,0)$q$,'42501');
reset role;
select set_config('request.jwt.claim.role', '', false);

\echo
\echo ===== SOURCE SNAPSHOT RPC RESULTS =====
select case when ok then 'PASS' else 'FAIL' end as result, label, coalesce(detail,'') as detail
  from t.results where label like 'snapshot:%' order by n;
select count(*) filter (where ok) as passed, count(*) filter (where not ok) as failed
  from t.results where label like 'snapshot:%';
