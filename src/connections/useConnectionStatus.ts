import { useCallback, useEffect, useRef, useState } from 'react'
import type { SupabaseSession } from '../lib/supabaseRest.ts'
import { loadConnectionStatus } from './api.ts'
import { describeConnection, type ConnectionRow } from './catalog.ts'

/** Loads connection state and keeps it fresh: quickly while work is in progress, slowly otherwise. Navigating away never stops the server-side sync. */
export function useConnectionStatus(session: SupabaseSession, organizationId: string) {
  const [rows, setRows] = useState<ConnectionRow[] | null>(null)
  const [error, setError] = useState('')
  const timer = useRef<number | undefined>(undefined)
  const alive = useRef(true)

  const refresh = useCallback(async () => {
    try {
      const next = await loadConnectionStatus(session, organizationId)
      if (!alive.current) return null
      setRows(next); setError('')
      return next
    } catch (cause) {
      if (alive.current) setError(cause instanceof Error ? cause.message : 'Could not load connection status.')
      return null
    }
  }, [session, organizationId])

  useEffect(() => {
    alive.current = true
    let stopped = false
    const tick = async () => {
      const next = await refresh()
      if (stopped) return
      const busy = (next ?? []).some((row) => describeConnection(row).state === 'syncing')
      timer.current = window.setTimeout(() => void tick(), busy ? 2500 : 30000)
    }
    void tick()
    return () => { stopped = true; alive.current = false; window.clearTimeout(timer.current) }
  }, [refresh])

  return { rows, error, refresh }
}
