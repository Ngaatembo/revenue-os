import assert from 'node:assert/strict'
import test from 'node:test'
import { transitionAction } from '../actions.ts'
import type { RevenueAction } from '../types.ts'

const proposed: RevenueAction = {
  id: 'action_1',
  opportunityId: 'overdue_invoice:invoice_1',
  kind: 'payment_reminder',
  status: 'proposed',
  proposedAt: '2026-10-14T08:00:00.000Z',
  executionMode: 'manual',
  payload: { recipientCustomerId: 'customer_1', invoiceIds: ['invoice_1'], message: 'Please advise when payment is expected.' },
}

test('recovery actions require approval before manual execution', () => {
  assert.throws(() => transitionAction(proposed, { type: 'execute_manually', actorId: 'user_1', at: '2026-10-14T09:00:00.000Z' }), /must be approved/)
})

test('approved action can be marked manually executed with audit fields', () => {
  const approved = transitionAction(proposed, { type: 'approve', actorId: 'user_1', at: '2026-10-14T08:30:00.000Z' })
  const executed = transitionAction(approved, { type: 'execute_manually', actorId: 'user_2', at: '2026-10-14T09:00:00.000Z' })
  assert.equal(executed.status, 'executed')
  assert.equal(executed.approvedBy, 'user_1')
  assert.equal(executed.executedBy, 'user_2')
  assert.equal(executed.executionMode, 'manual')
})

test('executed actions cannot be cancelled', () => {
  const approved = transitionAction(proposed, { type: 'approve', actorId: 'user_1', at: '2026-10-14T08:30:00.000Z' })
  const executed = transitionAction(approved, { type: 'execute_manually', actorId: 'user_2', at: '2026-10-14T09:00:00.000Z' })
  assert.throws(() => transitionAction(executed, { type: 'cancel', at: '2026-10-14T10:00:00.000Z' }), /cannot be cancelled/)
})
