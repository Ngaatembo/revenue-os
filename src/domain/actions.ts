import type { RevenueAction } from './types'

export type ActionEvent =
  | { type: 'approve'; actorId: string; at: string }
  | { type: 'execute_manually'; actorId: string; at: string }
  | { type: 'mark_failed'; at: string }
  | { type: 'cancel'; at: string }

/** Enforces the MVP approval gate. External execution is always manual. */
export function transitionAction(action: RevenueAction, event: ActionEvent): RevenueAction {
  if (event.type === 'approve') {
    if (action.status !== 'proposed') throw new Error('Only proposed actions can be approved.')
    return { ...action, status: 'approved', approvedBy: event.actorId, approvedAt: event.at }
  }

  if (event.type === 'execute_manually') {
    if (action.status !== 'approved' || !action.approvedBy || !action.approvedAt) {
      throw new Error('An action must be approved before it can be executed.')
    }
    return { ...action, status: 'executed', executedBy: event.actorId, executedAt: event.at }
  }

  if (event.type === 'mark_failed') {
    if (action.status !== 'approved') throw new Error('Only approved actions can be marked failed.')
    return { ...action, status: 'failed' }
  }

  if (action.status === 'executed') throw new Error('Executed actions cannot be cancelled.')
  if (action.status === 'cancelled' || action.status === 'failed') {
    throw new Error(`A ${action.status} action cannot be cancelled.`)
  }
  return { ...action, status: 'cancelled' }
}
