import assert from 'node:assert/strict'
import test from 'node:test'
import { classifySyncFailure, trackedOpportunitiesParams, opportunityEvidenceParams, syncRpcBody } from '../../lib/opportunityQueries.ts'

test('every opportunity read is scoped to the workspace id, so RLS is never the only filter', () => {
  const opps = trackedOpportunitiesParams('org_123')
  assert.equal(opps.get('organization_id'), 'eq.org_123')
  assert.equal(opps.get('status'), 'in.(open,dismissed)')
  assert.equal(opps.get('kind'), 'eq.overdue_invoice')
  assert.equal(opportunityEvidenceParams('org_123').get('organization_id'), 'eq.org_123')
})

test('workspace ids are encoded, not concatenated: a crafted id cannot add filters', () => {
  const evil = 'org&status=eq.closed'
  const params = trackedOpportunitiesParams(evil)
  assert.equal(params.get('organization_id'), 'eq.' + evil)
  assert.equal(params.get('status'), 'in.(open,dismissed)')
  assert.equal(new URLSearchParams(params.toString()).getAll('status').length, 1)
})

test('the sync call sends only the workspace id: no user id, role or key is chosen by the browser', () => {
  assert.deepEqual(JSON.parse(syncRpcBody('org_1')), { p_org_id: 'org_1' })
})

test('an empty workspace id is refused before any request is built', () => {
  assert.throws(() => trackedOpportunitiesParams(' '), /workspace id/)
  assert.throws(() => opportunityEvidenceParams(''), /workspace id/)
  assert.throws(() => syncRpcBody(''), /workspace id/)
})

test('sync failures are classified so a missing migration or a viewer role degrades safely', () => {
  assert.equal(classifySyncFailure('Could not find the function public.sync_overdue_opportunities(p_org_id) in the schema cache'), 'not_available')
  assert.equal(classifySyncFailure('Workspace permission denied'), 'no_permission')
  assert.equal(classifySyncFailure('Set and save a recovery-rate assumption before detecting opportunities'), 'no_assumption')
  assert.equal(classifySyncFailure('Database request failed (500).'), 'failed')
})

import { interactionsParams, issueStateBody, parseMinorUnits, paymentEvidenceParams, recordResponseBody } from '../../lib/opportunityQueries.ts'

test('interaction and payment reads are scoped to one workspace and cannot be widened by the id', () => {
  const evil = 'org&organization_id=neq.x'
  for (const params of [interactionsParams(evil), paymentEvidenceParams(evil)]) {
    assert.equal(params.get('organization_id'), `eq.${evil}`)
    assert.equal(new URLSearchParams(params.toString()).getAll('organization_id').length, 1)
  }
  assert.throws(() => interactionsParams(' '), /workspace id/)
  assert.throws(() => paymentEvidenceParams(''), /workspace id/)
})

test('parseMinorUnits accepts exact decimals only and never rounds', () => {
  assert.equal(parseMinorUnits('250'), 25_000)
  assert.equal(parseMinorUnits('250.5'), 25_050)
  assert.equal(parseMinorUnits('250.05'), 25_005)
  assert.equal(parseMinorUnits(' 0.01 '), 1)
  for (const bad of ['', '0', '0.00', '-5', '12.345', '1,000', 'abc', '1e3', '12.']) assert.equal(parseMinorUnits(bad), null, bad)
})

test('a promise body carries integer minor units and a date; other responses carry neither', () => {
  const base = { organizationId: 'org1', interactionId: 'i1', opportunityId: 'overdue_invoice:a', summary: '  said Friday  ' }
  const promise = JSON.parse(recordResponseBody({ ...base, type: 'promised_to_pay', promisedAmount: '500.00', promisedDate: '2026-10-25' }))
  assert.equal(promise.p_promised_amount_minor, 50_000)
  assert.equal(promise.p_promised_date, '2026-10-25')
  assert.equal(promise.p_summary, 'said Friday')
  assert.equal(promise.p_org_id, 'org1')
  const reply = JSON.parse(recordResponseBody({ ...base, type: 'customer_replied', promisedAmount: '999', promisedDate: '2026-10-25', nextFollowUp: '2026-10-22' }))
  assert.equal(reply.p_promised_amount_minor, null)
  assert.equal(reply.p_promised_date, null)
  assert.equal(reply.p_next_follow_up, '2026-10-22')
})

test('a promise without a valid amount or date is rejected before any request is made', () => {
  const base = { organizationId: 'org1', interactionId: 'i1', opportunityId: 'o', summary: 'said Friday', type: 'promised_to_pay' as const }
  assert.throws(() => recordResponseBody({ ...base, promisedAmount: 'lots', promisedDate: '2026-10-25' }), /promised amount/)
  assert.throws(() => recordResponseBody({ ...base, promisedAmount: '100', promisedDate: 'Friday' }), /promised to pay by/)
  assert.throws(() => recordResponseBody({ ...base, organizationId: ' ', promisedAmount: '100', promisedDate: '2026-10-25' }), /workspace id/)
})

test('issue state bodies carry the workspace id and trim the reason', () => {
  const body = JSON.parse(issueStateBody({ organizationId: 'org1', opportunityId: 'o1', transition: 'dismiss', reason: '  related party  ' }))
  assert.deepEqual(body, { p_org_id: 'org1', p_opportunity_id: 'o1', p_transition: 'dismiss', p_reason: 'related party', p_snooze_until: null })
  assert.throws(() => issueStateBody({ organizationId: '', opportunityId: 'o1', transition: 'acknowledge' }), /workspace id/)
})
