import assert from 'node:assert/strict'
import test from 'node:test'
import { classifySyncFailure, openOpportunitiesParams, opportunityEvidenceParams, syncRpcBody } from '../../lib/opportunityQueries.ts'

test('every opportunity read is scoped to the workspace id, so RLS is never the only filter', () => {
  const opps = openOpportunitiesParams('org_123')
  assert.equal(opps.get('organization_id'), 'eq.org_123')
  assert.equal(opps.get('status'), 'eq.open')
  assert.equal(opps.get('kind'), 'eq.overdue_invoice')
  assert.equal(opportunityEvidenceParams('org_123').get('organization_id'), 'eq.org_123')
})

test('workspace ids are encoded, not concatenated: a crafted id cannot add filters', () => {
  const evil = 'org&status=eq.closed'
  const params = openOpportunitiesParams(evil)
  assert.equal(params.get('organization_id'), 'eq.' + evil)
  assert.equal(params.get('status'), 'eq.open')
  assert.equal(new URLSearchParams(params.toString()).getAll('status').length, 1)
})

test('the sync call sends only the workspace id: no user id, role or key is chosen by the browser', () => {
  assert.deepEqual(JSON.parse(syncRpcBody('org_1')), { p_org_id: 'org_1' })
})

test('an empty workspace id is refused before any request is built', () => {
  assert.throws(() => openOpportunitiesParams(' '), /workspace id/)
  assert.throws(() => opportunityEvidenceParams(''), /workspace id/)
  assert.throws(() => syncRpcBody(''), /workspace id/)
})

test('sync failures are classified so a missing migration or a viewer role degrades safely', () => {
  assert.equal(classifySyncFailure('Could not find the function public.sync_overdue_opportunities(p_org_id) in the schema cache'), 'not_available')
  assert.equal(classifySyncFailure('Workspace permission denied'), 'no_permission')
  assert.equal(classifySyncFailure('Set and save a recovery-rate assumption before detecting opportunities'), 'no_assumption')
  assert.equal(classifySyncFailure('Database request failed (500).'), 'failed')
})
