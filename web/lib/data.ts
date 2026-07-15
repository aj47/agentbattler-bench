import rawData from '../generated/site-data.json';
import type { Agent, Match, SiteData } from './types';

export const siteData = rawData as SiteData;

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

export function agentUniqueScenarios(agent: Agent): number {
  return new Set(agent.matches.map((match) => `${match.opponentId}|${match.positionId}|${match.color}`)).size;
}
