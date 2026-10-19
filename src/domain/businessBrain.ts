import { formatMoney, money } from './money.ts'
import type { PaymentRecord } from './promises.ts'
import type { InvoiceEvidence, Money } from './types.ts'

/**
 * Business Brain: what the business knows, where each thing came from, and how sure we are.
 *
 * Classes (never blended):
 *  - verified:     backed by imported payment records
 *  - imported:     counted straight from imported records
 *  - derived:      calculated from records (with the formula stated)
 *  - user_entered: stated by the owner
 *  - assumption:   a setting the owner chose that drives estimates
 *  - estimate:     a guess the owner recorded
 *  - default:      a built-in starting value the owner has NOT confirmed
 */
export type BrainClass = 'verified' | 'imported' | 'derived' | 'user_entered' | 'assumption' | 'estimate' | 'default'
export type StoredFactKind = 'user_entered' | 'imported' | 'assumption' | 'estimate'
export type FactStatus = 'active' | 'superseded' | 'retracted'

export const CLASS_LABELS: Record<BrainClass, string> = {
  verified: 'Verified by payment records',
  imported: 'Imported record',
  derived: 'Calculated from records',
  user_entered: 'Entered by you',
  assumption: 'Assumption',
  estimate: 'Estimate',
  default: 'Built-in default, not confirmed',
}

export type BrainFact = {
  id: string
  key: string
  kind: StoredFactKind
  value: string
  sourceLabel: string
  sourceRef: string | null
  note: string | null
  status: FactStatus
  supersededBy: string | null
  statusReason: string | null
  statusChangedAt: string | null
  recordedBy: string
  recordedAt: string
}

export type BrainSettingKey = 'payment_terms_days' | 'quote_follow_up_days' | 'enquiry_response_hours' | 'lead_stall_days' | 'deposit_percent'

export type BrainSetting = { key: BrainSettingKey; label: string; unit: string; min: number; max: number; defaultValue: number; help: string }

/** Settings the attention rules read. Ranges must match private.brain_value_error in the database. */
export const BRAIN_SETTINGS: readonly BrainSetting[] = [
  { key: 'payment_terms_days', label: 'Payment terms', unit: 'days', min: 0, max: 365, defaultValue: 30, help: 'How many days customers normally have to pay an invoice.' },
  { key: 'quote_follow_up_days', label: 'Quote follow-up', unit: 'days', min: 1, max: 90, defaultValue: 7, help: 'Days to wait after sending a quotation before following up.' },
  { key: 'enquiry_response_hours', label: 'Enquiry response target', unit: 'hours', min: 1, max: 720, defaultValue: 24, help: 'How quickly a new enquiry should get a first reply.' },
  { key: 'lead_stall_days', label: 'Stalled lead after', unit: 'days', min: 1, max: 365, defaultValue: 14, help: 'Days without contact before a lead counts as stalled.' },
  { key: 'deposit_percent', label: 'Standard deposit', unit: '%', min: 0, max: 100, defaultValue: 0, help: 'Deposit normally requested up front (0 if none).' },
]

export function settingFor(key: string): BrainSetting | undefined {
  return BRAIN_SETTINGS.find((setting) => setting.key === key)
}

/** Mirrors the database check so the form can explain a problem before sending anything. */
export function validateFactValue(key: string, raw: string): { ok: true; value: string } | { ok: false; error: string } {
  const value = raw.trim()
  if (!value) return { ok: false, error: 'Enter a value.' }
  if (value.length > 500) return { ok: false, error: 'Keep the value under 500 characters.' }
  const setting = settingFor(key)
  if (!setting) return { ok: true, value }
  if (!/^\d{1,4}$/.test(value)) return { ok: false, error: `${setting.label} must be a whole number of ${setting.unit}.` }
  const number = Number(value)
  if (number < setting.min || number > setting.max) return { ok: false, error: `${setting.label} must be between ${setting.min} and ${setting.max} ${setting.unit}.` }
  return { ok: true, value }
}

export function validateFactKey(raw: string): string | null {
  return /^[a-z][a-z0-9_]{1,60}$/.test(raw) ? null : 'Use lowercase letters, digits and underscores, starting with a letter (for example preferred_payment_method).'
}

const PRECEDENCE: StoredFactKind[] = ['user_entered', 'imported', 'assumption', 'estimate']

