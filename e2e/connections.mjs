// Full journey: sign-in -> welcome -> Connections -> authorize Gmail -> synchronize -> Overview, then automatic
// re-sync, rate limits, revoked access, disconnect and workspace isolation.
//
// REAL here: the React app, the Worker code (OAuth, sync, scheduled handler), every SQL migration, RLS, PostgREST, Chromium.
// SIMULATED here: Google (e2e/fakeGoogle.mjs) and Supabase Auth, and Cloudflare's cron (the test calls the Worker's
// scheduled() handler). Nothing in this file proves that Google, Gmail's verification process or Cloudflare cron accept
// the app; see docs/connections-stage.md for what is and is not verified.
import crypto from 'node:crypto'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createDatabase, query, SECRET, sessionFor, startPostgrest } from './stack.mjs'
import { startServer } from './server.mjs'
import { createFakeGoogle, GOOGLE_HOSTS, OWNER, SHEET_HEADER, sheetRow } from './fakeGoogle.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const DB = 'ros_e2e_conn', API_PORT = 3102, APP_PORT = 4181, BASE = `http://127.0.0.1:${APP_PORT}`
const A = { id: '11111111-1111-4111-8111-111111111111', email: 'owner-a@example.test' }
const B = { id: '22222222-2222-4222-8222-222222222222', email: 'owner-b@example.test' }
const b64 = (v) => Buffer.from(JSON.stringify(v)).toString('base64url')
const mint = (claims) => { const head = b64({ alg: 'HS256', typ: 'JWT' }); const body = b64({ ...claims, iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 36000 }); return `${head}.${body}.${crypto.createHmac('sha256', SECRET).update(`${head}.${body}`).digest('base64url')}` }
const SERVICE_KEY = mint({ role: 'service_role', aud: 'authenticated' })
// RELEASE_SCOPE=initial replays only what the first production release contains: migrations 20261021150000 and 20261021160000.
// The WhatsApp migration (20261021170000) is deferred, so its table must not exist and the webhook must stay disabled.
const INITIAL_SCOPE = process.env.RELEASE_SCOPE === 'initial'
if (INITIAL_SCOPE) process.env.E2E_EXCLUDE_MIGRATIONS = '20261021170000'
const results = []
let page
const step = async (name, fn) => { try { await fn(); results.push({ name, ok: true }); console.log('PASS', name) } catch (e) { results.push({ name, ok: false }); console.log('FAIL', name, '-', String(e.message ?? e).split('\n')[0]); try { await page.screenshot({ path: path.join(os.tmpdir(), `conn-fail-${results.length}.png`), fullPage: true }) } catch { /* ignore */ } } }
const assert = (c, m) => { if (!c) throw new Error(m) }
const sql = (t) => query(DB, t)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const google = createFakeGoogle()
const realFetch = globalThis.fetch
globalThis.fetch = async (input, init) => {
  const request = new Request(input, init)
  return GOOGLE_HOSTS.has(new URL(request.url).host) ? google.handle(request) : realFetch(input, init)
}
const env = {
  GOOGLE_CLIENT_ID: 'fake-client', GOOGLE_CLIENT_SECRET: 'fake-secret', GOOGLE_TOKEN_ENCRYPTION_KEY: crypto.randomBytes(32).toString('hex'),
  APP_ORIGIN: BASE, SUPABASE_URL: BASE, SUPABASE_ANON_KEY: 'e2e-anon-key', SUPABASE_SERVICE_ROLE_KEY: SERVICE_KEY, SYNC_MESSAGE_BUDGET: '100', ...(INITIAL_SCOPE ? {} : { WHATSAPP_APP_SECRET: 'wa-app-secret-e2e', WHATSAPP_VERIFY_TOKEN: 'wa-verify-e2e' }),
  ASSETS: { fetch: async () => new Response('asset', { status: 404 }) },
}
const worker = (await import('../src/worker/index.ts')).default
async function api(req, res) {
  const chunks = []; for await (const c of req) chunks.push(c)
  const body = chunks.length ? Buffer.concat(chunks) : undefined
  const request = new Request(`${BASE}${req.url}`, { method: req.method, headers: req.headers, body: ['GET', 'HEAD'].includes(req.method) ? undefined : body })
  const out = await worker.fetch(request, env, { waitUntil: (p) => pendingWork.push(p) })
  res.writeHead(out.status, Object.fromEntries(out.headers)); res.end(Buffer.from(await out.arrayBuffer()))
}
const authUser = (header) => { try { const p = JSON.parse(Buffer.from(String(header).replace(/^Bearer /, '').split('.')[1], 'base64url').toString()); return p.sub ? { id: p.sub, email: p.email } : null } catch { return null } }
/** What Cloudflare's cron does once a minute. */
const pendingWork = []
const settle = async () => { while (pendingWork.length) await pendingWork.shift() }
const tick = async () => { await settle(); const pending = []; await worker.scheduled({}, env, { waitUntil: (p) => pending.push(p) }); await Promise.all(pending) }
const connOf = (provider) => (field) => sql(`select ${field} from public.provider_connections where provider='${provider}' limit 1`)
const conn = connOf('gmail')
const sheetsConn = connOf('google_sheets')
const dueNow = (provider) => sql(`update public.provider_connections set next_sync_at = now() - interval '1 second' where provider='${provider}'`)

