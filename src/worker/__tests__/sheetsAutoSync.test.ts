import assert from 'node:assert/strict'
import test from 'node:test'
import { chunkRanges, parseSheetsCursor, syncSheet, CHUNK_ROWS, type SheetsSyncIO } from '../connections/sheets.ts'
import { RateLimitedError } from '../connections/google.ts'

const HEADER = ['customer_id', 'customer_name', 'invoice_number', 'currency', 'total_amount', 'paid_amount', 'issued_at', 'due_at']
const row = (n: number, paid = 0) => [`c${n}`, `Customer ${n}`, `INV-${n}`, 'USD', 100 + n, paid, '2026-01-01', '2026-02-01']

/** Fake Drive + Sheets: honours row-bounded ranges like the real API. */
function fakeSheets(state: { values: unknown[][]; modifiedTime: string; status?: number; driveStatus?: number; trashed?: boolean }) {
  const calls: string[] = []
  const fetchFn = async (input: string | URL): Promise<Response> => {
    const url = new URL(String(input)); calls.push(url.pathname)
    if (url.host === 'www.googleapis.com') {
      if (state.driveStatus) return new Response('{}', { status: state.driveStatus })
      return new Response(JSON.stringify({ modifiedTime: state.modifiedTime, trashed: state.trashed ?? false }), { status: 200 })
    }
    if (state.status) return new Response(JSON.stringify({ error: { status: 'RESOURCE_EXHAUSTED' } }), { status: state.status, headers: { 'retry-after': '30' } })
    const range = decodeURIComponent(url.pathname.split('/values/')[1]!)
    const m = range.match(/!([A-Z]+)(\d+):([A-Z]+)(\d+)$/)
    const [from, to] = m ? [Number(m[2]), Number(m[4])] : [1, state.values.length]
    const page = state.values.slice(from - 1, to)
    while (page.length && (page[page.length - 1] as unknown[]).length === 0) page.pop() // the real API trims trailing blank rows
    return new Response(JSON.stringify({ values: page }), { status: 200 })
  }
  return { fetchFn, calls }
}
function io(fetchFn: SheetsSyncIO['fetchFn'], cursor = {}, extra: Partial<SheetsSyncIO> = {}): SheetsSyncIO & { imported: Array<{ rows: number; rejected: number }> } {
  const imported: Array<{ rows: number; rejected: number }> = []
  return { fetchFn, accessToken: 't', spreadsheetId: 'sheet1234567', range: "'Invoices'!A:H", cursor, onStage: async () => {},
    importSnapshot: async (s) => { imported.push({ rows: s.rows.length, rejected: s.rejectedRows }); return { duplicate: false } }, imported, ...extra }
}

test('column ranges are read page by page; other ranges are read once', () => {
  const chunk = chunkRanges("'Invoices'!A:H")!
  assert.equal(chunk(0), `'Invoices'!A1:H${CHUNK_ROWS}`); assert.equal(chunk(1), `'Invoices'!A${CHUNK_ROWS + 1}:H${CHUNK_ROWS * 2}`)
  assert.equal(chunkRanges("'Invoices'!A1:H40"), null)
})

test('first run imports every row of a multi-page sheet', async () => {
  const values = [HEADER, ...Array.from({ length: 6000 }, (_, i) => row(i + 1))]
  const g = fakeSheets({ values, modifiedTime: 't1' }); const h = io(g.fetchFn)
  const r = await syncSheet(h)
  assert.equal(r.kind, 'imported'); assert.equal(h.imported[0]!.rows, 6000); assert.equal(h.imported[0]!.rejected, 0)
  assert.equal(g.calls.filter((c) => c.includes('/values/')).length, 3, 'two pages of values plus the empty page that proves the end')
  assert.equal(r.cursor.modifiedTime, 't1'); assert.match(r.cursor.contentHash!, /^[a-f0-9]{64}$/)
})

test('a blank row at a page boundary does not truncate the import', async () => {
  const body = Array.from({ length: 7000 }, (_, i) => row(i + 1)); body[CHUNK_ROWS - 2] = [] // row 5000 of the sheet (header is row 1) is blank
  const g = fakeSheets({ values: [HEADER, ...body], modifiedTime: 't1' }); const h = io(g.fetchFn)
  const r = await syncSheet(h)
  assert.equal(r.kind, 'imported'); assert.equal(h.imported[0]!.rows, 6999, 'every non-blank row after the boundary is read')
})

