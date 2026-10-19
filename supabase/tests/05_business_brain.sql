-- Tests for the Business Brain: record_brain_fact, retract_brain_fact, resolve_brain_conflict, assumption audit.
-- Synthetic data only; own workspaces.
\set ON_ERROR_STOP off
\set X '00000000-0000-4000-8000-0000000000b1'
\set Z '00000000-0000-4000-8000-0000000000b2'
\set W '00000000-0000-4000-8000-0000000000b3'

insert into auth.users(id, email) values (:'X','bx@example.test'), (:'Z','bz@example.test'), (:'W','bviewer@example.test');
select set_config('request.jwt.claim.sub', :'X', false) \gset
set role authenticated;
select organization_id as orgx from public.bootstrap_revenue_os_organization('Brain Org X') \gset
reset role;
select set_config('request.jwt.claim.sub', :'Z', false) \gset
set role authenticated;
select organization_id as orgz from public.bootstrap_revenue_os_organization('Brain Org Z') \gset
reset role;
select set_config('t.orgx', :'orgx', false), set_config('t.orgz', :'orgz', false) \gset
select set_config('request.jwt.claim.sub', '', false) \gset
insert into public.users(id, auth_subject, email) values (:'W', :'W', 'bviewer@example.test');
insert into public.memberships(organization_id, user_id, role) values (:'orgx', :'W', 'viewer');

select set_config('request.jwt.claim.sub', :'X', false) \gset
set role authenticated;
-- ---------- Recording ----------
select t.ok('brain: owner records payment terms', $q$select public.record_brain_fact(t.o('orgx'),'f1','payment_terms_days','30','user_entered','Owner said so on the phone')$q$);
select t.eq('brain: fact is active with its source', $q$select status||'|'||source_label from public.brain_facts where organization_id=t.o('orgx') and id='f1'$q$, 'active|Owner said so on the phone');
select t.eq('brain: retry with same id is a duplicate, not a second row', $q$select (public.record_brain_fact(t.o('orgx'),'f1','payment_terms_days','30','user_entered','again'))->>'duplicate'$q$, 'true');
select t.eq('brain: still one row for f1', $q$select count(*)::text from public.brain_facts where organization_id=t.o('orgx')$q$, '1');
select t.err('brain: same id for another key is refused', $q$select public.record_brain_fact(t.o('orgx'),'f1','lead_stall_days','10','user_entered','x')$q$, '23505');
select t.err('brain: source is required', $q$select public.record_brain_fact(t.o('orgx'),'f2','lead_stall_days','10','user_entered','  ')$q$, '22023');
select t.err('brain: known numeric key rejects text', $q$select public.record_brain_fact(t.o('orgx'),'f3','payment_terms_days','thirty','user_entered','x')$q$, '22023');
select t.err('brain: known numeric key rejects out-of-range', $q$select public.record_brain_fact(t.o('orgx'),'f4','deposit_percent','150','user_entered','x')$q$, '22023');
select t.err('brain: bad key shape rejected', $q$select public.record_brain_fact(t.o('orgx'),'f5','Bad Key','1','user_entered','x')$q$, '22023');
select t.err('brain: unsupported kind (verified cannot be typed in) rejected', $q$select public.record_brain_fact(t.o('orgx'),'f6','payment_terms_days','30','verified','x')$q$, '22023');
select t.ok('brain: free-text fact for an unknown key accepted', $q$select public.record_brain_fact(t.o('orgx'),'f7','preferred_payment_method','Bank transfer','user_entered','Owner')$q$);

-- ---------- Supersede keeps history ----------
select t.ok('brain: newer value of same kind', $q$select public.record_brain_fact(t.o('orgx'),'f8','payment_terms_days','14','user_entered','Updated terms')$q$);
select t.eq('brain: old value kept as superseded history', $q$select status||'|'||superseded_by from public.brain_facts where organization_id=t.o('orgx') and id='f1'$q$, 'superseded|f8');
select t.eq('brain: exactly one active payment_terms_days', $q$select count(*)::text from public.brain_facts where organization_id=t.o('orgx') and fact_key='payment_terms_days' and status='active'$q$, '1');
select t.eq('brain: no conflict from supersede', $q$select (public.record_brain_fact(t.o('orgx'),'f8','payment_terms_days','14','user_entered','x'))->>'duplicate'$q$, 'true');

