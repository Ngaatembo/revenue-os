-- Tests for public.sync_overdue_opportunities. Synthetic data only; own workspace; runs after 02_journey.sql.
-- Run as a superuser after migrations + 00_supabase_stub.sql + 01_harness.sql.
\set ON_ERROR_STOP off
\set X '00000000-0000-4000-8000-0000000000f1'
\set Z '00000000-0000-4000-8000-0000000000f2'
\set W '00000000-0000-4000-8000-0000000000f3'

insert into auth.users(id, email) values (:'X','x@example.test'), (:'Z','z@example.test'), (:'W','viewer-x@example.test');
select set_config('request.jwt.claim.sub', :'X', false) \gset
set role authenticated;
select organization_id as orgx from public.bootstrap_revenue_os_organization('Sync Org X') \gset
reset role;
select set_config('request.jwt.claim.sub', :'Z', false) \gset
set role authenticated;
select organization_id as orgz from public.bootstrap_revenue_os_organization('Sync Org Z') \gset
reset role;
select set_config('t.orgx', :'orgx', false), set_config('t.orgz', :'orgz', false) \gset
select set_config('request.jwt.claim.sub', '', false) \gset
insert into public.users(id, auth_subject, email) values (:'W', :'W', 'viewer-x@example.test');
insert into public.memberships(organization_id, user_id, role) values (:'orgx', :'W', 'viewer');

-- ---------- Authorization ----------
set role anon;
select t.err('sync: anon cannot run detection', $q$select public.sync_overdue_opportunities(t.o('orgx'))$q$);
reset role;
select set_config('request.jwt.claim.sub', :'Z', false) \gset
set role authenticated;
select t.err('sync: other workspace member cannot run detection on this workspace', $q$select public.sync_overdue_opportunities(t.o('orgx'))$q$, '42501');
reset role;
select set_config('request.jwt.claim.sub', :'W', false) \gset
set role authenticated;
select t.err('sync: viewer cannot run detection', $q$select public.sync_overdue_opportunities(t.o('orgx'))$q$, '42501');
reset role;

-- ---------- No assumption -> refuses (never guesses a rate) ----------
select set_config('request.jwt.claim.sub', :'X', false) \gset
set role authenticated;
select t.err('sync: refuses to run without a saved recovery-rate assumption', $q$select public.sync_overdue_opportunities(t.o('orgx'))$q$, '22023');
select t.eq('sync: nothing created without an assumption', $q$select count(*)::text from public.opportunities where organization_id=t.o('orgx')$q$, '0');

select t.ok('sync: owner saves 30% recovery rate', $q$insert into public.assumptions(organization_id,id,assumption_key,value_bps,updated_by) values (t.o('orgx'),'recovery-rate','recovery_rate',3000,(select id from public.users where auth_subject=auth.uid()))$q$);
select t.ok('sync: invoices imported', $q$select public.persist_invoice_import(t.o('orgx'),'src-sync','sync.csv',repeat('a',64),
 jsonb_build_array(
  jsonb_build_object('id','inv-a','invoiceNumber','INV-A','customerId','ca','customerName','Cust A','currency','USD','totalMinor',100000,'paidMinor',0,'issuedAt',now()-interval '60 days','dueAt',now()-interval '30 days','importedAt',now()),
  jsonb_build_object('id','inv-b','invoiceNumber','INV-B','customerId','cb','customerName','Cust B','currency','USD','totalMinor',50000,'paidMinor',20000,'issuedAt',now()-interval '40 days','dueAt',now()-interval '10 days','importedAt',now()),
  jsonb_build_object('id','inv-c','invoiceNumber','INV-C','customerId','cc','customerName','Cust C','currency','EUR','totalMinor',70000,'paidMinor',0,'issuedAt',now()-interval '20 days','dueAt',now()-interval '5 days','importedAt',now()),
  jsonb_build_object('id','inv-d','invoiceNumber','INV-D','customerId','cd','customerName','Cust D','currency','USD','totalMinor',90000,'paidMinor',0,'issuedAt',now()-interval '5 days','dueAt',now()+interval '20 days','importedAt',now()),
  jsonb_build_object('id','inv-e','invoiceNumber','INV-E','customerId','ce','customerName','Cust E','currency','USD','totalMinor',10000,'paidMinor',10000,'issuedAt',now()-interval '50 days','dueAt',now()-interval '20 days','importedAt',now()),
  jsonb_build_object('id','inv-f','invoiceNumber','INV-F','customerId','cf','customerName','Cust F','currency','USD','totalMinor',40000,'paidMinor',0,'issuedAt',now()-interval '9 days','dueAt',now()-interval '12 hours','importedAt',now()),
  jsonb_build_object('id','inv-g','invoiceNumber','INV-G','customerId','cg','customerName','Cust G','currency','USD','totalMinor',12345,'paidMinor',0,'issuedAt',now()-interval '15 days','dueAt',now()-interval '3 days','importedAt',now())
 ),0)$q$);
