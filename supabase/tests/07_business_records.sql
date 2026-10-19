-- Tests: quotations, deposits, tasks, action owners, payment review queue. Synthetic data only.
\set ON_ERROR_STOP off
\set X '00000000-0000-4000-8000-0000000000f4'
\set Z '00000000-0000-4000-8000-0000000000f5'
\set W '00000000-0000-4000-8000-0000000000f6'
\set M '00000000-0000-4000-8000-0000000000f7'

insert into auth.users(id, email) values (:'X','kx@example.test'), (:'Z','kz@example.test'), (:'W','kviewer@example.test'), (:'M','kmember@example.test');
select set_config('request.jwt.claim.sub', :'X', false) \gset
set role authenticated;
select organization_id as orgx from public.bootstrap_revenue_os_organization('Rec Org X') \gset
reset role;
select set_config('request.jwt.claim.sub', :'Z', false) \gset
set role authenticated;
select organization_id as orgz from public.bootstrap_revenue_os_organization('Rec Org Z') \gset
reset role;
select set_config('t.orgx', :'orgx', false), set_config('t.orgz', :'orgz', false) \gset
select set_config('request.jwt.claim.sub', '', false) \gset
insert into public.users(id, auth_subject, email) values (:'W', :'W', 'kviewer@example.test'), (:'M', :'M', 'kmember@example.test');
insert into public.memberships(organization_id, user_id, role) values (:'orgx', :'W', 'viewer'), (:'orgx', :'M', 'operator');
select id as uidx from public.users where auth_subject = :'X' \gset
select set_config('t.uidx', :'uidx', false), set_config('t.uidm', :'M', false), set_config('t.uidz', (select id from public.users where auth_subject=:'Z'), false) \gset

