/**
 * Provider-neutral business signals.
 *
 * Connectors translate provider records into this contract; business rules consume
 * these normalized signals instead of depending on Gmail/WhatsApp/Drive payloads.
 * This is a domain contract only: persistence and provider access stay behind
 * organization-authorized adapters.
 */

export type BusinessSignalType =
  | 'inbound_enquiry'
  | 'outbound_reply'
  | 'quotation_sent'
  | 'payment_promise'
  | 'invoice_overdue'
  | 'payment_evidence_observed'
  | 'follow_up_due'
  | 'source_sync_failure'

export type SignalProvider =
  | 'google_sheets'
  | 'google_drive'
  | 'gmail'
  | 'outlook'
  | 'whatsapp_business'
  | 'accounting'
  | 'payment_provider'
  | 'csv'
  | 'manual'
  | (string & {})

export type CustomerMatch =
  | { status: 'matched'; customerId: string; method: 'exact_identifier' | 'confirmed_by_user' | 'provider_relationship' }
  | { status: 'candidate'; candidateCustomerIds: string[]; reason: string }
  | { status: 'unmatched'; reason: string }

export type SignalEvidence = {
  /** Stable provider-side record/message/document identifier, not a secret or token. */
  externalRecordId: string
  /** Optional deep link to the original source, when the provider supports it. */
  sourceUrl?: string
  /** Short, privacy-conscious explanation of the evidence. Avoid storing full message bodies by default. */
  description: string
}

export type BusinessSignal = {
  /** Tenant boundary; must be validated by the server adapter before persistence. */
  organizationId: string
  /** Provider/account connection identifier within this organization. */
  sourceId: string
  provider: SignalProvider
  type: BusinessSignalType
  /** Stable key for safe retries. Same source event must retain the same key. */
  idempotencyKey: string
  /** Time the business event occurred, not when Revenue OS happened to read it. */
  occurredAt: string
  /** Time Revenue OS observed/imported the event. */
  observedAt: string
  customer: CustomerMatch
  evidence: SignalEvidence
  /** 0..1 confidence in the interpretation; not a probability of payment or conversion. */
  confidence: number
  reviewState: 'ready' | 'needs_review'
  /** Short user-facing interpretation. It must not claim more than the evidence supports. */
  summary: string
}

export type SignalBatchResult = {
  accepted: BusinessSignal[]
  duplicates: string[]
  conflicts: { idempotencyKey: string; reason: string }[]
  rejected: { index: number; errors: string[] }[]
}

const signalTypes = new Set<BusinessSignalType>([
  'inbound_enquiry', 'outbound_reply', 'quotation_sent', 'payment_promise',
  'invoice_overdue', 'payment_evidence_observed', 'follow_up_due', 'source_sync_failure',
])

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
const isNonBlank = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0
const isValidTime = (value: unknown): value is string =>
  typeof value === 'string' && Number.isFinite(Date.parse(value)) && /^\d{4}-\d{2}-\d{2}T/.test(value)

