-- Synthetic invoice-to-verified-outcome journey, tenant isolation and role tests.
-- All data is synthetic. Run after migrations + 00_supabase_stub.sql + 01_harness.sql, as a superuser.
\set ON_ERROR_STOP off
\set A '00000000-0000-4000-8000-00000000000a'
\set B '00000000-0000-4000-8000-00000000000b'
\set V '00000000-0000-4000-8000-0000000000c1'
\set O '00000000-0000-4000-8000-0000000000d1'
\set M '00000000-0000-4000-8000-0000000000e1'

-- ---------- Setup: signed-up auth users, then two organizations bootstrapped through the intended flow ----------
insert into auth.users(id, email) values (:'A','a@example.test'), (:'B','b@example.test'), (:'V','viewer@example.test'), (:'O','operator@example.test'), (:'M','admin@example.test');
select set_config('request.jwt.claim.sub', :'A', false) \gset
set role authenticated;
select organization_id as orga from public.bootstrap_revenue_os_organization('Synthetic Org A') \gset
reset role;
select set_config('request.jwt.claim.sub', :'B', false) \gset
set role authenticated;
select organization_id as orgb from public.bootstrap_revenue_os_organization('Synthetic Org B') \gset
reset role;
select set_config('t.orga', :'orga', false), set_config('t.orgb', :'orgb', false) \gset

-- extra users in org A with other roles (inserted by superuser as test fixtures)
select set_config('request.jwt.claim.sub', '', false) \gset  -- maintenance context: no end-user identity
insert into public.users(id, auth_subject, email) values (:'V', :'V', 'viewer@example.test'), (:'O', :'O', 'operator@example.test'), (:'M', :'M', 'admin@example.test');
insert into public.memberships(organization_id, user_id, role) values (:'orga', :'V', 'viewer'), (:'orga', :'O', 'operator'), (:'orga', :'M', 'admin');

-- ---------- Bootstrap / first-time user ----------
select set_config('request.jwt.claim.sub', :'A', false) \gset
set role authenticated;
select t.eq('bootstrap is idempotent (same org returned)', $q$select organization_id from public.bootstrap_revenue_os_organization('Another name')$q$, :'orga');
select t.eq('owner membership created', $q$select role from public.memberships where organization_id=t.o('orga')$q$ || $q$ and user_id=(select id from public.users where auth_subject=auth.uid())$q$, 'owner');
select t.err('bootstrap rejects empty name', $q$select * from public.bootstrap_revenue_os_organization('   ')$q$, '22023');
reset role;

-- ---------- Unauthenticated ----------
set role anon;
select t.err('anon cannot import invoices', $q$select public.persist_invoice_import(t.o('orga'),'s','s',repeat('a',64),'[]'::jsonb,0)$q$);
select t.eq('anon sees no invoices', $q$select count(*)::text from public.invoices$q$, '0');
reset role;

-- ---------- Assumption upsert (operator) + role checks ----------
select set_config('request.jwt.claim.sub', :'O', false) \gset
set role authenticated;
select t.ok('operator can upsert recovery-rate assumption', $q$insert into public.assumptions(organization_id,id,assumption_key,value_bps,updated_by) values (t.o('orga'),'recovery-rate','recovery_rate',3000,(select id from public.users where auth_subject=auth.uid())) on conflict (organization_id,id) do update set value_bps=excluded.value_bps$q$);
select t.err('assumption rejects >10000 bps', $q$update public.assumptions set value_bps=10001 where organization_id=t.o('orga')$q$);
reset role;
select set_config('request.jwt.claim.sub', :'V', false) \gset
set role authenticated;
select t.err('viewer cannot import invoices', $q$select public.persist_invoice_import(t.o('orga'),'src','f.csv',repeat('b',64),'[]'::jsonb,0)$q$, '42501');
select t.err('viewer cannot update assumptions', $q$insert into public.assumptions(organization_id,id,assumption_key,value_bps,updated_by) values (t.o('orga'),'x','recovery_rate',1,'v') on conflict do nothing$q$);
select t.eq('viewer can read org data', $q$select count(*)::text from public.organizations$q$, '1');
reset role;