-- ================= Quotations =================
select set_config('request.jwt.claim.sub', :'X', false) \gset
set role authenticated;
select t.ok('rec:quote owner creates a quotation', $q$select public.create_quotation(t.o('orgx'),'q1','Q-100','Acme Ltd','USD',500000,current_date-5,current_date+25,current_date+2,null,'first quote')$q$);
select t.eq('rec:quote starts as sent with follow-up', $q$select status||'|'||follow_up_date::text from public.quotations where organization_id=t.o('orgx') and id='q1'$q$, 'sent|'||to_char(current_date+2,'YYYY-MM-DD'));
select t.eq('rec:quote retry of the same id is a no-op', $q$select (public.create_quotation(t.o('orgx'),'q1','Q-100','Acme Ltd','USD',500000,current_date-5,current_date+25,current_date+2))->>'duplicate'$q$, 'true');
select t.eq('rec:quote one row, one created event', $q$select (select count(*) from public.quotations where organization_id=t.o('orgx'))||'/'||(select count(*) from public.quotation_events where organization_id=t.o('orgx') and quotation_id='q1')$q$, '1/1');
select t.err('rec:quote zero amount rejected', $q$select public.create_quotation(t.o('orgx'),'q2','Q-2','A','USD',0,current_date,null,current_date+1)$q$, '22023');
select t.err('rec:quote future sent date rejected', $q$select public.create_quotation(t.o('orgx'),'q3','Q-3','A','USD',100,current_date+1,null,current_date+2)$q$, '22023');
select t.err('rec:quote expiry before sent rejected', $q$select public.create_quotation(t.o('orgx'),'q4','Q-4','A','USD',100,current_date,current_date-1,current_date+2)$q$, '22023');
select t.err('rec:quote bad currency rejected', $q$select public.create_quotation(t.o('orgx'),'q5','Q-5','A','usd',100,current_date,null,current_date+2)$q$, '22023');
select t.err('rec:quote owner must be a member', $q$select public.create_quotation(t.o('orgx'),'q6','Q-6','A','USD',100,current_date,null,current_date+2,t.o('uidz'))$q$, '22023');
select t.err('rec:quote follow-up needs a future date', $q$select public.record_quotation_event(t.o('orgx'),'e1','q1','follow_up_sent','Sent a WhatsApp message',null)$q$, '22023');
select t.ok('rec:quote follow-up recorded with next date', $q$select public.record_quotation_event(t.o('orgx'),'e1','q1','follow_up_sent','Sent a WhatsApp message',current_date+4)$q$);
select t.eq('rec:quote follow-up moves date and last contact', $q$select follow_up_date::text||'|'||last_contact_on::text from public.quotations where organization_id=t.o('orgx') and id='q1'$q$, to_char(current_date+4,'YYYY-MM-DD')||'|'||to_char(current_date,'YYYY-MM-DD'));
select t.eq('rec:quote retried event is a no-op', $q$select (public.record_quotation_event(t.o('orgx'),'e1','q1','follow_up_sent','Sent a WhatsApp message',current_date+4))->>'duplicate'$q$, 'true');
select t.ok('rec:quote rescheduling is recorded', $q$select public.record_quotation_event(t.o('orgx'),'e2','q1','rescheduled','Customer travelling',current_date+10)$q$);
select t.eq('rec:quote rescheduling does not count as contact', $q$select last_contact_on::text from public.quotations where organization_id=t.o('orgx') and id='q1'$q$, to_char(current_date,'YYYY-MM-DD'));
select t.ok('rec:quote accepted', $q$select public.record_quotation_event(t.o('orgx'),'e3','q1','accepted','Customer accepted by email',null)$q$);
select t.eq('rec:quote accepted closes it and clears follow-up', $q$select status||'|'||coalesce(follow_up_date::text,'none')||'|'||(closed_at is not null)::text from public.quotations where organization_id=t.o('orgx') and id='q1'$q$, 'accepted|none|true');
select t.err('rec:quote closed quotation cannot be chased', $q$select public.record_quotation_event(t.o('orgx'),'e4','q1','follow_up_sent','chasing again',current_date+1)$q$, '22023');
select t.err('rec:quote reopen needs a follow-up date', $q$select public.record_quotation_event(t.o('orgx'),'e5','q1','reopened','They changed their mind',null)$q$, '22023');
select t.ok('rec:quote reopened', $q$select public.record_quotation_event(t.o('orgx'),'e5','q1','reopened','They changed their mind',current_date+3)$q$);
select t.eq('rec:quote reopened is open again', $q$select status||'|'||(closed_at is null)::text from public.quotations where organization_id=t.o('orgx') and id='q1'$q$, 'sent|true');
select t.ok('rec:quote assigned to a member', $q$select public.assign_quotation(t.o('orgx'),'e6','q1',t.o('uidm'))$q$);
select t.eq('rec:quote history keeps every event', $q$select count(*)::text from public.quotation_events where organization_id=t.o('orgx') and quotation_id='q1'$q$, '6');
select t.err('rec:quote direct write not allowed', $q$update public.quotations set status='accepted' where organization_id=t.o('orgx')$q$);
reset role;
select t.err('rec:quote amount cannot be rewritten even by a superuser', format($q$update public.quotations set amount_minor=1 where organization_id=%L$q$, :'orgx'), '55000');
select t.err('rec:quote events are immutable', format($q$delete from public.quotation_events where organization_id=%L$q$, :'orgx'));

