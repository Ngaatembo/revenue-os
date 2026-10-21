export function Welcome({ onContinue }: { onContinue: () => void }) {
  return <div className="welcome-backdrop" role="dialog" aria-modal="true" aria-labelledby="welcome-title">
    <div className="welcome-card">
      <p className="eyebrow">WELCOME TO REVENUE OS</p>
      <h2 id="welcome-title">Your business watchman</h2>
      <p>Connect the tools you already use. Revenue OS keeps itself up to date, then shows you which customers are waiting on you and which invoices are overdue — with the original record behind every item.</p>
      <ol className="welcome-steps">
        <li><strong>Connect</strong> your email or invoice spreadsheet. You approve access on the provider's own page.</li>
        <li><strong>Wait a moment</strong> while the first synchronization runs. You can leave; it carries on.</li>
        <li><strong>Review</strong> what needs attention. Nothing is ever sent to a customer without you.</li>
      </ol>
      <button className="button button-primary" type="button" onClick={onContinue}>Choose what to connect</button>
    </div>
  </div>
}
