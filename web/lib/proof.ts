import type { Agent, SiteData, VerificationLevel } from './types';
import type { Publication } from './publication';
import { agentUniqueScenarios, shortHash } from './data';

export function runId(siteData: SiteData, snapshotId?: string | null): string {
  return snapshotId ?? siteData.benchmark.manifestId;
}

export function runProofNodes(
  siteData: SiteData,
  publication: Publication,
  agent?: Agent,
) {
  const { benchmark } = siteData;
  const id = runId(siteData, publication.snapshotId);
  const trace = agent ? publication.agents[agent.id] : null;
  const submissionHref = agent ? `/submissions/${agent.id}/` : `/runs/${id}/`;
  return [
    {
      label: 'Prompt',
      value: shortHash(agent?.generation.promptSha256 ?? benchmark.promptSha256),
      detail: 'prompt bytes hashed',
      href: agent ? `${submissionHref}#prompt` : `/runs/${id}/#configuration`,
    },
    {
      label: 'Harness run',
      value: agent ? `${agent.harness}@${agent.harnessVersion}` : benchmark.version,
      detail: trace ? 'session trace published' : 'local telemetry recorded',
      href: trace?.sessionUrl ?? `${submissionHref}#configuration`,
      external: Boolean(trace?.sessionUrl),
      state: trace ? 'verified' as const : 'partial' as const,
    },
    {
      label: 'Artifact',
      value: agent ? shortHash(agent.artifact.sourceSha256) : `${benchmark.totals.agents} agents`,
      detail: agent ? 'source hash matches manifest' : 'manifest-pinned roster',
      href: agent ? `${submissionHref}#artifact` : `/runs/${id}/#roster`,
    },
    {
      label: 'Probes',
      value: agent ? `${agent.generation.probeSummary.passed}/${agent.generation.probeSummary.total}` : '6/6 each',
      detail: 'sandboxed contract checks',
      href: agent ? `${submissionHref}#probes` : `/runs/${id}/#roster`,
    },
    {
      label: 'Battles',
      value: agent ? `${agent.standing.games} games` : `${benchmark.totals.matches} recorded`,
      detail: `${agent ? agentUniqueScenarios(agent) : benchmark.totals.uniqueScenarios} unique scenarios`,
      href: agent ? `/battles/?agent=${encodeURIComponent(agent.id)}` : '/battles/',
    },
    {
      label: 'Rating',
      value: agent ? `${agent.standing.elo} Elo` : 'provisional Elo',
      detail: agent ? 'uncertainty unavailable' : 'exploratory snapshot',
      href: agent ? `/results/?entry=${encodeURIComponent(agent.id)}` : '/results/',
      state: 'partial' as const,
    },
  ];
}

export function verificationLetter(level: VerificationLevel): string {
  return ({
    exploratory: 'E',
    'self-run': 'S',
    'trace-reviewed': 'T',
    'maintainer-verified': 'M',
  } as const)[level];
}
