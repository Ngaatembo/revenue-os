import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import test from 'node:test'
import { handleWhatsAppWebhook, parseEchoes, parseWebhook, verifySignature } from '../connections/whatsapp.ts'

const SECRET = 'app-secret-for-tests'
const sign = (body: string, secret = SECRET) => 'sha256=' + crypto.createHmac('sha256', secret).update(body).digest('hex')
const payload = (messages: unknown[], phoneNumberId = '109876543210', extra: Record<string, unknown> = {}) => JSON.stringify({
  object: 'whatsapp_business_account', entry: [{ id: 'waba', changes: [{ field: 'messages', value: {
    messaging_product: 'whatsapp', metadata: { display_phone_number: '15550001111', phone_number_id: phoneNumberId },
    contacts: [{ profile: { name: 'Tendai Moyo' }, wa_id: '263771234567' }], messages, ...extra } }] }],
})
const text = (id: string, body: string, ts = 1_790_000_000) => ({ from: '263771234567', id, timestamp: String(ts), type: 'text', text: { body } })

test('signature must match the raw body, including non-ASCII characters', async () => {
  const raw = payload([text('wamid.1', 'Café ☕ price?')])
  assert.equal(await verifySignature(raw, sign(raw), SECRET), true)
  assert.equal(await verifySignature(raw + ' ', sign(raw), SECRET), false, 'any change to the body invalidates it')
  assert.equal(await verifySignature(raw, sign(raw, 'other-secret'), SECRET), false)
  assert.equal(await verifySignature(raw, null, SECRET), false)
  assert.equal(await verifySignature(raw, 'sha256=nothex', SECRET), false)
  assert.equal(await verifySignature(raw, sign(raw).replace('sha256=', 'md5='), SECRET), false)
})

test('inbound text and media messages are normalised; statuses and malformed items are ignored', () => {
  const parsed = parseWebhook(JSON.parse(payload([
    text('wamid.1', 'x'.repeat(500)), { from: '263771234567', id: 'wamid.2', timestamp: '1790000100', type: 'image', image: { id: 'm' } },
    { from: 'not-a-number', id: 'wamid.3', timestamp: '1790000200', type: 'text', text: { body: 'bad sender' } }, { from: '263771234567', timestamp: '1', type: 'text' },
  ])))
  assert.equal(parsed.length, 1); assert.equal(parsed[0]!.phoneNumberId, '109876543210'); assert.equal(parsed[0]!.rows.length, 2)
  const [t, image] = parsed[0]!.rows
  assert.equal(t!.snippet!.length, 200); assert.equal(t!.counterpart_name, 'Tendai Moyo'); assert.equal(t!.thread_id, '263771234567'); assert.equal(t!.direction, 'inbound')
  assert.equal(image!.snippet, null); assert.equal(image!.subject, '[image]')
  assert.deepEqual(parseWebhook({ object: 'whatsapp_business_account', entry: [{ changes: [{ field: 'messages', value: { metadata: { phone_number_id: '109876543210' }, statuses: [{ id: 'x', status: 'read' }] } }] }] }), [])
  assert.deepEqual(parseWebhook({ object: 'page', entry: [] }), []); assert.deepEqual(parseWebhook(null), [])
})

function withFetch(handler: (url: string, init?: RequestInit) => Response) {
  const calls: Array<{ url: string; body?: string; headers?: Record<string, string> }> = []
  const real = globalThis.fetch
  globalThis.fetch = (async (input: string | URL, init?: RequestInit) => { calls.push({ url: String(input), body: init?.body as string | undefined, headers: init?.headers as Record<string, string> | undefined }); return handler(String(input), init) }) as typeof fetch
  return { calls, restore: () => { globalThis.fetch = real } }
}
const env = { WHATSAPP_APP_SECRET: SECRET, WHATSAPP_VERIFY_TOKEN: 'verify-me', SUPABASE_URL: 'https://db.test', SUPABASE_SERVICE_ROLE_KEY: 'svc' }
const post = (body: string, headers: Record<string, string> = {}) => new Request('https://app.test/api/webhooks/whatsapp', { method: 'POST', body, headers })

