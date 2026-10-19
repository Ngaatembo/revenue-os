-- Tests for public.record_invoice_response and public.set_opportunity_state.
-- Synthetic data only; own workspaces; runs after 03_sync_opportunities.sql.
\set ON_ERROR_STOP off
\set X '00000000-0000-4000-8000-0000000000a1'
\set Z '00000000-0000-4000-8000-0000000000a2'
\set W '00000000-0000-4000-8000-0000000000a3'

insert into auth.users(id, email) values (:'X','rx@example.test'), (:'Z','rz@example.test'), (:'W','rviewer@example.test');
select set_config('request.jwt.claim.sub', :'X', false) \gset
set role authenticated;
select organization_id as orgx from public.bootstrap_revenue_os_organization('Resp Org X') \gset
reset role;
select set_config('request.jwt.claim.sub', :'Z', false) \gset
set role authenticated;
select organization_id as orgz from public.bootstrap_revenue_os_organization('Resp Org Z') \gset
reset role;
select set_config('t.orgx', :'orgx', false), set_config('t.orgz', :'orgz', false) \gset
select set_config('request.jwt.claim.sub', '', false) \gset
insert into public.users(id, auth_subject, email) values (:'W', :'W', 'rviewer@example.test');
insert into public.memberships(organization_id, user_id, role) values (:'orgx', :'W', 'viewer');

-- ---------- Setup: invoices, rate, opportunities ----------
select set_config('request.jwt.claim.sub', :'X', false) \gset
set role authenticated;
select t.ok('resp: owner saves 30% recovery rate', $q$insert into public.assumptions(organization_id,id,assumption_key,value_bps,updated_by) values (t.o('orgx'),'recovery-rate','recovery_rate',3000,(select id from public.users where auth_subject=auth.uid()))$q$);
select t.ok('resp: invoices imported', $q$select public.persist_invoice_import(t.o('orgx'),'src-resp','resp.csv',repeat('b',64),
 jsonb_build_array(
  jsonb_build_object('id','r-a','invoiceNumber','R-A','customerId','ca','customerName','Cust A','currency','USD','totalMinor',100000,'paidMinor',0,'issuedAt',now()-interval '60 days','dueAt',now()-interval '30 days','importedAt',now()),
  jsonb_build_object('id','r-b','invoiceNumber','R-B','customerId','cb','customerName','Cust B','currency','USD','totalMinor',50000,'paidMinor',20000,'issuedAt',now()-interval '40 days','dueAt',now()-interval '10 days','importedAt',now()),
  jsonb_build_object('id','r-c','invoiceNumber','R-C','customerId','cc','customerName','Cust C','currency','USD','totalMinor',70000,'paidMinor',0,'issuedAt',now()-interval '20 days','dueAt',now()-interval '5 days','importedAt',now())
 ),0)$q$);
select t.eq('resp: detection reports 3 open issues', $q$select (public.sync_overdue_opportunities(t.o('orgx')))->>'open'$q$, '3');
select t.eq('resp: new issues start in workflow state new', $q$select string_agg(distinct workflow_state, ',') from public.opportunities where organization_id=t.o('orgx')$q$, 'new');
reset role;

-- snapshot of money tables so we can prove responses never move money
select count(*)::text as c_out from public.outcomes where organization_id=:'orgx' \gset
select count(*)::text as c_pay from public.payment_evidence where organization_id=:'orgx' \gset
select sum(paid_minor)::text as paid_sum from public.invoices where organization_id=:'orgx' \gset

-- ---------- Authorization ----------
set role anon;
select t.err('resp: anon cannot record a response', $q$select public.record_invoice_response(t.o('orgx'),'i-anon','overdue_invoice:r-a','customer_replied','spoke to them',null,null,current_date+3)$q$);
reset role;
select set_config('request.jwt.claim.sub', :'Z', false) \gset
set role authenticated;
select t.err('resp: other workspace member cannot record a response', $q$select public.record_invoice_response(t.o('orgx'),'i-z','overdue_invoice:r-a','customer_replied','spoke to them',null,null,current_date+3)$q$, '42501');
select t.err('resp: other workspace member cannot change issue state', $q$select public.set_opportunity_state(t.o('orgx'),'overdue_invoice:r-a','acknowledge')$q$, '42501');
select t.eq('resp: other workspace sees no interactions', $q$select count(*)::text from public.invoice_interactions where organization_id=t.o('orgx')$q$, '0');
reset role;
select set_config('request.jwt.claim.sub', :'W', false) \gset
set role authenticated;
select t.err('resp: viewer cannot record a response', $q$select public.record_invoice_response(t.o('orgx'),'i-v','overdue_invoice:r-a','customer_replied','spoke to them',null,null,current_date+3)$q$, '42501');
select t.err('resp: viewer cannot change issue state', $q$select public.set_opportunity_state(t.o('orgx'),'overdue_invoice:r-a','dismiss','not a real debt')$q$, '42501');
reset role;

