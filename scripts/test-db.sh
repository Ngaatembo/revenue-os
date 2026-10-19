#!/usr/bin/env bash
# Replays every migration into a DISPOSABLE Postgres database and runs the SQL journey/security tests.
# Uses the standard PG* environment variables (PGHOST, PGPORT, PGUSER, PGPASSWORD) to reach a server.
# It creates and drops its own database; it never touches an existing one and refuses to run
# if the server looks like a hosted Supabase project.
set -euo pipefail
cd "$(dirname "$0")/.."
case "${PGHOST:-}" in *supabase.co*|*supabase.com*) echo "Refusing to run against a hosted Supabase host." >&2; exit 2;; esac
DB="ros_test_$$"
psql_admin() { psql -X -q -v ON_ERROR_STOP=1 -d postgres "$@"; }
psql_db()    { psql -X -q -d "$DB" "$@"; }
psql_admin -c "create database $DB"
trap 'psql_admin -c "drop database if exists $DB with (force)" >/dev/null 2>&1 || true' EXIT
# Roles are cluster-wide; create them only if missing so reruns work.
psql_admin -c "do \$\$ begin
  if not exists (select 1 from pg_roles where rolname='anon') then create role anon nologin; end if;
  if not exists (select 1 from pg_roles where rolname='authenticated') then create role authenticated nologin; end if;
  if not exists (select 1 from pg_roles where rolname='service_role') then create role service_role nologin bypassrls; end if; end \$\$"
sed -e '/^create role /d' supabase/tests/00_supabase_stub.sql | psql_db -v ON_ERROR_STOP=1 -f -
for f in supabase/migrations/*.sql; do psql_db -v ON_ERROR_STOP=1 -f "$f" >/dev/null; done
psql_db -v ON_ERROR_STOP=1 -f supabase/tests/01_harness.sql
OUT=$(psql_db -f supabase/tests/02_journey.sql 2>&1)
echo "$OUT" | sed -n '/===== RESULTS =====/,$p'
OUT3=$(psql_db -f supabase/tests/03_sync_opportunities.sql 2>&1)
echo "$OUT3" | sed -n '/===== SYNC RESULTS =====/,$p'
OUT4=$(psql_db -f supabase/tests/04_invoice_responses.sql 2>&1)
echo "$OUT4" | sed -n '/===== RESPONSE RESULTS =====/,$p'
OUT5=$(psql_db -f supabase/tests/05_business_brain.sql 2>&1)
echo "$OUT5" | sed -n '/===== BRAIN RESULTS =====/,$p'
OUT6=$(psql_db -f supabase/tests/06_scheduled_evaluation.sql 2>&1)
echo "$OUT6" | sed -n '/===== SCHEDULE RESULTS =====/,$p'
OUT7=$(psql_db -f supabase/tests/07_business_records.sql 2>&1)
echo "$OUT7" | sed -n '/===== RECORDS RESULTS =====/,$p'
FAILED=$(psql_db -tAc "select count(*) from t.results where not ok")
if [ "$FAILED" != "0" ]; then echo "DB TESTS FAILED: $FAILED" >&2; exit 1; fi
echo "DB TESTS PASSED"
