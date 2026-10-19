import assert from 'node:assert/strict'
import test from 'node:test'
import { assumptionHistoryParams, brainFactsParams, recordFactBody, resolveConflictBody, retractFactBody } from '../../lib/brainQueries.ts'

test('every brain read is scoped to the workspace', () => {
  assert.equal(brainFactsParams('org-1').get('organization_id'), 'eq.org-1')
  assert.equal(assumptionHistoryParams('org-1').get('organization_id'), 'eq.org-1')
  assert.equal(assumptionHistoryParams('org-1').get('event_type'), 'eq.assumption_changed')
  assert.throws(() => brainFactsParams('  '), /workspace id/)
  assert.throws(() => recordFactBody({ organizationId: '', factId: 'f', key: 'k', value: 'v', kind: 'user_entered', sourceLabel: 's' }), /workspace id/)
  assert.throws(() => retractFactBody({ organizationId: '', factId: 'f', reason: 'r' }), /workspace id/)
  assert.throws(() => resolveConflictBody({ organizationId: '', key: 'k', keepFactId: 'f', reason: 'r' }), /workspace id/)
})

test('record body sends the workspace id and null for empty optional fields', () => {
  const body = JSON.parse(recordFactBody({ organizationId: 'org-1', factId: 'f1', key: 'lead_stall_days', value: '10', kind: 'user_entered', sourceLabel: 'Owner' }))
  assert.equal(body.p_org_id, 'org-1')
  assert.equal(body.p_source_ref, null)
  assert.equal(body.p_note, null)
})
