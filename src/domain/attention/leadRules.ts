import { dateOnly } from '../issueWorkflow.ts'
import { formatMoney, money } from '../money.ts'
import { detectStalledLeads } from '../stalledLeads.ts'
import type { AttentionContext, AttentionFinding, AttentionRule, LeadForAttention } from './types.ts'

const HOUR = 3_600_000
const active = (lead: LeadForAttention) => lead.status === 'new' || lead.status === 'follow_up' || lead.status === 'contacted'

function potential(lead: LeadForAttention) {
  const match = /^(0|[1-9]\d*)(?:\.(\d{1,2}))?$/.exec(lead.value.trim())
  if (!match || !/^[A-Z]{3}$/.test(lead.currency)) return undefined
  const minor = Number(BigInt(match[1]) * 100n + BigInt((match[2] ?? '').padEnd(2, '0')))
  return Number.isSafeInteger(minor) && minor > 0 ? money(minor, lead.currency) : undefined
}

const subjectOf = (lead: LeadForAttention) => ({ type: 'lead' as const, id: lead.id, label: `${lead.name} · ${lead.business}` })

export const stalledLeadRule: AttentionRule = {
  id: 'lead.stalled',
  description: 'The lead has had no follow-up for as long as your "stalled lead" setting.',
  run: (context: AttentionContext): AttentionFinding[] => {
    const threshold = context.settings.lead_stall_days
    const result = detectStalledLeads(context.leads.filter(active).map((lead) => ({ ...lead })), dateOnly(context.asOf), threshold.value)
    return result.stalled.map(({ lead, daysStalled, potentialValue }) => {
      const full = context.leads.find((candidate) => candidate.id === lead.id)!
      return {
        ruleId: 'lead.stalled', subject: subjectOf(full), severity: 3, strength: 'confirmed', urgency: Math.min(0.85, 0.4 + daysStalled / 60), likelihood: 0.4, effort: 0.3,
        speculativeMoney: potentialValue ?? undefined,
        what: `No follow-up for ${daysStalled} days.`,
        evidence: [`Follow-up was planned for ${lead.nextFollowUp} and has not been recorded.`, threshold.explanation, potentialValue ? `Estimated value ${formatMoney(potentialValue)} is a pipeline figure, not revenue.` : 'No value was recorded for this lead.'],
        why: 'Leads go cold quickly once follow-up stops.', nextStep: 'Contact the lead now and record the outcome.',
      }
    })
  },
}

export const unansweredEnquiryRule: AttentionRule = {
  id: 'lead.unanswered_enquiry',
  description: 'A new enquiry has had no recorded reply within your response target.',
  run: (context) => {
    const target = context.settings.enquiry_response_hours
    const now = Date.parse(context.asOf)
    return context.leads.filter((lead) => lead.status === 'new').flatMap((lead): AttentionFinding[] => {
      const created = Date.parse(lead.createdAt)
      if (!Number.isFinite(created)) return []
      const touched = context.leadActivities.some((activity) => activity.leadId === lead.id)
      const waitedHours = Math.floor((now - created) / HOUR)
      if (touched || waitedHours < target.value) return []
      return [{
        ruleId: 'lead.unanswered_enquiry', subject: subjectOf(lead), severity: 3, strength: 'inferred', urgency: Math.min(0.9, 0.5 + waitedHours / 240), likelihood: 0.6, effort: 0.2,
        speculativeMoney: potential(lead),
        what: `This enquiry has waited ${waitedHours} hours with no recorded reply.`,
        evidence: [`Added ${lead.createdAt.slice(0, 10)}; status is still "new" and no activity is recorded.`, target.explanation, 'If you replied outside Revenue OS, record it so this clears.'],
        why: 'The first business to reply usually wins the work.', nextStep: 'Reply to the enquiry and record that you did.',
      }]
    })
  },
}

export const leadFollowUpDueRule: AttentionRule = {
  id: 'lead.follow_up_due',
  description: 'A planned follow-up date for a lead has arrived.',
  run: (context) => {
    const today = dateOnly(context.asOf)
    const stalled = new Set(detectStalledLeads(context.leads.filter(active).map((lead) => ({ ...lead })), today, context.settings.lead_stall_days.value).stalled.map((entry) => entry.lead.id))
    return context.leads.filter(active).flatMap((lead): AttentionFinding[] => {
      if (lead.nextFollowUp > today || stalled.has(lead.id)) return []
      return [{
        ruleId: 'lead.follow_up_due', subject: subjectOf(lead), severity: 2, strength: 'confirmed', urgency: 0.45, likelihood: 0.5, effort: 0.2, speculativeMoney: potential(lead),
        what: `Follow-up planned for ${lead.nextFollowUp} is due.`, evidence: [`Status is "${lead.status.replace('_', ' ')}".`],
        why: 'Planned follow-ups are promises to yourself that are easy to miss.', nextStep: 'Follow up and record the outcome.',
      }]
    })
  },
}

export const LEAD_RULES: AttentionRule[] = [unansweredEnquiryRule, stalledLeadRule, leadFollowUpDueRule]