-- ================= Deposits =================
select set_config('request.jwt.claim.sub', :'X', false) \gset
set role authenticated;
select t.ok('rec:dep deposit promised against the quotation', $q$select public.create_deposit(t.o('orgx'),'d1','q1',null,null,150000,current_date+7,'30 percent upfront')$q$);
select t.eq('rec:dep inherits customer and currency; a promise only', $q$select customer_name||'|'||currency||'|'||status from public.deposits where organization_id=t.o('orgx') and id='d1'$q$, 'Acme Ltd|USD|promised');
select t.eq('rec:dep a promise creates no payment evidence or outcome', $q$select (select count(*) from public.payment_evidence where organization_id=t.o('orgx'))||'/'||(select count(*) from public.outcomes where organization_id=t.o('orgx'))$q$, '0/0');
select t.eq('rec:dep retry is a no-op', $q$select (public.create_deposit(t.o('orgx'),'d1','q1',null,null,150000,current_date+7))->>'duplicate'$q$, 'true');
select t.err('rec:dep above the quotation amount rejected', $q$select public.create_deposit(t.o('orgx'),'d2','q1',null,null,600000,current_date+7)$q$, '22023');
select t.err('rec:dep currency must match the quotation', $q$select public.create_deposit(t.o('orgx'),'d3','q1',null,'EUR',1000,current_date+7)$q$, '22023');
select t.err('rec:dep past promised date rejected', $q$select public.create_deposit(t.o('orgx'),'d4',null,'Walk-in','USD',1000,current_date-1)$q$, '22023');
select t.ok('rec:dep stand-alone deposit', $q$select public.create_deposit(t.o('orgx'),'d5',null,'Birch Co','USD',20000,current_date+3,'no quote')$q$);
select t.err('rec:dep reschedule needs a note', $q$select public.update_deposit(t.o('orgx'),'de1','d5','reschedule','',current_date+9)$q$, '22023');
select t.ok('rec:dep rescheduled', $q$select public.update_deposit(t.o('orgx'),'de1','d5','reschedule','Customer asked for more time',current_date+9)$q$);
select t.err('rec:dep owner confirmation cannot exceed the promise', $q$select public.update_deposit(t.o('orgx'),'de2','d5','confirm_received','Cash in hand',null,99999,current_date)$q$, '22023');
select t.ok('rec:dep owner confirms receipt', $q$select public.update_deposit(t.o('orgx'),'de2','d5','confirm_received','Cash in hand',null,20000,current_date)$q$);
select t.eq('rec:dep owner confirmation is UNVERIFIED, not revenue', $q$select status from public.deposits where organization_id=t.o('orgx') and id='d5'$q$, 'received_unverified');
select t.eq('rec:dep still no payment evidence from owner say-so', $q$select count(*)::text from public.payment_evidence where organization_id=t.o('orgx')$q$, '0');
select t.ok('rec:dep unverified receipt can be reopened', $q$select public.update_deposit(t.o('orgx'),'de3','d5','reopen','Customer actually paid someone else',current_date+2)$q$);
select t.eq('rec:dep back to promised with confirmation cleared', $q$select status||'|'||coalesce(owner_confirmed_minor::text,'none') from public.deposits where organization_id=t.o('orgx') and id='d5'$q$, 'promised|none');
select t.ok('rec:dep cancel', $q$select public.update_deposit(t.o('orgx'),'de4','d5','cancel','Deal fell through')$q$);
select t.err('rec:dep cannot reschedule a cancelled deposit', $q$select public.update_deposit(t.o('orgx'),'de5','d5','reschedule','x y z',current_date+2)$q$, '22023');
reset role;

-- ================= Payments: review queue =================
select set_config('request.jwt.claim.sub', :'X', false) \gset
set role authenticated;
select t.ok('rec:pay set recovery rate', $q$insert into public.assumptions(organization_id,id,assumption_key,value_bps,updated_by) values (t.o('orgx'),'recovery-rate','recovery_rate',2000,t.o('uidx'))$q$);
select t.ok('rec:pay invoices imported', $q$select public.persist_invoice_import(t.o('orgx'),'src-k','k.csv',repeat('e',64),
 jsonb_build_array(
  jsonb_build_object('id','k-a','invoiceNumber','K-A','customerId','ca','customerName','A','currency','USD','totalMinor',100000,'paidMinor',0,'issuedAt',now()-interval '60 days','dueAt',now()-interval '30 days','importedAt',now()),
  jsonb_build_object('id','k-b','invoiceNumber','K-B','customerId','cb','customerName','B','currency','USD','totalMinor',50000,'paidMinor',0,'issuedAt',now()-interval '40 days','dueAt',now()-interval '10 days','importedAt',now()),
  jsonb_build_object('id','k-d1','invoiceNumber','K-DUP','customerId','cd','customerName','D','currency','USD','totalMinor',10000,'paidMinor',0,'issuedAt',now()-interval '20 days','dueAt',now()-interval '5 days','importedAt',now())
 ),0)$q$);
select t.ok('rec:pay second source with the same invoice number (ambiguous)', $q$select public.persist_invoice_import(t.o('orgx'),'src-k2','k2.csv',repeat('f',64),
 jsonb_build_array(jsonb_build_object('id','k-d2','invoiceNumber','K-DUP','customerId','cd','customerName','D','currency','USD','totalMinor',10000,'paidMinor',0,'issuedAt',now()-interval '20 days','dueAt',now()-interval '5 days','importedAt',now())),0)$q$);