-- ---------- Invoice import ----------
select set_config('request.jwt.claim.sub', :'O', false) \gset
set role authenticated;
select t.ok('valid invoice import', $q$select public.persist_invoice_import(t.o('orga'),'src-inv','invoices.csv',repeat('1',64),
 jsonb_build_array(
  jsonb_build_object('id','inv-1','invoiceNumber','INV-1','customerId','c1','customerName','Cust One','currency','USD','totalMinor',100000,'paidMinor',0,'issuedAt',now()-interval '60 days','dueAt',now()-interval '30 days','importedAt',now()),
  jsonb_build_object('id','inv-2','invoiceNumber','INV-2','customerId','c2','customerName','Cust Two','currency','USD','totalMinor',50000,'paidMinor',20000,'issuedAt',now()-interval '40 days','dueAt',now()-interval '10 days','importedAt',now()),
  jsonb_build_object('id','inv-3','invoiceNumber','INV-3','customerId','c3','customerName','Cust Three','currency','EUR','totalMinor',70000,'paidMinor',0,'issuedAt',now()-interval '20 days','dueAt',now()-interval '5 days','importedAt',now()),
  jsonb_build_object('id','inv-4','invoiceNumber','INV-4','customerId','c4','customerName','Cust Four','currency','USD','totalMinor',90000,'paidMinor',0,'issuedAt',now()-interval '5 days','dueAt',now()+interval '20 days','importedAt',now()),
  jsonb_build_object('id','inv-5','invoiceNumber','INV-5','customerId','c5','customerName','Cust Five','currency','USD','totalMinor',10000,'paidMinor',10000,'issuedAt',now()-interval '50 days','dueAt',now()-interval '20 days','importedAt',now())
 ),2)$q$);
select t.eq('import persisted 5 invoices', $q$select count(*)::text from public.invoices where organization_id=t.o('orga')$q$, '5');
select t.eq('import records rejected count (2) and status', $q$select rejected_rows||':'||status from public.imports where organization_id=t.o('orga') and source_id='src-inv'$q$, '2:completed_with_errors');
select t.eq('re-importing same file is a no-op duplicate', $q$select (public.persist_invoice_import(t.o('orga'),'src-inv','invoices.csv',repeat('1',64),'[{"id":"zzz"}]'::jsonb,0))->>'duplicate'$q$, 'true');
select t.eq('invoice count unchanged after duplicate import', $q$select count(*)::text from public.invoices where organization_id=t.o('orga')$q$, '5');
select t.err('bad content hash rejected', $q$select public.persist_invoice_import(t.o('orga'),'src-x','x.csv','nothex','[]'::jsonb,0)$q$, '22023');
select t.err('non-array rows rejected', $q$select public.persist_invoice_import(t.o('orga'),'src-x','x.csv',repeat('2',64),'{}'::jsonb,0)$q$, '22023');
select t.err('negative rejected count rejected', $q$select public.persist_invoice_import(t.o('orga'),'src-x','x.csv',repeat('3',64),'[]'::jsonb,-1)$q$, '22023');
select t.err('invalid row (negative total) aborts import atomically', $q$select public.persist_invoice_import(t.o('orga'),'src-bad','bad.csv',repeat('4',64),
 jsonb_build_array(jsonb_build_object('id','ok-1','invoiceNumber','OK-1','customerId','c','customerName','n','currency','USD','totalMinor',100,'paidMinor',0,'issuedAt',now(),'dueAt',now(),'importedAt',now()),
                   jsonb_build_object('id','bad-1','invoiceNumber','BAD-1','customerId','c','customerName','n','currency','USD','totalMinor',-5,'paidMinor',0,'issuedAt',now(),'dueAt',now(),'importedAt',now())),0)$q$);
select t.eq('no partial rows left after failed import', $q$select count(*)::text from public.invoices where organization_id=t.o('orga') and id in ('ok-1','bad-1')$q$, '0');
select t.eq('no import record left after failed import', $q$select count(*)::text from public.imports where organization_id=t.o('orga') and source_id='src-bad'$q$, '0');
reset role;

-- ---------- Tenant isolation ----------
select set_config('request.jwt.claim.sub', :'B', false) \gset
set role authenticated;
select t.eq('org B cannot read org A invoices', $q$select count(*)::text from public.invoices where organization_id=t.o('orga')$q$, '0');
select t.eq('org B cannot read org A actions', $q$select count(*)::text from public.actions where organization_id=t.o('orga')$q$, '0');
select t.err('org B cannot import into org A', $q$select public.persist_invoice_import(t.o('orga'),'evil','e.csv',repeat('5',64),'[]'::jsonb,0)$q$, '42501');
select t.err('org B cannot propose on org A invoice', $q$select public.propose_invoice_reminder(t.o('orga'),'inv-1','Please pay invoice INV-1 soon')$q$, '42501');
select t.err('org B cannot write a lead into org A', $q$insert into public.sales_leads(organization_id,id,contact_name,business_name,next_follow_up,created_by) values (t.o('orga'),'l-x','n','b',current_date,'x')$q$);
select t.err('org B cannot add itself to org A', $q$insert into public.memberships(organization_id,user_id,role) values (t.o('orga'),(select id from public.users where auth_subject=auth.uid()),'owner')$q$);
reset role;