-- ---------- Cross-workspace manipulation ----------
select set_config('request.jwt.claim.sub', :'Z', false) \gset
set role authenticated;
select t.err('resp: owner of Z cannot target X issue through their own workspace id', $q$select public.record_invoice_response(t.o('orgz'),'i-cross','overdue_invoice:r-a','customer_replied','spoke to them',null,null,current_date+3)$q$, 'P0002');
reset role;

-- ---------- Validation ----------
select set_config('request.jwt.claim.sub', :'X', false) \gset
set role authenticated;
select t.err('resp: unknown type rejected', $q$select public.record_invoice_response(t.o('orgx'),'i-1','overdue_invoice:r-a','shrugged','something happened',null,null,current_date+3)$q$, '22023');
select t.err('resp: summary too short rejected', $q$select public.record_invoice_response(t.o('orgx'),'i-2','overdue_invoice:r-a','customer_replied','ok',null,null,current_date+3)$q$, '22023');
select t.err('resp: follow-up date required for a reply', $q$select public.record_invoice_response(t.o('orgx'),'i-3','overdue_invoice:r-a','customer_replied','they replied by email',null,null,null)$q$, '22023');
select t.err('resp: follow-up date cannot be in the past', $q$select public.record_invoice_response(t.o('orgx'),'i-4','overdue_invoice:r-a','customer_replied','they replied by email',null,null,current_date-1)$q$, '22023');
select t.err('resp: promise needs amount and date', $q$select public.record_invoice_response(t.o('orgx'),'i-5','overdue_invoice:r-a','promised_to_pay','will pay soon',null,null,null)$q$, '22023');
select t.err('resp: non-promise cannot carry a promised amount', $q$select public.record_invoice_response(t.o('orgx'),'i-6','overdue_invoice:r-a','customer_replied','they replied',5000,null,current_date+3)$q$, '22023');
select t.err('resp: promise cannot exceed outstanding balance (R-A outstanding 1000.00)', $q$select public.record_invoice_response(t.o('orgx'),'i-7','overdue_invoice:r-a','promised_to_pay','will pay everything plus extra',100001,current_date+5,null)$q$, '22023');
select t.err('resp: promise cannot exceed outstanding after partial payment (R-B outstanding 300.00)', $q$select public.record_invoice_response(t.o('orgx'),'i-8','overdue_invoice:r-b','promised_to_pay','claims to owe less but promises more',30001,current_date+5,null)$q$, '22023');
select t.err('resp: promised date cannot be in the past', $q$select public.record_invoice_response(t.o('orgx'),'i-9','overdue_invoice:r-a','promised_to_pay','said they paid last week',50000,current_date-2,null)$q$, '22023');
select t.err('resp: unknown issue rejected', $q$select public.record_invoice_response(t.o('orgx'),'i-10','overdue_invoice:nope','customer_replied','they replied',null,null,current_date+3)$q$, 'P0002');
select t.eq('resp: failed attempts recorded nothing', $q$select count(*)::text from public.invoice_interactions where organization_id=t.o('orgx')$q$, '0');

