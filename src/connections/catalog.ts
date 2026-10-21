/** What each source is, what it can read, and how its current state is shown. Pure and unit tested. */

export type ProviderId = 'gmail' | 'google_sheets' | 'whatsapp_business' | 'csv'

export interface ProviderInfo {
  id: ProviderId
  name: string
  summary: string
  /** What the provider lets Revenue OS read. */
  access: string[]
  /** What Revenue OS does with it. */
  usedFor: string[]
  /** 'available' means authorization and sync are implemented in this codebase; it never means "connected". */
  availability: 'available' | 'external_approval_required' | 'manual'
  /** The real-world dependency, shown to the owner instead of a fake "connect" button. */
  dependency?: string
}

export const PROVIDERS: ProviderInfo[] = [
  {
    id: 'gmail', name: 'Gmail (business email)', availability: 'available',
    summary: 'Finds customer enquiries and conversations that have gone quiet.',
    access: ['Sender, recipient, subject, date and a short preview of messages from the last 90 days', 'Whether each message was sent or received', 'New messages afterwards, checked automatically'],
    usedFor: ['Show customers who wrote to you and have not had a reply', 'Show conversations where you replied and the customer went silent', 'Keep a link back to the original email for every item'],
    dependency: 'Gmail read access is a restricted Google permission. While the Google app is in testing, only accounts added as test users can connect, and Google expires the access about every 7 days, so you will be asked to reconnect weekly. Public use needs Google verification and a security assessment.',
  },
  {
    id: 'google_sheets', name: 'Google Sheets', availability: 'available',
    summary: 'Reads your invoice spreadsheet so overdue balances are found automatically.',
    access: ['Spreadsheet names (to let you choose one)', 'The values in the invoice tab you select — read only'],
    usedFor: ['Detect overdue invoices and estimate possible recovery', 'Notice when a row disappears from the sheet and ask you what happened'],
  },
  {
    id: 'whatsapp_business', name: 'WhatsApp Business', availability: 'external_approval_required',
    summary: 'Customer messages sent to your business number.',
    access: ['Only messages sent to a number registered on the official WhatsApp Business Platform, received after setup', 'Delivery and read status of messages sent through that number'],
    usedFor: ['Show customer WhatsApp enquiries that need an answer'],
    dependency: 'The official API needs a Meta Business account, a verified business, an approved app and a phone number registered to the API. It does not read an ordinary personal WhatsApp account or your existing chats. Some numbers already used in the WhatsApp Business app can be linked alongside the API ("coexistence"), optionally sharing recent history, but that depends on Meta and your country. Revenue OS has not been through Meta review, so this cannot be connected yet.',
  },
  {
    id: 'csv', name: 'Invoice or payment file', availability: 'manual',
    summary: 'A spreadsheet export you upload yourself.',
    access: ['Only the file you choose'],
    usedFor: ['Works when no other source is available, or to add payments'],
  },
]

export type ConnectionStatus = 'pending' | 'connected' | 'syncing' | 'needs_attention' | 'error' | 'disconnected'
export type SyncStage = 'connecting' | 'fetching' | 'processing' | 'insights' | 'complete' | 'waiting_rate_limit' | 'failed'

/** Row returned by the list_connection_status() function. It never contains credentials. */
export interface ConnectionRow {
  provider: string
  status: ConnectionStatus
  provider_account_email: string | null
  sync_stage: SyncStage | null
  sync_started_at: string | null
  last_successful_sync_at: string | null
  initial_sync_completed_at: string | null
  next_sync_at: string | null
  last_error_code: string | null
  consecutive_failures: number
  records_synced: number
}

export type UiState = 'not_connected' | 'syncing' | 'connected' | 'needs_attention' | 'failed'
export interface ConnectionView {
  state: UiState
  label: string
  /** Honest description of the current stage; never a percentage. */
  stage: string | null
  /** True when the provider gives no total, so only an indeterminate indicator is truthful. */
  indeterminate: boolean
  message: string | null
  action: 'connect' | 'reconnect' | 'sync_now' | null
  initialSyncDone: boolean
}

const STAGE_TEXT: Record<SyncStage, string> = {
  connecting: 'Connecting securely',
  fetching: 'Fetching available information',
  processing: 'Processing and organizing records',
  insights: 'Preparing business insights',
  complete: 'Initial synchronization complete',
  waiting_rate_limit: 'Waiting for the provider to allow more requests',
  failed: 'Synchronization needs attention',
}

export function errorMessage(code: string | null): string | null {
  switch (code) {
    case null: return null
    case 'authorization_revoked': return 'Google access was removed or has expired. Reconnect to resume — everything already imported is kept.'
    case 'provider_rate_limited': return 'Google asked Revenue OS to slow down. It will continue automatically.'
    case 'provider_access_denied': return 'Google refused access to this mailbox. Check that the account still allows Revenue OS, then reconnect.'
    case 'provider_request_failed': return 'Google could not complete the request. Revenue OS will try again automatically.'
    case 'provider_token_refresh_failed': return 'Revenue OS could not renew its access to Google. It will try again automatically.'
    case 'account_email_missing': return 'The Google account could not be identified. Reconnect to try again.'
    case 'snapshot_rejected_rows': return 'Some rows in the sheet could not be read. Valid rows were kept; fix the rows listed in the sheet card.'
    default: return 'The last synchronization did not finish. Revenue OS will retry automatically.'
  }
}

export function describeConnection(row: ConnectionRow | undefined | null): ConnectionView {
  if (!row || row.status === 'disconnected' || row.status === 'pending') {
    return { state: 'not_connected', label: 'Not connected', stage: null, indeterminate: false, message: null, action: 'connect', initialSyncDone: false }
  }
  const initialSyncDone = Boolean(row.initial_sync_completed_at)
  if (row.status === 'error') {
    return { state: 'failed', label: row.last_error_code === 'authorization_revoked' ? 'Reconnect needed' : 'Failed', stage: STAGE_TEXT.failed, indeterminate: false,
      message: errorMessage(row.last_error_code), action: 'reconnect', initialSyncDone }
  }
  if (row.status === 'needs_attention') {
    return { state: 'needs_attention', label: 'Needs attention', stage: STAGE_TEXT.failed, indeterminate: false, message: errorMessage(row.last_error_code), action: 'sync_now', initialSyncDone }
  }
  const working = row.status === 'syncing' || !initialSyncDone
  if (working) {
    const stage = row.sync_stage ?? (row.status === 'connected' ? 'connecting' : 'fetching')
    const established = row.status === 'connected' && !row.sync_stage
    return { state: 'syncing', label: initialSyncDone ? 'Syncing' : 'Setting up', stage: established ? 'Connection established' : STAGE_TEXT[stage],
      indeterminate: true, message: row.last_error_code === 'provider_rate_limited' ? errorMessage(row.last_error_code) : null, action: null, initialSyncDone }
  }
  return { state: 'connected', label: 'Connected', stage: STAGE_TEXT.complete, indeterminate: false,
    message: row.last_error_code ? errorMessage(row.last_error_code) : null, action: 'sync_now', initialSyncDone }
}

export function formatAge(iso: string | null, now = Date.now()): string {
  if (!iso) return 'never'
  const seconds = Math.max(0, Math.round((now - new Date(iso).getTime()) / 1000))
  if (seconds < 60) return 'just now'
  if (seconds < 3600) return `${Math.floor(seconds / 60)} min ago`
  if (seconds < 86400) return `${Math.floor(seconds / 3600)} h ago`
  return `${Math.floor(seconds / 86400)} d ago`
}
