import Link from 'next/link';

export function Header() {
  return (
    <header className="site-header">
      <div className="header-inner">
        <Link className="brand" href="/" aria-label="AgentBattler home">
          <span className="brand-prompt" aria-hidden="true">&gt;_</span>
          <span>agent-battler</span>
        </Link>
        <nav className="nav-links" aria-label="Primary navigation">
          <Link href="/">leaderboard</Link>
          <Link href="/combos/">combos</Link>
          <Link href="/methodology/">methodology</Link>
          <a href="https://github.com/aj47/agentbattler-bench" rel="noreferrer">github ↗</a>
        </nav>
      </div>
    </header>
  );
}