reset role;
select sum(paid_minor)::text as paid_before from public.invoices where organization_id = :'orgx' \gset
select set_config('request.jwt.claim.sub', :'X', false) \gset
set role authenticated;
select t.eq('rec:pay mixed file keeps valid rows and queues the rest (accepted/review)', $q$select concat_ws('/', r->>'accepted_rows', r->>'review_rows') from (select public.persist_payment_import(t.o('orgx'),'src-p1','p1.csv',repeat('1',64),
 jsonb_build_array(
  jsonb_build_object('externalRecordId','P-1','invoiceNumber','K-A','currency','USD','amountMinor',40000,'receivedAt',now()-interval '2 days'),
  jsonb_build_object('externalRecordId','P-2','invoiceNumber','K-NOPE','currency','USD','amountMinor',25000,'receivedAt',now()-interval '2 days'),
  jsonb_build_object('externalRecordId','P-3','invoiceNumber','K-DUP','currency','USD','amountMinor',10000,'receivedAt',now()-interval '1 day'),
  jsonb_build_object('externalRecordId','P-4','invoiceNumber','K-B','currency','EUR','amountMinor',5000,'receivedAt',now()-interval '1 day')
 ),0) r) x$q$, '1/3');
select t.eq('rec:pay exactly one payment became evidence', $q$select count(*)::text from public.payment_evidence where organization_id=t.o('orgx')$q$, '1');
select t.eq('rec:pay three payments await review', $q$select count(*)::text from public.payment_review_items where organization_id=t.o('orgx') and status='pending'$q$, '3');
select t.eq('rec:pay ambiguous payment carries both candidates', $q$select cardinality(candidate_invoice_ids)::text from public.payment_review_items where organization_id=t.o('orgx') and external_record_id='P-3'$q$, '2');
select t.eq('rec:pay retrying the same file changes nothing', $q$select concat_ws('/', r->>'duplicate', r->>'accepted_rows', r->>'review_rows') from (select public.persist_payment_import(t.o('orgx'),'src-p1','p1.csv',repeat('1',64),'[]'::jsonb,0) r) x$q$, 'true/0/0');
select t.eq('rec:pay re-exported file (new hash, same references) adds nothing', $q$select concat_ws('/', r->>'accepted_rows', r->>'review_rows') from (select public.persist_payment_import(t.o('orgx'),'src-p1','p1b.csv',repeat('2',64),
 jsonb_build_array(
  jsonb_build_object('externalRecordId','P-1','invoiceNumber','K-A','currency','USD','amountMinor',40000,'receivedAt',now()-interval '2 days'),
  jsonb_build_object('externalRecordId','P-2','invoiceNumber','K-NOPE','currency','USD','amountMinor',25000,'receivedAt',now()-interval '2 days')),0) r) x$q$, '0/0');
