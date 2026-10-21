-- Service-side import + refresh used by automatic Google Sheets sync. Synthetic data only.
\set ON_ERROR_STOP off
\set P '00000000-0000-4000-8000-00000000fa01'
\set Q '00000000-0000-4000-8000-00000000fa02'

insert into auth.users(id, email) values (:'P','auto-p@example.test'), (:'Q','auto-q@example.test');
select set_config('request.jwt.claim.sub', :'P', false) \gset
set role authenticated;
select organization_id as orgp from public.bootstrap_revenue_os_organization('Auto Org P') \gset
reset role;
select set_config('request.jwt.claim.sub', :'Q', false) \gset
set role authenticated;
select organization_id as orgq from public.bootstrap_revenue_os_organization('Auto Org Q') \gset
reset role;
select set_config('t.orgp', :'orgp', false), set_config('t.orgq', :'orgq', false) \gset
select set_config('request.jwt.claim.sub', '', false) \gset

-- Callers without the service role are refused.
select set_config('request.jwt.claim.sub', :'P', false);
set role authenticated;
select t.err('auto: signed-in users cannot call the system import', $q$select public.persist_invoice_import_system(t.o('orgp'),'s','s',repeat('a',64),'[]'::jsonb,0)$q$, '42501');
select t.err('auto: signed-in users cannot call the refresh', $q$select public.refresh_org_after_sync(t.o('orgp'))$q$, '42501');
reset role;
select set_config('request.jwt.claim.sub', '', false);
set role anon;
select t.err('auto: anonymous cannot call the system import', $q$select public.persist_invoice_import_system('x','s','s',repeat('a',64),'[]'::jsonb,0)$q$, '42501');
reset role;

set role service_role;
select set_config('request.jwt.claim.role', 'service_role', false);
create temp table rows_v1 as select jsonb_build_array(
  jsonb_build_object('id','auto-1','invoiceNumber','A-1','customerId','c1','customerName','Cust One','currency','USD','totalMinor',100000,'paidMinor',0,'issuedAt',now()-interval '60 days','dueAt',now()-interval '30 days','importedAt',now()),
  jsonb_build_object('id','auto-2','invoiceNumber','A-2','customerId','c2','customerName','Cust Two','currency','USD','totalMinor',50000,'paidMinor',0,'issuedAt',now()-interval '60 days','dueAt',now()-interval '20 days','importedAt',now())) as r;
grant select on rows_v1 to public;
select t.eq('auto: first import stores both rows', $q$select (public.persist_invoice_import_system(t.o('orgp'),'google_sheets:abcdefghij','Google Sheets abcdefghij',repeat('1',64),(select r from rows_v1),0))->>'accepted_rows'$q$, '2');
select t.eq('auto: invoices were written', $q$select count(*)::text from public.invoices where organization_id=t.o('orgp') and source_id='google_sheets:abcdefghij'$q$, '2');
select t.eq('auto: repeating the same content is a duplicate no-op', $q$select (public.persist_invoice_import_system(t.o('orgp'),'google_sheets:abcdefghij','Google Sheets abcdefghij',repeat('1',64),(select r from rows_v1),0))->>'duplicate'$q$, 'true');
select t.eq('auto: still exactly two invoices', $q$select count(*)::text from public.invoices where organization_id=t.o('orgp')$q$, '2');
select t.ok('auto: changed content (a payment recorded) updates the same invoice', $q$select public.persist_invoice_import_system(t.o('orgp'),'google_sheets:abcdefghij','Google Sheets abcdefghij',repeat('2',64),
  (select jsonb_set(r,'{0,paidMinor}','40000'::jsonb) from rows_v1),0)$q$);
select t.eq('auto: the invoice was updated in place', $q$select paid_minor::text||'/'||(select count(*) from public.invoices where organization_id=t.o('orgp'))::text from public.invoices where organization_id=t.o('orgp') and id='auto-1'$q$, '40000/2');
select t.eq('auto: import is attributed to the workspace owner', $q$select (select auth_subject from public.users where id=created_by)::text from public.imports where organization_id=t.o('orgp') order by created_at limit 1$q$, :'P');
select t.err('auto: rows with bad shape are rejected by the original validation', $q$select public.persist_invoice_import_system(t.o('orgp'),'s','s','not-a-hash','[]'::jsonb,0)$q$, '22023');
select t.err('auto: a workspace without an owner cannot be imported into', $q$select public.persist_invoice_import_system('missing-org','s','s',repeat('3',64),'[]'::jsonb,0)$q$, '22023');

select t.eq('auto: refresh skips (and says so) without a recovery-rate assumption', $q$select public.refresh_org_after_sync(t.o('orgp'))$q$, 'skipped');
reset role;
insert into public.assumptions(organization_id,id,assumption_key,value_bps,updated_by) values (:'orgp','recovery-rate','recovery_rate',3000,(select id from public.users where auth_subject=:'P'));
set role service_role;
select t.eq('auto: refresh evaluates the workspace once the assumption exists', $q$select public.refresh_org_after_sync(t.o('orgp'))$q$, 'ok');
select t.eq('auto: overdue opportunities now exist from the synced rows', $q$select count(*)::text from public.opportunities where organization_id=t.o('orgp')$q$, '2');
select t.eq('auto: the refresh is logged as a run', $q$select count(*)::text from public.evaluation_runs where organization_id=t.o('orgp') and status='ok'$q$, '1');
select t.eq('auto: the other workspace is untouched', $q$select (select count(*) from public.invoices where organization_id=t.o('orgq'))||'/'||(select count(*) from public.opportunities where organization_id=t.o('orgq'))$q$, '0/0');
reset role;
select set_config('request.jwt.claim.role', '', false);

\echo
\echo ===== AUTO SYNC RESULTS =====
select case when ok then 'PASS' else 'FAIL' end as result, label, coalesce(detail,'') as detail
  from t.results where label like 'auto:%' order by n;
select count(*) filter (where ok) as passed, count(*) filter (where not ok) as failed
  from t.results where label like 'auto:%';
