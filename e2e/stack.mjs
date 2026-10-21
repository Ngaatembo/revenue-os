import { execFileSync, spawn } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

export const SECRET = 'e2e-only-secret-e2e-only-secret-e2e-only'
const b64 = (value) => Buffer.from(typeof value === 'string' ? value : JSON.stringify(value)).toString('base64url')
export function mintJwt(sub, email) {
  const now = Math.floor(Date.now() / 1000)
  const head = b64({ alg: 'HS256', typ: 'JWT' })
  const body = b64({ sub, email, role: 'authenticated', aud: 'authenticated', iat: now, exp: now + 36000 })
  return `${head}.${body}.${crypto.createHmac('sha256', SECRET).update(`${head}.${body}`).digest('base64url')}`
}
export const sessionFor = (sub, email) => ({ access_token: mintJwt(sub, email), refresh_token: 'e2e-not-used', expires_at: Math.floor(Date.now() / 1000) + 36000, user: { id: sub, email } })

const psql = (db, args, input) => execFileSync('psql', ['-X', '-q', '-v', 'ON_ERROR_STOP=1', '-d', db, ...args], { input, encoding: 'utf8', env: process.env })
export const query = (db, sql) => psql(db, ['-tA', '-c', sql]).trim()

/** Creates the throwaway database with every migration applied, using the same Supabase stand-ins as the SQL tests. */
export function createDatabase(root, db) {
  psql('postgres', ['-c', `drop database if exists ${db} with (force)`])
  psql('postgres', ['-c', `create database ${db}`])
  psql('postgres', ['-c', `do $$ begin
    if not exists (select 1 from pg_roles where rolname='anon') then create role anon nologin; end if;
    if not exists (select 1 from pg_roles where rolname='authenticated') then create role authenticated nologin; end if;
    if not exists (select 1 from pg_roles where rolname='service_role') then create role service_role nologin bypassrls; end if; end $$`])
  const stub = fs.readFileSync(path.join(root, 'supabase/tests/00_supabase_stub.sql'), 'utf8').replace(/^create role .*$/m, '')
  psql(db, ['-f', '-'], stub)
  // Supabase's real auth.uid() reads the JWT claims JSON that PostgREST sets.
  psql(db, ['-c', `create or replace function auth.uid() returns uuid language sql stable as $$ select coalesce(nullif(current_setting('request.jwt.claim.sub', true), ''), (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub'))::uuid $$`])
  psql(db, ['-c', `create or replace function auth.role() returns text language sql stable as $$ select coalesce(nullif(current_setting('request.jwt.claim.role', true), ''), (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role'), 'anon') $$`])
  const dir = path.join(root, 'supabase/migrations')
  for (const f of fs.readdirSync(dir).filter((n) => n.endsWith('.sql')).sort()) psql(db, ['-f', path.join(dir, f)])
}

export function startPostgrest({ bin, db, port }) {
  const child = spawn(bin, [], {
    env: { ...process.env, PGRST_DB_URI: `postgres://${process.env.PGUSER}:${process.env.PGPASSWORD}@${process.env.PGHOST ?? 'localhost'}/${db}`, PGRST_DB_SCHEMAS: 'public', PGRST_DB_ANON_ROLE: 'anon', PGRST_JWT_SECRET: SECRET,
      PGRST_SERVER_HOST: '127.0.0.1', PGRST_SERVER_PORT: String(port), PGRST_DB_POOL: '5', PGRST_LOG_LEVEL: 'warn' },
    stdio: ['ignore', 'inherit', 'inherit'],
  })
  return child
}