select t.eq('sync: importing invoices alone creates no opportunities', $q$select count(*)::text from public.opportunities where organization_id=t.o('orgx')$q$, '0');

-- ---------- Detection ----------
select t.eq('sync: first run reports 4 created (A, B, C, G)', $q$select (public.sync_overdue_opportunities(t.o('orgx')))->>'created'$q$, '4');
select t.eq('sync: exactly the 4 overdue unpaid invoices are opportunities', $q$select string_agg(id, ',' order by id) from public.opportunities where organization_id=t.o('orgx')$q$, 'overdue_invoice:inv-a,overdue_invoice:inv-b,overdue_invoice:inv-c,overdue_invoice:inv-g');
select t.eq('sync: not-yet-due, fully paid and <1 day overdue invoices are excluded', $q$select count(*)::text from public.opportunities where organization_id=t.o('orgx') and id in ('overdue_invoice:inv-d','overdue_invoice:inv-e','overdue_invoice:inv-f')$q$, '0');
select t.eq('sync: estimate = outstanding x rate (A 30% of 1000.00)', $q$select estimate_low_minor||'/'||estimate_high_minor||'/'||outstanding_minor from public.opportunities where organization_id=t.o('orgx') and id='overdue_invoice:inv-a'$q$, '30000/30000/100000');
select t.eq('sync: partial payment reduces outstanding (B outstanding 300.00, estimate 90.00)', $q$select outstanding_minor||'/'||estimate_low_minor from public.opportunities where organization_id=t.o('orgx') and id='overdue_invoice:inv-b'$q$, '30000/9000');
select t.eq('sync: currencies are kept separate (C is EUR)', $q$select currency||'/'||estimate_low_minor from public.opportunities where organization_id=t.o('orgx') and id='overdue_invoice:inv-c'$q$, 'EUR/21000');
select t.eq('sync: estimate rounds half up (12345 x 30% = 3703.5 -> 3704)', $q$select estimate_low_minor::text from public.opportunities where organization_id=t.o('orgx') and id='overdue_invoice:inv-g'$q$, '3704');
select t.eq('sync: status starts open', $q$select string_agg(distinct status, ',') from public.opportunities where organization_id=t.o('orgx')$q$, 'open');
select t.eq('sync: reason is stored with the opportunity', $q$select (detection_reason ~ '^Invoice INV-A was due on \d{4}-\d{2}-\d{2} and is 30 day\(s\) past due\. USD 1000\.00 of USD 1000\.00 is unpaid\.$')::text||'/'||detection_rule from public.opportunities where organization_id=t.o('orgx') and id='overdue_invoice:inv-a'$q$, 'true/overdue_invoice_v1');
select t.eq('sync: each opportunity links its source invoice as evidence', $q$select count(*)::text from public.opportunity_evidence e join public.invoices i on i.organization_id=e.organization_id and i.id=e.invoice_id where e.organization_id=t.o('orgx') and e.opportunity_id='overdue_invoice:'||i.id$q$, '4');
select t.eq('sync: estimates never create verified revenue', $q$select count(*)::text from public.outcomes where organization_id=t.o('orgx')$q$, '0');

-- ---------- Idempotency ----------
select t.eq('sync: second run creates nothing and refreshes 4', $q$select ((public.sync_overdue_opportunities(t.o('orgx')))->>'created')||'/'||((public.sync_overdue_opportunities(t.o('orgx')))->>'refreshed')$q$, '0/4');
select t.eq('sync: no duplicate opportunities after repeated runs', $q$select count(*)::text from public.opportunities where organization_id=t.o('orgx')$q$, '4');
select t.eq('sync: no duplicate evidence after repeated runs', $q$select count(*)::text from public.opportunity_evidence where organization_id=t.o('orgx')$q$, '4');

-- ---------- Rate change refreshes unactioned estimates ----------
select t.ok('sync: rate changed to 50%', $q$update public.assumptions set value_bps=5000 where organization_id=t.o('orgx') and id='recovery-rate'$q$);
select t.eq('sync: run reports the saved rate', $q$select (public.sync_overdue_opportunities(t.o('orgx')))->>'recovery_rate_bps'$q$, '5000');
select t.eq('sync: open opportunities reflect the new rate (A 50% of 1000.00)', $q$select estimate_low_minor::text from public.opportunities where organization_id=t.o('orgx') and id='overdue_invoice:inv-a'$q$, '50000');