export function validateBusinessSignal(input: BusinessSignal): string[] {
  const signal: unknown = input
  const errors: string[] = []
  if (!isRecord(signal)) return ['signal must be an object']

  if (!isNonBlank(signal.organizationId)) errors.push('organizationId is required')
  if (!isNonBlank(signal.sourceId)) errors.push('sourceId is required')
  if (!isNonBlank(signal.provider)) errors.push('provider is required')
  if (typeof signal.type !== 'string' || !signalTypes.has(signal.type as BusinessSignalType)) errors.push('type is not supported')
  if (!isNonBlank(signal.idempotencyKey)) errors.push('idempotencyKey is required')
  if (!isValidTime(signal.occurredAt)) errors.push('occurredAt must be a valid ISO timestamp')
  if (!isValidTime(signal.observedAt)) errors.push('observedAt must be a valid ISO timestamp')
  if (typeof signal.confidence !== 'number' || !Number.isFinite(signal.confidence) || signal.confidence < 0 || signal.confidence > 1) {
    errors.push('confidence must be between 0 and 1')
  }
  if (!isRecord(signal.evidence)) {
    errors.push('evidence must be an object')
  } else {
    if (!isNonBlank(signal.evidence.externalRecordId)) errors.push('evidence.externalRecordId is required')
    if (!isNonBlank(signal.evidence.description)) errors.push('evidence.description is required')
    if (signal.evidence.sourceUrl !== undefined && !isNonBlank(signal.evidence.sourceUrl)) {
      errors.push('evidence.sourceUrl must be a non-blank URL when provided')
    }
  }
  if (!isNonBlank(signal.summary)) errors.push('summary is required')

  const customer = signal.customer
  if (!isRecord(customer)) {
    errors.push('customer must be an object')
  } else if (customer.status === 'matched') {
    if (!isNonBlank(customer.customerId)) errors.push('matched customer requires customerId')
    if (!['exact_identifier', 'confirmed_by_user', 'provider_relationship'].includes(String(customer.method))) {
      errors.push('matched customer requires a supported match method')
    }
  } else if (customer.status === 'candidate') {
    if (!Array.isArray(customer.candidateCustomerIds) || customer.candidateCustomerIds.length === 0
      || !customer.candidateCustomerIds.every(isNonBlank)) {
      errors.push('candidate customer match requires at least one non-blank candidate ID')
    }
    if (!isNonBlank(customer.reason)) errors.push('candidate customer match requires a reason')
  } else if (customer.status === 'unmatched') {
    if (!isNonBlank(customer.reason)) errors.push('unmatched customer requires a reason')
  } else {
    errors.push('customer status is not supported')
  }

  if (signal.reviewState !== 'ready' && signal.reviewState !== 'needs_review') {
    errors.push('reviewState is not supported')
  }
  if (signal.reviewState === 'ready' && (!isRecord(customer) || customer.status !== 'matched')) {
    errors.push('signals without a confirmed customer match must remain needs_review')
  }
  return errors
}

/**
 * Validate and deduplicate one fetched batch. If a key has conflicting payloads,
 * every row for that key is quarantined (none is returned as accepted). This helper
 * does not replace database uniqueness or server-side tenant checks.
 */
export function classifyBusinessSignalBatch(signals: BusinessSignal[]): SignalBatchResult {
  const accepted: BusinessSignal[] = []
  const duplicates: string[] = []
  const conflicts: SignalBatchResult['conflicts'] = []
  const rejected: SignalBatchResult['rejected'] = []
  const seen = new Map<string, { signal: BusinessSignal; acceptedIndex: number; conflicted: boolean }>()

  signals.forEach((signal, index) => {
    const errors = validateBusinessSignal(signal)
    if (errors.length) {
      rejected.push({ index, errors })
      return
    }

    const key = JSON.stringify([signal.organizationId, signal.sourceId, signal.idempotencyKey])
    const previous = seen.get(key)
    if (!previous) {
      const acceptedIndex = accepted.push(signal) - 1
      seen.set(key, { signal, acceptedIndex, conflicted: false })
      return
    }

    if (previous.conflicted) {
      conflicts.push({ idempotencyKey: signal.idempotencyKey, reason: 'This source key was already quarantined because its batch contains conflicting signal content.' })
      return
    }

    const sameEvent = previous.signal.type === signal.type
      && previous.signal.provider === signal.provider
      && previous.signal.evidence.externalRecordId === signal.evidence.externalRecordId
      && previous.signal.occurredAt === signal.occurredAt
      && previous.signal.observedAt === signal.observedAt
      && previous.signal.summary === signal.summary
      && previous.signal.customer.status === signal.customer.status
      && JSON.stringify(previous.signal.customer) === JSON.stringify(signal.customer)

    if (sameEvent) {
      duplicates.push(signal.idempotencyKey)
    } else {
      accepted.splice(previous.acceptedIndex, 1)
      previous.conflicted = true
      conflicts.push({ idempotencyKey: signal.idempotencyKey, reason: 'The same source key describes conflicting signal content; all rows for this key were quarantined for manual review.' })
    }
  })

  return { accepted, duplicates, conflicts, rejected }
}
