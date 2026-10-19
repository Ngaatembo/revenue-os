import { test } from 'node:test'
import assert from 'node:assert/strict'
import { googleSheetsSyncErrorMessage } from '../googleSheetsHandlers.ts'

test('missing sheet columns tell the user which fields to add', () => {
  assert.match(googleSheetsSyncErrorMessage('missing_columns:customer_id,due_at'), /customer_id, due_at/)
  assert.match(googleSheetsSyncErrorMessage('missing_columns:customer_id,due_at'), /template/i)
})

test('invalid invoice rows explain the fields to check', () => {
  assert.match(googleSheetsSyncErrorMessage('no_valid_invoice_rows'), /customer names, invoice numbers, currency, amounts and dates/i)
})

test('Google access errors give the correct next step', () => {
  assert.match(googleSheetsSyncErrorMessage('google_sheet_access_denied'), /Viewer access/i)
  assert.match(googleSheetsSyncErrorMessage('google_token_refresh_failed'), /reconnect/i)
})

test('unknown sync errors do not expose internal details', () => {
  assert.match(googleSheetsSyncErrorMessage('unexpected_database_error'), /could not be synced/i)
  assert.doesNotMatch(googleSheetsSyncErrorMessage('unexpected_database_error'), /unexpected_database_error/)
})