-- ---------- Actioned opportunities keep their proposal-time snapshot ----------
select t.ok('sync: reminder proposed for A', $q$select public.propose_invoice_reminder(t.o('orgx'),'inv-a','Hello, invoice INV-A is overdue. Please pay.')$q$);
select t.ok('sync: rate lowered to 10%', $q$update public.assumptions set value_bps=1000 where organization_id=t.o('orgx') and id='recovery-rate'$q$);
select t.ok('sync: re-run after rate change', $q$select public.sync_overdue_opportunities(t.o('orgx'))$q$);
select t.eq('sync: actioned opportunity keeps its snapshot (A stays 50000)', $q$select estimate_low_minor::text from public.opportunities where organization_id=t.o('orgx') and id='overdue_invoice:inv-a'$q$, '50000');
select t.eq('sync: unactioned opportunity follows the new rate (B 10% of 300.00)', $q$select estimate_low_minor::text from public.opportunities where organization_id=t.o('orgx') and id='overdue_invoice:inv-b'$q$, '3000');
reset role;

-- ---------- Paid invoices close opportunities; snapshot protects verification ----------
update public.invoices set paid_minor = total_minor where organization_id = :'orgx' and id = 'inv-b';
update public.invoices set paid_minor = 60000 where organization_id = :'orgx' and id = 'inv-a';
update public.opportunities set status = 'dismissed' where organization_id = :'orgx' and id = 'overdue_invoice:inv-c';
select set_config('request.jwt.claim.sub', :'X', false) \gset
set role authenticated;
select t.eq('sync: paid-in-full invoice closes its opportunity (1 closed)', $q$select (public.sync_overdue_opportunities(t.o('orgx')))->>'closed'$q$, '1');
select t.eq('sync: B is closed, not deleted', $q$select status from public.opportunities where organization_id=t.o('orgx') and id='overdue_invoice:inv-b'$q$, 'closed');
select t.eq('sync: dismissed opportunities are never reopened', $q$select status from public.opportunities where organization_id=t.o('orgx') and id='overdue_invoice:inv-c'$q$, 'dismissed');
select t.eq('sync: partially paid actioned invoice stays open with its snapshot', $q$select status||'/'||outstanding_minor from public.opportunities where organization_id=t.o('orgx') and id='overdue_invoice:inv-a'$q$, 'open/100000');
select t.eq('sync: closing is idempotent', $q$select (public.sync_overdue_opportunities(t.o('orgx')))->>'closed'$q$, '0');
select t.eq('sync: closed opportunities keep their evidence link', $q$select count(*)::text from public.opportunity_evidence where organization_id=t.o('orgx') and opportunity_id='overdue_invoice:inv-b'$q$, '1');

-- verification still works after sync, and counts only matched payment evidence
select (public.propose_invoice_reminder(:'orgx','inv-a','Hello, invoice INV-A is overdue. Please pay.'))->>'id' as acta \gset
select set_config('t.acta', :'acta', false) \gset
select t.ok('sync: approve', $q$select public.transition_revenue_action(t.o('orgx'),t.o('acta'),'approve')$q$);
select t.ok('sync: mark sent manually', $q$select public.transition_revenue_action(t.o('orgx'),t.o('acta'),'mark_sent')$q$);
select t.eq('sync: no verified outcome without payment evidence', $q$select (public.verify_recovery_outcome(t.o('orgx'),t.o('acta'),30))->>'verified'$q$, 'false');
select t.ok('sync: payment evidence imported', $q$select public.persist_payment_import(t.o('orgx'),'src-sync-pay','sync-pay.csv',repeat('b',64),
 jsonb_build_array(jsonb_build_object('externalRecordId','SYNC-PAY-1','invoiceNumber','INV-A','currency','USD','amountMinor',40000,'receivedAt',now()+interval '1 hour')),0)$q$);
select t.eq('sync: verified revenue equals matched payment evidence only', $q$select (public.verify_recovery_outcome(t.o('orgx'),t.o('acta'),30))->>'amount_minor'$q$, '40000');
-- (propose_invoice_reminder refreshes the opportunity snapshot on each call: 40000 outstanding x 10% = 4000)
select t.eq('sync: verified revenue comes from the outcome record, not from the opportunity estimate', $q$select o.amount_minor||'/'||p.estimate_low_minor from public.outcomes o join public.opportunities p on p.organization_id=o.organization_id and p.id=o.opportunity_id where o.organization_id=t.o('orgx')$q$, '40000/4000');
reset role;

-- ---------- Tenant isolation of the persisted opportunities ----------
select set_config('request.jwt.claim.sub', :'Z', false) \gset
set role authenticated;
select t.eq('sync: other workspace sees none of these opportunities', $q$select count(*)::text from public.opportunities where organization_id=t.o('orgx')$q$, '0');
select t.eq('sync: other workspace can sync its own (empty) data after setting a rate', $q$select (select count(*) from public.opportunities where organization_id=t.o('orgz')) || ''$q$, '0');
reset role;

\echo
\echo ===== SYNC RESULTS =====
select case when ok then 'PASS' else 'FAIL' end as r, label, coalesce(detail,'') as detail from t.results where label like 'sync:%' order by n;
select count(*) filter (where ok) as passed, count(*) filter (where not ok) as failed from t.results where label like 'sync:%';