-- ---------- Happy paths and state mapping ----------
select t.eq('resp: no_response -> awaiting_response', $q$select (public.record_invoice_response(t.o('orgx'),'i-nr','overdue_invoice:r-a','no_response','sent reminder on WhatsApp, no reply',null,null,current_date+3))->>'workflow_state'$q$, 'awaiting_response');
select t.eq('resp: customer_replied -> in_conversation', $q$select (public.record_invoice_response(t.o('orgx'),'i-rp','overdue_invoice:r-a','customer_replied','finance contact replied, checking',null,null,current_date+2))->>'workflow_state'$q$, 'in_conversation');
select t.eq('resp: promise -> promised', $q$select (public.record_invoice_response(t.o('orgx'),'i-pr','overdue_invoice:r-a','promised_to_pay','will pay half on Friday',50000,current_date+4,null))->>'workflow_state'$q$, 'promised');
select t.eq('resp: follow-up defaults to the day after the promised date', $q$select (next_follow_up = current_date+5)::text from public.opportunities where organization_id=t.o('orgx') and id='overdue_invoice:r-a'$q$, 'true');
select t.eq('resp: promise stored on the issue', $q$select promised_amount_minor||'/'||(promised_date = current_date+4)::text from public.opportunities where organization_id=t.o('orgx') and id='overdue_invoice:r-a'$q$, '50000/true');
select t.eq('resp: dispute -> disputed and clears the promise', $q$select ((public.record_invoice_response(t.o('orgx'),'i-ds','overdue_invoice:r-b','disputed','customer says delivery was incomplete',null,null,current_date+7))->>'workflow_state')$q$, 'disputed');
select t.eq('resp: dispute clears any earlier promise', $q$select coalesce(promised_amount_minor::text,'none') from public.opportunities where organization_id=t.o('orgx') and id='overdue_invoice:r-b'$q$, 'none');
select t.eq('resp: paid_claimed -> payment_claimed (still needs evidence)', $q$select (public.record_invoice_response(t.o('orgx'),'i-pc','overdue_invoice:r-c','paid_claimed','customer says they paid by bank transfer',null,null,null))->>'workflow_state'$q$, 'payment_claimed');
select t.eq('resp: note changes nothing about state', $q$select ((public.record_invoice_response(t.o('orgx'),'i-nt','overdue_invoice:r-c','note','spoke to accounts, awaiting remittance',null,null,null))->>'workflow_state')$q$, 'payment_claimed');
select t.eq('resp: interactions link the invoice', $q$select count(*)::text from public.invoice_interactions where organization_id=t.o('orgx') and invoice_id in ('r-a','r-b','r-c')$q$, '6');

-- ---------- Idempotency ----------
select t.eq('resp: retrying the same interaction id is reported as a duplicate', $q$select (public.record_invoice_response(t.o('orgx'),'i-pr','overdue_invoice:r-a','promised_to_pay','will pay half on Friday',50000,current_date+4,null))->>'duplicate'$q$, 'true');
select t.eq('resp: the retry did not create a second record', $q$select count(*)::text from public.invoice_interactions where organization_id=t.o('orgx') and id='i-pr'$q$, '1');
select t.err('resp: reusing an interaction id for another issue is refused', $q$select public.record_invoice_response(t.o('orgx'),'i-pr','overdue_invoice:r-c','note','different issue same id',null,null,null)$q$, '23505');

-- ---------- Money is never touched ----------
select t.eq('resp: no outcomes created by responses or promises', $q$select count(*)::text from public.outcomes where organization_id=t.o('orgx')$q$, :'c_out');
select t.eq('resp: no payment evidence created by responses or promises', $q$select count(*)::text from public.payment_evidence where organization_id=t.o('orgx')$q$, :'c_pay');
select t.eq('resp: invoice paid amounts unchanged by responses or promises', $q$select sum(paid_minor)::text from public.invoices where organization_id=t.o('orgx')$q$, :'paid_sum');

-- ---------- Immutability and direct-write protection ----------
select t.err('resp: interactions cannot be edited', $q$update public.invoice_interactions set summary='rewritten history' where organization_id=t.o('orgx')$q$);
select t.err('resp: interactions cannot be deleted', $q$delete from public.invoice_interactions where organization_id=t.o('orgx')$q$);
select t.err('resp: interactions cannot be inserted directly', $q$insert into public.invoice_interactions(organization_id,id,opportunity_id,invoice_id,interaction_type,summary,created_by) values (t.o('orgx'),'direct','overdue_invoice:r-a','r-a','note','sneaky direct write',(select id from public.users where auth_subject=auth.uid()))$q$);
select t.err('resp: opportunity state cannot be edited directly', $q$update public.opportunities set workflow_state='promised' where organization_id=t.o('orgx')$q$);

