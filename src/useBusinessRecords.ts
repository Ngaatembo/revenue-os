import { useCallback, useEffect, useState } from 'react'
import type { Deposit, PaymentReviewItem, Quotation, Task, WorkspaceMember } from './domain/records'
import { loadActionOwners, loadDeposits, loadPaymentReviewItems, loadQuotations, loadRescheduleCounts, loadTasks, loadWorkspaceMembers, type SupabaseSession } from './lib/supabaseRest'

export type BusinessRecords = {
  quotations: Quotation[]; deposits: Deposit[]; tasks: Task[]; reviews: PaymentReviewItem[]
  rescheduleCounts: Map<string, number>; actionOwners: Map<string, string | null>; members: WorkspaceMember[]
  loading: boolean
  /** Set when the records could not be read. An unread list is never shown as an empty one. */
  error: string | null
  /** True once the database update that adds these records has been applied. */
  available: boolean
}
const EMPTY: BusinessRecords = { quotations: [], deposits: [], tasks: [], reviews: [], rescheduleCounts: new Map(), actionOwners: new Map(), members: [], loading: true, error: null, available: true }

/** Loads the owner's quotations, deposits, tasks and payment review queue. `reload` refetches after any change. */
export function useBusinessRecords(session: SupabaseSession, organizationId: string): BusinessRecords & { reload: () => void } {
  const [state, setState] = useState<BusinessRecords>(EMPTY)
  const [tick, setTick] = useState(0)
  const reload = useCallback(() => setTick((value) => value + 1), [])
  useEffect(() => {
    let cancelled = false
    Promise.all([
      loadQuotations(session, organizationId), loadDeposits(session, organizationId), loadTasks(session, organizationId), loadPaymentReviewItems(session, organizationId),
      loadRescheduleCounts(session, organizationId), loadActionOwners(session, organizationId), loadWorkspaceMembers(session, organizationId),
    ]).then(([quotations, deposits, tasks, reviews, rescheduleCounts, actionOwners, members]) => {
      if (!cancelled) setState({ quotations, deposits, tasks, reviews, rescheduleCounts, actionOwners, members, loading: false, error: null, available: true })
    }).catch((cause) => {
      if (cancelled) return
      const message = cause instanceof Error ? cause.message : 'Could not load records.'
      // PostgREST reports a missing table/function with these codes: the database update has not been applied yet.
      const missing = /relation .* does not exist|Could not find the (table|function)|PGRST20[25]|42P01/i.test(message)
      setState({ ...EMPTY, loading: false, available: !missing, error: missing ? null : message })
    })
    return () => { cancelled = true }
  }, [session, organizationId, tick])
  return { ...state, reload }
}
