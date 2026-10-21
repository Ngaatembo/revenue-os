-- WhatsApp webhook storage. Synthetic data only.
\set ON_ERROR_STOP off
\set W '00000000-0000-4000-8000-00000000fb01'
insert into auth.users(id, email) values (:'W','wa-owner@example.test');
select set_config('request.jwt.claim.sub', :'W', false) \gset
set role authenticated;
select organization_id as orgw from public.bootstrap_revenue_os_organization('WA Org') \gset
reset role;
select set_config('t.orgw', :'orgw', false) \gset
select set_config('request.jwt.claim.sub', '', false) \gset

set role service_role;
select set_config('request.jwt.claim.role', 'service_role', false);
select t.ok('wa: operator registers a number for a workspace', $q$insert into public.whatsapp_numbers(phone_number_id, organization_id, display_phone_number) values ('109876543210', t.o('orgw'), '15550001111')$q$);
select t.err('wa: a number cannot be registered twice (no cross-tenant claim)', $q$insert into public.whatsapp_numbers(phone_number_id, organization_id) values ('109876543210', t.o('orgw'))$q$, '23505');
select t.err('wa: malformed phone number id rejected', $q$insert into public.whatsapp_numbers(phone_number_id, organization_id) values ('abc', t.o('orgw'))$q$, '23514');
select t.ok('wa: inbound message stored', $q$insert into public.communications(organization_id, provider, external_id, thread_id, direction, counterpart_address, counterpart_name, snippet, occurred_at) values (t.o('orgw'),'whatsapp','wamid.1','263771234567','inbound','263771234567','Tendai','Do you deliver?', now())$q$);
select t.err('wa: the same message id cannot be stored twice', $q$insert into public.communications(organization_id, provider, external_id, thread_id, direction, occurred_at) values (t.o('orgw'),'whatsapp','wamid.1','263771234567','inbound', now())$q$, '23505');
select t.ok('wa: a gmail message may reuse an id from another provider', $q$insert into public.communications(organization_id, provider, external_id, thread_id, direction, occurred_at) values (t.o('orgw'),'gmail','wamid.1','g1','inbound', now())$q$);
select t.err('wa: unknown providers are still rejected', $q$insert into public.communications(organization_id, provider, external_id, thread_id, direction, occurred_at) values (t.o('orgw'),'telegram','x','x','inbound', now())$q$, '23514');
select t.eq('wa: threads keep providers apart', $q$select count(distinct provider)::text from public.conversation_threads where organization_id=t.o('orgw')$q$, '2');
reset role;
select set_config('request.jwt.claim.role', '', false);

select set_config('request.jwt.claim.sub', :'W', false);
set role authenticated;
select t.err('wa: members cannot read the number registry', $q$select * from public.whatsapp_numbers$q$, '42501');
select t.err('wa: members cannot register numbers', $q$insert into public.whatsapp_numbers(phone_number_id, organization_id) values ('555555555555', t.o('orgw'))$q$, '42501');
select t.eq('wa: members can read their own stored messages', $q$select count(*)::text from public.communications where provider='whatsapp'$q$, '1');
reset role;
set role anon;
select t.err('wa: anonymous cannot read the registry', $q$select * from public.whatsapp_numbers$q$, '42501');
reset role;

\echo
\echo ===== WHATSAPP RESULTS =====
select case when ok then 'PASS' else 'FAIL' end as result, label, coalesce(detail,'') as detail from t.results where label like 'wa:%' order by n;
select count(*) filter (where ok) as passed, count(*) filter (where not ok) as failed from t.results where label like 'wa:%';
