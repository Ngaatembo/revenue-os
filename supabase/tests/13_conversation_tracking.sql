-- Conversation tracking: handled / snooze / reopen / note, and muted senders. Synthetic data only.
\set ON_ERROR_STOP off
\set A '00000000-0000-4000-8000-00000000fc01'
\set B '00000000-0000-4000-8000-00000000fc02'
\set V '00000000-0000-4000-8000-00000000fc03'

insert into auth.users(id, email) values (:'A','trk-a@example.test'), (:'B','trk-b@example.test'), (:'V','trk-v@example.test');
select set_config('request.jwt.claim.sub', :'A', false) \gset
set role authenticated;
select organization_id as orga from public.bootstrap_revenue_os_organization('Track Org A') \gset
reset role;
select set_config('request.jwt.claim.sub', :'B', false) \gset
set role authenticated;
select organization_id as orgb from public.bootstrap_revenue_os_organization('Track Org B') \gset
reset role;
select set_config('t.orga', :'orga', false), set_config('t.orgb', :'orgb', false) \gset
select set_config('request.jwt.claim.sub', '', false) \gset
insert into public.users(id, auth_subject, email) values (:'V', :'V', 'trk-v@example.test');
insert into public.memberships(organization_id, user_id, role) values (:'orga', :'V', 'viewer');
insert into public.communications(organization_id, provider, external_id, thread_id, direction, counterpart_address, subject, occurred_at)
values (:'orga', 'gmail', 'm1', 'thread-1', 'inbound', 'customer@example.test', 'Quote', now() - interval '3 days'),
       (:'orgb', 'gmail', 'm2', 'thread-other', 'inbound', 'x@example.test', 'Other workspace', now() - interval '3 days');

-- ---------- Authorization ----------
set role anon;
select t.err('trk: anon cannot track a conversation', $q$select public.set_conversation_tracking(t.o('orga'),'gmail','thread-1','handled')$q$);
select t.err('trk: anon cannot mute a sender', $q$select public.mute_sender(t.o('orga'),'a@b.test')$q$);
reset role;
select set_config('request.jwt.claim.sub', :'B', false) \gset
set role authenticated;
select t.err('trk: a member of another workspace cannot track', $q$select public.set_conversation_tracking(t.o('orga'),'gmail','thread-1','handled')$q$, '42501');
select t.err('trk: a member of another workspace cannot mute', $q$select public.mute_sender(t.o('orga'),'a@b.test')$q$, '42501');
select t.err('trk: own workspace id with a foreign thread is refused', $q$select public.set_conversation_tracking(t.o('orgb'),'gmail','thread-1','handled')$q$, '22023');
reset role;
select set_config('request.jwt.claim.sub', :'V', false) \gset
set role authenticated;
select t.err('trk: a viewer cannot track', $q$select public.set_conversation_tracking(t.o('orga'),'gmail','thread-1','handled')$q$, '42501');
select t.err('trk: a viewer cannot unmute', $q$select public.unmute_sender(t.o('orga'),'a@b.test')$q$, '42501');
select t.err('trk: browsers cannot write the table directly', $q$insert into public.conversation_tracking(organization_id,provider,thread_id,status,handled_at) values (t.o('orga'),'gmail','thread-1','handled',now())$q$);
select t.err('trk: browsers cannot write muted senders directly', $q$insert into public.muted_senders(organization_id,address) values (t.o('orga'),'a@b.test')$q$);
reset role;