select t.eq('rec:pay still one evidence row and three review rows', $q$select (select count(*) from public.payment_evidence where organization_id=t.o('orgx'))||'/'||(select count(*) from public.payment_review_items where organization_id=t.o('orgx'))$q$, '1/3');
select t.eq('rec:pay import never changed invoice balances', $q$select (select sum(paid_minor) from public.invoices where organization_id=t.o('orgx'))::text$q$, :'paid_before');
-- resolve
select t.err('rec:pay dismiss needs a reason', $q$select public.resolve_payment_review(t.o('orgx'),(select id from public.payment_review_items where organization_id=t.o('orgx') and external_record_id='P-4'),'dismiss',null,'')$q$, '22023');
select t.err('rec:pay cannot assign to an invoice in another currency', $q$select public.resolve_payment_review(t.o('orgx'),(select id from public.payment_review_items where organization_id=t.o('orgx') and external_record_id='P-4'),'to_invoice','k-b','eur payment')$q$, '22023');
select t.ok('rec:pay ambiguous payment placed on the right invoice', $q$select public.resolve_payment_review(t.o('orgx'),(select id from public.payment_review_items where organization_id=t.o('orgx') and external_record_id='P-3'),'to_invoice','k-d2','Matched by customer and amount')$q$);
select t.eq('rec:pay that payment is now evidence on the chosen invoice', $q$select invoice_id from public.payment_evidence where organization_id=t.o('orgx') and external_record_id='P-3'$q$, 'k-d2');
select t.eq('rec:pay second resolve of the same item is a no-op', $q$select (public.resolve_payment_review(t.o('orgx'),(select id from public.payment_review_items where organization_id=t.o('orgx') and external_record_id='P-3'),'to_invoice','k-d1','again'))->>'duplicate'$q$, 'true');
select t.eq('rec:pay two evidence rows after resolution, no double count', $q$select count(*)::text from public.payment_evidence where organization_id=t.o('orgx')$q$, '2');
select t.ok('rec:pay unmatched payment dismissed with reason', $q$select public.resolve_payment_review(t.o('orgx'),(select id from public.payment_review_items where organization_id=t.o('orgx') and external_record_id='P-4'),'dismiss',null,'Test payment from the bank')$q$);
select t.eq('rec:pay dismissed payment stays visible as history', $q$select status||'|'||resolution from public.payment_review_items where organization_id=t.o('orgx') and external_record_id='P-4'$q$, 'dismissed|dismissed');
-- deposit payment: P-2 is the deposit money
select t.ok('rec:pay unmatched payment linked to a deposit', $q$select public.resolve_payment_review(t.o('orgx'),(select id from public.payment_review_items where organization_id=t.o('orgx') and external_record_id='P-2'),'to_deposit','d1','Deposit for Q-100')$q$);
select t.eq('rec:pay partial deposit evidence does not verify the deposit', $q$select status from public.deposits where organization_id=t.o('orgx') and id='d1'$q$, 'promised');
select t.eq('rec:pay deposit payment is not invoice evidence', $q$select count(*)::text from public.payment_evidence where organization_id=t.o('orgx') and external_record_id='P-2'$q$, '0');
select t.eq('rec:pay deposit payment recorded once', $q$select count(*)::text from public.deposit_payments where organization_id=t.o('orgx') and deposit_id='d1'$q$, '1');
reset role;

-- corrected import: a later invoice import supplies a previously missing invoice; rematch applies it once
select set_config('request.jwt.claim.sub', :'X', false) \gset
set role authenticated;
select t.ok('rec:pay later payment file with an unknown invoice', $q$select public.persist_payment_import(t.o('orgx'),'src-p2','p2.csv',repeat('3',64),
 jsonb_build_array(jsonb_build_object('externalRecordId','P-5','invoiceNumber','K-LATE','currency','USD','amountMinor',7000,'receivedAt',now())),0)$q$);
select t.eq('rec:pay waiting for the invoice', $q$select status from public.payment_review_items where organization_id=t.o('orgx') and external_record_id='P-5'$q$, 'pending');
select t.ok('rec:pay the missing invoice arrives', $q$select public.persist_invoice_import(t.o('orgx'),'src-k3','k3.csv',repeat('4',64),
 jsonb_build_array(jsonb_build_object('id','k-late','invoiceNumber','K-LATE','customerId','cl','customerName','L','currency','USD','totalMinor',7000,'paidMinor',0,'issuedAt',now()-interval '20 days','dueAt',now()-interval '5 days','importedAt',now())),0)$q$);
select t.eq('rec:pay rematch applies the exact match', $q$select (public.rematch_payment_review(t.o('orgx')))->>'matched'$q$, '1');
select t.eq('rec:pay auto-matched item is resolved', $q$select status||'|'||resolution from public.payment_review_items where organization_id=t.o('orgx') and external_record_id='P-5'$q$, 'resolved|auto_matched');
select t.eq('rec:pay rematch again changes nothing', $q$select (public.rematch_payment_review(t.o('orgx')))->>'matched'$q$, '0');
select t.eq('rec:pay evidence for P-5 exists exactly once', $q$select count(*)::text from public.payment_evidence where organization_id=t.o('orgx') and external_record_id='P-5'$q$, '1');
reset role;