test('an unchanged file costs one metadata call and no import', async () => {
  const g = fakeSheets({ values: [HEADER, row(1)], modifiedTime: 't1' })
  const first = await syncSheet(io(g.fetchFn)); assert.equal(first.kind, 'imported')
  g.calls.length = 0
  const h = io(g.fetchFn, first.cursor); const second = await syncSheet(h)
  assert.equal(second.kind, 'unchanged'); assert.equal(h.imported.length, 0); assert.deepEqual(g.calls, ['/drive/v3/files/sheet1234567'])
})

test('an edited cell is detected and re-imported; a touch that changes nothing is not', async () => {
  const state = { values: [HEADER, row(1), row(2)] as unknown[][], modifiedTime: 't1' }
  const g = fakeSheets(state); const first = await syncSheet(io(g.fetchFn))
  state.modifiedTime = 't2' // modified, same rows
  const same = io(g.fetchFn, first.cursor); const touched = await syncSheet(same)
  assert.equal(touched.kind, 'unchanged'); assert.equal(same.imported.length, 0); assert.equal(touched.cursor.modifiedTime, 't2')
  state.values = [HEADER, row(1, 50), row(2)]; state.modifiedTime = 't3' // a payment was recorded
  const changed = io(g.fetchFn, touched.cursor); const third = await syncSheet(changed)
  assert.equal(third.kind, 'imported'); assert.equal(changed.imported.length, 1)
})

test('rows that cannot be read are counted, never silently coerced', async () => {
  const bad = [...row(2)]; bad[3] = 'usd-dollars'
  const g = fakeSheets({ values: [HEADER, row(1), bad], modifiedTime: 't1' }); const h = io(g.fetchFn)
  const r = await syncSheet(h)
  assert.equal(r.kind, 'imported'); assert.equal(h.imported[0]!.rows, 1); assert.equal(h.imported[0]!.rejected, 1)
  const again = await syncSheet(io(g.fetchFn, r.cursor)); assert.equal(again.kind, 'unchanged')
  assert.equal(again.kind === 'unchanged' && again.rejectedRows, 1, 'the warning persists while the rows stay unreadable')
})

test('a structural problem is reported once per version of the file, not re-read every poll', async () => {
  const g = fakeSheets({ values: [['name', 'amount'], ['a', 1]], modifiedTime: 't1' })
  const first = await syncSheet(io(g.fetchFn))
  assert.equal(first.kind, 'rejected_known'); assert.match(first.kind === 'rejected_known' ? first.code : '', /^missing_columns:/)
  g.calls.length = 0
  const again = await syncSheet(io(g.fetchFn, first.cursor))
  assert.equal(again.kind, 'rejected_known'); assert.deepEqual(g.calls, ['/drive/v3/files/sheet1234567'], 'values are not re-read until the file changes')
})

test('provider trouble maps to typed errors', async () => {
  await assert.rejects(syncSheet(io(fakeSheets({ values: [HEADER, row(1)], modifiedTime: 't', status: 429 }).fetchFn)), (e: unknown) => e instanceof RateLimitedError && e.retryAfterSeconds === 30)
  await assert.rejects(syncSheet(io(fakeSheets({ values: [], modifiedTime: 't', driveStatus: 404 }).fetchFn)), /google_sheet_not_found/)
  await assert.rejects(syncSheet(io(fakeSheets({ values: [], modifiedTime: 't', trashed: true }).fetchFn)), /google_sheet_not_found/)
})

test('without the optional Drive scope the sheet is still read and compared by content', async () => {
  const g = fakeSheets({ values: [HEADER, row(1)], modifiedTime: 't', driveStatus: 403 })
  const first = await syncSheet(io(g.fetchFn)); assert.equal(first.kind, 'imported'); assert.equal(first.cursor.modifiedTime, undefined)
  const second = await syncSheet(io(g.fetchFn, first.cursor)); assert.equal(second.kind, 'unchanged')
})

test('cursor parsing tolerates garbage', () => { assert.deepEqual(parseSheetsCursor('nope'), {}); assert.deepEqual(parseSheetsCursor(null), {}) })
