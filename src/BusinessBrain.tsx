import { useMemo, useState, type FormEvent } from 'react'
import {
  BRAIN_SETTINGS, CLASS_LABELS, activeFacts, factHistory, findConflicts, resolveAllSettings, validateFactKey, validateFactValue,
  type BrainFact, type DerivedEntry, type RecordMismatch, type StoredFactKind,
} from './domain/businessBrain'
import type { AssumptionChange } from './lib/supabaseRest'

const fmt = (value: string) => new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value))
const pct = (bps: number | null) => bps === null ? 'Not set' : `${(bps / 100).toFixed(2).replace(/\.00$/, '')}%`

type Props = {
  facts: BrainFact[]
  derived: DerivedEntry[]
  mismatches: RecordMismatch[]
  assumptionBps: number | null
  assumptionHistory: AssumptionChange[]
  loading: boolean
  loadError: string
  busy: boolean
  notice: string
  onRecord: (input: { key: string; value: string; kind: StoredFactKind; sourceLabel: string; note?: string }) => Promise<string | null>
  onRetract: (fact: BrainFact, reason: string) => Promise<string | null>
  onResolve: (key: string, keep: BrainFact, reason: string) => Promise<string | null>
  onSaveRecoveryRate: (percent: string) => Promise<string | null>
}

function FactLine({ fact }: { fact: BrainFact }) {
  return <li className={'brain-fact brain-fact-' + fact.status}>
    <strong>{fact.value}</strong> <span className="brain-tag">{CLASS_LABELS[fact.kind]}</span>
    {fact.status !== 'active' && <span className="brain-tag brain-tag-muted">{fact.status === 'superseded' ? 'Replaced' : 'Retracted'}</span>}
    <br /><small>Source: {fact.sourceLabel} · recorded {fmt(fact.recordedAt)}{fact.note ? ` · ${fact.note}` : ''}{fact.statusReason && fact.status !== 'active' ? ` · ${fact.statusReason}` : ''}</small>
  </li>
}