-- ================= Tasks =================
select set_config('request.jwt.claim.sub', :'X', false) \gset
set role authenticated;
select t.ok('rec:task created and unowned', $q$select public.create_task(t.o('orgx'),'t1','Call Acme about the deposit','Ask for the 30% deposit',current_date+1,null,'deposit','d1')$q$);
select t.eq('rec:task unowned by default', $q$select coalesce(owner_id,'none') from public.tasks where organization_id=t.o('orgx') and id='t1'$q$, 'none');
select t.eq('rec:task retry is a no-op', $q$select (public.create_task(t.o('orgx'),'t1','Call Acme about the deposit',null,current_date+1))->>'duplicate'$q$, 'true');
select t.err('rec:task past due date rejected', $q$select public.create_task(t.o('orgx'),'t2','Old task here',null,current_date-1)$q$, '22023');
select t.err('rec:task related record must exist in this workspace', $q$select public.create_task(t.o('orgx'),'t3','Chase something',null,current_date+1,null,'quotation','nope')$q$, 'P0002');
select t.err('rec:task related type and id come together', $q$select public.create_task(t.o('orgx'),'t4','Chase something',null,current_date+1,null,'quotation',null)$q$, '22023');
select t.err('rec:task owner must be a member', $q$select public.update_task(t.o('orgx'),'te1','t1','assign',null,null,t.o('uidz'))$q$, '22023');
select t.ok('rec:task assigned', $q$select public.update_task(t.o('orgx'),'te1','t1','assign',null,null,t.o('uidm'))$q$);
select t.err('rec:task rescheduling needs a reason', $q$select public.update_task(t.o('orgx'),'te2','t1','reschedule','',current_date+5)$q$, '22023');
select t.ok('rec:task rescheduled with a reason', $q$select public.update_task(t.o('orgx'),'te2','t1','reschedule','Customer unavailable',current_date+5)$q$);
select t.ok('rec:task completed', $q$select public.update_task(t.o('orgx'),'te3','t1','complete','Deposit confirmed by phone')$q$);
select t.err('rec:task closed task cannot be rescheduled', $q$select public.update_task(t.o('orgx'),'te4','t1','reschedule','too late now',current_date+5)$q$, '22023');
select t.err('rec:task reopen needs a date and a reason', $q$select public.update_task(t.o('orgx'),'te5','t1','reopen','Deposit bounced',null)$q$, '22023');
select t.ok('rec:task reopened', $q$select public.update_task(t.o('orgx'),'te5','t1','reopen','Deposit bounced',current_date+2)$q$);
select t.eq('rec:task open again with owner kept', $q$select status||'|'||(owner_id=t.o('uidm'))::text||'|'||(closed_at is null)::text from public.tasks where organization_id=t.o('orgx') and id='t1'$q$, 'open|true|true');
select t.eq('rec:task full history kept (created, assigned, rescheduled, completed, reopened)', $q$select count(*)::text from public.task_events where organization_id=t.o('orgx') and task_id='t1'$q$, '5');
select t.ok('rec:action owner assigned to a recovery action', $q$select 1$q$);
select t.ok('rec:members listed for a member', $q$select count(*) from public.list_workspace_members(t.o('orgx'))$q$);
select t.eq('rec:members three people in X', $q$select count(*)::text from public.list_workspace_members(t.o('orgx'))$q$, '3');
reset role;

