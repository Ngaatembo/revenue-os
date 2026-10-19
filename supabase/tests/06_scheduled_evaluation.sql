-- Tests for the scheduled evaluation: run_scheduled_evaluation, evaluation_runs.
\set ON_ERROR_STOP off
\set X '00000000-0000-4000-8000-0000000000e9'
\set Z '00000000-0000-4000-8000-0000000000e8'
\set N '00000000-0000-4000-8000-0000000000e7'

insert into auth.users(id, email) values (:'X','sx@example.test'), (:'Z','sz@example.test'), (:'N','sn@example.test');
select set_config('request.jwt.claim.sub', :'X', false) \gset
set role authenticated;
select organization_id as orgx from public.bootstrap_revenue_os_organization('Sched Org X') \gset
reset role;
select set_config('request.jwt.claim.sub', :'Z', false) \gset
set role authenticated;
select organization_id as orgz from public.bootstrap_revenue_os_organization('Sched Org Z') \gset
reset role;
select set_config('request.jwt.claim.sub', :'N', false) \gset
set role authenticated;
select organization_id as orgn from public.bootstrap_revenue_os_organization('Sched Org N') \gset
reset role;
select set_config('t.orgx', :'orgx', false), set_config('t.orgz', :'orgz', false), set_config('t.orgn', :'orgn', false) \gset

-- Org X: rate + 2 overdue invoices. Org Z: rate + nothing overdue. Org N: nothing set.
select set_config('request.jwt.claim.sub', :'X', false) \gset
set role authenticated;
select t.ok('sched: X sets rate', $q$insert into public.assumptions(organization_id,id,assumption_key,value_bps,updated_by) values (t.o('orgx'),'recovery-rate','recovery_rate',2000,(select id from public.users where auth_subject=auth.uid()))$q$);
select t.ok('sched: X imports invoices', $q$select public.persist_invoice_import(t.o('orgx'),'src-s','s.csv',repeat('c',64),
 jsonb_build_array(
  jsonb_build_object('id','s-a','invoiceNumber','S-A','customerId','ca','customerName','A','currency','USD','totalMinor',100000,'paidMinor',0,'issuedAt',now()-interval '60 days','dueAt',now()-interval '30 days','importedAt',now()),
  jsonb_build_object('id','s-b','invoiceNumber','S-B','customerId','cb','customerName','B','currency','USD','totalMinor',50000,'paidMinor',0,'issuedAt',now()-interval '40 days','dueAt',now()-interval '10 days','importedAt',now())
 ),0)$q$);
reset role;
select set_config('request.jwt.claim.sub', :'Z', false) \gset
set role authenticated;
select t.ok('sched: Z sets rate', $q$insert into public.assumptions(organization_id,id,assumption_key,value_bps,updated_by) values (t.o('orgz'),'recovery-rate','recovery_rate',1000,(select id from public.users where auth_subject=auth.uid()))$q$);
reset role;
select set_config('request.jwt.claim.sub', '', false) \gset

-- Callers cannot run it
set role anon;
select t.err('sched: anon cannot run the scheduler', $q$select public.run_scheduled_evaluation()$q$);
reset role;
select set_config('request.jwt.claim.sub', :'X', false) \gset
set role authenticated;
select t.err('sched: a signed-in owner cannot run the scheduler', $q$select public.run_scheduled_evaluation()$q$);
select t.err('sched: nor the private per-org function', $q$select private.run_org_evaluation(t.o('orgx'),'manual')$q$);
reset role;
select set_config('request.jwt.claim.sub', '', false) \gset