-- ---------- Lead recovery activity loop ----------
select set_config('request.jwt.claim.sub', :'A', false) \\gset
set role authenticated;
insert into public.sales_leads (
  organization_id, id, contact_name, business_name, next_follow_up, created_by
) values (t.o('orga'), 'lead-activity-1', 'Synthetic Contact', 'Synthetic Lead Business', current_date, :'A');
select (public.record_lead_activity(
  :'orga', 'lead-activity-1', 'activity-1', 'no_response',
  'Sent a follow-up and no reply has arrived yet', current_date + 3
))->>'lead_status' as activity_status \\gset
select t.eq('no-response activity updates lead status', :'activity_status', 'contacted');
select (current_date + 3)::text as activity_follow_up \\gset
select t.eq('activity schedules the next follow-up atomically', $q$select next_follow_up::text from public.sales_leads where organization_id=t.o('orga') and id='lead-activity-1'$q$, :'activity_follow_up');
select t.eq('activity is saved in the audit history', $q$select count(*)::text from public.lead_activities where organization_id=t.o('orga') and lead_id='lead-activity-1'$q$, '1');
select t.err('viewer cannot record lead activity', $q$select public.record_lead_activity(t.o('orga'),'lead-activity-1','activity-viewer','note','Attempted unauthorized activity',current_date + 3)$q$, '42501');
reset role;
select set_config('request.jwt.claim.sub', :'B', false) \\gset
set role authenticated;
select t.eq('other workspace cannot read lead activity', $q$select count(*)::text from public.lead_activities where organization_id=t.o('orga')$q$, '0');
reset role;

-- ---------- Propose / approve / execute ----------
select set_config('request.jwt.claim.sub', :'O', false) \gset
set role authenticated;
select t.err('cannot propose for not-yet-due invoice', $q$select public.propose_invoice_reminder(t.o('orga'),'inv-4','Please pay invoice INV-4 soon')$q$, '22023');
select t.err('cannot propose for fully paid invoice', $q$select public.propose_invoice_reminder(t.o('orga'),'inv-5','Please pay invoice INV-5 soon')$q$, '22023');
select t.err('reminder draft must be long enough', $q$select public.propose_invoice_reminder(t.o('orga'),'inv-1','hi')$q$, '22023');
select (public.propose_invoice_reminder(:'orga','inv-1','Hello, invoice INV-1 is overdue. Please pay.'))->>'id' as act1 \gset
select set_config('t.act1', :'act1', false) \gset
select t.eq('proposal is idempotent', $q$select (public.propose_invoice_reminder(t.o('orga'),'inv-1','Hello, invoice INV-1 is overdue. Please pay.'))->>'id'$q$, :'act1');
select t.eq('estimate = 30% of outstanding, rounded', $q$select estimate_low_minor::text from public.opportunities where organization_id=t.o('orga') and id='overdue_invoice:inv-1'$q$, '30000');
select t.err('cannot verify an action that is only proposed', $q$select public.verify_recovery_outcome(t.o('orga'),t.o('act1'),30)$q$, '22023');
select t.err('cannot mark_sent before approval', $q$select public.transition_revenue_action(t.o('orga'),t.o('act1'),'mark_sent')$q$, '22023');
select t.err('direct update of action status is blocked', $q$update public.actions set status='executed', executed_at=now() where organization_id=t.o('orga')$q$);
select t.ok('approve', $q$select public.transition_revenue_action(t.o('orga'),t.o('act1'),'approve')$q$);
select t.err('cannot verify an action that is approved but not executed', $q$select public.verify_recovery_outcome(t.o('orga'),t.o('act1'),30)$q$, '22023');
reset role;
select set_config('request.jwt.claim.sub', :'V', false) \gset
set role authenticated;
select t.err('viewer cannot transition actions', $q$select public.transition_revenue_action(t.o('orga'),t.o('act1'),'mark_sent')$q$, '42501');
reset role;
select set_config('request.jwt.claim.sub', :'O', false) \gset
set role authenticated;
select t.ok('mark_sent (manual execution)', $q$select public.transition_revenue_action(t.o('orga'),t.o('act1'),'mark_sent')$q$);
select t.err('cannot re-approve an executed action', $q$select public.transition_revenue_action(t.o('orga'),t.o('act1'),'approve')$q$, '22023');
select t.eq('no payment evidence yet -> not verified', $q$select (public.verify_recovery_outcome(t.o('orga'),t.o('act1'),30))->>'verified'$q$, 'false');
select t.eq('no outcome row created when nothing matched', $q$select count(*)::text from public.outcomes where organization_id=t.o('orga')$q$, '0');