-- ---------- Owner flow ----------
select set_config('request.jwt.claim.sub', :'A', false) \gset
set role authenticated;
select t.ok('trk: owner marks handled', $q$select public.set_conversation_tracking(t.o('orga'),'gmail','thread-1','handled')$q$);
select t.eq('trk: handled sets the time and clears any reminder', $q$select (status||','||(handled_at is not null)||','||(remind_at is null)) from public.conversation_tracking where organization_id=t.o('orga') and thread_id='thread-1'$q$, 'handled,true,true');
select t.ok('trk: owner snoozes for 3 days with a note', $q$select public.set_conversation_tracking(t.o('orga'),'gmail','thread-1','snooze', now() + interval '3 days', 'quoted $400, waiting on deposit')$q$);
select t.eq('trk: snooze replaces handled', $q$select (status||','||(handled_at is null)||','||(remind_at is not null)||','||note) from public.conversation_tracking where organization_id=t.o('orga') and thread_id='thread-1'$q$, 'snoozed,true,true,quoted $400, waiting on deposit');
select t.ok('trk: a note alone keeps the status', $q$select public.set_conversation_tracking(t.o('orga'),'gmail','thread-1','note', null, 'updated note')$q$);
select t.eq('trk: note changed, still snoozed', $q$select status||','||note from public.conversation_tracking where organization_id=t.o('orga') and thread_id='thread-1'$q$, 'snoozed,updated note');
select t.ok('trk: reopen clears handled and reminder but keeps the note', $q$select public.set_conversation_tracking(t.o('orga'),'gmail','thread-1','reopen')$q$);
select t.eq('trk: reopened state', $q$select status||','||(handled_at is null)||','||(remind_at is null)||','||note from public.conversation_tracking where organization_id=t.o('orga') and thread_id='thread-1'$q$, 'open,true,true,updated note');
select t.ok('trk: an empty note clears it', $q$select public.set_conversation_tracking(t.o('orga'),'gmail','thread-1','note', null, '   ')$q$);
select t.eq('trk: note cleared', $q$select (note is null)::text from public.conversation_tracking where organization_id=t.o('orga') and thread_id='thread-1'$q$, 'true');
select t.eq('trk: one row per conversation', $q$select count(*)::text from public.conversation_tracking where organization_id=t.o('orga')$q$, '1');

-- ---------- Validation ----------
select t.err('trk: unknown action refused', $q$select public.set_conversation_tracking(t.o('orga'),'gmail','thread-1','archive')$q$, '22023');
select t.err('trk: unknown conversation refused', $q$select public.set_conversation_tracking(t.o('orga'),'gmail','no-such-thread','handled')$q$, '22023');
select t.err('trk: a reminder in the past is refused', $q$select public.set_conversation_tracking(t.o('orga'),'gmail','thread-1','snooze', now() - interval '1 hour')$q$, '22023');
select t.err('trk: a reminder without a time is refused', $q$select public.set_conversation_tracking(t.o('orga'),'gmail','thread-1','snooze')$q$, '22023');
select t.err('trk: a reminder beyond 90 days is refused', $q$select public.set_conversation_tracking(t.o('orga'),'gmail','thread-1','snooze', now() + interval '91 days')$q$, '22023');
select t.err('trk: a 501 character note is refused', $q$select public.set_conversation_tracking(t.o('orga'),'gmail','thread-1','note', null, repeat('x',501))$q$, '22023');

-- ---------- Muted senders ----------
select t.ok('trk: owner mutes a sender (normalised to lower case)', $q$select public.mute_sender(t.o('orga'),'  Notify@Updates.Example.TEST ')$q$);
select t.eq('trk: stored normalised', $q$select address from public.muted_senders where organization_id=t.o('orga')$q$, 'notify@updates.example.test');
select t.ok('trk: muting twice is harmless', $q$select public.mute_sender(t.o('orga'),'notify@updates.example.test')$q$);
select t.eq('trk: still one mute', $q$select count(*)::text from public.muted_senders where organization_id=t.o('orga')$q$, '1');
select t.err('trk: a malformed address is refused', $q$select public.mute_sender(t.o('orga'),'not an address')$q$, '22023');
select t.ok('trk: owner unmutes', $q$select public.unmute_sender(t.o('orga'),'NOTIFY@updates.example.test')$q$);
select t.eq('trk: unmuted', $q$select count(*)::text from public.muted_senders where organization_id=t.o('orga')$q$, '0');
select t.ok('trk: owner mutes again for the isolation checks', $q$select public.mute_sender(t.o('orga'),'x@y.test')$q$);
reset role;

-- ---------- Isolation ----------
select set_config('request.jwt.claim.sub', :'B', false) \gset
set role authenticated;
select t.eq('trk: another workspace sees no tracking', $q$select count(*)::text from public.conversation_tracking$q$, '0');
select t.eq('trk: another workspace sees no mutes', $q$select count(*)::text from public.muted_senders$q$, '0');
reset role;
select set_config('request.jwt.claim.sub', :'V', false) \gset
set role authenticated;
select t.eq('trk: a viewer can read the tracking', $q$select count(*)::text from public.conversation_tracking$q$, '1');
reset role;
select set_config('request.jwt.claim.sub', '', false) \gset

\echo
\echo ===== TRACKING RESULTS =====
select case when ok then 'PASS' else 'FAIL' end as result, label, coalesce(detail,'') as detail
  from t.results where label like 'trk:%' order by n;
select count(*) filter (where ok) as passed, count(*) filter (where not ok) as failed
  from t.results where label like 'trk:%';