-- Run as the database scheduler (superuser) with no user signed in
select t.ok('sched: first scheduled run completes', $q$select public.run_scheduled_evaluation()$q$);
select t.eq('sched: the run covered all three test workspaces', format($q$select count(*)::text from public.evaluation_runs where organization_id in (%L,%L,%L)$q$, :'orgx', :'orgz', :'orgn'), '3');
select t.eq('sched: X opportunities detected without anyone opening the app', format($q$select count(*)::text from public.opportunities where organization_id=%L and status='open'$q$, :'orgx'), '2');
select t.eq('sched: Z has nothing to detect', format($q$select count(*)::text from public.opportunities where organization_id=%L$q$, :'orgz'), '0');
select t.eq('sched: N (no rate) is skipped with a reason', format($q$select status||'|'||message from public.evaluation_runs where organization_id=%L$q$, :'orgn'), 'skipped|No recovery-rate assumption is set');
select t.eq('sched: X run recorded with counts', format($q$select status||'|'||created_count||'|'||open_count from public.evaluation_runs where organization_id=%L$q$, :'orgx'), 'ok|2|2');
select t.eq('sched: the run did not leave a user signed in', $q$select coalesce(nullif(current_setting('request.jwt.claim.sub', true),''),'none')$q$, 'none');

-- Idempotent and retry-safe
select t.ok('sched: second run', $q$select public.run_scheduled_evaluation()$q$);
select t.eq('sched: no duplicate opportunities after a second run', format($q$select count(*)::text from public.opportunities where organization_id=%L$q$, :'orgx'), '2');
select t.eq('sched: both runs are logged (history kept)', format($q$select count(*)::text from public.evaluation_runs where organization_id=%L$q$, :'orgx'), '2');
select t.eq('sched: second run created nothing new', format($q$select created_count::text from public.evaluation_runs where organization_id=%L order by started_at desc, id limit 1$q$, :'orgx'), '0');

-- A paid invoice is closed by the scheduler
update public.invoices set paid_minor = total_minor where organization_id = :'orgx' and id = 's-b';
select t.ok('sched: run after payment', $q$select public.run_scheduled_evaluation()$q$);
select t.eq('sched: paid invoice closed in the background', format($q$select status from public.opportunities where organization_id=%L and id='overdue_invoice:s-b'$q$, :'orgx'), 'closed');
select t.eq('sched: unpaid invoice stays open', format($q$select status from public.opportunities where organization_id=%L and id='overdue_invoice:s-a'$q$, :'orgx'), 'open');

-- The scheduler never reopens a dismissed issue
select set_config('request.jwt.claim.sub', :'X', false) \gset
set role authenticated;
select t.ok('sched: owner dismisses s-a', $q$select public.set_opportunity_state(t.o('orgx'),'overdue_invoice:s-a','dismiss','settled outside the system')$q$);
reset role;
select set_config('request.jwt.claim.sub', '', false) \gset
select t.ok('sched: run after dismissal', $q$select public.run_scheduled_evaluation()$q$);
select t.eq('sched: dismissal survives the scheduler', format($q$select status from public.opportunities where organization_id=%L and id='overdue_invoice:s-a'$q$, :'orgx'), 'dismissed');

-- Isolation of the run log
select set_config('request.jwt.claim.sub', :'Z', false) \gset
set role authenticated;
select t.eq('iso: Z sees only its own runs', $q$select count(distinct organization_id)::text from public.evaluation_runs$q$, '1');
select t.eq('iso: Z sees its own run log', $q$select count(*)::text from public.evaluation_runs where organization_id=t.o('orgz')$q$, '4');
select t.eq('iso: Z cannot see X runs', $q$select count(*)::text from public.evaluation_runs where organization_id=t.o('orgx')$q$, '0');
select t.err('iso: runs cannot be written by users', $q$insert into public.evaluation_runs(organization_id,id,trigger_kind,status) values (t.o('orgz'),'x','manual','ok')$q$);
reset role;
select t.err('sched: run log is immutable', format($q$delete from public.evaluation_runs where organization_id=%L$q$, :'orgx'));

\echo ===== SCHEDULE RESULTS =====
select case when ok then 'PASS' else 'FAIL' end as r, label, detail from t.results where label ~ '^sched:|^iso: (Z sees|Z cannot|runs)' order by n;
select count(*) filter (where ok) as passed, count(*) filter (where not ok) as failed from t.results where label ~ '^sched:';
