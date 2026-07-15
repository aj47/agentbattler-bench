import Link from 'next/link';

export function Header() {
  return (
    <header className="site-header">
      <div className="header-inner">
        <Link className="brand" href="/" aria-label="AgentBattler home">
          <span className="brand-mark" aria-hidden="true">AB</span>
          <span>AgentBattler</span>
          <small>public evidence registry</small>
        </Link>
        <nav className="nav-links" aria-label="Primary navigation">
          <Link href="/results/">Results</Link>
          <Link href="/battles/">Battles</Link>
          <Link href="/runs/">Runs</Link>
          <Link href="/methodology/">Methodology</Link>
          <Link href="/submit/">Submit</Link>
        </nav>
        <a className="header-evidence-link" href="https://github.com/aj47/agentbattler-bench" rel="noreferrer">GitHub ↗</a>
      </div>
    </header>
  );
}