test('the endpoint does not exist unless it is configured', async () => {
  assert.equal((await handleWhatsAppWebhook(post('{}'), {})).status, 404)
  assert.equal((await handleWhatsAppWebhook(post('{}'), { WHATSAPP_APP_SECRET: 'x' })).status, 404)
})
test('subscription handshake echoes the challenge only for the right token', async () => {
  const ok = await handleWhatsAppWebhook(new Request('https://app.test/api/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=verify-me&hub.challenge=12345'), env)
  assert.equal(ok.status, 200); assert.equal(await ok.text(), '12345')
  assert.equal((await handleWhatsAppWebhook(new Request('https://app.test/api/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=nope&hub.challenge=1'), env)).status, 403)
})
test('unsigned or wrongly signed deliveries are rejected before anything is read from or written to the database', async () => {
  const f = withFetch(() => new Response('[]'))
  try {
    const raw = payload([text('wamid.1', 'hello')])
    assert.equal((await handleWhatsAppWebhook(post(raw), env)).status, 401)
    assert.equal((await handleWhatsAppWebhook(post(raw, { 'x-hub-signature-256': sign(raw, 'wrong') }), env)).status, 401)
    assert.equal(f.calls.length, 0)
  } finally { f.restore() }
})
test('a signed delivery for a registered number is stored idempotently; an unregistered number is acknowledged and dropped', async () => {
  const f = withFetch((url) => url.includes('whatsapp_numbers') ? new Response(JSON.stringify(url.includes('109876543210') ? [{ organization_id: 'org-1' }] : [])) : new Response('', { status: 201 }))
  try {
    const raw = payload([text('wamid.1', 'Do you deliver?')]); const r = await handleWhatsAppWebhook(post(raw, { 'x-hub-signature-256': sign(raw) }), env)
    assert.equal(r.status, 200); assert.deepEqual(await r.json(), { received: 1, ignored_unknown_number: 0 })
    const write = f.calls.find((c) => c.url.includes('communications'))!
    assert.match(write.url, /on_conflict=organization_id,provider,external_id/); assert.equal(JSON.parse(write.body!)[0].organization_id, 'org-1')
    const other = payload([text('wamid.9', 'hi')], '999999999999'); f.calls.length = 0
    const r2 = await handleWhatsAppWebhook(post(other, { 'x-hub-signature-256': sign(other) }), env)
    assert.deepEqual(await r2.json(), { received: 0, ignored_unknown_number: 1 }); assert.equal(f.calls.filter((c) => c.url.includes('communications')).length, 0)
  } finally { f.restore() }
})
test('a storage failure returns 500 so Meta retries (storage is idempotent)', async () => {
  const f = withFetch((url) => url.includes('whatsapp_numbers') ? new Response(JSON.stringify([{ organization_id: 'org-1' }])) : new Response('{}', { status: 500 }))
  try { const raw = payload([text('wamid.1', 'x')]); assert.equal((await handleWhatsAppWebhook(post(raw, { 'x-hub-signature-256': sign(raw) }), env)).status, 500) } finally { f.restore() }
})

test('COMPATIBILITY with the initial release: while WhatsApp is not configured the handler never touches the database, so the deferred migration is not needed', async () => {
  const f = withFetch(() => { throw new Error('the database must not be contacted') })
  try {
    for (const method of ['GET', 'POST']) assert.equal((await handleWhatsAppWebhook(new Request('https://app.test/api/webhooks/whatsapp', { method, body: method === 'POST' ? '{}' : undefined }), { SUPABASE_URL: 'https://db.test', SUPABASE_SERVICE_ROLE_KEY: 'svc' })).status, 404)
    assert.equal(f.calls.length, 0)
  } finally { f.restore() }
})

const echoPayload = (echoes: unknown[], phoneNumberId = '109876543210') => JSON.stringify({
  object: 'whatsapp_business_account', entry: [{ id: 'waba', changes: [{ field: 'smb_message_echoes', value: {
    messaging_product: 'whatsapp', metadata: { display_phone_number: '15550001111', phone_number_id: phoneNumberId }, message_echoes: echoes } }] }],
})
const echo = (id: string, body: string, to = '263771234567', ts = 1_790_000_100) => ({ from: '15550001111', to, id, timestamp: String(ts), type: 'text', text: { body } })

