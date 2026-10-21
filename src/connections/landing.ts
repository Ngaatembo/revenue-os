import type { ConnectionRow } from './catalog.ts'

export type Landing = 'loading' | 'welcome' | 'connections' | 'overview'

/**
 * Where a signed-in owner should land.
 *  - First visit with nothing set up: a short welcome, then Connections.
 *  - Setup started but not finished: resume on Connections.
 *  - Setup done (a source has synced, or records already exist): Overview, never forced back.
 */
export function decideLanding(input: { welcomeSeen: boolean; connections: ConnectionRow[] | null; hasRecords: boolean; recordsLoading: boolean }): Landing {
  if (input.connections === null || input.recordsLoading) return 'loading'
  const synced = input.connections.some((c) => Boolean(c.initial_sync_completed_at || c.last_successful_sync_at))
  if (synced || input.hasRecords) return 'overview'
  return input.welcomeSeen ? 'connections' : 'welcome'
}

const key = (userId: string, organizationId: string) => `revenue-os.welcome.${userId}.${organizationId}`
export function readWelcomeSeen(userId: string, organizationId: string): boolean {
  try { return localStorage.getItem(key(userId, organizationId)) === '1' } catch { return false }
}
export function writeWelcomeSeen(userId: string, organizationId: string) {
  try { localStorage.setItem(key(userId, organizationId), '1') } catch { /* private mode: the welcome simply shows again */ }
}