-- ---------- Conflicts ----------
select t.eq('brain: different kind, different value => conflict flagged', $q$select (public.record_brain_fact(t.o('orgx'),'f9','payment_terms_days','45','imported','Customer contract import'))->>'conflict'$q$, 'true');
select t.eq('brain: both stay active while in conflict', $q$select count(*)::text from public.brain_facts where organization_id=t.o('orgx') and fact_key='payment_terms_days' and status='active'$q$, '2');
select t.err('brain: cannot resolve with a fact of another key', $q$select public.resolve_brain_conflict(t.o('orgx'),'payment_terms_days','f7','x too short?')$q$, 'P0002');
select t.err('brain: resolve needs a reason', $q$select public.resolve_brain_conflict(t.o('orgx'),'payment_terms_days','f8','')$q$, '22023');
select t.err('brain: no conflict to resolve for a clean key', $q$select public.resolve_brain_conflict(t.o('orgx'),'preferred_payment_method','f7','nothing to resolve')$q$, '22023');
select t.ok('brain: owner resolves conflict keeping f8', $q$select public.resolve_brain_conflict(t.o('orgx'),'payment_terms_days','f8','Contract is outdated')$q$);
select t.eq('brain: f9 superseded by f8 with reason', $q$select status||'|'||superseded_by||'|'||status_reason from public.brain_facts where organization_id=t.o('orgx') and id='f9'$q$, 'superseded|f8|Conflict resolved: Contract is outdated');
select t.eq('brain: one active value remains', $q$select value_text from public.brain_facts where organization_id=t.o('orgx') and fact_key='payment_terms_days' and status='active'$q$, '14');
select t.eq('brain: same value from another kind is not a conflict', $q$select (public.record_brain_fact(t.o('orgx'),'f10','payment_terms_days','14','imported','CSV'))->>'conflict'$q$, 'false');

-- ---------- Retract ----------
select t.err('brain: retract needs a reason', $q$select public.retract_brain_fact(t.o('orgx'),'f7','')$q$, '22023');
select t.ok('brain: retract a fact', $q$select public.retract_brain_fact(t.o('orgx'),'f7','Wrong, we use cheques')$q$);
select t.eq('brain: retracted fact kept as history', $q$select status from public.brain_facts where organization_id=t.o('orgx') and id='f7'$q$, 'retracted');
select t.err('brain: cannot retract twice', $q$select public.retract_brain_fact(t.o('orgx'),'f7','again please')$q$, '22023');

-- ---------- Immutability ----------
select t.err('brain: direct insert not allowed', $q$insert into public.brain_facts(organization_id,id,fact_key,kind,value_text,source_label,recorded_by) values (t.o('orgx'),'zz','k_x','user_entered','1','s','nobody')$q$);
select t.err('brain: direct update not allowed', $q$update public.brain_facts set value_text='999' where organization_id=t.o('orgx') and id='f8'$q$);
select t.err('brain: direct delete not allowed', $q$delete from public.brain_facts where organization_id=t.o('orgx')$q$);
reset role;
select t.err('brain: even a privileged update cannot rewrite a value', format($q$update public.brain_facts set value_text='1' where organization_id=%L and id='f8'$q$, :'orgx'), '55000');
select t.err('brain: even a privileged update cannot reactivate history', format($q$update public.brain_facts set status='active', status_changed_at=null where organization_id=%L and id='f1'$q$, :'orgx'), '55000');
select t.err('brain: even a privileged delete is refused', format($q$delete from public.brain_facts where organization_id=%L$q$, :'orgx'), '55000');

