import { describeConnection, formatAge, type ConnectionRow } from './catalog.ts'
import { automatedThreadIds, whoLabel } from './conversationInsights.ts'
import { ConversationRow } from './ConversationRow.tsx'
import type { SetAside } from './tracking.ts'
import type { ConversationData } from './useConversations.ts'

const dateOnly = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' })
function setAsideLabel(reason: SetAside['reason'], tracking: SetAside['tracking']): string {
  if (reason === 'handled') return `Handled ${formatAge(tracking.handled_at)}`
  return tracking.remind_at ? `Snoozed until ${dateOnly.format(new Date(tracking.remind_at))}` : 'Snoozed'
}

/** Customer conversations from synchronized email. Facts and inferences are labelled separately. */
export function ConversationsPanel({ data, gmail, onOpenConnections }: {
  data: ConversationData; gmail: ConnectionRow | undefined; onOpenConnections: () => void
}) {
  const { threads, insights, error } = data
  const view = describeConnection(gmail)

  if (view.state === 'not_connected') {
    return <section id="conversations" className="panel conversations-panel" aria-labelledby="conversations-title"><h2 id="conversations-title">Customer conversations</h2>
      <p>No email is connected, so Revenue OS cannot tell which customers are waiting for you.</p>
      <button className="button button-secondary" type="button" onClick={onOpenConnections}>Connect Gmail</button></section>
  }
  const automated = automatedThreadIds(threads ?? [])
  const real = (threads ?? []).filter((t) => !automated.has(t.thread_id))
  const waiting = insights.filter((i) => i.kind === 'awaiting_reply').length
  return <section id="conversations" className="panel conversations-panel" aria-labelledby="conversations-title" data-testid="conversations-panel">
    <div className="panel-heading"><div><h2 id="conversations-title">Customer conversations</h2>
      <p>From {gmail?.provider_account_email ?? 'your mailbox'} · last updated {formatAge(gmail?.last_successful_sync_at ?? null)}</p></div>
      {threads && <span className="status-pill">{waiting} waiting for you</span>}</div>
    {view.state === 'syncing' && !view.initialSyncDone && <p className="connection-note" role="status">{view.stage}. Results appear as records are stored{Number(gmail?.records_synced) > 0 ? ` (${Number(gmail?.records_synced).toLocaleString()} so far)` : ''}.</p>}
    {view.message && <p className="connection-message" role="alert">{view.message}</p>}
    {error && <p className="connection-message" role="alert">{error}</p>}
    {threads && <p className="conversation-facts">Observed: {real.length} customer conversation{real.length === 1 ? '' : 's'} in the last 90 days{threads.length - real.length > 0 ? ` (${threads.length - real.length} automated or notification thread${threads.length - real.length === 1 ? '' : 's'} ignored)` : ''}.</p>}
    {threads && insights.length === 0 && view.initialSyncDone && <div className="empty-state compact"><h3>{real.length === 0 ? 'No customer conversations found' : 'Nobody is waiting on you'}</h3>
      <p>{real.length === 0 ? 'Revenue OS found no non-automated email from the last 90 days. If your sales conversations happen elsewhere, connect that source or import a file.' : 'Every recent customer email either has a reply or is too recent to chase.'}</p></div>}
    {(['awaiting_reply', 'gone_quiet'] as const).map((kind) => {
      const rows = insights.filter((i) => i.kind === kind).slice(0, kind === 'awaiting_reply' ? 8 : 5)
      if (rows.length === 0) return null
      return <div className="conversation-group" key={kind} data-group={kind}>
        <h3 className="conversation-group-title">{kind === 'awaiting_reply' ? 'Waiting for your reply' : 'Gone quiet — you wrote last'} <span>{rows.length}</span></h3>
        <ul className="conversation-list">{rows.map((item) => <ConversationRow key={item.thread.thread_id} item={item} data={data} account={gmail?.provider_account_email ?? null} />)}</ul>
      </div>
    })}
    {data.actionError && <p className="connection-message" role="alert">{data.actionError}</p>}
    {data.trackingAvailable && data.setAside.length > 0 && <details className="set-aside" data-testid="set-aside">
      <summary>Handled and snoozed ({data.setAside.length})</summary>
      <ul className="conversation-list">{data.setAside.map(({ thread, tracking, reason }) => <li key={thread.thread_id} className="conversation-item is-set-aside">
        <div className="conversation-top"><strong>{whoLabel(thread)}</strong><span className="connection-pill">{setAsideLabel(reason, tracking)}</span></div>
        <p className="conversation-subject">{thread.subject ?? '(no subject)'}</p>
        {tracking.note && <p className="conversation-note"><strong>Your note:</strong> {tracking.note}</p>}
        <div className="track-actions"><button type="button" className="button button-secondary" disabled={data.busyThread === thread.thread_id} onClick={() => void data.actions.reopen(thread.thread_id)}>Reopen</button></div>
      </li>)}</ul>
    </details>}
    {data.trackingAvailable && data.mutedSenders.length > 0 && <details className="set-aside" data-testid="hidden-senders">
      <summary>Hidden senders ({data.mutedSenders.length})</summary>
      <ul className="conversation-list">{data.mutedSenders.map((address) => <li key={address} className="conversation-item is-set-aside">
        <div className="conversation-top"><strong>{address}</strong></div>
        <div className="track-actions"><button type="button" className="button button-secondary" disabled={data.busyThread === address} onClick={() => void data.actions.unmute(address)}>Unhide</button></div>
      </li>)}</ul>
    </details>}
  </section>
}
