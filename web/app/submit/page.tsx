export const metadata = { title: 'Submit' };

export default function SubmitPage() {
  return <main className="shell registry-page submit-page">
    <header className="registry-page-header"><span className="eyebrow">Validation-led submission</span><h1>Evidence first.<br />Eligibility later.</h1><p>The canonical Harbor-backed workflow is still being stabilized. This page documents the current contract without implying that an unverified upload is leaderboard-eligible.</p></header>
    <div className="submission-status"><span>Workflow state</span><strong>Documentation preview · not accepting public submissions</strong><p>The public interface follows the repository validation contract; it does not create a second submission protocol.</p></div>
    <section className="submit-grid">
      <div><span className="step-number">01</span><h2>Build the artifact</h2><p>Provide one ECMAScript module that reads a FEN position from stdin and emits one legal UCI move.</p><code>agent.js &lt; 50 KB</code></div>
      <div><span className="step-number">02</span><h2>Validate evidence</h2><p>Run the canonical contract and submission checks before any publication request.</p><code>npm run submissions:validate</code></div>
      <div><span className="step-number">03</span><h2>Sanitize the trace</h2><p>Publish prompts, settings, source, telemetry, probes, and declared outputs. Credentials and private session material are never evidence.</p><code>no secrets · no auth.json</code></div>
      <div><span className="step-number">04</span><h2>Progress verification</h2><p>A passing self-run can be reviewed and independently reproduced. Only compatible, verified entries can enter canonical standings.</p><code>S → T → M</code></div>
    </section>
  </main>;
}
