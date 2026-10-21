#!/usr/bin/env bash
# Rehearses the Connections release on a DISPOSABLE database: rebuild the schema as production has it today
# (every migration before 20261021), seed a production-like Google Sheets connection, apply the new migrations in one
# transaction each, check old-code compatibility and the new constraints, then roll back and prove the schema is restored.
# Uses PG* variables, refuses hosted hosts, never touches an existing database.
set -euo pipefail
cd "$(dirname "$0")/.."
case "${PGHOST:-}" in *supabase.co*|*supabase.com*) echo "Refusing to run against a hosted Supabase host." >&2; exit 2;; esac
DB="rehearse_$$"
admin() { psql -X -q -v ON_ERROR_STOP=1 -d postgres "$@"; }
run()   { psql -X -q -v ON_ERROR_STOP=1 -d "$DB" "$@"; }
val()   { psql -X -tA -v ON_ERROR_STOP=1 -d "$DB" "$@"; }
trap 'admin -c "drop database if exists $DB with (force)" >/dev/null 2>&1 || true' EXIT
admin -c "create database $DB"
admin -c "do \$\$ begin
  if not exists (select 1 from pg_roles where rolname='anon') then create role anon nologin; end if;
  if not exists (select 1 from pg_roles where rolname='authenticated') then create role authenticated nologin; end if;
  if not exists (select 1 from pg_roles where rolname='service_role') then create role service_role nologin bypassrls; end if; end \$\$"