let postgrest, server, browser
try {
  const { chromium } = await import('playwright').catch(() => import('/opt/npm-tools/node_modules/playwright/index.mjs'))
  createDatabase(root, DB)
  sql(`insert into auth.users(id, email) values ('${A.id}','${A.email}'), ('${B.id}','${B.email}')`)
  postgrest = startPostgrest({ bin: process.env.POSTGREST_BIN ?? '/tmp/pgrst/postgrest', db: DB, port: API_PORT })
  const dist = path.join(os.tmpdir(), 'ros-e2e-conn-dist')
  execFileSync('npx', ['vite', 'build', '--outDir', dist, '--emptyOutDir', '--logLevel', 'error'], { cwd: root, stdio: 'inherit', env: { ...process.env, VITE_SUPABASE_URL: BASE, VITE_SUPABASE_ANON_KEY: 'e2e-anon-key' } })
  server = await startServer({ dist, port: APP_PORT, upstream: `http://127.0.0.1:${API_PORT}`, api, authUser })
  for (let i = 0; i < 50; i += 1) { try { if ((await realFetch(`http://127.0.0.1:${API_PORT}/`)).ok) break } catch { /* wait */ } await sleep(200) }

  browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {})
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } })
  page = await context.newPage()
  page.on('dialog', (d) => void d.accept())
  await context.addInitScript((v) => { try { if (!localStorage.getItem('revenue-os.auth-session')) localStorage.setItem('revenue-os.auth-session', JSON.stringify(v)) } catch { /* ignore */ } }, sessionFor(A.id, A.email))
  // Google's consent page is replaced by an immediate approval that redirects to our real callback with the real state.
  await page.route('https://accounts.google.com/**', async (route) => {
    const u = new URL(route.request().url())
    if (!google.state.forceScope) google.state.scopeGranted = u.searchParams.get('scope')
    const target = new URL(u.searchParams.get('redirect_uri')); target.searchParams.set('code', 'fake-code'); target.searchParams.set('state', u.searchParams.get('state'))
    await route.fulfill({ status: 302, headers: { location: target.toString() } })
  })

  await step('before signing in, the welcome explains the product with the approved logo, then offers sign-in or sign-up', async () => {
    const anon = await browser.newContext({ viewport: { width: 1280, height: 900 } })
    const p0 = await anon.newPage()
    await p0.goto(BASE)
    const welcome = p0.getByTestId('auth-welcome')
    await welcome.waitFor({ timeout: 20000 })
    await welcome.getByRole('heading', { name: /Know who owes you, and who is waiting on you/ }).waitFor()
    for (const text of ['Connect once', 'It keeps itself up to date', 'See what needs you']) await welcome.getByText(text).waitFor()
    await welcome.getByText(/WhatsApp Business needs Meta approval and is not available yet/).waitFor()
    const logo = welcome.getByRole('img', { name: /Revenue OS/ })
    assert((await logo.getAttribute('src')) === '/revenue-os-logo.png', 'the supplied logo is used')
    assert((await logo.evaluate((img) => img.naturalWidth)) > 300, 'the logo image actually loaded')
    await p0.getByRole('tab', { name: 'Sign in' }).waitFor(); await p0.getByRole('tab', { name: 'Create account' }).waitFor()
    await p0.getByRole('button', { name: 'Continue with Google' }).waitFor()
    if (process.env.E2E_SHOTS) {
      fs.mkdirSync(process.env.E2E_SHOTS, { recursive: true })
      await p0.screenshot({ path: path.join(process.env.E2E_SHOTS, 'welcome-light.png'), fullPage: true })
      await p0.emulateMedia({ colorScheme: 'dark' }); await sleep(500); await p0.screenshot({ path: path.join(process.env.E2E_SHOTS, 'welcome-dark.png'), fullPage: true })
      await p0.emulateMedia({ colorScheme: 'light' }); await p0.setViewportSize({ width: 390, height: 844 }); await sleep(500); await p0.screenshot({ path: path.join(process.env.E2E_SHOTS, 'welcome-mobile.png'), fullPage: true })
    }
    await anon.close()
  })
  await step('after signing in, a new owner is taken straight to Connections with honest setup steps and no pop-up', async () => {
    await page.goto(BASE)
    await page.getByRole('heading', { name: 'Connect your business once' }).waitFor({ timeout: 20000 })
    assert((await page.getByRole('dialog').count()) === 0, 'no welcome dialog after sign-in')
    const steps = page.getByTestId('setup-steps')
    await steps.waitFor()
    assert((await steps.locator('li.active').innerText()).startsWith('1') || (await steps.locator('li.active strong').innerText()) === 'Connect', 'step 1 (Connect) is the active step')
    assert((await steps.getByRole('button', { name: 'Open your Overview' }).count()) === 0, 'the Overview step stays locked until a synchronization completes')
    // CSV is a fallback below the primary sources, not a connection card.
    assert((await page.locator('.connection-source-grid [data-provider=csv]').count()) === 0, 'CSV is not in the connection grid')
    await page.locator('.fallback-import[data-provider=csv]').getByText(/manual fallback/).waitFor()
    await page.locator('.fallback-import').getByRole('button', { name: 'Upload an invoice file' }).waitFor()
    // Approved brand: blue action, light sidebar, navy ink, supplied mark in the navigation.
    const look = await page.evaluate(() => {
      const css = (el, prop) => getComputedStyle(el)[prop]
      const primary = document.querySelector('.button-primary'); const sidebar = document.querySelector('.sidebar'); const mark = document.querySelector('.brand-symbol')
      return { primary: css(primary, 'backgroundColor'), sidebar: css(sidebar, 'backgroundColor'), mark: mark.getAttribute('src'), markLoaded: mark.naturalWidth > 0, theme: document.querySelector('meta[name=theme-color]').content }
    })
    assert(look.primary === 'rgb(0, 100, 234)', 'primary buttons are the brand blue, got ' + look.primary)
    const [r, g, b] = look.sidebar.match(/\d+/g).map(Number)
    assert(r > 235 && g > 235 && b > 235, 'sidebar is light, not the green drift: ' + look.sidebar)
    assert(look.mark === '/revenue-os-mark.png' && look.markLoaded && look.theme === '#0064ea', 'supplied mark and brand theme colour')
    assert((await page.locator('.owner-next-step').count()) === 0, 'no START HERE card')
    if (process.env.E2E_SHOTS) { fs.mkdirSync(process.env.E2E_SHOTS, { recursive: true }); await page.screenshot({ path: path.join(process.env.E2E_SHOTS, 'connections-setup.png'), fullPage: true })
      await page.emulateMedia({ colorScheme: 'dark' }); await sleep(500); await page.screenshot({ path: path.join(process.env.E2E_SHOTS, 'connections-dark.png'), fullPage: true }); await page.emulateMedia({ colorScheme: 'light' })
      await page.setViewportSize({ width: 390, height: 844 }); await sleep(500); await page.screenshot({ path: path.join(process.env.E2E_SHOTS, 'connections-mobile.png'), fullPage: true }); await page.setViewportSize({ width: 1280, height: 900 }) }
  })
  await step('Connections lists what each source reads; WhatsApp is honest about approval; nothing is shown connected', async () => {
    const gmail = page.locator('[data-provider=gmail]')
    assert((await gmail.getAttribute('data-state')) === 'not_connected', 'gmail should start not connected')
    await gmail.locator('summary', { hasText: 'What it reads' }).click()
    await gmail.getByText(/Sender, recipient, subject, date/).waitFor()
    const wa = page.locator('[data-provider=whatsapp_business]')
    assert((await wa.getAttribute('data-state')) === 'unavailable', 'whatsapp state')
    await wa.getByText(/does not read an ordinary personal WhatsApp/).waitFor()
    assert(await wa.getByRole('button', { name: 'Not available yet' }).isDisabled(), 'whatsapp must not be connectable')
    assert((await page.locator('.connection-pill-ready').count()) === 0, 'no source may be shown connected')
  })
  await step('relaunching mid-setup resumes on Connections, not Overview', async () => {
    await page.reload()
    await page.getByRole('heading', { name: 'Connect your business once' }).waitFor({ timeout: 20000 })
    assert((await page.getByRole('dialog').count()) === 0, 'welcome must not repeat')
  })

  await step('authorizing Gmail returns to the app, stores an encrypted token against the workspace and starts syncing', async () => {
    await page.locator('[data-provider=gmail]').getByRole('button', { name: 'Connect Gmail' }).click()
    await page.waitForURL(/connection=gmail|^[^?]*$/, { timeout: 20000 }).catch(() => undefined)
    await page.locator('[data-provider=gmail] .sync-stage').waitFor({ timeout: 20000 })
    assert(google.state.tokenGrants === 1, 'authorization code was not exchanged')
    assert(conn('status') !== 'pending' && conn('provider_account_email') === OWNER, 'connection not stored')
    const token = conn('encrypted_refresh_token')
    assert(token.length > 20 && !token.includes('rt-secret-value'), 'refresh token must be stored encrypted')
    assert(conn('organization_id') === sql(`select id from public.organizations where name like 'My Revenue OS%' limit 1`), 'connection belongs to the owner workspace')
  })
  await step('the first chunk is visible as an honest indeterminate stage with a real stored count', async () => {
    await settle() // the sync runs after the HTTP response, so closing the tab could not cancel it
    const card = page.locator('[data-provider=gmail]')
    await card.getByText(/Fetching available information|Processing and organizing records/).waitFor({ timeout: 15000 })
    assert((await card.getByRole('progressbar').count()) === 1, 'indeterminate progress indicator expected')
    const shown = await card.innerText()
    assert(!/\d+\s?%/.test(shown), 'no invented percentage')
    assert(sql(`select count(*) from public.communications`) === '100', 'first chunk should have stored exactly the 100-message budget, got ' + sql(`select count(*) from public.communications`))
    assert(shown.includes('100 records stored so far'), 'UI should show the real stored count')
  })
  await step('leaving the page does not stop the sync; when the first synchronization completes the owner is offered the Overview', async () => {
    await page.getByRole('button', { name: /^Overview$/ }).first().click().catch(() => undefined)
    await sleep(500)
    await page.getByRole('button', { name: /^Connections$/ }).first().click()
    await page.getByTestId('setup-steps').waitFor()
    for (let i = 0; i < 6 && conn('initial_sync_completed_at') === ''; i += 1) await tick()
    assert(conn('initial_sync_completed_at') !== '', 'initial sync did not complete')
    assert(conn('status') === 'connected' && conn('sync_stage') === 'complete' && conn('last_error_code') === '', 'connection should be cleanly connected')
    assert(sql(`select count(*) from public.communications`) === '207', 'expected all 207 messages exactly once, got ' + sql(`select count(*) from public.communications`))
    assert(sql(`select count(*) from (select external_id from public.communications group by 1 having count(*)>1) d`) === '0', 'duplicates found')
    // The open page notices the completed background sync and unlocks step 3 without a reload.
    const open = page.getByTestId('setup-steps').getByRole('button', { name: 'Open your Overview' })
    await open.waitFor({ timeout: 30000 })
    await open.click()
    await page.getByTestId('conversations-panel').waitFor({ timeout: 20000 })
    if (process.env.E2E_SHOTS) await page.screenshot({ path: path.join(process.env.E2E_SHOTS, 'overview.png'), fullPage: true })
  })
  await step('stored records are metadata with source references; newsletters are marked automated', async () => {
    assert(sql(`select count(*) from public.communications where is_automated`) === '200', 'newsletters should be flagged automated')
    assert(sql(`select count(*) from public.communications where thread_id='wait-1' and external_id is not null and source_account='${OWNER}'`) === '1', 'source reference missing')
    assert(sql(`select count(*) from information_schema.columns where table_name='communications' and column_name in ('body','html','raw','content')`) === '0', 'no message body column may exist')
  })
  await step('Overview shows real conversations from the synced mailbox, labelled observed / inferred', async () => {
    await page.goto(BASE)
    await page.getByTestId('conversations-panel').waitFor({ timeout: 20000 })
    const panel = page.getByTestId('conversations-panel')
    await panel.getByText('Quote request: 20 bags of cement').waitFor({ timeout: 15000 })
    await panel.getByText('Delivery to Bulawayo?').waitFor()
    await panel.getByText('Pricing for 5 tonnes').waitFor()
    assert((await panel.locator('[data-kind=awaiting_reply]').count()) === 2, 'two customers are waiting')
    assert((await panel.locator('[data-kind=gone_quiet]').count()) === 1, 'one conversation went quiet')
    assert((await panel.getByText('Invoice 114').count()) === 0 && (await panel.getByText('Question this morning').count()) === 0, 'replied and too-recent threads must not be flagged')
    assert((await panel.getByText('Weekly deals').count()) === 0, 'newsletters must not be flagged')
    assert((await panel.locator('.tag-observed').count()) >= 3 && (await panel.locator('.tag-inferred').count()) >= 3, 'observed and inferred are labelled separately')
    const href = await panel.locator('a', { hasText: 'Open the original email' }).first().getAttribute('href')
    assert(/^https:\/\/mail\.google\.com\/mail\/\?authuser=.*#all\/.+/.test(href), 'each item links to its source email: ' + href)
    await panel.getByText(/5 customer conversations in the last 90 days \(200 automated/).waitFor()
  })
  await step('a returning owner whose source has synced goes straight to Overview', async () => {
    await page.reload()
    await page.getByRole('heading', { name: 'Customer conversations' }).waitFor({ timeout: 20000 })
    assert((await page.getByRole('dialog').count()) === 0, 'no onboarding for a finished setup')
  })

  await step('automatic sync: a new customer email appears with no user action', async () => {
    const before = sql(`select count(*) from public.communications`)
    google.state.deliver({ thread: 'new-1', from: 'Nyasha <nyasha@buyer.test>', subject: 'Urgent: need 3 pallets', snippet: 'We need 3 pallets by Friday', at: Date.now() - 3 * 86_400_000 })
    sql(`update public.provider_connections set next_sync_at = now() - interval '1 minute' where provider='gmail'`)
    await tick()
    assert(Number(sql(`select count(*) from public.communications`)) === Number(before) + 1, 'new message should be stored exactly once')
    await tick()
    assert(Number(sql(`select count(*) from public.communications`)) === Number(before) + 1, 'a repeat run must not duplicate')
    await page.reload()
    await page.getByTestId('conversations-panel').getByText('Urgent: need 3 pallets').waitFor({ timeout: 20000 })
    const band = page.getByTestId('needs-you')
    await band.getByText('is waiting for your reply').first().waitFor({ timeout: 20000 })
    assert((await band.getByText('Inferred').count()) > 0, 'a conversation in the needs-you band is labelled Inferred, not presented as fact')
    assert((await page.locator('[data-group=awaiting_reply]').count()) === 1, 'conversations are grouped under "Waiting for your reply"')
    await band.getByText('is waiting for your reply').first().click()
  })
  await step('rate limit: sync pauses with a checkpoint, then resumes without losing or duplicating data', async () => {
    google.state.deliver({ thread: 'new-2', from: 'Tapiwa <tapiwa@buyer.test>', subject: 'Second new enquiry', at: Date.now() - 3 * 86_400_000 })
    google.state.rateLimitedGets = 1
    sql(`update public.provider_connections set next_sync_at = now() - interval '1 minute' where provider='gmail'`)
    const count = sql(`select count(*) from public.communications`)
    await tick()
    assert(conn('sync_stage') === 'waiting_rate_limit' && conn('last_error_code') === 'provider_rate_limited', 'rate-limit state expected')
    assert(conn('consecutive_failures') === '0', 'a rate limit is not a failure')
    assert(new Date(conn('next_sync_at')).getTime() > Date.now() + 60_000, 'must wait at least the provider-requested time')
    assert(sql(`select count(*) from public.communications`) === count, 'nothing stored yet')
    sql(`update public.provider_connections set next_sync_at = now() - interval '1 second' where provider='gmail'`)
    await tick()
    assert(Number(sql(`select count(*) from public.communications`)) === Number(count) + 1 && conn('last_error_code') === '' && conn('sync_stage') === 'complete', 'resumed and completed')
  })
  await step('transient provider failure backs off, flags attention after repeated failures, and recovers', async () => {
    const real = google.handle
    let failing = true
    google.handle = async (r) => (failing && new URL(r.url).host === 'gmail.googleapis.com' ? new Response('{}', { status: 500 }) : real(r))
    for (let i = 0; i < 3; i += 1) { sql(`update public.provider_connections set next_sync_at = now() - interval '1 second' where provider='gmail'`); await tick() }
    assert(conn('status') === 'needs_attention' && conn('consecutive_failures') === '3', 'three failures => needs attention, got ' + conn('status'))
    await page.reload(); await page.getByRole('button', { name: /^Connections$/ }).first().click()
    await page.locator('[data-provider=gmail] [role=alert]').waitFor({ timeout: 15000 })
    failing = false; google.handle = real
    sql(`update public.provider_connections set next_sync_at = now() - interval '1 second' where provider='gmail'`)
    await tick()
    assert(conn('status') === 'connected' && conn('consecutive_failures') === '0' && conn('last_error_code') === '', 'recovered')
  })
  await step('revoked access: the credential is dropped, the owner is asked to reconnect, imported data is kept', async () => {
    const kept = sql(`select count(*) from public.communications`)
    google.state.revoked = true
    sql(`update public.provider_connections set next_sync_at = now() - interval '1 second' where provider='gmail'`)
    await tick()
    assert(conn('status') === 'error' && conn('last_error_code') === 'authorization_revoked' && conn('encrypted_refresh_token') === '', 'revocation handling')
    assert(sql(`select count(*) from public.communications`) === kept, 'records kept')
    await page.reload(); await page.getByRole('button', { name: /^Connections$/ }).first().click()
    await page.locator('[data-provider=gmail]').getByText('Reconnect needed').waitFor({ timeout: 15000 })
    await tick() // the scheduler must not retry a connection that has no credential
    assert(conn('status') === 'error', 'no retry loop on a revoked connection')
  })
  await step('reconnecting after revocation restores syncing and creates no duplicates', async () => {
    google.state.revoked = false
    const kept = sql(`select count(*) from public.communications`)
    await page.locator('[data-provider=gmail]').getByRole('button', { name: 'Reconnect Gmail' }).click()
    for (let i = 0; i < 100 && google.state.tokenGrants < 2; i += 1) await sleep(100)
    assert(google.state.tokenGrants === 2, 'second authorization code was not exchanged')
    await page.getByText(/Synchronization started|Gmail authorization succeeded/).first().waitFor({ timeout: 20000 })
    for (let i = 0; i < 8 && !(conn('status') === 'connected' && conn('sync_stage') === 'complete' && conn('last_error_code') === ''); i += 1) await tick()
    assert(conn('status') === 'connected' && conn('encrypted_refresh_token') !== '', 'reconnected')
    assert(sql(`select count(*) from public.communications`) === kept, 'a full re-read after reauthorization must not duplicate records')
  })

  await step('workspace isolation: another owner sees nothing and cannot sync, read status or read tokens', async () => {
    const bToken = sessionFor(B.id, B.email).access_token
    const orgA = sql(`select organization_id from public.provider_connections where provider='gmail' limit 1`)
    await realFetch(`${BASE}/rest/v1/rpc/bootstrap_revenue_os_organization`, { method: 'POST', headers: { Authorization: `Bearer ${bToken}`, apikey: 'k', 'content-type': 'application/json' }, body: JSON.stringify({ org_name: 'B Org' }) })
    const get = async (p, init = {}) => realFetch(`${BASE}${p}`, { ...init, headers: { Authorization: `Bearer ${bToken}`, apikey: 'k', 'content-type': 'application/json', ...(init.headers ?? {}) } })
    assert((await (await get('/rest/v1/communications?select=id')).json()).length === 0, 'B must not read A communications')
    assert((await (await get('/rest/v1/conversation_threads?select=thread_id')).json()).length === 0, 'B must not read A threads')
    assert((await get('/rest/v1/rpc/list_connection_status', { method: 'POST', body: JSON.stringify({ p_organization_id: orgA }) })).status === 403, 'B must not read A status')
    assert((await get('/rest/v1/provider_connections?select=encrypted_refresh_token')).status >= 400, 'tokens are never readable by clients')
    assert((await get('/api/connections/sync', { method: 'POST', body: JSON.stringify({ organization_id: orgA, provider: 'gmail' }) })).status === 403, 'B must not trigger A sync')
    assert((await get('/api/connections/disconnect', { method: 'POST', body: JSON.stringify({ organization_id: orgA, provider: 'gmail' }) })).status === 403, 'B must not disconnect A')
    assert((await realFetch(`${BASE}/api/connections/sync`, { method: 'POST', body: '{}' })).status === 401, 'unauthenticated requests are refused')
  })
  await step('only owners and admins can connect a source: an operator is refused at the start of the flow', async () => {
    const C = { id: '33333333-3333-4333-8333-333333333333', email: 'operator-c@example.test' }
    const orgA = sql(`select organization_id from public.provider_connections where provider='gmail' limit 1`)
    sql(`insert into auth.users(id,email) values ('${C.id}','${C.email}')`); sql(`insert into public.users(id, auth_subject, email) values ('${C.id}','${C.id}','${C.email}')`)
    sql(`insert into public.memberships(organization_id,user_id,role) values ('${orgA}','${C.id}','operator')`)
    const start = await realFetch(`${BASE}/api/integrations/google/start?organization_id=${encodeURIComponent(orgA)}&provider=gmail`, { headers: { Authorization: `Bearer ${sessionFor(C.id, C.email).access_token}` } })
    assert(start.status === 403, 'operator must not start authorization, got ' + start.status)
    assert(sql(`select count(*) from public.provider_oauth_states where user_id='${C.id}'`) === '0', 'no OAuth state may be created for a refused user')
    const sync = await realFetch(`${BASE}/api/connections/sync`, { method: 'POST', headers: { Authorization: `Bearer ${sessionFor(C.id, C.email).access_token}`, 'content-type': 'application/json' }, body: JSON.stringify({ organization_id: orgA, provider: 'gmail' }) })
    assert(sync.status === 202, 'an operator may ask for an immediate check of an existing connection')
    await settle()
  })
  await step('a new owner with nothing connected lands on Connections and is not shown fake data', async () => {
    const ctx2 = await browser.newContext({ viewport: { width: 1280, height: 900 } })
    const p2 = await ctx2.newPage()
    await ctx2.addInitScript((v) => { try { localStorage.setItem('revenue-os.auth-session', JSON.stringify(v)) } catch { /* ignore */ } }, sessionFor(B.id, B.email))
    await p2.goto(BASE)
    await p2.getByRole('heading', { name: 'Connect your business once' }).waitFor({ timeout: 20000 })
    assert((await p2.getByRole('dialog').count()) === 0, 'no pop-up')
    assert((await p2.locator('[data-provider=gmail]').getAttribute('data-state')) === 'not_connected', 'B sees Gmail as not connected')
    assert((await p2.getByText('Quote request').count()) === 0, "B must not see A's mail")
    await ctx2.close()
  })
  // ---------------- Google Sheets: authorize once, then everything is automatic ----------------
  await step('Sheets: authorize once, choose the invoice tab, and the first import happens without pressing sync', async () => {
    sql(`insert into public.assumptions(organization_id,id,assumption_key,value_bps,updated_by) select organization_id,'recovery-rate','recovery_rate',3000,user_id from public.memberships where role='owner' and organization_id=(select organization_id from public.provider_connections where provider='gmail') limit 1`)
    await page.reload(); await page.getByRole('button', { name: /^Connections$/ }).first().click()
    await page.getByRole('button', { name: 'Connect Google Sheets' }).click()
    await page.getByLabel('Choose a spreadsheet').waitFor({ timeout: 25000 })
    assert(sheetsConn('status') === 'connected' && sheetsConn('encrypted_refresh_token') !== '', 'sheets connection stored')
    assert(sql(`select count(*) from public.invoices`) === '0', 'nothing is imported just because access was granted')
    await page.getByLabel('Choose a spreadsheet').selectOption({ label: 'Invoices 2026 · Updated ' + new Date('2026-10-21T08:00:00.000Z').toLocaleDateString() })
    await page.getByTestId('sheets-auto-status').waitFor()
    for (let i = 0; i < 8 && sql(`select count(*) from public.invoices`) === '0'; i += 1) { await sleep(500); await tick() }
    assert(sql(`select count(*) from public.invoices`) === '3', 'three invoices imported automatically, got ' + sql(`select count(*) from public.invoices`))
    assert(sheetsConn('status') === 'connected' && sheetsConn('last_error_code') === '' && sheetsConn('initial_sync_completed_at') !== '' && sheetsConn('records_synced') === '3', 'sheets connection reports a clean first sync')
  })
  await step('Sheets: an unchanged sheet is not re-imported or re-read on later checks', async () => {
    const reads = google.state.sheet.reads, runs = sql(`select count(*) from public.source_sync_runs`)
    for (let i = 0; i < 3; i += 1) { dueNow('google_sheets'); await tick() }
    assert(google.state.sheet.reads === reads, 'values must not be re-read while the file is unchanged')
    assert(sql(`select count(*) from public.source_sync_runs`) === runs, 'no new sync run rows while nothing changed')
    assert(sql(`select count(*) from public.invoices`) === '3', 'no duplicates')
  })
  await step('Sheets: a changed spreadsheet reaches the database and the Overview with no manual import', async () => {
    await page.getByRole('button', { name: /^Overview$/ }).first().click()
    // The owner edits their spreadsheet: one invoice is fully paid, one new overdue invoice is added.
    google.state.sheet.values = [SHEET_HEADER, sheetRow(1, 1001), sheetRow(2), sheetRow(3), sheetRow(4, 0, -45)]
    google.state.sheet.modifiedTime = '2026-10-21T09:30:00.000Z'
    dueNow('google_sheets'); await tick()
    assert(sql(`select count(*) from public.invoices`) === '4', 'new invoice stored')
    assert(sql(`select paid_minor from public.invoices where invoice_number='SINV-1'`) === '100100', 'payment recorded in the sheet reached the database')
    assert(sql(`select count(*) from public.invoices where invoice_number='SINV-1'`) === '1', 'updated in place, not duplicated')
    assert(Number(sql(`select count(*) from public.opportunities where status='open'`)) >= 3, 'opportunities refreshed by the sync itself')
    // No reload and no click: the open page notices the finished background sync and shows the new invoice.
    await page.getByText(/4 invoice records · saved in Supabase/).first().waitFor({ timeout: 45000 })
    assert((await page.getByText(/3 invoice records · saved in Supabase/).count()) === 0, 'stale count must be gone')
  })
  await step('Sheets: removing a row marks it for review instead of deleting or assuming payment', async () => {
    google.state.sheet.values = [SHEET_HEADER, sheetRow(1, 1001), sheetRow(2), sheetRow(4, 0, -45)]
    google.state.sheet.modifiedTime = '2026-10-21T10:00:00.000Z'
    dueNow('google_sheets'); await tick()
    assert(sql(`select count(*) from public.invoices`) === '4', 'invoice history is kept')
    assert(sql(`select count(*) from public.source_sync_memberships where review_state='missing_from_source_pending_review'`) === '1', 'missing row queued for the owner to review')
  })
  await step('Sheets: a broken sheet is reported with a fix the owner can act on, then recovers when fixed', async () => {
    google.state.sheet.values = [['name', 'amount'], ['a', 1]]; google.state.sheet.modifiedTime = '2026-10-21T10:30:00.000Z'
    dueNow('google_sheets'); await tick()
    assert(sheetsConn('status') === 'needs_attention' && sheetsConn('last_error_code').startsWith('missing_columns:'), 'owner-fixable problem flagged, got ' + sheetsConn('status') + ' ' + sheetsConn('last_error_code'))
    assert(sql(`select count(*) from public.invoices`) === '4', 'previously synced data is kept')
    const reads = google.state.sheet.reads; dueNow('google_sheets'); await tick()
    assert(google.state.sheet.reads === reads, 'the broken version is not re-read every poll')
    await page.reload(); await page.getByRole('button', { name: /^Connections$/ }).first().click()
    await page.getByTestId('sheets-auto-status').getByText(/missing these invoice columns/).waitFor({ timeout: 15000 })
    google.state.sheet.values = [SHEET_HEADER, sheetRow(1, 1001), sheetRow(2), sheetRow(4, 0, -45)]; google.state.sheet.modifiedTime = '2026-10-21T11:00:00.000Z'
    dueNow('google_sheets'); await tick()
    assert(sheetsConn('status') === 'connected' && sheetsConn('last_error_code') === '', 'recovered after the owner fixed the sheet')
  })
  await step('Gmail and Sheets together: both stay connected and sync independently; one failing does not affect the other', async () => {
    await page.locator('[data-provider=gmail] [data-x]').count().catch(() => 0)
    for (let i = 0; i < 3; i += 1) { dueNow('google_sheets'); dueNow('gmail') }
    const real = google.handle
    google.handle = async (r) => (new URL(r.url).host === 'sheets.googleapis.com' || new URL(r.url).pathname.startsWith('/drive/') ? new Response('{}', { status: 500 }) : real(r))
    google.state.deliver({ thread: 'together-1', from: 'Both <both@buyer.test>', subject: 'Both sources running', at: Date.now() - 3 * 86_400_000 })
    dueNow('google_sheets'); dueNow('gmail'); await tick()
    google.handle = real
    assert(sql(`select count(*) from public.communications where thread_id='together-1'`) === '1', 'gmail still synced while sheets was failing')
    assert(sheetsConn('consecutive_failures') === '1' && conn('consecutive_failures') === '0', 'only sheets recorded a failure')
    dueNow('google_sheets'); sql(`update public.provider_connections set next_sync_at = now() - interval '1 second' where provider='google_sheets'`); await tick()
    assert(sheetsConn('status') !== 'disconnected', 'sheets still connected')
    assert(sql(`select count(distinct organization_id) from public.provider_connections where status <> 'disconnected'`) === '1', 'both belong to the same workspace')
  })

  await step('setup check reports configuration without revealing any secret, and shows background sync is running', async () => {
    await page.reload(); await page.getByRole('button', { name: /^Connections$/ }).first().click()
    await page.getByText('Server setup check').click()
    await page.getByRole('button', { name: 'Run setup check' }).click()
    const report = page.getByTestId('setup-check-report')
    await report.waitFor({ timeout: 15000 })
    const text = await report.innerText()
    assert((await report.locator('[data-ok=false]').count()) === 0, 'all checks should pass in this configuration: ' + text)
    assert(text.includes(`${BASE}/api/integrations/google/callback`), 'shows the exact redirect URI to register')
    assert(/Background sync: Running/.test(text), 'background sync observed: ' + text)
    for (const secret of ['fake-secret', env.GOOGLE_TOKEN_ENCRYPTION_KEY, SERVICE_KEY, 'rt-secret-value']) assert(!text.includes(secret), 'a secret value leaked into the report')
  })
  if (INITIAL_SCOPE) await step('initial release scope: without the deferred WhatsApp migration everything else works and WhatsApp stays off', async () => {
    assert(sql(`select to_regclass('public.whatsapp_numbers') is null`) === 't', 'the deferred migration must not be applied in the initial scope')
    assert(sql(`select pg_get_constraintdef(oid) from pg_constraint where conname='communications_provider_check'`).includes("'gmail'") && !sql(`select pg_get_constraintdef(oid) from pg_constraint where conname='communications_provider_check'`).includes('whatsapp'), 'communications accepts gmail only')
    const attempt = await realFetch(`${BASE}/api/webhooks/whatsapp`, { method: 'POST', body: '{}' })
    assert(attempt.status === 404, 'webhook is disabled when its settings are absent, got ' + attempt.status)
  })
  if (!INITIAL_SCOPE) await step('WhatsApp webhook (dormant receiver): signed deliveries are stored once, forged ones are rejected, and the product still marks WhatsApp unavailable', async () => {
    const orgA = sql(`select organization_id from public.provider_connections where provider='gmail' limit 1`)
    sql(`insert into public.whatsapp_numbers(phone_number_id, organization_id, display_phone_number) values ('109876543210', '${orgA}', '15550001111')`)
    const body = JSON.stringify({ object: 'whatsapp_business_account', entry: [{ id: 'waba', changes: [{ field: 'messages', value: { messaging_product: 'whatsapp',
      metadata: { display_phone_number: '15550001111', phone_number_id: '109876543210' }, contacts: [{ profile: { name: 'Kudzai' }, wa_id: '263771112222' }],
      messages: [{ from: '263771112222', id: 'wamid.E2E1', timestamp: String(Math.floor(Date.now() / 1000) - 3 * 86400), type: 'text', text: { body: 'Hello, are you open on Saturday? ☕' } }] } }] }] })
    const sig = 'sha256=' + crypto.createHmac('sha256', 'wa-app-secret-e2e').update(body).digest('hex')
    const send = (b, signature) => realFetch(`${BASE}/api/webhooks/whatsapp`, { method: 'POST', headers: { 'content-type': 'application/json', ...(signature ? { 'x-hub-signature-256': signature } : {}) }, body: b })
    const handshake = await realFetch(`${BASE}/api/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=wa-verify-e2e&hub.challenge=987`)
    assert(handshake.status === 200 && (await handshake.text()) === '987', 'handshake')
    assert((await realFetch(`${BASE}/api/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=wrong&hub.challenge=1`)).status === 403, 'wrong verify token')
    assert((await send(body)).status === 401 && (await send(body, 'sha256=' + 'a'.repeat(64))).status === 401, 'forged deliveries rejected')
    assert(sql(`select count(*) from public.communications where provider='whatsapp'`) === '0', 'nothing stored from forged deliveries')
    assert((await send(body, sig)).status === 200 && (await send(body, sig)).status === 200, 'signed delivery accepted, replay acknowledged')
    assert(sql(`select count(*) from public.communications where provider='whatsapp' and external_id='wamid.E2E1' and organization_id='${orgA}'`) === '1', 'stored exactly once')
    const unknown = body.replace('109876543210', '999999999999'); assert((await send(unknown, 'sha256=' + crypto.createHmac('sha256', 'wa-app-secret-e2e').update(unknown).digest('hex'))).status === 200, 'unknown number acknowledged')
    assert(sql(`select count(*) from public.communications where provider='whatsapp'`) === '1', 'unregistered numbers store nothing')
    await page.reload(); await page.getByTestId('conversations-panel').waitFor({ timeout: 20000 })
    assert((await page.getByTestId('conversations-panel').getByText('Kudzai').count()) === 0, 'WhatsApp threads are not turned into "waiting for reply" guesses: their replies are invisible to the API')
    await page.getByRole('button', { name: /^Connections$/ }).first().click()
    assert((await page.locator('[data-provider=whatsapp_business]').getAttribute('data-state')) === 'unavailable', 'WhatsApp stays unavailable in the product')
    assert(sql(`select count(*) from public.communications where provider='whatsapp' and subject is null and snippet like 'Hello%'`) === '1', 'text preview stored, no body column')
  })
  await step('connecting a different mailbox starts fresh: counters reset and the old mailbox is not shown as the new one', async () => {
    google.state.accountEmail = 'second@shop.test'
    await page.reload(); await page.getByRole('button', { name: /^Connections$/ }).first().click()
    await page.locator('[data-provider=gmail]').getByRole('button', { name: 'Disconnect' }).click() // switching mailbox = disconnect, then connect the other one
    await page.locator('[data-provider=gmail][data-state=not_connected]').waitFor({ timeout: 15000 })
    const grants = google.state.tokenGrants
    await page.locator('[data-provider=gmail]').getByRole('button', { name: 'Connect Gmail' }).click()
    for (let i = 0; i < 100 && google.state.tokenGrants === grants; i += 1) await sleep(100)
    for (let i = 0; i < 100 && conn('provider_account_email') !== 'second@shop.test'; i += 1) await sleep(100)
    assert(conn('provider_account_email') === 'second@shop.test', 'new account stored')
    await settle()
    assert(conn('initial_sync_completed_at') === '' || conn('records_synced') === '0', 'a new mailbox must not inherit the old mailbox completion state')
    await page.getByRole('button', { name: /^Overview$/ }).first().click()
    await page.getByTestId('conversations-panel').waitFor({ timeout: 20000 })
    assert((await page.getByTestId('conversations-panel').getByText('Quote request: 20 bags of cement').count()) === 0, 'threads from the previous mailbox are not shown for the new one')
    google.state.accountEmail = null
  })
  await step('disconnect revokes at the provider, removes the stored credential and keeps imported records', async () => {
    const kept = sql(`select count(*) from public.communications`)
    await page.reload(); await page.getByRole('button', { name: /^Connections$/ }).first().click()
    await page.locator('[data-provider=gmail]').getByRole('button', { name: 'Disconnect' }).click()
    await page.locator('[data-provider=gmail][data-state=not_connected]').waitFor({ timeout: 15000 })
    assert(google.state.revokeCalls === 2, 'each disconnect revoked the token at the provider')
    assert(conn('status') === 'disconnected' && conn('encrypted_refresh_token') === '', 'credential removed')
    assert(sql(`select count(*) from public.communications`) === kept, 'records kept')
    await tick(); assert(conn('status') === 'disconnected', 'scheduler leaves disconnected sources alone')
  })
  await step('declining permission stores nothing as connected', async () => {
    google.state.forceScope = 'openid email'
    await page.locator('[data-provider=gmail]').getByRole('button', { name: 'Connect Gmail' }).click()
    await page.getByText(/authorization did not complete, so nothing was connected/).waitFor({ timeout: 20000 })
    assert(conn('status') === 'disconnected', 'must remain disconnected')
  })
} catch (error) {
  console.error('E2E SETUP ERROR', error)
  results.push({ name: 'setup', ok: false })
} finally {
  await browser?.close(); server?.close(); postgrest?.kill()
}
const failed = results.filter((r) => !r.ok)
console.log(`\n${results.length - failed.length} passed, ${failed.length} failed`)
process.exit(failed.length ? 1 : 0)
