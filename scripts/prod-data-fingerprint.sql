-- READ-ONLY. Run in the Supabase SQL editor (or through the migration tool's read-only query) before and after the release.
-- One row per public table: row count and a checksum of every row. Business tables must be IDENTICAL before and after the
-- migrations (they only add objects). Tables the release legitimately touches are excluded from the checksum comparison:
-- provider_connections / provider_oauth_states (new columns, transient rows) and evaluation_runs (the daily check keeps running).
select c.relname as table_name,
       (xpath('/row/n/text()', query_to_xml(format('select count(*) as n from public.%I', c.relname), false, true, '')))[1]::text::bigint as row_count,
       (xpath('/row/h/text()', query_to_xml(format('select md5(coalesce(string_agg(x::text, %L order by x::text), %L)) as h from public.%I x', '', '', c.relname), false, true, '')))[1]::text as checksum
  from pg_class c join pg_namespace n on n.oid = c.relnamespace
 where n.nspname = 'public' and c.relkind = 'r'
   and c.relname not in ('provider_connections', 'provider_oauth_states', 'evaluation_runs')
 order by c.relname;
