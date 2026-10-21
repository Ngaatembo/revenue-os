import type { ConnectionRow } from './catalog.ts'

export type Landing = 'loading' | 'connections' | 'overview'

/**
 * Where a signed-in owner should land (the welcome itself is shown before sign-in).
 *  - Nothing has synced and no records exist: Connections, every time, until setup is finished.
 *  - A source has completed a synchronization, or records already exist: Overview, never forced back.
 */
export function decideLanding(input: { connections: ConnectionRow[] | null; hasRecords: boolean; recordsLoading: boolean }): Landing {
  if (input.connections === null || input.recordsLoading) return 'loading'
  const synced = input.connections.some((c) => Boolean(c.initial_sync_completed_at || c.last_successful_sync_at))
  return synced || input.hasRecords ? 'overview' : 'connections'
}

/** True while the owner is still setting up: no source has finished a first synchronization. */
export function setupInProgress(connections: ConnectionRow[] | null): boolean {
  return (connections ?? []).every((c) => !c.initial_sync_completed_at && !c.last_successful_sync_at)
}
