import { describeConnection, formatAge, type ConnectionRow } from './catalog.ts'
import { gmailThreadLink, whoLabel } from './conversationInsights.ts'
import type { ConversationData } from './useConversations.ts'

/** Customer conversations from synchronized email. Facts and inferences are labelled separately. */
export function ConversationsPanel({ data, gmail, onOpenConnections }: {
  data: ConversationData; gmail: ConnectionRow | undefined; onOpenConnections: () => void
}) {
  const { threads, insights, error } = data
  const view = describeConnection(gmail)

  if (view.state === 'not_connected') {
    return <section className="panel conversations-panel" aria-labelledby="conversations-title"><h2 id="conversations-title">Customer conversations</h2>
      <p>No email is connected, so Revenue OS cannot tell which customers are waiting for you.</p>
      <button className="button button-secondary" type="button" onClick={onOpenConnections}>Connect Gmail</button></section>
  }
  const real = (threads ?? []).filter((t) => !t.all_automated)
  const waiting = insights.filter((i) => i.kind === 'awaiting_reply').length
  return <section className="panel conversations-panel" aria-labelledby="conversations-title" data-testid="conversations-panel">
    <div className="panel-heading"><div><h2 id="conversations-title">Customer conversations</h2>
      <p>From {gmail?.provider_account_email ?? 'your mailbox'} · last updated {formatAge(gmail?.last_successful_sync_at ?? null)}</p></div>
      {threads && <span className="status-pill">{waiting} waiting for you</span>}</div>
    {view.state === 'syncing' && !view.initialSyncDone && <p className="connection-note" role="status">{view.stage}. Results appear as records are stored{Number(gmail?.records_synced) > 0 ? ` (${Number(gmail?.records_synced).toLocaleString()} so far)` : ''}.</p>}
    {view.message && <p className="connection-message" role="alert">{view.message}</p>}
    {error && <p className="connection-message" role="alert">{error}</p>}
    {threads && <p className="conversation-facts">Observed: {real.length} customer conversation{real.length === 1 ? '' : 's'} in the last 90 days{threads.length - real.length > 0 ? ` (${threads.length - real.length} automated or newsletter thread${threads.length - real.length === 1 ? '' : 's'} ignored)` : ''}.</p>}
    {threads && insights.length === 0 && view.initialSyncDone && <div className="empty-state compact"><h3>{real.length === 0 ? 'No customer conversations found' : 'Nobody is waiting on you'}</h3>
      <p>{real.length === 0 ? 'Revenue OS found no non-automated email from the last 90 days. If your sales conversations happen elsewhere, connect that source or import a file.' : 'Every recent customer email either has a reply or is too recent to chase.'}</p></div>}
    <ul className="conversation-list">{insights.slice(0, 8).map((item) => <li key={item.thread.thread_id} className="conversation-item" data-kind={item.kind}>
      <div className="conversation-top"><strong>{whoLabel(item.thread)}</strong><span className="connection-pill">{item.kind === 'awaiting_reply' ? 'Waiting for your reply' : 'Gone quiet'}</span></div>
      <p className="conversation-subject">{item.thread.subject ?? '(no subject)'}</p>
      <p><span className="tag-observed">Observed</span> {item.observed}</p>
      <p><span className="tag-inferred">Inferred</span> {item.inference}</p>
      <p><span className="tag-action">Suggested</span> {item.recommendation}</p>
      <a className="template-link" href={gmailThreadLink(gmail?.provider_account_email ?? null, item.thread.thread_id)} target="_blank" rel="noreferrer">Open the original email →</a>
    </li>)}</ul>
  </section>
}
