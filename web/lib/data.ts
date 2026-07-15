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

  for (const agent of data.agents) {
    const key = `${agent.harness}:${agent.familyId}`;
    const harness = harnesses.get(agent.harness);
    const family = harness?.families.find((candidate) => candidate.id === agent.familyId);
    const artifactScore = agent.standing.games > 0
      ? roundScore((agent.standing.points / agent.standing.games) * 100)
      : 0;
    const bucket = buckets.get(key) ?? {
      id: key,
      harness: agent.harness,
      harnessDisplayName: harness?.displayName ?? agent.harness,
      harnessVersion: agent.harnessVersion,
      familyId: agent.familyId,
      familyDisplayName: family?.displayName ?? agent.familyId,
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
      games: agent.standing.games,
      wins: agent.standing.wins,
      draws: agent.standing.draws,
      losses: agent.standing.losses,
      points: agent.standing.points,
      scorePct: artifactScore,
    });
    bucket.games += agent.standing.games;
    bucket.wins += agent.standing.wins;
    bucket.draws += agent.standing.draws;
    bucket.losses += agent.standing.losses;
    bucket.points += agent.standing.points;
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
