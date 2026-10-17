import { money } from './money.ts'
import type { Money } from './types.ts'

export type LeadForDetection = {
  id: string
  name: string
  business: string
  status: 'new' | 'follow_up' | 'contacted' | 'converted' | 'closed'
  /** Calendar date YYYY-MM-DD of the next planned follow-up. */
  nextFollowUp: string
  /** Decimal string such as "250.00", or empty when no value was recorded. */
  value: string
  currency: string
}

export type StalledLead = {
  lead: LeadForDetection
  daysStalled: number
  reason: string
  /** What the lead might be worth if won. A pipeline figure, never revenue and never collected money. */
  potentialValue: Money | null
}

export type StalledLeadResult = {
  stalled: StalledLead[]
  /** Leads that could not be assessed (invalid date). They are reported, never guessed at. */
  skippedIds: string[]
}

export const DEFAULT_STALLED_AFTER_DAYS = 7
const DAY_MS = 24 * 60 * 60 * 1000

function dayNumber(value: string): number | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value)
  if (!match) return null
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])]
  const timestamp = Date.UTC(year, month - 1, day)
  const check = new Date(timestamp)
  if (check.getUTCFullYear() !== year || check.getUTCMonth() !== month - 1 || check.getUTCDate() !== day) return null
  return timestamp / DAY_MS
}

function potentialValueOf(lead: LeadForDetection): Money | null {
  const match = /^(0|[1-9]\d*)(?:\.(\d{1,2}))?$/.exec(lead.value.trim())
  if (!match || !/^[A-Z]{3}$/.test(lead.currency)) return null
  const minor = Number(BigInt(match[1]) * 100n + BigInt((match[2] ?? '').padEnd(2, '0')))
  return Number.isSafeInteger(minor) && minor > 0 ? money(minor, lead.currency) : null
}

/**
 * Deterministic rule: a lead that is still being worked (new, follow_up or contacted) is "stalled"
 * when its next follow-up date is at least `stalledAfterDays` calendar days before `asOfDate`.
 * Converted and closed leads are never stalled. Built only from saved lead records.
 */
export function detectStalledLeads(
  leads: LeadForDetection[],
  asOfDate: string,
  stalledAfterDays: number = DEFAULT_STALLED_AFTER_DAYS,
): StalledLeadResult {
  const today = dayNumber(asOfDate)
  if (today === null) throw new Error('asOfDate must be a valid YYYY-MM-DD date.')
  if (!Number.isSafeInteger(stalledAfterDays) || stalledAfterDays < 1) {
    throw new Error('stalledAfterDays must be a positive integer.')
  }
  const stalled: StalledLead[] = []
  const skippedIds: string[] = []
  for (const lead of leads) {
    if (lead.status === 'converted' || lead.status === 'closed') continue
    const due = dayNumber(lead.nextFollowUp)
    if (due === null) { skippedIds.push(lead.id); continue }
    const daysStalled = today - due
    if (daysStalled < stalledAfterDays) continue
    stalled.push({
      lead,
      daysStalled,
      reason: `Follow-up with ${lead.business} was planned for ${lead.nextFollowUp}, ${daysStalled} day${daysStalled === 1 ? '' : 's'} ago, and the lead is still marked "${lead.status.replace('_', ' ')}".`,
      potentialValue: potentialValueOf(lead),
    })
  }
  stalled.sort((a, b) => b.daysStalled - a.daysStalled || a.lead.id.localeCompare(b.lead.id))
  return { stalled, skippedIds }
}