export function activeFacts(facts: BrainFact[], key?: string): BrainFact[] {
  return facts.filter((fact) => fact.status === 'active' && (key === undefined || fact.key === key))
}

export type FactConflict = { key: string; facts: BrainFact[] }

/** Two or more active facts for one key whose values differ. Same value from two sources is agreement, not conflict. */
export function findConflicts(facts: BrainFact[]): FactConflict[] {
  const byKey = new Map<string, BrainFact[]>()
  for (const fact of activeFacts(facts)) byKey.set(fact.key, [...(byKey.get(fact.key) ?? []), fact])
  const conflicts: FactConflict[] = []
  for (const [key, list] of byKey) {
    if (new Set(list.map((fact) => fact.value.trim().toLowerCase())).size > 1) {
      conflicts.push({ key, facts: [...list].sort((a, b) => Date.parse(b.recordedAt) - Date.parse(a.recordedAt)) })
    }
  }
  return conflicts.sort((a, b) => a.key.localeCompare(b.key))
}

export type ResolvedSetting = {
  key: BrainSettingKey
  label: string
  unit: string
  value: number
  source: BrainClass
  factId: string | null
  /** True when sources disagree. The default is used until the owner resolves it, never a silent pick. */
  conflicted: boolean
  explanation: string
}

/** The value a rule should use for a setting, and exactly why. */
export function resolveSetting(key: BrainSettingKey, facts: BrainFact[]): ResolvedSetting {
  const setting = settingFor(key)
  if (!setting) throw new Error('Unknown setting ' + key)
  const active = activeFacts(facts, key).filter((fact) => validateFactValue(key, fact.value).ok)
  const base = { key, label: setting.label, unit: setting.unit }
  if (new Set(active.map((fact) => fact.value.trim())).size > 1) {
    return { ...base, value: setting.defaultValue, source: 'default', factId: null, conflicted: true,
      explanation: `${setting.label} has conflicting recorded values, so the built-in default of ${setting.defaultValue} ${setting.unit} is used until you resolve it.` }
  }
  const chosen = [...active].sort((a, b) => PRECEDENCE.indexOf(a.kind) - PRECEDENCE.indexOf(b.kind) || Date.parse(b.recordedAt) - Date.parse(a.recordedAt))[0]
  if (!chosen) {
    return { ...base, value: setting.defaultValue, source: 'default', factId: null, conflicted: false,
      explanation: `${setting.label} is not set. The built-in default of ${setting.defaultValue} ${setting.unit} is used; confirm it in the Business Brain.` }
  }
  return { ...base, value: Number(chosen.value), source: chosen.kind, factId: chosen.id, conflicted: false,
    explanation: `${setting.label} is ${chosen.value} ${setting.unit} (${CLASS_LABELS[chosen.kind].toLowerCase()}, source: ${chosen.sourceLabel}).` }
}

export function resolveAllSettings(facts: BrainFact[]): Record<BrainSettingKey, ResolvedSetting> {
  return Object.fromEntries(BRAIN_SETTINGS.map((setting) => [setting.key, resolveSetting(setting.key, facts)])) as Record<BrainSettingKey, ResolvedSetting>
}

export type DerivedEntry = { id: string; label: string; value: string; cls: BrainClass; source: string; basis: string }

const DAY = 86_400_000
const outstandingOf = (invoice: InvoiceEvidence): number => Math.max(0, invoice.total.amount - invoice.paid.amount)

function sumByCurrency(items: { currency: string; amount: number }[]): Money[] {
  const totals = new Map<string, number>()
  for (const item of items) totals.set(item.currency, (totals.get(item.currency) ?? 0) + item.amount)
  return [...totals].sort(([a], [b]) => a.localeCompare(b)).map(([currency, amount]) => money(amount, currency))
}

export function medianTermsDays(invoices: InvoiceEvidence[]): number | null {
  const terms = invoices
    .map((invoice) => Math.round((Date.parse(invoice.dueAt) - Date.parse(invoice.issuedAt)) / DAY))
    .filter((days) => Number.isFinite(days) && days >= 0)
    .sort((a, b) => a - b)
  if (terms.length === 0) return null
  const middle = Math.floor(terms.length / 2)
  return terms.length % 2 ? terms[middle] : Math.round((terms[middle - 1] + terms[middle]) / 2)
}

