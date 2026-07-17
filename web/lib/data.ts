import rawData from '../generated/site-data.json';
import type { Agent, HarnessModelEntrant, Match, SiteData } from './types';

export const siteData = rawData as unknown as SiteData;

function roundScore(value: number): number {
  return Math.round(value * 100) / 100;
}

function median(values: number[]): number {
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[middle - 1] + sorted[middle]) / 2
    : sorted[middle];
}

export function aggregateHarnessModelEntrants(data: SiteData): HarnessModelEntrant[] {
  const harnesses = new Map(data.harnesses.map((harness) => [harness.id, harness]));
  const buckets = new Map<string, Omit<HarnessModelEntrant, 'rank' | 'artifactScore' | 'scorePct'>>();
  const controlledStats = new Map<string, { games: number; wins: number; draws: number; losses: number; points: number }>();

  for (const match of data.matches) {
    if (match.white.harness === match.black.harness || match.white.model !== match.black.model || match.final.outcome === 'void') continue;
    const draw = match.final.outcome === '1/2-1/2';
    for (const [agent, won] of [
      [match.white, match.final.outcome === '1-0'],
      [match.black, match.final.outcome === '0-1'],
    ] as const) {
      const stats = controlledStats.get(agent.id) ?? { games: 0, wins: 0, draws: 0, losses: 0, points: 0 };
      stats.games += 1;
      stats.wins += won ? 1 : 0;
      stats.draws += draw ? 1 : 0;
      stats.losses += !draw && !won ? 1 : 0;
      stats.points += won ? 1 : draw ? 0.5 : 0;
      controlledStats.set(agent.id, stats);
    }
  }

  for (const agent of data.agents) {
    const stats = controlledStats.get(agent.id);
    if (!stats) continue;
    const key = `${agent.harness}:${agent.familyId}`;
    const harness = harnesses.get(agent.harness);
    const family = harness?.families.find((candidate) => candidate.id === agent.familyId);
    const fallbackFamilyName = agent.model.startsWith('gpt-5.6-')
      ? `GPT-5.6 ${agent.familyId[0].toUpperCase()}${agent.familyId.slice(1)}`
      : agent.familyId;
    const artifactScore = stats.games > 0
      ? roundScore((stats.points / stats.games) * 100)
      : 0;
    const bucket = buckets.get(key) ?? {
      id: key,
      harness: agent.harness,
      harnessDisplayName: harness?.displayName ?? agent.harness,
      harnessVersion: agent.harnessVersion,
      familyId: agent.familyId,
      familyDisplayName: family?.displayName ?? fallbackFamilyName,
      model: agent.model,
      artifacts: [],
      games: 0,
      wins: 0,
      draws: 0,
      losses: 0,
      points: 0,
    };

    bucket.artifacts.push({
      id: agent.id,
      displayName: agent.displayName,
      games: stats.games,
      wins: stats.wins,
      draws: stats.draws,
      losses: stats.losses,
      points: stats.points,
      scorePct: artifactScore,
    });
    bucket.games += stats.games;
    bucket.wins += stats.wins;
    bucket.draws += stats.draws;
    bucket.losses += stats.losses;
    bucket.points += stats.points;
    buckets.set(key, bucket);
  }

  return [...buckets.values()]
    .map((bucket) => {
      const scores = bucket.artifacts.map((artifact) => artifact.scorePct);
      return {
        ...bucket,
        rank: 0,
        scorePct: bucket.games > 0 ? roundScore((bucket.points / bucket.games) * 100) : 0,
        artifactScore: {
          minimum: Math.min(...scores),
          median: roundScore(median(scores)),
          maximum: Math.max(...scores),
        },
      };
    })
    .sort((left, right) => right.scorePct - left.scorePct || right.points - left.points || left.id.localeCompare(right.id))
    .map((entrant, index) => ({ ...entrant, rank: index + 1 }));
}

export const harnessModelEntrants = aggregateHarnessModelEntrants(siteData);

export function getAgent(id: string): Agent | undefined {
  return siteData.agents.find((agent) => agent.id === id);
}

export function getMatch(id: string): Match | undefined {
  return siteData.matches.find((match) => match.id === id);
}

export function formatNumber(value: number): string {
  return new Intl.NumberFormat('en-US').format(value);
}

export function formatDuration(milliseconds: number): string {
  if (milliseconds < 1000) return `${Math.round(milliseconds)} ms`;
  const seconds = milliseconds / 1000;
  return seconds < 60 ? `${seconds.toFixed(1)} s` : `${Math.floor(seconds / 60)}m ${Math.round(seconds % 60)}s`;
}

export function formatDate(value: string): string {
  return new Intl.DateTimeFormat('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    timeZone: 'UTC',
  }).format(new Date(value));
}

export function shortHash(value: string, length = 12): string {
  return value.slice(0, length);
}

export function resultLabel(outcome: string): string {
  if (outcome === '1-0') return 'White won';
  if (outcome === '0-1') return 'Black won';
  if (outcome === '1/2-1/2') return 'Draw';
  return 'Void';
}