-- ---------- Payment import ----------
select t.err('direct insert of payment evidence is blocked', $q$insert into public.payment_evidence(organization_id,id,invoice_id,source_id,external_record_id,amount_minor,currency,received_at,imported_at) values (t.o('orga'),'forged','inv-1','src-inv','FORGED',99999,'USD',now(),now())$q$);
select t.ok('valid payment import', $q$select public.persist_payment_import(t.o('orga'),'src-pay1','pay1.csv',repeat('6',64),
 jsonb_build_array(jsonb_build_object('externalRecordId','PAY-1','invoiceNumber','INV-1','currency','USD','amountMinor',40000,'receivedAt',now()+interval '1 hour')),0)$q$);
select t.eq('payment stored', $q$select count(*)::text from public.payment_evidence where organization_id=t.o('orga')$q$, '1');
select t.eq('duplicate payment reference (new file) is skipped', $q$select (public.persist_payment_import(t.o('orga'),'src-pay1','pay1b.csv',repeat('7',64),
 jsonb_build_array(jsonb_build_object('externalRecordId','PAY-1','invoiceNumber','INV-1','currency','USD','amountMinor',40000,'receivedAt',now()+interval '1 hour')),0))->>'accepted_rows'$q$, '0');
select t.eq('still one payment after duplicate reference', $q$select count(*)::text from public.payment_evidence where organization_id=t.o('orga')$q$, '1');
select t.eq('same payment file re-imported is duplicate', $q$select (public.persist_payment_import(t.o('orga'),'src-pay1','pay1.csv',repeat('6',64),'[]'::jsonb,0))->>'duplicate'$q$, 'true');
select t.err('missing invoice match rejects whole file', $q$select public.persist_payment_import(t.o('orga'),'src-pay2','pay2.csv',repeat('8',64),
 jsonb_build_array(jsonb_build_object('externalRecordId','PAY-2','invoiceNumber','INV-2','currency','USD','amountMinor',1000,'receivedAt',now()),
                   jsonb_build_object('externalRecordId','PAY-3','invoiceNumber','NOPE-9','currency','USD','amountMinor',1000,'receivedAt',now())),0)$q$, '22023');
select t.eq('no partial payments after failed file', $q$select count(*)::text from public.payment_evidence where organization_id=t.o('orga')$q$, '1');
select t.err('currency mismatch is not matched to the invoice', $q$select public.persist_payment_import(t.o('orga'),'src-pay3','pay3.csv',repeat('9',64),
 jsonb_build_array(jsonb_build_object('externalRecordId','PAY-4','invoiceNumber','INV-1','currency','EUR','amountMinor',1000,'receivedAt',now())),0)$q$, '22023');
select t.err('non-positive amount rejected', $q$select public.persist_payment_import(t.o('orga'),'src-pay4','pay4.csv',repeat('a',64),
 jsonb_build_array(jsonb_build_object('externalRecordId','PAY-5','invoiceNumber','INV-1','currency','USD','amountMinor',0,'receivedAt',now())),0)$q$, '22023');
select t.err('fractional amount rejected', $q$select public.persist_payment_import(t.o('orga'),'src-pay5','pay5.csv',repeat('b',64),
 jsonb_build_array(jsonb_build_object('externalRecordId','PAY-6','invoiceNumber','INV-1','currency','USD','amountMinor','10.5','receivedAt',now())),0)$q$, '22023');
-- ambiguous invoice number across two sources
select t.ok('second source with same invoice number', $q$select public.persist_invoice_import(t.o('orga'),'src-inv-b','invoices-b.csv',repeat('c',64),
 jsonb_build_array(jsonb_build_object('id','inv-9b','invoiceNumber','INV-2','customerId','c2','customerName','Cust Two','currency','USD','totalMinor',50000,'paidMinor',0,'issuedAt',now()-interval '40 days','dueAt',now()-interval '10 days','importedAt',now())),0)$q$);
