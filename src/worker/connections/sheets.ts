import { assertGoogleOk, type FetchFn } from './google.ts'
import { parseSheetInvoiceValues, type SheetInvoiceRow } from '../googleSheetsSync.ts'

export interface SheetsCursor {
  /** Drive modifiedTime of the last fully handled version of the file. */
  modifiedTime?: string
  /** SHA-256 of the last accepted snapshot content (importedAt excluded). */
  contentHash?: string
  rejectedRows?: number
  /** Deterministic problem found in this version of the file; not retried until the file changes. */
  error?: { modifiedTime: string; code: string }
}
export function parseSheetsCursor(raw: string | null): SheetsCursor {
  if (!raw) return {}
  try { const v = JSON.parse(raw) as SheetsCursor; return v && typeof v === 'object' ? v : {} } catch { return {} }
}

/** Machine-readable problem code that fits the 80-character column; long column lists are cut at a column boundary. */
export function safeProblemCode(message: string): string | null {
  if (!/^[a-z0-9_:,-]+$/.test(message)) return null
  if (message.length <= 80) return message
  const cut = message.slice(0, 80)
  const comma = cut.lastIndexOf(',')
  return comma > 0 ? cut.slice(0, comma) : cut
}
export const CHUNK_ROWS = 5000
export const MAX_ROWS = 50000
const SHEETS = 'https://sheets.googleapis.com/v4/spreadsheets'

async function getJson(fetchFn: FetchFn, token: string, url: URL): Promise<{ r: Response; body: Record<string, unknown> | null }> {
  const r = await fetchFn(url, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(20000) })
  return { r, body: await r.json().catch(() => null) as Record<string, unknown> | null }
}

/** Split `'Tab'!A:H` into row-bounded requests so large sheets are read page by page. Other ranges are read once. */
export function chunkRanges(range: string, chunkRows = CHUNK_ROWS): ((index: number) => string) | null {
  const m = range.match(/^(.+)!([A-Z]{1,3}):([A-Z]{1,3})$/)
  if (!m) return null
  return (index) => `${m[1]}!${m[2]}${index * chunkRows + 1}:${m[3]}${(index + 1) * chunkRows}`
}

async function readValues(fetchFn: FetchFn, token: string, spreadsheetId: string, range: string): Promise<unknown[][]> {
  const read = async (r: string) => {
    const url = new URL(`${SHEETS}/${encodeURIComponent(spreadsheetId)}/values/${encodeURIComponent(r)}`)
    url.searchParams.set('majorDimension', 'ROWS'); url.searchParams.set('valueRenderOption', 'UNFORMATTED_VALUE')
    const { r: res, body } = await getJson(fetchFn, token, url)
    if (res.status === 400) throw new Error('google_sheet_invalid_range')
    if (res.status === 404) throw new Error('google_sheet_not_found')
    assertGoogleOk(res, body)
    return Array.isArray(body?.values) ? body!.values as unknown[][] : []
  }
  const chunk = chunkRanges(range)
  if (!chunk) return read(range)
  const all: unknown[][] = []
  for (let i = 0; i * CHUNK_ROWS < MAX_ROWS + CHUNK_ROWS; i += 1) {
    const rows = await read(chunk(i))
    all.push(...rows)
    if (all.length > MAX_ROWS + 1) throw new Error('sheet_too_large')
    if (rows.length < CHUNK_ROWS) return all
  }
  throw new Error('sheet_too_large')
}

async function sha256(text: string) {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('')
}
export const snapshotHash = (spreadsheetId: string, range: string, rows: SheetInvoiceRow[]) => sha256(JSON.stringify({ spreadsheetId, range, rows: rows.map((row) => ({ id: row.id, invoiceNumber: row.invoiceNumber, customerId: row.customerId, customerName: row.customerName, currency: row.currency, totalMinor: row.totalMinor, paidMinor: row.paidMinor, issuedAt: row.issuedAt, dueAt: row.dueAt })) }))

export interface SheetsSyncIO {
  fetchFn: FetchFn
  accessToken: string
  spreadsheetId: string
  range: string
  cursor: SheetsCursor
  /** Persist a changed snapshot. Resolves with the finalizer result; must be idempotent. */
  importSnapshot: (snapshot: { rows: SheetInvoiceRow[]; rejectedRows: number; contentHash: string }) => Promise<{ duplicate: boolean }>
  onStage: (stage: 'fetching' | 'processing') => Promise<void>
}
export type SheetsSyncResult =
  | { kind: 'unchanged'; cursor: SheetsCursor; rows: number; rejectedRows: number }
  | { kind: 'imported'; cursor: SheetsCursor; rows: number; rejectedRows: number; duplicate: boolean }
  | { kind: 'rejected_known'; cursor: SheetsCursor; code: string }

/** One pass over a selected spreadsheet. Cheap when nothing changed: a single Drive metadata call. */
export async function syncSheet(io: SheetsSyncIO): Promise<SheetsSyncResult> {
  await io.onStage('fetching')
  let modifiedTime: string | undefined
  {
    const url = new URL(`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(io.spreadsheetId)}`)
    url.searchParams.set('fields', 'modifiedTime,trashed')
    const { r, body } = await getJson(io.fetchFn, io.accessToken, url)
    if (r.status === 404) throw new Error('google_sheet_not_found')
    if (r.ok && body?.trashed === true) throw new Error('google_sheet_not_found')
    if (r.ok && typeof body?.modifiedTime === 'string') modifiedTime = body.modifiedTime
    else if (!r.ok && r.status !== 403) assertGoogleOk(r, body) // 403 here only means the optional Drive scope is missing
  }
  const c = io.cursor
  if (modifiedTime) {
    if (c.error && c.error.modifiedTime === modifiedTime) return { kind: 'rejected_known', cursor: c, code: c.error.code }
    if (c.modifiedTime === modifiedTime && c.contentHash) return { kind: 'unchanged', cursor: c, rows: 0, rejectedRows: c.rejectedRows ?? 0 }
  }
  const values = await readValues(io.fetchFn, io.accessToken, io.spreadsheetId, io.range)
  await io.onStage('processing')
  let parsed
  try { parsed = parseSheetInvoiceValues(values, `google_sheets:${io.spreadsheetId}`, new Date().toISOString()) }
  catch (cause) {
    const code = (cause instanceof Error ? safeProblemCode(cause.message) : null) ?? 'sheet_unreadable'
    if (modifiedTime) return { kind: 'rejected_known', cursor: { ...c, error: { modifiedTime, code } }, code }
    throw cause
  }
  const contentHash = await snapshotHash(io.spreadsheetId, io.range, parsed.rows)
  if (c.contentHash === contentHash && (c.rejectedRows ?? 0) === parsed.rejectedRows) {
    // Drive says "modified" (e.g. a cell outside the range changed) but our rows are identical.
    return { kind: 'unchanged', cursor: { contentHash, rejectedRows: parsed.rejectedRows, ...(modifiedTime ? { modifiedTime } : {}) }, rows: parsed.rows.length, rejectedRows: parsed.rejectedRows }
  }
  const { duplicate } = await io.importSnapshot({ rows: parsed.rows, rejectedRows: parsed.rejectedRows, contentHash })
  return { kind: 'imported', cursor: { contentHash, rejectedRows: parsed.rejectedRows, ...(modifiedTime ? { modifiedTime } : {}) }, rows: parsed.rows.length, rejectedRows: parsed.rejectedRows, duplicate }
}
