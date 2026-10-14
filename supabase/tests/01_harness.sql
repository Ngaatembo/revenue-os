-- Tiny assertion harness. Run as a superuser; test steps switch to `authenticated`.
create schema if not exists t;
drop table if exists t.results;
create table t.results(n serial, label text, ok boolean, detail text);
grant usage on schema t to public; grant all on all tables in schema t to public; grant all on all sequences in schema t to public;

create or replace function t.o(k text) returns text language sql stable as $$ select current_setting('t.'||k) $$;
grant execute on function t.o(text) to public;

-- statement must succeed
create or replace function t.ok(p_label text, p_sql text) returns void language plpgsql as $$
begin
  begin execute p_sql; insert into t.results(label,ok) values (p_label,true);
  exception when others then insert into t.results(label,ok,detail) values (p_label,false,sqlstate||' '||sqlerrm); end;
end $$;
-- statement must fail with the given SQLSTATE (null = any)
create or replace function t.err(p_label text, p_sql text, p_state text default null) returns void language plpgsql as $$
begin
  begin execute p_sql; insert into t.results(label,ok,detail) values (p_label,false,'expected an error but statement succeeded');
  exception when others then
    if p_state is null or sqlstate = p_state then insert into t.results(label,ok,detail) values (p_label,true,sqlstate||' '||left(sqlerrm,80));
    else insert into t.results(label,ok,detail) values (p_label,false,'expected '||p_state||' got '||sqlstate||' '||sqlerrm); end if;
  end;
end $$;
-- scalar query must equal expected text
create or replace function t.eq(p_label text, p_sql text, p_expected text) returns void language plpgsql as $$
declare v text;
begin
  begin execute p_sql into v;
    insert into t.results(label,ok,detail) values (p_label, v is not distinct from p_expected, case when v is not distinct from p_expected then null else 'expected '||coalesce(p_expected,'NULL')||' got '||coalesce(v,'NULL') end);
  exception when others then insert into t.results(label,ok,detail) values (p_label,false,sqlstate||' '||sqlerrm); end;
end $$;
grant execute on all functions in schema t to public;
