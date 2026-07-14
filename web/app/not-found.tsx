import Link from 'next/link';

export default function NotFound() {
  return <main className="shell not-found"><span className="eyebrow">404 · no evidence found</span><h1>This artifact is not in the bundle.</h1><Link className="action-link" href="/">return to leaderboard →</Link></main>;
}