-- ---------- Audit trail ----------
select t.eq('resp: every recorded response wrote an audit entry', $q$select count(*)::text from public.audit_log where organization_id=t.o('orgx') and event_type='invoice_response_recorded'$q$, '6');
select t.eq('resp: duplicate retry wrote no extra audit entry', $q$select count(*)::text from public.audit_log where organization_id=t.o('orgx') and event_type='invoice_response_recorded' and details->>'interaction_id'='i-pr'$q$, '1');

-- ---------- Issue states: acknowledge / snooze / dismiss / reopen ----------
select t.err('state: cannot acknowledge an issue that is already being worked', $q$select public.set_opportunity_state(t.o('orgx'),'overdue_invoice:r-a','acknowledge')$q$, '22023');
select t.ok('state: owner can snooze for 7 days', $q$select public.set_opportunity_state(t.o('orgx'),'overdue_invoice:r-c','snooze',null,now()+interval '7 days')$q$);
select t.eq('state: snooze is stored', $q$select (snoozed_until > now())::text from public.opportunities where organization_id=t.o('orgx') and id='overdue_invoice:r-c'$q$, 'true');
select t.err('state: snooze in the past refused', $q$select public.set_opportunity_state(t.o('orgx'),'overdue_invoice:r-c','snooze',null,now()-interval '1 day')$q$, '22023');
select t.err('state: snooze beyond 90 days refused', $q$select public.set_opportunity_state(t.o('orgx'),'overdue_invoice:r-c','snooze',null,now()+interval '120 days')$q$, '22023');
select t.err('state: dismiss needs a reason', $q$select public.set_opportunity_state(t.o('orgx'),'overdue_invoice:r-c','dismiss','')$q$, '22023');
select t.ok('state: dismiss with a reason', $q$select public.set_opportunity_state(t.o('orgx'),'overdue_invoice:r-c','dismiss','Customer is a related party; handled by the owner directly')$q$);
select t.eq('state: dismissed issue records status and reason', $q$select status||'/'||dismissed_reason from public.opportunities where organization_id=t.o('orgx') and id='overdue_invoice:r-c'$q$, 'dismissed/Customer is a related party; handled by the owner directly');
select t.eq('state: dismissing does not change the unpaid invoice', $q$select (total_minor-paid_minor)::text from public.invoices where organization_id=t.o('orgx') and id='r-c'$q$, '70000');
select t.err('state: cannot record a response on a dismissed issue', $q$select public.record_invoice_response(t.o('orgx'),'i-late','overdue_invoice:r-c','note','trying after dismissal',null,null,null)$q$, '22023');
select t.eq('state: sync reports only the 2 still-open issues', $q$select (public.sync_overdue_opportunities(t.o('orgx')))->>'open'$q$, '2');
select t.eq('state: sync does not reopen a dismissed issue', $q$select status from public.opportunities where organization_id=t.o('orgx') and id='overdue_invoice:r-c'$q$, 'dismissed');
select t.ok('state: owner can reopen a dismissed issue', $q$select public.set_opportunity_state(t.o('orgx'),'overdue_invoice:r-c','reopen')$q$);
select t.eq('state: reopened issue is open with the reason cleared', $q$select status||'/'||coalesce(dismissed_reason,'none') from public.opportunities where organization_id=t.o('orgx') and id='overdue_invoice:r-c'$q$, 'open/none');
select t.err('state: cannot reopen an open issue', $q$select public.set_opportunity_state(t.o('orgx'),'overdue_invoice:r-c','reopen')$q$, '22023');
select t.err('state: unsupported transition refused', $q$select public.set_opportunity_state(t.o('orgx'),'overdue_invoice:r-c','delete')$q$, '22023');
select t.eq('state: state changes are audited', $q$select count(*)::text from public.audit_log where organization_id=t.o('orgx') and event_type in ('opportunity_snooze','opportunity_dismiss','opportunity_reopen')$q$, '3');

