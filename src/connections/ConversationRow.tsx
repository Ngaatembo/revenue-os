import { useState } from 'react'
import { gmailThreadLink, whoLabel, type ConversationInsight } from './conversationInsights.ts'
import { ownerHasWrittenTo, REMINDER_CHOICES } from './tracking.ts'
import type { ConversationData } from './useConversations.ts'

type Mode = 'none' | 'remind' | 'note' | 'mute'

/** One conversation that needs the owner, with the follow-up controls: handled, remind me, note, not a customer. */
export function ConversationRow({ item, data, account }: { item: ConversationInsight; data: ConversationData; account: string | null }) {
  const [mode, setMode] = useState<Mode>('none')
  const id = item.thread.thread_id
  const address = item.thread.counterpart_address
  const note = data.notes.get(id) ?? ''
  const [draft, setDraft] = useState(note)
  const busy = data.busyThread === id || (address !== null && data.busyThread === address)
  const wroteBefore = ownerHasWrittenTo(address, data.threads ?? [])
  const toggle = (next: Mode) => { setMode(mode === next ? 'none' : next); if (next === 'note') setDraft(note) }

  return <li className="conversation-item" data-kind={item.kind}>
    <div className="conversation-top"><strong>{whoLabel(item.thread)}</strong><span className="connection-pill">{item.kind === 'awaiting_reply' ? 'Waiting for your reply' : 'Gone quiet'}</span></div>
    <p className="conversation-subject">{item.thread.subject ?? '(no subject)'}</p>
    <p><span className="tag-observed">Observed</span> {item.observed}</p>
    <p><span className="tag-inferred">Inferred</span> {item.inference}</p>
    <p><span className="tag-action">Suggested</span> {item.recommendation}</p>
    {note && mode !== 'note' && <p className="conversation-note"><strong>Your note:</strong> {note}</p>}
    <a className="template-link" href={gmailThreadLink(account, id)} target="_blank" rel="noreferrer">Open the original email →</a>
    {data.trackingAvailable && <div className="track-actions" role="group" aria-label={`Follow-up for ${whoLabel(item.thread)}`}>
      <button type="button" className="button button-primary track-primary" disabled={busy} onClick={() => void data.actions.markHandled(id)}>Mark handled</button>
      <button type="button" className="button button-secondary" aria-expanded={mode === 'remind'} disabled={busy} onClick={() => toggle('remind')}>Remind me</button>
      <button type="button" className="button button-secondary" aria-expanded={mode === 'note'} disabled={busy} onClick={() => toggle('note')}>{note ? 'Edit note' : 'Add note'}</button>
      {address && <button type="button" className="button button-quiet" aria-expanded={mode === 'mute'} disabled={busy} onClick={() => toggle('mute')}>Not a customer</button>}
    </div>}
    {mode === 'remind' && <div className="track-panel" role="group" aria-label="Remind me">
      {REMINDER_CHOICES.map((choice) => <button key={choice.id} type="button" className="button button-secondary" disabled={busy} onClick={() => { setMode('none'); void data.actions.remind(id, choice.id) }}>{choice.label}</button>)}
      <small>It returns sooner if the customer writes again.</small>
    </div>}
    {mode === 'note' && <form className="track-panel" onSubmit={(event) => { event.preventDefault(); setMode('none'); void data.actions.saveNote(id, draft) }}>
      <label>Your note (only your team sees it)
        <textarea rows={2} maxLength={500} value={draft} onChange={(event) => setDraft(event.target.value)} placeholder="e.g. quoted $400, waiting on deposit" />
      </label>
      <div className="track-buttons"><button type="submit" className="button button-primary" disabled={busy}>Save note</button><button type="button" className="button button-secondary" onClick={() => setMode('none')}>Cancel</button></div>
    </form>}
    {mode === 'mute' && address && <div className="track-panel" role="group" aria-label="Hide this sender">
      <p>Hide everything from <strong>{address}</strong> from this list? {wroteBefore ? 'You have written to this sender before, so they may be a real customer. ' : ''}You can unhide them later under “Hidden senders”.</p>
      <div className="track-buttons"><button type="button" className="button button-primary" disabled={busy} onClick={() => { setMode('none'); void data.actions.mute(address) }}>Hide this sender</button><button type="button" className="button button-secondary" onClick={() => setMode('none')}>Cancel</button></div>
    </div>}
  </li>
}
