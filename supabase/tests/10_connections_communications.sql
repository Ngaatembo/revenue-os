-- Connections state, claim lease, communications isolation. Synthetic data only.
\set ON_ERROR_STOP off
\set A '00000000-0000-4000-8000-0000000000a1'
\set B '00000000-0000-4000-8000-0000000000a2'

insert into auth.users(id, email) values (:'A','conn-a@example.test'), (:'B','conn-b@example.test');
select set_config('request.jwt.claim.sub', :'A', false) \gset
set role authenticated;
select organization_id as orga from public.bootstrap_revenue_os_organization('Conn Org A') \gset
reset role;
select set_config('request.jwt.claim.sub', :'B', false) \gset
set role authenticated;
select organization_id as orgb from public.bootstrap_revenue_os_organization('Conn Org B') \gset
reset role;
select set_config('t.orga', :'orga', false), set_config('t.orgb', :'orgb', false) \gset
select set_config('request.jwt.claim.sub', '', false) \gset

-- Server side: connection + communications written by the service role only.
set role service_role;
select set_config('request.jwt.claim.role', 'service_role', false);
insert into public.provider_connections(organization_id, provider, status, encrypted_refresh_token, provider_account_email)
  values (t.o('orga'), 'gmail', 'connected', 'enc-token-a', 'owner-a@example.test'),
         (t.o('orgb'), 'gmail', 'connected', 'enc-token-b', 'owner-b@example.test');
select t.ok('conn: gmail is an accepted provider', $q$select 1$q$);
select t.err('conn: unknown provider rejected', $q$insert into public.provider_connections(organization_id, provider, status) values (t.o('orga'),'tiktok','pending')$q$, '23514');
select t.err('conn: connected without a token rejected', $q$insert into public.provider_connections(organization_id, provider, status) values (t.o('orga'),'google_sheets','connected')$q$, '23514');
select t.eq('conn: first claim wins', $q$select count(*)::text from public.claim_connection_sync(t.o('orga'),'gmail')$q$, '1');
select t.eq('conn: second claim while syncing is refused', $q$select count(*)::text from public.claim_connection_sync(t.o('orga'),'gmail')$q$, '0');
select t.eq('conn: claim marks the connection syncing', $q$select status||'/'||sync_stage from public.provider_connections where organization_id=t.o('orga') and provider='gmail'$q$, 'syncing/connecting');
update public.provider_connections set sync_started_at = now() - interval '11 minutes' where organization_id=t.o('orga') and provider='gmail';
select t.eq('conn: a stale lease (crashed worker) can be reclaimed', $q$select count(*)::text from public.claim_connection_sync(t.o('orga'),'gmail')$q$, '1');
update public.provider_connections set status='connected', next_sync_at = now() + interval '1 hour' where organization_id=t.o('orga') and provider='gmail';
select t.eq('conn: not due yet is not claimed', $q$select count(*)::text from public.claim_connection_sync(t.o('orga'),'gmail')$q$, '0');
select t.eq('conn: force overrides schedule', $q$select count(*)::text from public.claim_connection_sync(t.o('orga'),'gmail',true)$q$, '1');
update public.provider_connections set status='connected', sync_started_at=null, sync_stage='waiting_rate_limit', next_sync_at = now() + interval '5 minutes' where organization_id=t.o('orga') and provider='gmail';
select t.eq('conn: "sync now" cannot skip a provider rate-limit pause', $q$select count(*)::text from public.claim_connection_sync(t.o('orga'),'gmail',true)$q$, '0');
update public.provider_connections set status='connected', sync_started_at=null, sync_stage='complete', next_sync_at=null where organization_id=t.o('orga') and provider='gmail';

insert into public.communications(organization_id, provider, external_id, thread_id, direction, counterpart_address, counterpart_name, subject, snippet, occurred_at)
values (t.o('orga'),'gmail','m1','t1','inbound','cust@example.test','Cust','Quote for 10 units','Can you send a quote?', now()-interval '5 days'),
       (t.o('orga'),'gmail','m2','t2','inbound','other@example.test','Other','Invoice question','Where is my invoice?', now()-interval '4 days'),
       (t.o('orga'),'gmail','m3','t2','outbound','other@example.test','Other','Re: Invoice question','Sent it today', now()-interval '3 days'),
       (t.o('orgb'),'gmail','m1','t1','inbound','b@example.test','B','B private subject','secret', now()-interval '1 day');
select t.err('conn: duplicate external id rejected', $q$insert into public.communications(organization_id, provider, external_id, thread_id, direction, occurred_at) values (t.o('orga'),'gmail','m1','t9','inbound',now())$q$, '23505');
select t.eq('conn: thread view carries the source mailbox', $q$select coalesce(source_account,'none') from public.conversation_threads where organization_id=t.o('orga') and thread_id='t2'$q$, 'none');
select t.eq('conn: thread view groups messages', $q$select message_count||'/'||last_direction from public.conversation_threads where organization_id=t.o('orga') and thread_id='t2'$q$, '2/outbound');
reset role;
select set_config('request.jwt.claim.role', '', false);

-- Member of A: reads A only, status without tokens, no direct writes, no token column access.
select set_config('request.jwt.claim.sub', :'A', false);
set role authenticated;
select t.eq('conn: member sees own communications', $q$select count(*)::text from public.communications$q$, '3');
select t.eq('conn: member sees own threads only', $q$select count(*)::text from public.conversation_threads$q$, '2');
select t.eq('conn: member never sees another workspace subject', $q$select count(*)::text from public.communications where subject like 'B private%'$q$, '0');
select t.eq('conn: status RPC returns this workspace connection', $q$select provider||'/'||status from public.list_connection_status(t.o('orga'))$q$, 'gmail/connected');
select t.err('conn: status RPC refuses another workspace', $q$select * from public.list_connection_status(t.o('orgb'))$q$, '42501');
select t.err('conn: connections table not readable by members', $q$select * from public.provider_connections$q$, '42501');
select t.err('conn: members cannot write communications', $q$insert into public.communications(organization_id, provider, external_id, thread_id, direction, occurred_at) values (t.o('orga'),'gmail','x','x','inbound',now())$q$, '42501');
select t.err('conn: members cannot claim syncs', $q$select * from public.claim_connection_sync(t.o('orga'),'gmail')$q$, '42501');
reset role;
select set_config('request.jwt.claim.sub', '', false);
set role anon;
select t.err('conn: anonymous cannot read communications', $q$select count(*) from public.communications$q$, '42501');
select t.err('conn: anonymous cannot call status RPC', $q$select * from public.list_connection_status('x')$q$, '42501');
reset role;

\echo
\echo ===== CONNECTION RESULTS =====
select case when ok then 'PASS' else 'FAIL' end as result, label, coalesce(detail,'') as detail
  from t.results where label like 'conn:%' order by n;
select count(*) filter (where ok) as passed, count(*) filter (where not ok) as failed
  from t.results where label like 'conn:%';