/** Facts calculated live from saved records. They are never stored, so they cannot go stale or be edited by hand. */
export function deriveRecordFacts(input: {
  invoices: InvoiceEvidence[]
  payments: PaymentRecord[]
  assumptionBps: number | null
  asOf: string
}): DerivedEntry[] {
  const { invoices, payments, assumptionBps, asOf } = input
  const now = Date.parse(asOf)
  const entries: DerivedEntry[] = []
  if (invoices.length) {
    const latest = invoices.map((invoice) => invoice.source.importedAt).sort().at(-1)!
    entries.push({ id: 'invoice_records', label: 'Invoice records', cls: 'imported', value: `${invoices.length} invoice${invoices.length === 1 ? '' : 's'} from ${new Set(invoices.map((invoice) => invoice.customerId)).size} customer(s)`,
      source: 'Invoice import', basis: `Latest import ${latest.slice(0, 10)}.` })
    const unpaid = sumByCurrency(invoices.map((invoice) => ({ currency: invoice.currency, amount: outstandingOf(invoice) })).filter((item) => item.amount > 0))
    entries.push({ id: 'unpaid_total', label: 'Unpaid on invoices', cls: 'derived', value: unpaid.length ? unpaid.map((item) => formatMoney(item)).join(' · ') : 'Nothing unpaid',
      source: 'Invoice records', basis: 'Invoice total minus amount paid on the last import, by currency. Not converted between currencies.' })
    const overdue = sumByCurrency(invoices.filter((invoice) => Date.parse(invoice.dueAt) < now).map((invoice) => ({ currency: invoice.currency, amount: outstandingOf(invoice) })).filter((item) => item.amount > 0))
    entries.push({ id: 'overdue_total', label: 'Past due and unpaid', cls: 'derived', value: overdue.length ? overdue.map((item) => formatMoney(item)).join(' · ') : 'Nothing past due',
      source: 'Invoice records', basis: `Unpaid balance on invoices whose due date is before ${asOf.slice(0, 10)}.` })
    const terms = medianTermsDays(invoices)
    if (terms !== null) entries.push({ id: 'observed_terms', label: 'Payment terms seen in invoices', cls: 'derived', value: `${terms} days (median)`, source: 'Invoice records', basis: 'Median of due date minus issue date across imported invoices.' })
  }
  if (payments.length) {
    const received = sumByCurrency(payments.map((payment) => ({ currency: payment.amount.currency, amount: payment.amount.amount })))
    entries.push({ id: 'payments_recorded', label: 'Payments recorded', cls: 'verified', value: received.map((item) => formatMoney(item)).join(' · '),
      source: 'Payment import', basis: `${payments.length} imported payment record${payments.length === 1 ? '' : 's'}. Promises and claims are not included.` })
  }
  entries.push({ id: 'recovery_rate', label: 'Expected recovery rate', cls: 'assumption',
    value: assumptionBps === null ? 'Not set' : `${(assumptionBps / 100).toFixed(2).replace(/\.00$/, '')}%`,
    source: 'Your setting', basis: 'Used to turn overdue balances into estimates. Estimates are never counted as revenue.' })
  return entries
}

export type RecordMismatch = { key: string; stated: string; observed: string; message: string }

/** Where what the owner stated disagrees with what their own records show. Informational: the owner decides which is right. */
export function findRecordMismatches(facts: BrainFact[], invoices: InvoiceEvidence[]): RecordMismatch[] {
  const mismatches: RecordMismatch[] = []
  const stated = activeFacts(facts, 'payment_terms_days')
  const observed = medianTermsDays(invoices)
  if (observed !== null) {
    for (const fact of stated) {
      const value = Number(fact.value)
      if (Number.isFinite(value) && Math.abs(value - observed) >= 7) {
        mismatches.push({ key: 'payment_terms_days', stated: `${value} days`, observed: `${observed} days`,
          message: `You recorded payment terms of ${value} days (${fact.sourceLabel}), but your invoices show a median of ${observed} days between issue and due date.` })
      }
    }
  }
  return mismatches
}

export type HistoryEntry = { at: string; text: string }

export function factHistory(facts: BrainFact[], key: string): BrainFact[] {
  return facts.filter((fact) => fact.key === key).sort((a, b) => Date.parse(b.recordedAt) - Date.parse(a.recordedAt))
}
