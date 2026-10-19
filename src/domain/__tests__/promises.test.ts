import assert from 'node:assert/strict'
import test from 'node:test'
import { money } from '../money.ts'
import { assessPromise, paymentsByInvoice, type PaymentRecord } from '../promises.ts'

const promise = { invoiceId: 'inv-1', promised: money(50_000, 'USD'), promisedDate: '2026-10-25', recordedAt: '2026-10-19T08:00:00.000Z' }
const pay = (amount: number, receivedAt: string, invoiceId = 'inv-1', currency = 'USD'): PaymentRecord => ({ invoiceId, amount: money(amount, currency), receivedAt })

test('a promise with no payment evidence is only a promise: awaiting before the date, broken after it', () => {
  assert.equal(assessPromise({ ...promise, payments: [], asOf: '2026-10-20T00:00:00.000Z' }).status, 'awaiting')
  const broken = assessPromise({ ...promise, payments: [], asOf: '2026-10-26T00:00:00.000Z' })
  assert.equal(broken.status, 'broken')
  assert.equal(broken.received.amount, 0)
  assert.match(broken.label, /not backed by payment evidence/)
})

test('only payment evidence on the same invoice, same currency and after the promise counts', () => {
  const result = assessPromise({
    ...promise, asOf: '2026-10-26T00:00:00.000Z',
    payments: [
      pay(50_000, '2026-10-10T00:00:00.000Z'),            // before the promise was recorded
      pay(50_000, '2026-10-24T00:00:00.000Z', 'inv-2'),    // different invoice
      pay(50_000, '2026-10-24T00:00:00.000Z', 'inv-1', 'EUR'), // different currency
    ],
  })
  assert.equal(result.status, 'broken')
  assert.equal(result.received.amount, 0)
})

test('matching payment evidence keeps the promise; less than promised is partly kept', () => {
  assert.equal(assessPromise({ ...promise, asOf: '2026-10-26T00:00:00.000Z', payments: [pay(50_000, '2026-10-24T00:00:00.000Z')] }).status, 'kept')
  const partly = assessPromise({ ...promise, asOf: '2026-10-26T00:00:00.000Z', payments: [pay(20_000, '2026-10-24T00:00:00.000Z')] })
  assert.equal(partly.status, 'partly_kept')
  assert.equal(partly.received.amount, 20_000)
  assert.match(partly.label, /promised date has passed/)
  const split = assessPromise({ ...promise, asOf: '2026-10-26T00:00:00.000Z', payments: [pay(20_000, '2026-10-22T00:00:00.000Z'), pay(30_000, '2026-10-24T00:00:00.000Z')] })
  assert.equal(split.status, 'kept')
})

test('an invalid recorded time is an error, never silently ignored', () => {
  assert.throws(() => assessPromise({ ...promise, recordedAt: 'nope', payments: [], asOf: '2026-10-26T00:00:00.000Z' }), /valid recorded time/)
})

test('payment totals are grouped per invoice and per currency, never mixed', () => {
  const totals = paymentsByInvoice([pay(100, '2026-10-01T00:00:00.000Z'), pay(250, '2026-10-02T00:00:00.000Z'), pay(900, '2026-10-02T00:00:00.000Z', 'inv-1', 'EUR'), pay(5, '2026-10-02T00:00:00.000Z', 'inv-2')])
  assert.deepEqual(totals.get('inv-1')?.map((m) => `${m.currency}:${m.amount}`).sort(), ['EUR:900', 'USD:350'])
  assert.deepEqual(totals.get('inv-2')?.map((m) => `${m.currency}:${m.amount}`), ['USD:5'])
})