select t.err('ambiguous invoice number is rejected', $q$select public.persist_payment_import(t.o('orga'),'src-pay6','pay6.csv',repeat('d',64),
 jsonb_build_array(jsonb_build_object('externalRecordId','PAY-7','invoiceNumber','INV-2','currency','USD','amountMinor',1000,'receivedAt',now())),0)$q$, '22023');

-- ---------- Outcome verification ----------
select t.eq('verified outcome for single partial payment', $q$select (public.verify_recovery_outcome(t.o('orga'),t.o('act1'),30))->>'amount_minor'$q$, '40000');
select t.eq('outcome row is verified/matched_payment_record', $q$select state||'/'||method||'/'||currency||'/'||amount_minor from public.outcomes where organization_id=t.o('orga')$q$, 'verified/matched_payment_record/USD/40000');
select t.eq('causal claim is not asserted', $q$select causal_claim from public.outcomes where organization_id=t.o('orga')$q$, 'observed_after_action_not_proven_causal');
select t.eq('repeat verification is idempotent (one outcome)', $q$select (select (public.verify_recovery_outcome(t.o('orga'),t.o('act1'),30))->>'verified')||':'||(select count(*) from public.outcomes where organization_id=t.o('orga'))$q$, 'true:1');
select t.eq('one linked payment evidence row', $q$select count(*)::text from public.outcome_payment_evidence where organization_id=t.o('orga')$q$, '1');
select t.ok('payments before action / outside window imported', $q$select public.persist_payment_import(t.o('orga'),'src-pay7','pay7.csv',repeat('e',64),
 jsonb_build_array(jsonb_build_object('externalRecordId','PAY-BEFORE','invoiceNumber','INV-1','currency','USD','amountMinor',99999,'receivedAt',now()-interval '5 days'),
                   jsonb_build_object('externalRecordId','PAY-LATE','invoiceNumber','INV-1','currency','USD','amountMinor',99999,'receivedAt',now()+interval '40 days')),0)$q$);
select t.eq('payments before action / after window are excluded', $q$select (public.verify_recovery_outcome(t.o('orga'),t.o('act1'),30))->>'amount_minor'$q$, '40000');
select t.ok('second valid payment imported', $q$select public.persist_payment_import(t.o('orga'),'src-pay8','pay8.csv',repeat('f',64),
 jsonb_build_array(jsonb_build_object('externalRecordId','PAY-2','invoiceNumber','INV-1','currency','USD','amountMinor',20000,'receivedAt',now()+interval '2 days')),0)$q$);
select t.eq('multiple valid payments are summed', $q$select (public.verify_recovery_outcome(t.o('orga'),t.o('act1'),30))->>'amount_minor'$q$, '60000');
select t.eq('outcome amount updated, still one outcome', $q$select count(*)||':'||max(amount_minor) from public.outcomes where organization_id=t.o('orga')$q$, '1:60000');
select t.ok('overpayment imported', $q$select public.persist_payment_import(t.o('orga'),'src-pay9','pay9.csv',repeat('0',64),
 jsonb_build_array(jsonb_build_object('externalRecordId','PAY-OVER','invoiceNumber','INV-1','currency','USD','amountMinor',60000,'receivedAt',now()+interval '3 days')),0)$q$);
select t.err('payments exceeding balance snapshot are refused', $q$select public.verify_recovery_outcome(t.o('orga'),t.o('act1'),30)$q$, '22023');
select t.err('window of 0 days rejected', $q$select public.verify_recovery_outcome(t.o('orga'),t.o('act1'),0)$q$, '22023');
-- direct tampering
select t.err('direct insert of outcome is blocked', $q$insert into public.outcomes(organization_id,id,action_id,opportunity_id,state,method,amount_minor,currency,measurement_starts_at,measurement_ends_at,recorded_by,recorded_at) values (t.o('orga'),'forged-outcome',t.o('act1'),'overdue_invoice:inv-1','verified','matched_payment_record',1,'USD',now(),now(),'x',now())$q$);
select t.err('direct update of outcome is blocked', $q$update public.outcomes set amount_minor=999999999 where organization_id=t.o('orga')$q$, '42501');
select t.err('direct delete of payment evidence is blocked', $q$delete from public.payment_evidence where organization_id=t.o('orga')$q$, '42501');
reset role;
select set_config('request.jwt.claim.sub', :'B', false) \gset
set role authenticated;
select t.err('org B cannot verify org A outcomes', $q$select public.verify_recovery_outcome(t.o('orga'),t.o('act1'),30)$q$, '42501');
select t.eq('org B sees no outcomes/payments of org A', $q$select (select count(*) from public.outcomes)||':'||(select count(*) from public.payment_evidence)$q$, '0:0');
reset role;

