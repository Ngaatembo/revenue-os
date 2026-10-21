import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { looksAutomatedAddress, repeatedSystemMail } from '../senderAutomation.ts'

describe('looksAutomatedAddress', () => {
  it('flags the product notifications seen in a real mailbox', () => {
    assert.equal(looksAutomatedAddress('hi@mailing.windsor.ai'), true)
    assert.equal(looksAutomatedAddress('notify@updates.notion.com'), true)
  })
  it('flags classic automated senders', () => {
    for (const a of ['noreply@x.com', 'no-reply@x.com', 'do-not-reply@x.com', 'donotreply@x.com', 'mailer-daemon@x.com', 'notifications@github.com', 'alerts@bank.com', 'newsletter@shop.com']) assert.equal(looksAutomatedAddress(a), true, a)
  })
  it('never flags addresses people actually use, including generic business names', () => {
    for (const a of ['tendai@gmail.com', 'coordinator@zimbali.co.zw', 'team@base44.com', 'info@acme.co.zw', 'support@acme.com', 'sales@acme.com', 'hello@acme.com', 'accounts@mbare.co.zw']) assert.equal(looksAutomatedAddress(a), false, a)
  })
  it('reads the registrable domain correctly for co.zw style endings', () => {
    assert.equal(looksAutomatedAddress('owner@updates.co.zw'), false) // "updates" is the company name, not a sub-domain
    assert.equal(looksAutomatedAddress('owner@mailing.acme.co.zw'), true)
  })
  it('handles missing or malformed input', () => {
    assert.equal(looksAutomatedAddress(null), false)
    assert.equal(looksAutomatedAddress(''), false)
    assert.equal(looksAutomatedAddress('not-an-address'), false)
  })
})

describe('repeatedSystemMail', () => {
  const t = (id: string, address: string | null, subject: string | null, out: string | null = null) => ({ thread_id: id, counterpart_address: address, subject, last_outbound_at: out })
  it('flags the same sender repeating an identical subject that the owner never answered', () => {
    const flagged = repeatedSystemMail([t('1', 'team@base44.com', 'Your monthly integration credits are running low'), t('2', 'team@base44.com', 'Your monthly integration credits are running low'), t('3', 'team@base44.com', 'Your monthly integration credits are running low')])
    assert.deepEqual([...flagged].sort(), ['1', '2', '3'])
  })
  it('does not flag a single message, which could be a real first enquiry', () => {
    assert.equal(repeatedSystemMail([t('1', 'new@customer.com', 'Quote request')]).size, 0)
  })
  it('does not flag a sender the owner has ever written to', () => {
    const flagged = repeatedSystemMail([t('1', 'c@x.com', 'Invoice'), t('2', 'c@x.com', 'Invoice'), t('3', 'c@x.com', 'Re: earlier', '2026-10-01T00:00:00Z')])
    assert.equal(flagged.size, 0)
  })
  it('does not flag different subjects or threads without a subject', () => {
    assert.equal(repeatedSystemMail([t('1', 'a@x.com', 'One'), t('2', 'a@x.com', 'Two'), t('3', 'a@x.com', null), t('4', 'a@x.com', null)]).size, 0)
  })
})

describe('what the owner sees (real-mailbox shapes)', () => {
  const day = 86_400_000
  const now = Date.parse('2026-10-21T10:00:00Z')
  const thread = (id: string, address: string, subject: string, daysAgo: number, direction: 'inbound' | 'outbound' = 'inbound') => ({
    provider: 'gmail', thread_id: id, message_count: 1, last_message_at: new Date(now - daysAgo * day).toISOString(), last_direction: direction,
    last_inbound_at: direction === 'inbound' ? new Date(now - daysAgo * day).toISOString() : null, last_outbound_at: direction === 'outbound' ? new Date(now - daysAgo * day).toISOString() : null,
    counterpart_address: address, counterpart_name: null, subject, last_snippet: null, all_automated: false,
  })
  it('hides product notifications but keeps a real customer waiting for a reply', async () => {
    const { deriveConversationInsights, automatedThreadIds } = await import('../conversationInsights.ts')
    const threads = [
      thread('w', 'hi@mailing.windsor.ai', 'Your Windsor.ai trial is ending soon!', 3),
      thread('b1', 'team@base44.com', 'Your monthly integration credits are running low', 6), thread('b2', 'team@base44.com', 'Your monthly integration credits are running low', 6), thread('b3', 'team@base44.com', 'Your monthly integration credits are running low', 6),
      thread('n', 'notify@updates.notion.com', 'Join your team on Notion', 11),
      thread('c', 'tendai@mbare.co.zw', 'Quote request: 20 bags of cement', 3),
    ]
    assert.deepEqual([...automatedThreadIds(threads)].sort(), ['b1', 'b2', 'b3', 'n', 'w'])
    const insights = deriveConversationInsights(threads, now)
    assert.deepEqual(insights.map((i) => i.thread.thread_id), ['c'])
  })
})
