import type { CsvIssue } from './invoiceCsv.ts'
import type { InvoiceEvidence } from './types.ts'

/**
 * The same file re-imported is already a no-op (content hash). A re-export saved under a
 * DIFFERENT file name gets a different source id, so without this check the same invoice would be
 * stored twice and its overdue balance counted twice.
 *
 * A row is a cross-source duplicate when an invoice with the same number and currency is already
 * saved from a different source. Rows from the SAME source are not duplicates: re-importing a
 * corrected file under the same name updates that source's records.
 */
export function partitionCrossSourceDuplicates(
  incoming: InvoiceEvidence[],
  rowNumbers: number[],
  existing: InvoiceEvidence[],
): { fresh: InvoiceEvidence[]; duplicates: CsvIssue[] } {
  const key = (invoice: InvoiceEvidence) => `${invoice.currency}|${invoice.invoiceNumber.trim().toLowerCase()}`
  const savedElsewhere = new Map<string, string>()
  for (const invoice of existing) {
    const mapKey = key(invoice)
    if (!savedElsewhere.has(mapKey)) savedElsewhere.set(mapKey, invoice.source.sourceId)
  }
  const fresh: InvoiceEvidence[] = []
  const duplicates: CsvIssue[] = []
  incoming.forEach((invoice, index) => {
    const source = savedElsewhere.get(key(invoice))
    const sameSource = existing.some((saved) => saved.source.sourceId === invoice.source.sourceId && key(saved) === key(invoice))
    if (source !== undefined && !sameSource) {
      duplicates.push({
        row: rowNumbers[index] ?? index + 2,
        message: `Invoice ${invoice.invoiceNumber} (${invoice.currency}) is already saved from another file, so it was not imported again. Re-import under the original file name to update it.`,
      })
    } else {
      fresh.push(invoice)
    }
  })
  return { fresh, duplicates }
}