-- ---------- Acknowledge on a fresh issue ----------
select t.ok('state: setup a fresh overdue invoice', $q$select public.persist_invoice_import(t.o('orgx'),'src-resp2','resp2.csv',repeat('c',64),
 jsonb_build_array(jsonb_build_object('id','r-d','invoiceNumber','R-D','customerId','cd','customerName','Cust D','currency','USD','totalMinor',25000,'paidMinor',0,'issuedAt',now()-interval '30 days','dueAt',now()-interval '15 days','importedAt',now())),0)$q$);
select t.ok('state: sync picks up the new overdue invoice', $q$select public.sync_overdue_opportunities(t.o('orgx'))$q$);
select t.ok('state: acknowledge a new issue', $q$select public.set_opportunity_state(t.o('orgx'),'overdue_invoice:r-d','acknowledge')$q$);
select t.eq('state: acknowledged state stored', $q$select workflow_state from public.opportunities where organization_id=t.o('orgx') and id='overdue_invoice:r-d'$q$, 'acknowledged');

-- ---------- Payment closes the issue but the promise is never counted as money ----------
select t.ok('pay: payment evidence for the promised invoice is imported', $q$select public.persist_payment_import(t.o('orgx'),'pay-resp','pay.csv',repeat('d',64),
 jsonb_build_array(jsonb_build_object('invoiceNumber','R-A','externalRecordId','PAY-R-A-1','currency','USD','amountMinor',50000,'receivedAt',now())),0)$q$);
select t.eq('pay: promised 500.00 and received 500.00 are separate records', $q$select (select promised_amount_minor::text from public.opportunities where organization_id=t.o('orgx') and id='overdue_invoice:r-a')||'/'||(select sum(amount_minor)::text from public.payment_evidence where organization_id=t.o('orgx') and invoice_id='r-a')$q$, '50000/50000');
select t.eq('pay: no verified outcome exists until an executed action is verified', $q$select count(*)::text from public.outcomes where organization_id=t.o('orgx')$q$, :'c_out');
reset role;

-- ---------- End-to-end: detect -> remind -> approve -> send -> promise -> pay -> verify -> close ----------
select set_config('request.jwt.claim.sub', :'X', false) \gset
set role authenticated;
select t.ok('e2e: invoice imported', $q$select public.persist_invoice_import(t.o('orgx'),'src-e2e','e2e.csv',repeat('e',64),
 jsonb_build_array(jsonb_build_object('id','r-e','invoiceNumber','R-E','customerId','ce','customerName','Cust E','currency','USD','totalMinor',80000,'paidMinor',0,'issuedAt',now()-interval '40 days','dueAt',now()-interval '20 days','importedAt',now())),0)$q$);
select t.eq('e2e: detection flags the new overdue invoice (5 open: A, B, C reopened, D, E)', $q$select (public.sync_overdue_opportunities(t.o('orgx')))->>'open'$q$, '5');
select (public.propose_invoice_reminder(:'orgx','r-e','Hello, invoice R-E is overdue. Please pay.'))->>'id' as acte \gset
select set_config('t.acte', :'acte', false) \gset
select t.ok('e2e: owner approves the drafted reminder', $q$select public.transition_revenue_action(t.o('orgx'),t.o('acte'),'approve')$q$);
select t.ok('e2e: owner records that they sent it manually', $q$select public.transition_revenue_action(t.o('orgx'),t.o('acte'),'mark_sent')$q$);
select t.eq('e2e: customer promise links to the executed reminder', $q$select (public.record_invoice_response(t.o('orgx'),'e2e-promise','overdue_invoice:r-e','promised_to_pay','Customer will pay in two parts',80000,current_date+5,null))->>'action_id'$q$, :'acte');
select t.eq('e2e: nothing is verified yet; a promise is not a payment', $q$select count(*)::text from public.outcomes where organization_id=t.o('orgx')$q$, :'c_out');
select t.ok('e2e: first payment of 600.00 is imported as evidence', $q$select public.persist_payment_import(t.o('orgx'),'pay-e2e','pay-e2e.csv',repeat('f',64),
 jsonb_build_array(jsonb_build_object('invoiceNumber','R-E','externalRecordId','PAY-R-E-1','currency','USD','amountMinor',60000,'receivedAt',now())),0)$q$);