-- ---------- Membership escalation ----------
select set_config('request.jwt.claim.sub', :'O', false) \gset
set role authenticated;
select t.eq('operator cannot promote self to owner (no write access)', $q$with u as (update public.memberships set role='owner' where organization_id=t.o('orga') and user_id=(select id from public.users where auth_subject=auth.uid()) returning 1) select count(*)::text from u$q$, '0');
reset role;
select set_config('request.jwt.claim.sub', :'M', false) \gset
set role authenticated;
select t.err('admin cannot promote self to owner', $q$update public.memberships set role='owner' where organization_id=t.o('orga') and user_id=(select id from public.users where auth_subject=auth.uid())$q$, '42501');
select t.err('admin cannot grant owner to another user', $q$update public.memberships set role='owner' where organization_id=t.o('orga') and user_id='00000000-0000-4000-8000-0000000000c1'$q$, '42501');
select t.err('admin cannot add an admin', $q$insert into public.memberships(organization_id,user_id,role) values (t.o('orga'),'00000000-0000-4000-8000-00000000000b','admin')$q$, '42501');
select t.err('admin cannot add an owner', $q$insert into public.memberships(organization_id,user_id,role) values (t.o('orga'),'00000000-0000-4000-8000-00000000000b','owner')$q$, '42501');
select t.err('admin cannot delete the owner', $q$delete from public.memberships where organization_id=t.o('orga') and role='owner'$q$, '42501');
select t.ok('admin can still add a viewer (legitimate flow)', $q$insert into public.memberships(organization_id,user_id,role) values (t.o('orga'),'00000000-0000-4000-8000-00000000000b','viewer')$q$);
select t.ok('admin can change a viewer to analyst (legitimate flow)', $q$update public.memberships set role='analyst' where organization_id=t.o('orga') and user_id='00000000-0000-4000-8000-00000000000b'$q$);
reset role;
select set_config('request.jwt.claim.sub', :'A', false) \gset
set role authenticated;
select t.err('owner cannot demote or remove the last owner', $q$delete from public.memberships where organization_id=t.o('orga') and role='owner'$q$, '42501');
select t.err('owner cannot change own role', $q$update public.memberships set role='admin' where organization_id=t.o('orga') and role='owner'$q$, '42501');
select t.ok('owner can promote an admin to owner (legitimate flow)', $q$update public.memberships set role='owner' where organization_id=t.o('orga') and user_id='00000000-0000-4000-8000-0000000000e1'$q$);
select t.ok('with two owners an owner can be removed', $q$delete from public.memberships where organization_id=t.o('orga') and user_id='00000000-0000-4000-8000-0000000000e1'$q$);
reset role;
select set_config('request.jwt.claim.sub', :'B', false) \gset
set role authenticated;
select t.err('a user cannot insert themselves into another workspace', $q$insert into public.memberships(organization_id,user_id,role) values (t.o('orga'),'00000000-0000-4000-8000-00000000000b','viewer')$q$);
reset role;

-- Self-removal policy: a member with delete rights may LEAVE a workspace (admin here); they cannot
-- rejoin themselves, and the last owner can never leave (tested above).
select set_config('request.jwt.claim.sub', :'M', false) \gset
set role authenticated;
select t.ok('admin can leave the workspace (self-removal)', $q$delete from public.memberships where organization_id=t.o('orga') and user_id=(select id from public.users where auth_subject=auth.uid())$q$);
select t.err('a user who left cannot add themselves back', $q$insert into public.memberships(organization_id,user_id,role) values (t.o('orga'),(select id from public.users where auth_subject=auth.uid()),'admin')$q$, '42501');
reset role;

-- ---------- Leads ----------
select set_config('request.jwt.claim.sub', :'O', false) \gset
set role authenticated;
select t.ok('operator can create a lead in own org', $q$insert into public.sales_leads(organization_id,id,contact_name,business_name,next_follow_up,created_by) values (t.o('orga'),'lead-1','Synthetic Contact','Synthetic Biz',current_date,(select id from public.users where auth_subject=auth.uid()))$q$);
reset role;

-- ---------- Report ----------
\echo
\echo ===== RESULTS =====
select case when ok then 'PASS' else 'FAIL' end as r, label, coalesce(detail,'') as detail from t.results order by n;
select count(*) filter (where ok) as passed, count(*) filter (where not ok) as failed from t.results;