export function BusinessBrain(props: Props) {
  const { facts, derived, mismatches, assumptionBps, assumptionHistory, loading, loadError, busy, notice } = props
  const [editing, setEditing] = useState<string | null>(null)
  const [value, setValue] = useState('')
  const [source, setSource] = useState('')
  const [kind, setKind] = useState<StoredFactKind>('user_entered')
  const [customKey, setCustomKey] = useState('')
  const [customValue, setCustomValue] = useState('')
  const [customSource, setCustomSource] = useState('')
  const [reason, setReason] = useState('')
  const [rate, setRate] = useState('')
  const [error, setError] = useState('')
  const settings = useMemo(() => resolveAllSettings(facts), [facts])
  const conflicts = useMemo(() => findConflicts(facts), [facts])
  const customKeys = useMemo(() => [...new Set(activeFacts(facts).map((fact) => fact.key))].filter((key) => !BRAIN_SETTINGS.some((setting) => setting.key === key)).sort(), [facts])

  async function save(event: FormEvent, key: string, rawValue: string, rawSource: string, factKind: StoredFactKind): Promise<boolean> {
    event.preventDefault()
    setError('')
    const keyError = validateFactKey(key)
    if (keyError) { setError(keyError); return false }
    const checked = validateFactValue(key, rawValue)
    if (!checked.ok) { setError(checked.error); return false }
    if (!rawSource.trim()) { setError('Say where this comes from (for example "Owner, phone call" or "Contract with Acme").'); return false }
    const message = await props.onRecord({ key, value: checked.value, kind: factKind, sourceLabel: rawSource.trim() })
    if (message) { setError(message); return false }
    return true
  }

  async function act(run: () => Promise<string | null>) {
    setError('')
    const message = await run()
    if (message) setError(message); else setReason('')
  }

  if (loading) return <section className="panel"><p>Loading what your business knows…</p></section>
  return <div className="brain-page">
    <section className="panel">
      <div className="panel-heading"><div><h2>Business Brain</h2><p>What Revenue OS knows about your business, where each fact came from, and how sure it is. Estimates and assumptions are never shown as revenue.</p></div></div>
      {loadError && <div className="alert alert-error" role="alert">{loadError}</div>}
      {notice && <div className="alert alert-info" role="status">{notice}</div>}
      {error && <div className="alert alert-error" role="alert">{error}</div>}
      <details className="brain-reason-disclosure">
        <summary>Need to retract a fact or resolve a conflict?</summary>
        <p>Only open this if you are changing or removing an existing fact. A short reason is required before those actions can be saved.</p>
        <label>Reason for this change<input maxLength={500} value={reason} onChange={(event) => setReason(event.target.value)} placeholder="e.g. Entered by mistake" /></label>
      </details>
    </section>

    {conflicts.length > 0 && <section className="panel brain-conflicts" aria-labelledby="conflicts-title">
      <div className="panel-heading"><div><h2 id="conflicts-title">Conflicting facts ({conflicts.length})</h2><p>Two sources disagree. Until you choose, the built-in default is used for rules, not either value.</p></div></div>
      {conflicts.map((conflict) => <div className="brain-conflict" key={conflict.key}>
        <strong>{BRAIN_SETTINGS.find((s) => s.key === conflict.key)?.label ?? conflict.key}</strong>
        <ul className="brain-facts">{conflict.facts.map((fact) => <li key={fact.id}><FactLine fact={fact} />
          <button className="button button-secondary" type="button" disabled={busy || reason.trim().length < 3} onClick={() => void act(() => props.onResolve(conflict.key, fact, reason.trim()))}>Keep this one</button>
        </li>)}</ul>
      </div>)}
    </section>}

    {mismatches.length > 0 && <section className="panel" aria-labelledby="mismatch-title">
      <div className="panel-heading"><div><h2 id="mismatch-title">Your records disagree with what you told us</h2><p>Nothing was changed. Decide which is right and update the fact if needed.</p></div></div>
      <ul className="brain-facts">{mismatches.map((mismatch) => <li key={mismatch.message}>{mismatch.message}</li>)}</ul>
    </section>}

    <section className="panel" aria-labelledby="settings-title">
      <div className="panel-heading"><div><h2 id="settings-title">Settings the rules use</h2><p>These drive when something needs your attention. Anything you have not confirmed uses a built-in default and says so.</p></div></div>
      <div className="brain-settings">{BRAIN_SETTINGS.map((setting) => {
        const resolved = settings[setting.key]
        const history = factHistory(facts, setting.key)
        return <article className="brain-setting" key={setting.key}>
          <div className="brain-setting-top"><div><strong>{setting.label}</strong><small>{setting.help}</small></div>
            <div className="brain-setting-value"><strong>{resolved.value} {setting.unit}</strong><span className={'brain-tag' + (resolved.source === 'default' ? ' brain-tag-muted' : '')}>{resolved.conflicted ? 'Conflict, default used' : CLASS_LABELS[resolved.source]}</span></div></div>
          <p className="brain-note">{resolved.explanation}</p>
          <div className="recovery-action-controls">
            <button className="button button-secondary" type="button" aria-expanded={editing === setting.key} onClick={() => { setEditing(editing === setting.key ? null : setting.key); setError(''); setValue(String(resolved.source === 'default' ? '' : resolved.value)) }}>{resolved.source === 'default' ? 'Set value' : 'Change'}</button>
            {resolved.factId && <button className="button button-quiet" type="button" disabled={busy || reason.trim().length < 3} title="Enter a reason at the top first" onClick={() => void act(() => props.onRetract(facts.find((f) => f.id === resolved.factId)!, reason.trim()))}>Retract</button>}
          </div>
          {editing === setting.key && <form className="issue-form" onSubmit={(event) => void save(event, setting.key, value, source, kind).then((saved) => { if (saved) { setEditing(null); setValue(''); setSource(''); setKind('user_entered') } })}>
            <label>{setting.label} ({setting.unit})<input required inputMode="numeric" value={value} onChange={(event) => setValue(event.target.value)} /></label>
            <label>Where does this come from?<input required maxLength={200} value={source} onChange={(event) => setSource(event.target.value)} placeholder="e.g. Owner, our standard terms" /></label>
            <label>How sure are you?<select value={kind} onChange={(event) => setKind(event.target.value as StoredFactKind)}>
              <option value="user_entered">I know this (entered by me)</option><option value="imported">Copied from a document</option><option value="assumption">An assumption</option><option value="estimate">An estimate</option></select></label>
            <div className="recovery-action-controls"><button className="button button-primary" type="submit" disabled={busy}>{busy ? 'Saving…' : 'Save'}</button><button className="button button-quiet" type="button" onClick={() => setEditing(null)}>Cancel</button></div>
          </form>}
          {history.length > 0 && <details className="why-details"><summary>History ({history.length})</summary><ul className="brain-facts">{history.map((fact) => <FactLine key={fact.id} fact={fact} />)}</ul></details>}
        </article>
      })}</div>
      {(resolveReasonHint(settings))}
    </section>

    <section className="panel" aria-labelledby="notes-title">
      <div className="panel-heading"><div><h2 id="notes-title">Other things your business knows</h2><p>Facts in your own words, each with a source.</p></div></div>
      {customKeys.length === 0 ? <p className="brain-note">Nothing recorded yet.</p> : <ul className="brain-facts">{customKeys.map((key) => <li key={key}><strong>{key.replace(/_/g, ' ')}</strong><ul>{activeFacts(facts, key).map((fact) => <li key={fact.id}><FactLine fact={fact} />
        <button className="button button-quiet" type="button" disabled={busy || reason.trim().length < 3} title="Enter a reason at the top first" onClick={() => void act(() => props.onRetract(fact, reason.trim()))}>Retract</button></li>)}</ul></li>)}</ul>}
      <form className="issue-form" onSubmit={(event) => void save(event, customKey.trim(), customValue, customSource, 'user_entered').then((saved) => { if (saved) { setCustomKey(''); setCustomValue(''); setCustomSource('') } })}>
        <label>Name (lowercase, underscores)<input maxLength={61} value={customKey} onChange={(event) => setCustomKey(event.target.value)} placeholder="preferred_payment_method" /></label>
        <label>Value<input maxLength={500} value={customValue} onChange={(event) => setCustomValue(event.target.value)} /></label>
        <label>Source<input maxLength={200} value={customSource} onChange={(event) => setCustomSource(event.target.value)} placeholder="Who or what says so" /></label>
        <button className="button button-secondary" type="submit" disabled={busy}>Add fact</button>
      </form>
    </section>

    <section className="panel" aria-labelledby="records-title">
      <div className="panel-heading"><div><h2 id="records-title">From your records</h2><p>Calculated live from imported invoices and payments. Not editable, so they cannot drift from the source.</p></div></div>
      <div className="brain-derived">{derived.map((entry) => <article key={entry.id} className="brain-derived-item">
        <div><strong>{entry.label}</strong><small>{entry.source}</small></div>
        <div><strong>{entry.value}</strong><span className="brain-tag">{CLASS_LABELS[entry.cls]}</span></div>
        <small>{entry.basis}</small>
        {entry.id === 'recovery_rate' && <form className="issue-form" onSubmit={(event) => { event.preventDefault(); void act(() => props.onSaveRecoveryRate(rate)) }}>
          <label>Recovery rate (%)<input inputMode="decimal" value={rate} onChange={(event) => setRate(event.target.value)} placeholder={assumptionBps === null ? 'e.g. 25' : pct(assumptionBps).replace('%', '')} /></label>
          <button className="button button-secondary" type="submit" disabled={busy || !rate.trim()}>Save assumption</button>
          {assumptionHistory.length > 0 && <details className="why-details"><summary>Change history ({assumptionHistory.length})</summary><ul className="brain-facts">{assumptionHistory.map((change) => <li key={change.id}>{change.oldBps === null ? 'Set to' : `${pct(change.oldBps)} →`} <strong>{pct(change.newBps)}</strong> · {fmt(change.at)}</li>)}</ul></details>}
        </form>}
      </article>)}</div>
    </section>

    <section className="panel" id="csv-format"><div className="format-box"><strong>Invoice CSV columns</strong><code>customer_id, customer_name, invoice_number, currency, total_amount, paid_amount, issued_at, due_at</code><small>Amounts use a decimal point and up to two decimal places. Currency must be a three-letter ISO code such as USD.</small></div></section>
  </div>
}

function resolveReasonHint(settings: ReturnType<typeof resolveAllSettings>) {
  const defaults = Object.values(settings).filter((setting) => setting.source === 'default' && !setting.conflicted).length
  return defaults > 0 ? <p className="brain-note">{defaults} setting{defaults === 1 ? ' uses' : 's use'} a built-in default you have not confirmed.</p> : null
}
