import { useMemo, useState, type FormEvent } from 'react'

type Stage = 'Enquiry' | 'Quote sent' | 'Awaiting decision' | 'Deposit pending' | 'Won' | 'Lost'
type FollowUpRecord = {
  id: string
  prospect: string
  stage: Stage
  nextStep: string
  dueDate: string
  value: string
  currency: string
  createdAt: string
}

const stages: Stage[] = ['Enquiry', 'Quote sent', 'Awaiting decision', 'Deposit pending', 'Won', 'Lost']

function todayIso() {
  const now = new Date()
  const local = new Date(now.getTime() - now.getTimezoneOffset() * 60_000)
  return local.toISOString().slice(0, 10)
}

function alertState(record: FollowUpRecord, today: string) {
  if (record.stage === 'Won' || record.stage === 'Lost') return 'Resolved' as const
  if (!record.nextStep.trim() || !record.dueDate) return 'Needs review' as const
  if (record.dueDate < today) return 'Overdue next step' as const
  return 'On track' as const
}

export default function StalledOpportunities() {
  const [records, setRecords] = useState<FollowUpRecord[]>([])
  const [prospect, setProspect] = useState('')
  const [stage, setStage] = useState<Stage>('Quote sent')
  const [nextStep, setNextStep] = useState('')
  const [dueDate, setDueDate] = useState('')
  const [value, setValue] = useState('')
  const [currency, setCurrency] = useState('USD')
  const [notice, setNotice] = useState('')
  const today = todayIso()

  const flagged = useMemo(() => records.filter((record) => {
    const state = alertState(record, today)
    return state === 'Overdue next step' || state === 'Needs review'
  }), [records, today])

  function addRecord(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const cleanProspect = prospect.trim()
    if (!cleanProspect) return
    const record: FollowUpRecord = {
      id: `opp-${Date.now()}-${records.length}`,
      prospect: cleanProspect,
      stage,
      nextStep: nextStep.trim(),
      dueDate,
      value: value.trim(),
      currency: currency.trim().toUpperCase() || 'USD',
      createdAt: new Date().toISOString(),
    }
    setRecords((current) => [record, ...current])
    setProspect('')
    setNextStep('')
    setDueDate('')
    setValue('')
    setNotice('Opportunity added for this browser session.')
  }

  function updateStage(id: string, nextStage: Stage) {
    setRecords((current) => current.map((record) => record.id === id ? { ...record, stage: nextStage } : record))
  }

  function removeRecord(id: string) {
    setRecords((current) => current.filter((record) => record.id !== id))
  }

  return (
    <div className="stalled-workspace">
      <section className="panel stalled-intro">
        <div>
          <p className="eyebrow">FIRST WORKFLOW · MANUAL REVIEW</p>
          <h2>Stalled prospects and quotations</h2>
          <p>Track a specific promised next step. Revenue OS flags overdue dates only when the next step is known; missing details are marked for review, not guessed.</p>
        </div>
        <div className="stalled-summary">
          <span>Needs attention</span>
          <strong>{flagged.length}</strong>
          <small>overdue or incomplete records</small>
        </div>
      </section>

      <section className="panel stalled-form-panel">
        <div className="panel-heading"><div><h2>Add an opportunity</h2><p>Use aliases or short labels. Do not paste private conversations or sensitive customer data.</p></div></div>
        <form className="stalled-form" onSubmit={addRecord}>
          <label>Prospect or quote label<input value={prospect} onChange={(event) => setProspect(event.target.value)} placeholder="e.g. P-01 · lodge website" required maxLength={100} /></label>
          <label>Current stage<select value={stage} onChange={(event) => setStage(event.target.value as Stage)}>{stages.map((item) => <option key={item} value={item}>{item}</option>)}</select></label>
          <label className="stalled-wide">Promised next step<input value={nextStep} onChange={(event) => setNextStep(event.target.value)} placeholder="e.g. Call to confirm quotation feedback" maxLength={180} /></label>
          <label>Next step due date<input type="date" value={dueDate} onChange={(event) => setDueDate(event.target.value)} /></label>
          <label>Known quote value (optional)<input value={value} onChange={(event) => setValue(event.target.value)} inputMode="decimal" placeholder="e.g. 250" /></label>
          <label>Currency<select value={currency} onChange={(event) => setCurrency(event.target.value)}><option>USD</option><option>ZWL</option><option>ZIG</option><option>ZAR</option><option>GBP</option><option>EUR</option></select></label>
          <div className="stalled-form-actions"><button className="button button-primary" type="submit">Add opportunity</button><span>Only known dates trigger overdue alerts.</span></div>
        </form>
        {notice && <p className="stalled-notice" role="status">{notice}</p>}
      </section>

      <section className="panel stalled-records-panel">
        <div className="panel-heading"><div><h2>Opportunity review</h2><p>Changes stay in this tab only and are cleared when you leave or refresh.</p></div><span className="status-pill">{records.length} tracked</span></div>
        {records.length === 0 ? (
          <div className="empty-state compact"><span className="empty-icon">+</span><h3>No opportunities added yet</h3><p>Add a current prospect or quotation above to test the rules.</p></div>
        ) : (
          <div className="stalled-record-list">
            {records.map((record) => {
              const state = alertState(record, today)
              return <article className="stalled-record" key={record.id}>
                <div className="stalled-record-top">
                  <div><strong>{record.prospect}</strong><p>{record.stage}{record.value ? ` · Quoted value: ${record.currency} ${record.value}` : ''}</p></div>
                  <span className={`stalled-state ${state === 'Overdue next step' ? 'is-overdue' : state === 'Needs review' ? 'is-review' : state === 'Resolved' ? 'is-resolved' : 'is-track'}`}>{state}</span>
                </div>
                <p className="stalled-next-step">{record.nextStep || 'No next step recorded.'}</p>
                <small>{record.dueDate ? `Due ${record.dueDate}` : 'No due date recorded'}{record.dueDate && record.dueDate < today && state === 'Overdue next step' ? ` · ${Math.floor((Date.parse(`${today}T00:00:00Z`) - Date.parse(`${record.dueDate}T00:00:00Z`)) / 86_400_000)} day(s) past due` : ''}</small>
                <div className="stalled-record-actions">
                  <label>Update stage<select value={record.stage} onChange={(event) => updateStage(record.id, event.target.value as Stage)}>{stages.map((item) => <option key={item} value={item}>{item}</option>)}</select></label>
                  <button className="template-link" type="button" onClick={() => removeRecord(record.id)}>Remove</button>
                </div>
              </article>
            })}
          </div>
        )}
      </section>
      <p className="stalled-disclaimer">Prototype only: this is not connected to WhatsApp, email, or a database. It does not send reminders or prove that a follow-up recovered revenue.</p>
    </div>
  )
}
