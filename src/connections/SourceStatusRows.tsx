import { describeConnection, formatAge, type ConnectionRow } from './catalog.ts'

const ROWS: Array<{ provider: string; name: string }> = [{ provider: 'gmail', name: 'Gmail' }, { provider: 'google_sheets', name: 'Google Sheets' }]

/** Real per-source state for the monitoring panel. WhatsApp is listed as unavailable because it genuinely is. */
export function SourceStatusRows({ rows }: { rows: ConnectionRow[] | null }) {
  return <>
    {ROWS.map(({ provider, name }) => {
      const row = rows?.find((r) => r.provider === provider)
      const view = describeConnection(row)
      const dot = view.state === 'connected' ? 'connection-dot' : 'connection-dot connection-dot-muted'
      const text = rows === null ? 'Checking…' : view.state === 'not_connected' ? 'Not connected'
        : `${view.label}${row?.last_successful_sync_at ? ` · last synchronized ${formatAge(row.last_successful_sync_at)}` : view.stage ? ` · ${view.stage}` : ''}`
      return <div key={provider}><span><i className={dot} />{name}</span><strong>{text}</strong></div>
    })}
    <div><span><i className="connection-dot connection-dot-muted" />WhatsApp Business</span><strong>Not available yet</strong></div>
  </>
}