-- ================= Authorization & isolation =================
set role anon;
select t.err('iso:rec anon cannot create a quotation', $q$select public.create_quotation(t.o('orgx'),'qa','Q','A','USD',100,current_date,null,current_date+1)$q$);
select t.err('iso:rec anon cannot import payments', $q$select public.persist_payment_import(t.o('orgx'),'s','s.csv',repeat('5',64),'[]'::jsonb,0)$q$);
reset role;
select set_config('request.jwt.claim.sub', :'W', false) \gset
set role authenticated;
select t.err('iso:rec viewer cannot create a quotation', $q$select public.create_quotation(t.o('orgx'),'qv','Q','A','USD',100,current_date,null,current_date+1)$q$, '42501');
select t.err('iso:rec viewer cannot create a deposit', $q$select public.create_deposit(t.o('orgx'),'dv',null,'A','USD',100,current_date+1)$q$, '42501');
select t.err('iso:rec viewer cannot create a task', $q$select public.create_task(t.o('orgx'),'tv','Do something',null,current_date+1)$q$, '42501');
select t.err('iso:rec viewer cannot resolve a payment', $q$select public.resolve_payment_review(t.o('orgx'),'x','dismiss',null,'because')$q$, '42501');
select t.err('iso:rec viewer cannot import payments', $q$select public.persist_payment_import(t.o('orgx'),'s','s.csv',repeat('5',64),'[]'::jsonb,0)$q$, '42501');
select t.err('iso:rec viewer cannot assign an action owner', $q$select public.assign_action_owner(t.o('orgx'),'a','u')$q$, '42501');
select t.ok('iso:rec viewer can read quotations', $q$select count(*) from public.quotations where organization_id=t.o('orgx')$q$);
select t.eq('iso:rec viewer sees the review queue', $q$select count(*)::text from public.payment_review_items where organization_id=t.o('orgx')$q$, '4');
reset role;
select set_config('request.jwt.claim.sub', :'Z', false) \gset
set role authenticated;
select t.eq('iso:rec other workspace sees no quotations', $q$select count(*)::text from public.quotations$q$, '0');
select t.eq('iso:rec other workspace sees no deposits', $q$select count(*)::text from public.deposits$q$, '0');
select t.eq('iso:rec other workspace sees no tasks', $q$select count(*)::text from public.tasks$q$, '0');
select t.eq('iso:rec other workspace sees no review payments', $q$select count(*)::text from public.payment_review_items$q$, '0');
select t.eq('iso:rec other workspace sees no deposit payments or events', $q$select (select count(*) from public.deposit_payments)+(select count(*) from public.quotation_events)+(select count(*) from public.task_events)+(select count(*) from public.deposit_events)$q$, '0');
select t.err('iso:rec other workspace cannot read member list', $q$select * from public.list_workspace_members(t.o('orgx'))$q$, '42501');
select t.err('iso:rec other workspace cannot add a quotation to X', $q$select public.create_quotation(t.o('orgx'),'qz','Q','A','USD',100,current_date,null,current_date+1)$q$, '42501');
select t.err('iso:rec other workspace cannot resolve X payments', $q$select public.resolve_payment_review(t.o('orgx'),(select id from public.payment_review_items limit 1),'dismiss',null,'because')$q$, '42501');
select t.err('iso:rec other workspace cannot update an X task', $q$select public.update_task(t.o('orgx'),'tz','t1','complete','nope nope')$q$, '42501');
select t.ok('iso:rec Z owns its own records with the same ids', $q$select public.create_task(t.o('orgz'),'t1','Z own task here',null,current_date+1)$q$);
select t.err('iso:rec Z cannot attach X record to its task', $q$select public.create_task(t.o('orgz'),'t9','Z task about X',null,current_date+1,null,'quotation','q1')$q$, 'P0002');
select t.err('iso:rec Z cannot link an X deposit to its quotation', $q$select public.create_deposit(t.o('orgz'),'dz','q1',null,null,100,current_date+1)$q$, 'P0002');
reset role;
select t.eq('iso:rec X task untouched by Z', format($q$select title from public.tasks where organization_id=%L and id='t1'$q$, :'orgx'), 'Call Acme about the deposit');

-- ================= Audit =================
select t.ok('rec:audit quotation, deposit, task and payment decisions are logged', format($q$select 1 from public.audit_log where organization_id=%L having count(*) filter (where event_type='quotation_created')>=1 and count(*) filter (where event_type='deposit_created')>=1 and count(*) filter (where event_type='task_created')>=1 and count(*) filter (where event_type='payment_review_to_invoice')>=1 and count(*) filter (where event_type='payment_import')>=2$q$, :'orgx'));

-- ================= Scheduler also re-matches =================
select set_config('request.jwt.claim.sub', '', false) \gset
select t.ok('rec:sched scheduled evaluation runs with the new rematch step', $q$select public.run_scheduled_evaluation()$q$);
select t.eq('rec:sched last run for X is ok', format($q$select status from public.evaluation_runs where organization_id=%L order by started_at desc, id limit 1$q$, :'orgx'), 'ok');

\echo ===== RECORDS RESULTS =====
select case when ok then 'PASS' else 'FAIL' end as r, label, detail from t.results where label ~ '^(rec:|iso:rec)' order by n;
select count(*) filter (where ok) as passed, count(*) filter (where not ok) as failed from t.results where label ~ '^(rec:|iso:rec)';