test('messages the owner sent from the Business app become outbound rows addressed to the customer; malformed echoes are skipped', () => {
  const parsed = parseEchoes(JSON.parse(echoPayload([echo('wamid.OUT1', 'Yes, we deliver on Friday'), { id: 'x', to: 'not-a-number', timestamp: '1', type: 'text' }, echo('', 'no id')])))
  assert.equal(parsed.length, 1); assert.equal(parsed[0]!.rows.length, 1)
  const row = parsed[0]!.rows[0]!
  assert.equal(row.direction, 'outbound'); assert.equal(row.thread_id, '263771234567'); assert.equal(row.counterpart_address, '263771234567'); assert.equal(row.external_id, 'wamid.OUT1')
  assert.deepEqual(parseWebhook(JSON.parse(echoPayload([echo('wamid.OUT1', 'hi')]))), [], 'echoes are never mistaken for inbound messages')
  assert.deepEqual(parseEchoes(JSON.parse(payload([text('wamid.1', 'hi')]))), [], 'inbound messages are never mistaken for echoes')
})
test('an echo is stored once as an outbound row in the registered workspace only', async () => {
  const f = withFetch((url) => url.includes('whatsapp_numbers') ? new Response(JSON.stringify(url.includes('109876543210') ? [{ organization_id: 'org-1' }] : [])) : new Response('', { status: 201 }))
  try {
    const raw = echoPayload([echo('wamid.OUT1', 'On its way')]); const r = await handleWhatsAppWebhook(post(raw, { 'x-hub-signature-256': sign(raw) }), env)
    assert.equal(r.status, 200); assert.deepEqual(await r.json(), { received: 1, ignored_unknown_number: 0 })
    const write = f.calls.find((c) => c.url.includes('communications'))!
    const rows = JSON.parse(write.body!); assert.equal(rows.length, 1); assert.equal(rows[0].direction, 'outbound'); assert.equal(rows[0].organization_id, 'org-1')
    assert.match(String(write.headers?.Prefer), /ignore-duplicates/)
  } finally { f.restore() }
})
test('one delivery naming two numbers writes each batch only to its own workspace and never mixes them', async () => {
  const owners: Record<string, string> = { '111111111111': 'org-A', '222222222222': 'org-B' }
  const f = withFetch((url) => { if (url.includes('whatsapp_numbers')) { const id = /phone_number_id=eq\.(\d+)/.exec(url)![1]!; return new Response(JSON.stringify(owners[id] ? [{ organization_id: owners[id] }] : [])) } return new Response('', { status: 201 }) })
  try {
    const mixed = JSON.stringify({ object: 'whatsapp_business_account', entry: [
      { id: 'w1', changes: [{ field: 'messages', value: { metadata: { display_phone_number: '1', phone_number_id: '111111111111' }, messages: [text('wamid.A1', 'for A')] } }] },
      { id: 'w2', changes: [{ field: 'messages', value: { metadata: { display_phone_number: '2', phone_number_id: '222222222222' }, messages: [text('wamid.B1', 'for B')] } }] },
      { id: 'w3', changes: [{ field: 'messages', value: { metadata: { display_phone_number: '3', phone_number_id: '333333333333' }, messages: [text('wamid.X1', 'nobody')] } }] },
    ] })
    const r = await handleWhatsAppWebhook(post(mixed, { 'x-hub-signature-256': sign(mixed) }), env)
    assert.deepEqual(await r.json(), { received: 2, ignored_unknown_number: 1 })
    const writes = f.calls.filter((c) => c.url.includes('communications')).map((c) => JSON.parse(c.body!) as Array<{ organization_id: string; external_id: string }>)
    assert.equal(writes.length, 2)
    for (const batch of writes) for (const row of batch) assert.equal(row.organization_id, row.external_id.startsWith('wamid.A') ? 'org-A' : 'org-B')
    assert.equal(writes.flat().some((row) => row.external_id === 'wamid.X1'), false, 'a number nobody registered writes nothing')
  } finally { f.restore() }
})
test('a verify token of the wrong length or value is refused', async () => {
  for (const token of ['', 'verify', 'verify-me!', 'VERIFY-ME']) assert.equal((await handleWhatsAppWebhook(new Request(`https://app.test/api/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=${token}&hub.challenge=1`), env)).status, 403, token)
})
test('nothing sensitive reaches the logs: no message text, signature, secret or token on success, rejection or failure', async () => {
  const lines: string[] = []; const originals = { log: console.log, info: console.info, warn: console.warn, error: console.error, debug: console.debug }
  for (const key of Object.keys(originals) as Array<keyof typeof originals>) console[key] = (...args: unknown[]) => { lines.push(args.map(String).join(' ')) }
  const f = withFetch((url) => url.includes('whatsapp_numbers') ? new Response(JSON.stringify([{ organization_id: 'org-1' }])) : new Response('{}', { status: 500 }))
  try {
    const raw = payload([text('wamid.S1', 'my secret order SENSITIVE-BODY')])
    await handleWhatsAppWebhook(post(raw, { 'x-hub-signature-256': sign(raw) }), env) // storage failure path
    await handleWhatsAppWebhook(post(raw, { 'x-hub-signature-256': sign(raw, 'bad') }), env) // forged
    await handleWhatsAppWebhook(post('not json', { 'x-hub-signature-256': sign('not json') }), env)
  } finally { f.restore(); Object.assign(console, originals) }
  const joined = lines.join('\n')
  for (const secret of ['SENSITIVE-BODY', SECRET, 'verify-me', 'svc', sign('x').slice(7, 20), '263771234567']) assert.equal(joined.includes(secret), false, 'leaked: ' + secret.slice(0, 6))
})
