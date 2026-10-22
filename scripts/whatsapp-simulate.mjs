#!/usr/bin/env node
// SIMULATED Meta deliveries for the WhatsApp receiver. This is NOT evidence that Meta can reach us: it only proves our endpoint behaves
// correctly for correctly and incorrectly signed requests. It signs with your app secret, so run it against a TEST workspace only.
//
//   WHATSAPP_APP_SECRET=... WHATSAPP_VERIFY_TOKEN=... PHONE_NUMBER_ID=... node scripts/whatsapp-simulate.mjs https://your-worker.example
//
// Values come from the environment and are never printed. Only HTTP status codes are shown.
import crypto from 'node:crypto'

const base = (process.argv[2] ?? '').replace(/\/$/, '')
const { WHATSAPP_APP_SECRET: secret, WHATSAPP_VERIFY_TOKEN: verifyToken, PHONE_NUMBER_ID: phoneNumberId } = process.env
if (!/^https?:\/\//.test(base) || !secret || !verifyToken || !/^[0-9]{5,32}$/.test(phoneNumberId ?? '')) {
  console.error('Usage: WHATSAPP_APP_SECRET=… WHATSAPP_VERIFY_TOKEN=… PHONE_NUMBER_ID=… node scripts/whatsapp-simulate.mjs <base-url>')
  process.exit(2)
}
const url = `${base}/api/webhooks/whatsapp`
const sign = (body, key = secret) => 'sha256=' + crypto.createHmac('sha256', key).update(body).digest('hex')
const stamp = Math.floor(Date.now() / 1000)
const messageId = `wamid.SIMULATED.${stamp}`
const body = JSON.stringify({ object: 'whatsapp_business_account', entry: [{ id: 'simulated-waba', changes: [{ field: 'messages', value: {
  messaging_product: 'whatsapp', metadata: { display_phone_number: '15550000000', phone_number_id: phoneNumberId },
  contacts: [{ profile: { name: 'Simulated customer' }, wa_id: '15550009999' }],
  messages: [{ from: '15550009999', id: messageId, timestamp: String(stamp), type: 'text', text: { body: 'SIMULATED test message from whatsapp-simulate.mjs' } }] } }] }] })
const post = async (b, signature) => (await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', ...(signature ? { 'x-hub-signature-256': signature } : {}) }, body: b })).status

const results = []
const check = (name, actual, expected) => { results.push({ name, ok: actual === expected, actual, expected }); console.log(`${actual === expected ? 'PASS' : 'FAIL'} ${name} (HTTP ${actual}, expected ${expected})`) }
check('handshake with the right token', (await fetch(`${url}?hub.mode=subscribe&hub.verify_token=${encodeURIComponent(verifyToken)}&hub.challenge=4242`)).status, 200)
check('handshake with a wrong token is refused', (await fetch(`${url}?hub.mode=subscribe&hub.verify_token=wrong&hub.challenge=1`)).status, 403)
check('unsigned delivery is rejected', await post(body), 401)
check('delivery signed with the wrong secret is rejected', await post(body, sign(body, secret + 'x')), 401)
check('correctly signed delivery is accepted', await post(body, sign(body)), 200)
check('the same delivery replayed (Meta retry) is acknowledged', await post(body, sign(body)), 200)
const failed = results.filter((r) => !r.ok).length
console.log(`\n${results.length - failed} passed, ${failed} failed.`)
console.log(`Now confirm in the database that exactly ONE row exists with external_id = ${messageId} (it must be a test workspace).`)
process.exit(failed ? 1 : 0)
