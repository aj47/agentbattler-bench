import Link from 'next/link';

import type { VerificationLevel } from '../lib/types';

type ProofNode = {
  label: string;
  value: string;
  detail: string;
  href: string;
  external?: boolean;
  state?: 'verified' | 'partial' | 'unavailable';
};

export function ProofSpine({
  nodes,
  level,
  label = 'Evidence chain',
}: {
  nodes: ProofNode[];
  level: VerificationLevel;
  label?: string;
}) {
  return (
    <nav className={`proof-spine proof-spine-${level}`} aria-label={label}>
      <ol>
        {nodes.map((node, index) => {
          const content = (
            <>
              <span className="proof-index" aria-hidden="true">{String(index + 1).padStart(2, '0')}</span>
              <span className={`proof-state proof-state-${node.state ?? 'verified'}`} aria-hidden="true">
                {node.state === 'unavailable' ? '—' : node.state === 'partial' ? '!' : '✓'}
              </span>
              <span className="proof-copy">
                <strong>{node.label}</strong>
                <span>{node.value}</span>
                <small>{node.detail}</small>
              </span>
            </>
          );
          return (
            <li key={node.label}>
              {node.external ? (
                <a href={node.href} target="_blank" rel="noreferrer">{content}</a>
              ) : (
                <Link href={node.href}>{content}</Link>
              )}
            </li>
          );
        })}
      </ol>
    </nav>
  );
}