-- ---------- Authorization & isolation ----------
set role anon;
select t.err('brain: anon cannot record', $q$select public.record_brain_fact(t.o('orgx'),'a1','lead_stall_days','10','user_entered','x')$q$);
reset role;
select set_config('request.jwt.claim.sub', :'Z', false) \gset
set role authenticated;
select t.err('brain: other workspace owner cannot record into X', $q$select public.record_brain_fact(t.o('orgx'),'a2','lead_stall_days','10','user_entered','x')$q$, '42501');
select t.err('brain: other workspace owner cannot retract X fact', $q$select public.retract_brain_fact(t.o('orgx'),'f8','trying to delete')$q$, '42501');
select t.err('brain: other workspace owner cannot resolve X conflict', $q$select public.resolve_brain_conflict(t.o('orgx'),'payment_terms_days','f8','nope nope')$q$, '42501');
select t.eq('iso: other workspace reads zero X brain facts', $q$select count(*)::text from public.brain_facts$q$, '0');
select t.ok('brain: Z records its own fact with an id X already used', $q$select public.record_brain_fact(t.o('orgz'),'f8','payment_terms_days','60','user_entered','Z owner')$q$);
select t.eq('iso: Z fact does not touch X value', $q$select value_text from public.brain_facts where id='f8'$q$, '60');
reset role;
select t.eq('iso: X active value unchanged by Z', format($q$select value_text from public.brain_facts where organization_id=%L and id='f8'$q$, :'orgx'), '14');
select set_config('request.jwt.claim.sub', :'W', false) \gset
set role authenticated;
select t.err('brain: viewer cannot record', $q$select public.record_brain_fact(t.o('orgx'),'v1','lead_stall_days','10','user_entered','x')$q$, '42501');
select t.err('brain: viewer cannot retract', $q$select public.retract_brain_fact(t.o('orgx'),'f8','not allowed')$q$, '42501');
select t.ok('brain: viewer can read X facts', $q$select count(*) from public.brain_facts where organization_id=t.o('orgx')$q$);
select t.eq('brain: viewer sees full history', $q$select count(*)::text from public.brain_facts where organization_id=t.o('orgx') and fact_key='payment_terms_days'$q$, '4');
reset role;

-- ---------- Audit ----------
select t.eq('audit: each effective brain write (5 records, 1 retract, 1 resolve) has one audit entry; duplicates and refusals have none', format($q$select count(*)::text from public.audit_log where organization_id=%L and event_type in ('brain_fact_recorded','brain_fact_retracted','brain_conflict_resolved')$q$, :'orgx'), '7');
select t.eq('audit: record entry names old and new values', format($q$select (details->>'replaced_value')||'>'||(details->>'value') from public.audit_log where organization_id=%L and entity_id='f8' and event_type='brain_fact_recorded'$q$, :'orgx'), '30>14');

-- ---------- Assumption audit ----------
select set_config('request.jwt.claim.sub', :'X', false) \gset
set role authenticated;
select t.ok('assump: owner sets recovery rate', $q$insert into public.assumptions(organization_id,id,assumption_key,value_bps,updated_by) values (t.o('orgx'),'recovery-rate','recovery_rate',2500,(select id from public.users where auth_subject=auth.uid()))$q$);
select t.ok('assump: owner changes recovery rate', $q$update public.assumptions set value_bps=3000 where organization_id=t.o('orgx') and id='recovery-rate'$q$);
select t.ok('assump: saving the same value again', $q$update public.assumptions set value_bps=3000, updated_at=now() where organization_id=t.o('orgx') and id='recovery-rate'$q$);
select t.eq('assump: two audit entries (create, change), not three', $q$select count(*)::text from public.audit_log where organization_id=t.o('orgx') and event_type='assumption_changed'$q$, '2');
select t.eq('assump: change records old and new', $q$select (details->>'old_bps')||'>'||(details->>'new_bps') from public.audit_log where organization_id=t.o('orgx') and event_type='assumption_changed' order by created_at desc, id limit 1$q$, '2500>3000');
reset role;

\echo ===== BRAIN RESULTS =====
select case when ok then 'PASS' else 'FAIL' end as r, label, detail from t.results where label ~ '^(brain|assump|audit):' order by n;
select count(*) filter (where ok) as passed, count(*) filter (where not ok) as failed from t.results where label ~ '^(brain|assump|audit):';