sed -e '/^create role /d' supabase/tests/00_supabase_stub.sql | run -f - >/dev/null
for f in $(ls supabase/migrations/*.sql | sort); do
  case "$(basename "$f")" in 20261021*) ;; *) run -f "$f" >/dev/null 2>&1 || { echo "pre-release migration failed: $f"; exit 1; };; esac
done
FP=$(mktemp); cat > "$FP" <<'SQL'
select kind||':'||md5(string_agg(md5(def),',' order by md5(def))) from (
select 'col' kind, c.table_schema||'.'||c.table_name||'.'||c.column_name||':'||c.data_type||':'||c.is_nullable||':'||coalesce(c.column_default,'') def from information_schema.columns c where c.table_schema in ('public','private')
union all select 'con', conrelid::regclass::text||'.'||conname||':'||pg_get_constraintdef(oid) from pg_constraint where connamespace in ('public'::regnamespace,'private'::regnamespace)
union all select 'idx', indexdef from pg_indexes where schemaname in ('public','private')
union all select 'pol', schemaname||'.'||tablename||'.'||policyname||':'||cmd||':'||roles::text||':'||coalesce(qual,'')||':'||coalesce(with_check,'') from pg_policies where schemaname in ('public','private')
union all select 'fn', p.oid::regprocedure::text||':'||md5(replace(p.prosrc,E'\r',''))||':'||p.prosecdef||':'||coalesce(p.proconfig::text,'') from pg_proc p where pronamespace in ('public'::regnamespace,'private'::regnamespace) and not exists (select 1 from pg_depend d where d.objid=p.oid and d.deptype='e')
union all select 'fnacl', p.oid::regprocedure::text||':'||has_function_privilege('anon',p.oid,'execute')||has_function_privilege('authenticated',p.oid,'execute')||has_function_privilege('service_role',p.oid,'execute') from pg_proc p where pronamespace in ('public'::regnamespace,'private'::regnamespace) and not exists (select 1 from pg_depend d where d.objid=p.oid and d.deptype='e')
union all select 'tblacl', c.oid::regclass::text||':'||r.rolname||':'||(select string_agg(pr,',' order by pr) from unnest(array['select','insert','update','delete']) pr where has_table_privilege(r.rolname,c.oid,pr)) from pg_class c, pg_roles r where c.relkind in ('r','v') and c.relnamespace='public'::regnamespace and r.rolname in ('anon','authenticated','service_role')
) s group by kind order by kind
SQL
BEFORE=$(val -f "$FP")
echo "== seeding a production-like connection"
run -c "insert into auth.users(id,email) values ('00000000-0000-4000-8000-0000000000aa','seed@example.test')"
run -c "select set_config('request.jwt.claim.sub','00000000-0000-4000-8000-0000000000aa',false)" -c "set role authenticated" -c "select organization_id from public.bootstrap_revenue_os_organization('Rehearsal Org')" >/dev/null
ORG=$(val -c "select id from public.organizations limit 1")
run -c "insert into public.provider_connections(organization_id,provider,status,provider_account_email,encrypted_refresh_token,granted_scopes,last_successful_sync_at,last_error_code) values ('$ORG','google_sheets','connected','seed@example.test','enc-seed','{https://www.googleapis.com/auth/spreadsheets.readonly}',now(),'google_sheet_sync_failed')"
run -c "insert into public.provider_source_selections(organization_id,provider,source_id,source_name,source_config) values ('$ORG','google_sheets','google_sheets:abcdefghij','Seed sheet','{\"spreadsheet_id\":\"abcdefghij\",\"range\":\"Sheet1!A:H\"}')"
run -c "insert into public.provider_oauth_states(state_hash,provider,organization_id,user_id,expires_at) select repeat('a',64),'google_sheets','$ORG',m.user_id,now()+interval '10 minutes' from public.memberships m where m.organization_id='$ORG' limit 1"
echo "== applying 20261021120000, 20261021130000 and 20261021140000 (one transaction each)"
run -1 -f supabase/migrations/20261021120000_connections_sync_and_communications.sql
run -1 -f supabase/migrations/20261021130000_sheets_automatic_sync.sql
run -1 -f supabase/migrations/20261021140000_whatsapp_webhook_receiver.sql
echo "== checks after apply"
check() { local want="$1" got; got=$(val -c "$2"); if [ "$got" = "$want" ]; then echo "PASS $3"; else echo "FAIL $3 (expected '$want', got '$got')"; FAILS=$((FAILS+1)); fi; }
FAILS=0
check "connected|google_sheet_sync_failed|0|0" "select status||'|'||last_error_code||'|'||consecutive_failures||'|'||records_synced from public.provider_connections where provider='google_sheets'" "existing Sheets connection survives untouched (new columns defaulted)"
check "enc-seed" "select encrypted_refresh_token from public.provider_connections where provider='google_sheets'" "existing credential preserved"
check "1" "select count(*) from public.provider_source_selections" "source selection preserved"
check "google_sheets" "select provider from public.consume_provider_oauth_state(repeat('a',64))" "an OAuth flow started before the release can still complete (old-Worker compatible)"
check "t" "select (select count(*) from public.provider_connections)=1 and to_regclass('public.communications') is not null" "new table exists; no connection rows added"
check "0" "select count(*) from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and c.relname in ('communications','provider_connections','provider_oauth_states') and not c.relrowsecurity" "RLS enabled on every touched table"
check "f" "select has_table_privilege('authenticated','public.provider_connections','select') or has_table_privilege('anon','public.provider_connections','select')" "provider_connections still unreadable by clients (tokens)"
check "f" "select has_table_privilege('anon','public.communications','select')" "anonymous cannot read communications"
check "f" "select has_table_privilege('authenticated','public.whatsapp_numbers','select') or has_table_privilege('anon','public.whatsapp_numbers','select')" "WhatsApp number registry is service-role only"
check "falsefalse" "select has_function_privilege('anon','public.claim_connection_sync(text,text,boolean)','execute')::text || has_function_privilege('authenticated','public.claim_connection_sync(text,text,boolean)','execute')::text" "claim_connection_sync not callable by clients"
check "falsefalse" "select has_function_privilege('authenticated','public.persist_invoice_import_system(text,text,text,text,jsonb,integer)','execute')::text || has_function_privilege('authenticated','public.refresh_org_after_sync(text)','execute')::text" "service-side import/refresh not callable by clients"
check "truefalse" "select has_function_privilege('authenticated','public.list_connection_status(text)','execute')::text || has_function_privilege('anon','public.list_connection_status(text)','execute')::text" "status function: members yes, anonymous no"
if run -1 -f supabase/migrations/20261021120000_connections_sync_and_communications.sql >/dev/null 2>&1; then echo "PASS re-applying 20261021120000 is safe (idempotent)"; else echo "FAIL re-applying 20261021120000 errored"; FAILS=$((FAILS+1)); fi
check "connected|enc-seed" "select status||'|'||encrypted_refresh_token from public.provider_connections where provider='google_sheets'" "the re-apply changed no data"
check "provider_connections_consecutive_failures_check,provider_connections_error_len,provider_connections_provider_check,provider_connections_records_synced_check,provider_connections_status_check,provider_connections_sync_cursor_check,provider_connections_sync_stage_check,provider_connections_token_required" "select string_agg(conname, ',' order by conname) from pg_constraint where conrelid='public.provider_connections'::regclass and contype='c'" "re-applying keeps every constraint, including the column-level checks"
echo "== rolling back"
run -1 -f supabase/rollbacks/20261021140000_whatsapp_webhook_receiver.rollback.sql
run -1 -f supabase/rollbacks/20261021130000_sheets_automatic_sync.rollback.sql
run -1 -f supabase/rollbacks/20261021120000_connections_sync_and_communications.rollback.sql
AFTER=$(val -f "$FP")
if [ "$BEFORE" = "$AFTER" ]; then echo "PASS schema fingerprint after rollback equals the pre-release schema (columns, constraints, indexes, policies, functions, grants)"; else echo "FAIL rollback did not restore the schema"; diff <(echo "$BEFORE") <(echo "$AFTER") || true; FAILS=$((FAILS+1)); fi
check "connected|enc-seed" "select status||'|'||encrypted_refresh_token from public.provider_connections where provider='google_sheets'" "Sheets connection still intact after rollback"
if [ "$FAILS" != "0" ]; then echo "REHEARSAL FAILED: $FAILS"; exit 1; fi
echo "REHEARSAL PASSED"
