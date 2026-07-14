import type { VerificationLevel } from '../lib/types';

export function VerificationBadge({ level, label }: { level: VerificationLevel; label: string }) {
  return <span className={`verification-badge verification-${level}`}>{label}</span>;
}