select t.eq('e2e: verification matches the payment evidence only', $q$select (public.verify_recovery_outcome(t.o('orgx'),t.o('acte'),30))->>'amount_minor'$q$, '60000');
select t.eq('e2e: exactly one verified outcome exists', $q$select count(*)::text from public.outcomes where organization_id=t.o('orgx') and state='verified' and action_id=t.o('acte')$q$, '1');
select t.eq('e2e: the 800.00 promise and the 600.00 verified amount stay separate', $q$select (select promised_amount_minor::text from public.opportunities where organization_id=t.o('orgx') and id='overdue_invoice:r-e')||'/'||(select amount_minor::text from public.outcomes where organization_id=t.o('orgx') and action_id=t.o('acte'))$q$, '80000/60000');
select t.eq('e2e: until invoices are re-imported the issue stays open and the balance is unchanged', $q$select o.status||'/'||(i.total_minor-i.paid_minor)::text from public.opportunities o join public.invoices i on i.organization_id=o.organization_id and i.id='r-e' where o.organization_id=t.o('orgx') and o.id='overdue_invoice:r-e'$q$, 'open/80000');
select t.ok('e2e: second payment of 200.00 is imported', $q$select public.persist_payment_import(t.o('orgx'),'pay-e2e-2','pay-e2e-2.csv',repeat('9',64),
 jsonb_build_array(jsonb_build_object('invoiceNumber','R-E','externalRecordId','PAY-R-E-2','currency','USD','amountMinor',20000,'receivedAt',now())),0)$q$);
select t.eq('e2e: re-verifying counts both payments once (800.00, no double counting)', $q$select (public.verify_recovery_outcome(t.o('orgx'),t.o('acte'),30))->>'amount_minor'$q$, '80000');
select t.eq('e2e: still exactly one outcome after re-verification', $q$select count(*)::text from public.outcomes where organization_id=t.o('orgx') and action_id=t.o('acte')$q$, '1');
select t.ok('e2e: invoice export re-imported showing the invoice paid in full', $q$select public.persist_invoice_import(t.o('orgx'),'src-e2e','e2e-paid.csv',repeat('8',64),
 jsonb_build_array(jsonb_build_object('id','r-e','invoiceNumber','R-E','customerId','ce','customerName','Cust E','currency','USD','totalMinor',80000,'paidMinor',80000,'issuedAt',now()-interval '40 days','dueAt',now()-interval '20 days','importedAt',now())),0)$q$);
select t.eq('e2e: detection closes the paid issue', $q$select (public.sync_overdue_opportunities(t.o('orgx')))->>'closed'$q$, '1');
select t.eq('e2e: the closed issue keeps its history, promise record and outcome', $q$select (select status from public.opportunities where organization_id=t.o('orgx') and id='overdue_invoice:r-e')||'/'||(select count(*)::text from public.invoice_interactions where organization_id=t.o('orgx') and opportunity_id='overdue_invoice:r-e')||'/'||(select count(*)::text from public.outcomes where organization_id=t.o('orgx') and action_id=t.o('acte'))$q$, 'closed/1/1');
select t.err('e2e: a closed issue accepts no further responses', $q$select public.record_invoice_response(t.o('orgx'),'e2e-late','overdue_invoice:r-e','note','late note after payment',null,null,null)$q$, '22023');
reset role;

-- ---------- Tenant isolation of reads ----------
select set_config('request.jwt.claim.sub', :'Z', false) \gset
set role authenticated;
select t.eq('iso: other workspace reads zero of X interactions', $q$select count(*)::text from public.invoice_interactions$q$, '0');
select t.eq('iso: other workspace reads zero of X audit entries for responses', $q$select count(*)::text from public.audit_log where event_type like 'opportunity_%' or event_type='invoice_response_recorded'$q$, '0');
reset role;
select set_config('request.jwt.claim.sub', :'W', false) \gset
set role authenticated;
select t.ok('iso: viewer can read interactions in their workspace', $q$select count(*) from public.invoice_interactions where organization_id=t.o('orgx')$q$);
reset role;

\echo ===== RESPONSE RESULTS =====
select case when ok then 'PASS' else 'FAIL' end as r, label, detail from t.results where label ~ '^(resp|state|pay|iso|e2e):' order by n;
select count(*) filter (where ok) as passed, count(*) filter (where not ok) as failed from t.results where label ~ '^(resp|state|pay|iso|e2e):';
