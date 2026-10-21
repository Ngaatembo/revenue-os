// Drives the real screens against a real local database. See e2e/README.md for what is real and what is a stand-in.
import { execFileSync, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createDatabase, query, sessionFor, startPostgrest } from './stack.mjs'
import { startServer } from './server.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const DB = 'ros_e2e'
const API_PORT = 3101
const APP_PORT = 4180
const BASE = `http://127.0.0.1:${APP_PORT}`
const A = { id: '11111111-1111-4111-8111-111111111111', email: 'owner-a@example.test' }
const B = { id: '22222222-2222-4222-8222-222222222222', email: 'owner-b@example.test' }
const day = (n) => new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10)

const results = []
let page
async function step(name, fn) {
  try { await fn(); results.push({ name, ok: true }); console.log('PASS', name) }
  catch (error) {
    results.push({ name, ok: false, error: String(error.message ?? error).split('\n')[0] }); console.log('FAIL', name, '-', String(error.message ?? error).split('\n')[0])
    try { await page.screenshot({ path: path.join(os.tmpdir(), `e2e-fail-${results.length}.png`), fullPage: true }) } catch { /* ignore */ }
  }
}
const assert = (condition, message) => { if (!condition) throw new Error(message) }
const sql = (text) => query(DB, text)

let postgrest, server, browser
try {
  const { chromium } = await import('playwright').catch(() => import('/opt/npm-tools/node_modules/playwright/index.mjs'))
  createDatabase(root, DB)
  sql(`insert into auth.users(id, email) values ('${A.id}','${A.email}'), ('${B.id}','${B.email}')`)
  postgrest = startPostgrest({ bin: process.env.POSTGREST_BIN ?? '/tmp/pgrst/postgrest', db: DB, port: API_PORT })
  const dist = path.join(os.tmpdir(), 'ros-e2e-dist')
  execFileSync('npx', ['vite', 'build', '--outDir', dist, '--emptyOutDir', '--logLevel', 'error'], { cwd: root, stdio: 'inherit', env: { ...process.env, VITE_SUPABASE_URL: BASE, VITE_SUPABASE_ANON_KEY: 'e2e-anon-key' } })
  server = await startServer({ dist, port: APP_PORT, upstream: `http://127.0.0.1:${API_PORT}` })
  for (let i = 0; i < 50; i += 1) { try { if ((await fetch(`http://127.0.0.1:${API_PORT}/`)).ok) break } catch { /* wait */ } await new Promise((r) => setTimeout(r, 200)) }

  browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {})
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } })
  page = await context.newPage()
  page.on('response', async (response) => { if (response.status() >= 400 && response.url().includes('/rest/v1/')) console.log('HTTP', response.status(), response.request().method(), response.url().replace(BASE, ''), (await response.text().catch(() => '')).slice(0, 160)) })
  page.on('dialog', (dialog) => void dialog.accept())
  const session = sessionFor(A.id, A.email)
  await context.addInitScript((value) => { try { localStorage.setItem('revenue-os.auth-session', JSON.stringify(value)) } catch { /* ignore */ } }, session)
  const nav = async (name) => { await page.locator('nav').getByRole('button', { name: new RegExp('^' + name + '( \\d+)?$') }).first().click() }
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ros-e2e-'))
  const write = (name, text) => { const file = path.join(tmp, name); fs.writeFileSync(file, text); return file }

  await step('signed-in owner gets a workspace', async () => {
    await page.goto(BASE)
    // A brand-new owner with nothing connected lands on Connections (covered in depth by e2e/connections.mjs).
    await page.getByRole('heading', { name: 'Connect your business once' }).waitFor({ timeout: 20000 })
    assert(sql(`select count(*) from public.organizations`) === '1', 'workspace not created')
  })
  const orgA = () => sql(`select id from public.organizations order by created_at limit 1`)

  await step('set recovery-rate assumption and import invoices', async () => {
    await nav('Opportunities')
    const csv = 'customer_id,customer_name,invoice_number,currency,total_amount,paid_amount,issued_at,due_at\n'
      + `c1,Acme Ltd,INV-100,USD,1000.00,0,${day(-80)},${day(-50)}\n`
      + `c2,Birch Co,INV-200,USD,500.00,0,${day(-70)},${day(-40)}\n`
      + `c3,Cedar Ltd,INV-300,USD,250.00,0,${day(-60)},${day(-30)}\n`
    await page.locator('input[type=file]').first().setInputFiles(write('invoices.csv', csv))
    await page.getByRole('button', { name: /Confirm and save 3 records/ }).waitFor({ timeout: 15000 })
    await page.getByRole('button', { name: /Confirm and save 3 records/ }).click()
    await page.getByText(/3 invoice records? saved to Supabase/).first().waitFor({ timeout: 20000 })
    assert(sql(`select count(*) from public.invoices`) === '3', 'invoices not saved')
  })
  await step('recovery rate set so overdue invoices become opportunities', async () => {
    const input = page.locator('#recovery-rate')
    await input.waitFor({ timeout: 15000 })
    await input.fill('25')
    await page.getByRole('button', { name: 'Save rate' }).click()
    await page.getByText(/Recovery-rate assumption saved/).first().waitFor({ timeout: 15000 })
    await page.getByText('INV-100').first().waitFor({ timeout: 20000 })
    assert(Number(sql(`select count(*) from public.opportunities`)) >= 3, 'opportunities not detected')
  })

  await step('payment file: matched payment kept, unmatched queued not lost', async () => {
    await nav('Outcomes')
    const csv = 'invoice_number,payment_reference,currency,amount,received_at\n'
      + `INV-100,P-1,USD,400.00,${day(-1)}\n`
      + `INV-999,P-2,USD,250.00,${day(-1)}\n`
    await page.locator('input[type=file]').last().setInputFiles(write('payments.csv', csv))
    await page.getByText(/1 payment\(s\) matched/).first().waitFor({ timeout: 20000 })
    assert(sql(`select count(*) from public.payment_evidence`) === '1', 'matched payment not saved')
    assert(sql(`select count(*) from public.payment_review_items where status='pending'`) === '1', 'unmatched payment not queued')
    assert(sql(`select coalesce(sum(paid_minor),0) from public.invoices`) === '0', 'payment import must not change invoice balances')
  })
  await step('re-importing the same payment file adds nothing', async () => {
    const file = path.join(tmp, 'payments.csv')
    await page.locator('input[type=file]').last().setInputFiles(file)
    await page.getByText(/already imported/).first().waitFor({ timeout: 20000 })
    assert(sql(`select count(*) from public.payment_evidence`) === '1' && sql(`select count(*) from public.payment_review_items`) === '1', 'duplicate rows created')
  })

  await step('Urgent queue shows the waiting payment with its explanation', async () => {
    await nav('Urgent')
    await page.getByText(/not in your records/).first().waitFor({ timeout: 20000 })
    await page.getByText(/Why it matters/).first().waitFor()
  })
  await step('owner places the queued payment on an invoice', async () => {
    await nav('Follow-ups')
    await page.getByRole('tab', { name: /Payments to review/ }).click()
    await page.getByRole('button', { name: 'Put on an invoice' }).click()
    await page.getByLabel('Which invoice').selectOption({ label: await page.getByLabel('Which invoice').locator('option', { hasText: 'INV-200' }).textContent() })
    await page.getByRole('button', { name: 'Save decision' }).click()
    await page.getByText(/No payments are waiting|resolved/).first().waitFor({ timeout: 15000 })
    assert(sql(`select invoice_id from public.payment_evidence where external_record_id='P-2'`) !== '', 'P-2 not recorded as evidence')
    assert(sql(`select count(*) from public.payment_evidence`) === '2', 'expected two evidence rows')
  })

  await step('add an old quotation: it is flagged as unanswered in Urgent', async () => {
    await nav('Follow-ups')
    await page.getByRole('tab', { name: /Quotations/ }).click()
    const form = page.getByRole('form', { name: 'Add a quotation' })
    await form.getByLabel('Customer').fill('Delta Works')
    await form.getByLabel('Quotation reference').fill('Q-2001')
    await form.getByLabel('Amount').fill('3000')
    await form.getByLabel('Sent on').fill(day(-20))
    await form.getByLabel('Follow up on').fill(day(0))
    await form.getByRole('button', { name: 'Save quotation' }).click()
    await page.getByText('Delta Works · Q-2001').first().waitFor({ timeout: 15000 })
    await nav('Urgent')
    await page.getByText(/No recorded contact on this quotation for 20 days/).first().waitFor({ timeout: 15000 })
  })
  await step('recording a follow-up from the Urgent card clears it and is logged', async () => {
    const card = page.locator('article.attention-card', { hasText: 'Delta Works' }).first()
    await card.getByRole('button', { name: 'Record what happened' }).click()
    await card.getByLabel('Details').fill('Called, decision due Friday')
    await card.getByLabel('Follow up on').fill(day(4))
    await card.getByRole('button', { name: 'Save', exact: true }).click()
    await page.locator('article.attention-card', { hasText: 'Delta Works' }).waitFor({ state: 'detached', timeout: 15000 })
    assert(sql(`select follow_up_date::text from public.quotations where reference='Q-2001'`) === day(4), 'follow-up date not moved')
    assert(sql(`select last_contact_on::text from public.quotations where reference='Q-2001'`) === day(0), 'last contact not recorded')
    assert(sql(`select count(*) from public.quotation_events where event_type='follow_up_sent'`) === '1', 'event missing')
  })
  await step('accepted quotation + promised deposit: due deposit is flagged; owner confirmation is NOT verified', async () => {
    await nav('Follow-ups')
    await page.getByRole('tab', { name: /Quotations/ }).click()
    const row = page.getByTestId(/quotation-/).first()
    await row.getByRole('button', { name: 'Record what happened' }).click()
    await row.getByLabel('What happened').selectOption('accepted')
    await row.getByLabel('Details').fill('Accepted by email')
    await row.getByRole('button', { name: 'Save', exact: true }).click()
    await page.waitForFunction(() => document.body.innerText.includes('accepted'))
    await page.getByRole('tab', { name: /Deposits/ }).click()
    const form = page.getByRole('form', { name: 'Record a promised deposit' })
    await form.getByLabel('For quotation (optional)').selectOption({ index: 1 })
    await form.getByLabel(/Amount promised/).fill('900')
    await form.getByLabel('Promised for').fill(day(0))
    await form.getByRole('button', { name: 'Save deposit' }).click()
    await page.getByText('Promised, not received').first().waitFor({ timeout: 15000 })
    await nav('Urgent')
    await page.getByText(/promised deposit is due today/).first().waitFor({ timeout: 15000 })
    const card = page.locator('article.attention-card', { hasText: /promised deposit is due/ }).first()
    await card.getByRole('button', { name: 'Update this deposit' }).click()
    await card.getByLabel('What changed').selectOption('confirm_received')
    await card.getByLabel('Note', { exact: true }).fill('Cash handed over')
    await card.getByRole('button', { name: 'Save', exact: true }).click()
    await page.locator('article.attention-card', { hasText: /promised deposit is due/ }).waitFor({ state: 'detached', timeout: 15000 })
    assert(sql(`select status from public.deposits`) === 'received_unverified', 'deposit should be unverified')
    assert(sql(`select count(*) from public.payment_evidence`) === '2' && sql(`select count(*) from public.deposit_payments`) === '0', 'owner say-so must not create payment evidence')
  })

  await step('unowned overdue task is flagged, then assigned, then completed', async () => {
    await nav('Follow-ups')
    await page.getByRole('tab', { name: /Tasks/ }).click()
    const form = page.getByRole('form', { name: 'Add a task' })
    await form.getByLabel('What needs doing').fill('Send revised terms to Birch')
    await form.getByLabel('Due').fill(day(1))
    await form.getByRole('button', { name: 'Save task' }).click()
    await page.getByText('Send revised terms to Birch').first().waitFor({ timeout: 15000 })
    await nav('Urgent')
    const card = page.locator('article.attention-card', { hasText: 'Send revised terms' }).first()
    await card.waitFor({ timeout: 15000 })
    await card.getByText('Evidence and ranking').click()
    await card.getByText(/no owner assigned/).waitFor({ timeout: 5000 })
    await card.getByLabel(/Owner of task/).selectOption({ index: 1 })
    await page.waitForFunction(() => !document.body.innerText.includes('no owner assigned'), null, { timeout: 15000 })
    assert(sql(`select owner_id from public.tasks`) === A.id, 'owner not saved')
    await page.locator('article.attention-card', { hasText: 'Send revised terms' }).first().getByRole('button', { name: 'Done' }).click()
    await page.locator('article.attention-card', { hasText: 'Send revised terms' }).getByLabel('What was done').fill('Sent by email')
    await page.locator('article.attention-card', { hasText: 'Send revised terms' }).getByRole('button', { name: 'Save', exact: true }).click()
    await page.locator('article.attention-card', { hasText: 'Send revised terms' }).waitFor({ state: 'detached', timeout: 15000 })
    assert(sql(`select status from public.tasks`) === 'done', 'task not completed')
  })

  await step('Overview lists each overdue invoice once, with one primary action and a menu', async () => {
    await nav('Overview')
    const band = page.getByTestId('needs-you')
    await band.getByText('Acme Ltd').first().waitFor({ timeout: 15000 })
    assert((await page.getByText('Acme Ltd').count()) === 1, 'an invoice customer appears once on Overview')
    assert((await page.getByRole('heading', { name: 'Priority opportunities' }).count()) === 0, 'the duplicate invoice list is gone from Overview')
    assert((await band.getByRole('button', { name: 'Draft reminder' }).count()) >= 1, 'each invoice row has a primary Draft reminder button')
    await band.getByRole('button', { name: /More actions for Acme Ltd/ }).click()
    await page.getByRole('menuitem', { name: 'Snooze 7 days' }).waitFor({ timeout: 5000 })
    assert((await page.getByRole('menuitem').count()) === 2, 'the menu holds snooze and record/dismiss')
    await page.keyboard.press('Escape')
    assert((await page.getByRole('menuitem').count()) === 0, 'Escape closes the menu')
    assert((await page.getByTestId('money-summary').getByText('Verified revenue', { exact: true }).count()) === 1, 'verified revenue is shown as its own line')
    if (process.env.E2E_SHOTS) {
      const wait = (ms) => new Promise((r) => setTimeout(r, ms)); const shot = (name) => page.screenshot({ path: path.join(process.env.E2E_SHOTS, name), fullPage: true })
      fs.mkdirSync(process.env.E2E_SHOTS, { recursive: true })
      await shot('wf-overview.png')
      await page.emulateMedia({ colorScheme: 'dark' }); await wait(500); await shot('wf-overview-dark.png'); await page.emulateMedia({ colorScheme: 'light' })
      await page.setViewportSize({ width: 390, height: 844 }); await wait(500); await shot('wf-overview-mobile.png')
      await page.setViewportSize({ width: 1280, height: 900 })
    }
  })

  await step('reminder lifecycle: draft, unowned flag, assign, approve, sent, payment evidence, verified outcome', async () => {
    await nav('Opportunities')
    await page.getByRole('button', { name: /Draft reminder/ }).first().click()
    await nav('Actions')
    await page.getByText(/Draft, needs your review/).first().waitFor({ timeout: 15000 })
    await nav('Urgent')
    await page.getByText(/nobody responsible for reviewing it/i).first().waitFor({ timeout: 15000 })
    await nav('Actions')
    await page.getByLabel(/Owner of the reminder/).first().selectOption({ index: 1 })
    await page.waitForTimeout(800)
    assert(sql(`select owner_id from public.action_owners`) === A.id, 'action owner not saved')
    await nav('Urgent')
    assert((await page.getByText(/nobody responsible for reviewing it/i).count()) === 0, 'owned action must not be flagged')
    await nav('Actions')
    await page.getByRole('button', { name: 'Approve draft' }).first().click()
    await page.getByRole('button', { name: "I've sent it manually" }).first().click()
    await page.getByText(/Marked sent by you/).first().waitFor({ timeout: 15000 })
    assert(sql(`select count(*) from public.actions where status='executed'`) === '1', 'action not executed')
  })

  await step('verified outcome counts only payments received AFTER the sent reminder', async () => {
    await nav('Outcomes')
    const csv = 'invoice_number,payment_reference,currency,amount,received_at\n' + `INV-100,P-3,USD,600.00,${day(1)}\n`
    await page.locator('input[type=file]').last().setInputFiles(write('payments2.csv', csv))
    await page.getByText(/1 payment\(s\) matched/).first().waitFor({ timeout: 20000 })
    await page.getByRole('button', { name: /Check payment evidence/ }).first().click()
    await page.waitForFunction(() => /600\.00/.test(document.body.innerText), null, { timeout: 15000 })
    assert(sql(`select amount_minor from public.outcomes`) === '60000', 'outcome should be 600.00 only (the 400.00 payment predates the reminder), got ' + sql(`select amount_minor from public.outcomes`))
    assert(sql(`select count(*) from public.outcomes where amount_minor = 100000`) === '0', 'earlier payment must not be credited to the reminder')
    assert(sql(`select count(*) from public.outcomes`) === '1', 'one outcome expected')
    assert(sql(`select coalesce(sum(paid_minor),0) from public.invoices`) === '0', 'invoice balances must stay untouched')
  })

  await step('tenant isolation: another workspace cannot read or write A data', async () => {
    const orgId = orgA()
    const jwt = sessionFor(B.id, B.email).access_token
    const out = await page.evaluate(async ({ jwt, orgId }) => {
      const h = { apikey: 'x', Authorization: `Bearer ${jwt}`, 'Content-Type': 'application/json' }
      const get = async (table) => (await (await fetch(`/rest/v1/${table}?organization_id=eq.${orgId}&select=id`, { headers: h })).json()).length
      const boot = await fetch('/rest/v1/rpc/bootstrap_revenue_os_organization', { method: 'POST', headers: h, body: JSON.stringify({ org_name: 'B org' }) })
      const write = await fetch('/rest/v1/rpc/create_task', { method: 'POST', headers: h, body: JSON.stringify({ p_org_id: orgId, p_id: 'x1', p_title: 'intrusion', p_detail: null, p_due_date: '2099-01-01' }) })
      const resolve = await fetch('/rest/v1/rpc/rematch_payment_review', { method: 'POST', headers: h, body: JSON.stringify({ p_org_id: orgId }) })
      const members = await fetch('/rest/v1/rpc/list_workspace_members', { method: 'POST', headers: h, body: JSON.stringify({ p_org_id: orgId }) })
      return { counts: [await get('quotations'), await get('deposits'), await get('tasks'), await get('payment_review_items'), await get('invoices'), await get('payment_evidence')], boot: boot.status, write: write.status, resolve: resolve.status, members: members.status }
    }, { jwt, orgId })
    assert(out.boot === 200, 'B should get its own workspace: ' + out.boot)
    assert(out.counts.every((n) => n === 0), 'B can read A rows: ' + out.counts)
    assert([out.write, out.resolve, out.members].every((s) => s >= 400), 'B could write/read A via RPC: ' + JSON.stringify(out))
    assert(sql(`select count(*) from public.tasks where title='intrusion'`) === '0', 'intrusion row exists')
  })

  await step('lead recovery: stalled lead is flagged, interaction recorded, next follow-up rescheduled and logged', async () => {
    await nav('Lead Recovery')
    const form = page.locator('form.lead-form')
    await form.getByLabel('Contact name').fill('Tendai M.')
    await form.getByLabel('Business name').fill('Zeta Guest House')
    await form.getByLabel('Potential value').fill('300')
    await form.getByLabel('Next follow-up date').fill(day(-10))
    await form.getByRole('button', { name: 'Add lead' }).click()
    await page.getByText('Zeta Guest House').first().waitFor({ timeout: 15000 })
    assert(sql(`select count(*) from public.sales_leads where business_name='Zeta Guest House'`) === '1', 'lead not saved')
    await page.getByText(/Stalled \d+d/).first().waitFor({ timeout: 10000 })
    await page.getByRole('button', { name: 'Recover lead' }).first().click()
    await page.getByLabel('What happened').selectOption('interested')
    await page.getByLabel('Interaction notes').fill('Spoke to owner, wants a revised quote')
    await page.getByLabel('Next follow-up date').last().fill(day(3))
    await page.getByRole('button', { name: 'Save interaction' }).click()
    await page.getByText(/Stalled \d+d/).first().waitFor({ state: 'detached', timeout: 15000 })
    assert(sql(`select count(*) from public.lead_activities where summary like 'Spoke to owner%'`) === '1', 'interaction not logged')
    assert(sql(`select next_follow_up from public.sales_leads where business_name='Zeta Guest House'`) === day(3), 'follow-up not rescheduled')
  })

  await step('phone width: no horizontal scroll on Follow-ups or Urgent', async () => {
    await page.setViewportSize({ width: 375, height: 800 })
    for (const name of ['Follow-ups', 'Urgent']) {
      await page.locator('nav').getByRole('button', { name: new RegExp('^' + name) }).last().click()
      await page.waitForTimeout(300)
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)
      assert(overflow <= 1, `${name} overflows by ${overflow}px`)
    }
  })

  await step('daily check run is logged and distinguishes background work from messages', async () => {
    const out = sql(`select public.run_scheduled_evaluation()::text`)
    assert(out !== '', 'no result from scheduled run')
    const last = sql(`select status from public.evaluation_runs where organization_id='${orgA()}' order by started_at desc limit 1`)
    assert(last === 'ok', 'scheduled evaluation status ' + last)
    assert(sql(`select count(*) from public.evaluation_runs where organization_id='${orgA()}' and status='skipped'`) === '0', 'workspace A should not be skipped')
    assert(sql(`select count(*) from public.evaluation_runs where status='skipped' and message like 'No recovery-rate%'`) === '1', 'workspace B (no assumption) should be logged as skipped, not silently ignored')
    assert(sql(`select count(*) from public.actions where status='executed'`) === '1', 'run must not execute external actions')
  })
} catch (error) {
  console.error('E2E SETUP ERROR', error)
  results.push({ name: 'setup', ok: false, error: String(error.message ?? error) })
} finally {
  await browser?.close()
  server?.close()
  postgrest?.kill()
}
const failed = results.filter((r) => !r.ok)
console.log(`\n${results.length - failed.length} passed, ${failed.length} failed`)
process.exit(failed.length ? 1 : 0)
