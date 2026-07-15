export type VerificationLevel = 'exploratory' | 'self-run' | 'trace-reviewed' | 'maintainer-verified';

export type Probe = {
  positionId: string;
  status: string;
  move: string | null;
  legal: boolean;
  runtimeMs: number;
  detail: string | null;
};

export type MatchSummary = {
  id: string;
  opponentId: string;
  opponentName: string;
  color: 'white' | 'black';
  score: number | null;
  outcome: string;
  reason: string;
  positionId: string;
  seed: number;
  plies: number;
  scope: 'within-harness' | 'cross-harness';
};

export type Agent = {
  id: string;
  familyId: string;
  displayName: string;
  harness: string;
  harnessVersion: string;
  model: string;
  reasoningEffort: string;
  verification: {
    level: VerificationLevel;
    label: string;
    detail: string;
  };
  standing: {
    rank: number;
    elo: number;
    games: number;
    wins: number;
    draws: number;
    losses: number;
    points: number;
  };
  generation: {
    modelRequested: string;
    harnessVersion: string;
    durationMs: number;
    turns: number;
    toolCalls: number;
    toolBreakdown: Record<string, number>;
    mcpCalls: number;
    inputTokens: number;
    cachedInputTokens: number;
    outputTokens: number;
    reasoningTokens: number | null;
    totalTokens: number;
    promptPath: string;
    promptSha256: string;
    sessionId: string;
    command: string[];
    isolation: Record<string, unknown>;
    probes: Probe[];
    probeSummary: { allPassed: boolean; passed: number; total: number };
  };
  artifact: {
    sourcePath: string;
    sourceSha256: string;
    sizeBytes: number;
    source: string;
  };
  matches: MatchSummary[];
  decisiveGames: number;
};

export type ModelFamily = {
  id: string;
  displayName: string;
  model: string;
  rank: number;
  artifacts: Array<{
    id: string;
    displayName: string;
    games: number;
    wins: number;
    draws: number;
    losses: number;
    points: number;
    scorePct: number;
    elo: number;
    totalTokens: number;
    durationMs: number;
    toolCalls: number;
  }>;
  games: number;
  wins: number;
  draws: number;
  losses: number;
  voids: number;
  points: number;
  scorePct: number;
  artifactScore: { minimum: number; median: number; maximum: number };
  generation: {
    totalTokens: number;
    medianTokens: number;
    totalDurationMs: number;
    medianDurationMs: number;
    toolCalls: number;
  };
  reliability: { failures: number; timeouts: number; illegalMoves: number };
  pairwise: Array<{
    opponentId: string;
    opponentName: string;
    games: number;
    wins: number;
    draws: number;
    losses: number;
    points: number;
  }>;
};

export type MatchAgent = {
  id: string;
  name: string;
  harness: string;
  model: string;
  sourceSha256: string;
};

export type Ply = {
  ply: number;
  color: 'w' | 'b';
  agentId: string;
  input: string;
  move: string | null;
  resultingFen: string | null;
  runtimeMs: number;
  status: string;
};

export type Match = {
  id: string;
  white: MatchAgent;
  black: MatchAgent;
  position: {
    id: string;
    initialFen: string;
    seed: number;
    maxPlies: number;
  };
  final: {
    outcome: string;
    reason: string;
    failure: unknown;
  };
  plies: Ply[];
  resultSha256: string;
};

export type SiteData = {
  schemaVersion: string;
  benchmark: {
    name: string;
    version: string;
    description: string;
    status: string;
    updatedAt: string;
    manifestId: string;
    manifestSha256: string;
    resultSha256: string;
    resultSha256Short: string;
    promptSha256: string;
    globalConfigUnchanged: boolean;
    globalConfigAdjudication: null | {
      admissible: boolean;
      status: string;
      detail: string;
      observedHostConfigMtime: string;
    };
    totals: {
      harnesses: number;
      agents: number;
      matches: number;
      withinHarnessMatches: number;
      crossHarnessMatches: number;
      controlledHarnessMatches: number;
      uniqueScenarios: number;
      decisive: number;
      draws: number;
      voids: number;
      agentInvocations: number;
      generationTokens: number;
      generationToolCalls: number;
      generationMcpCalls: number;
      matchDurationMs: number;
    };
    warning: string;
  };
  harnessComparison: {
    scope: string;
    overall: { codex: HarnessRecord; pi: HarnessRecord; games: number };
    allCrossHarnessGames: number;
    models: Array<{
      id: string;
      displayName: string;
      model: string;
      games: number;
      codex: HarnessRecord;
      pi: HarnessRecord;
    }>;
  };
  harnesses: Array<{
    id: string;
    displayName: string;
    harnessVersion: string;
    families: ModelFamily[];
    totals: { agents: number; matches: number; tokens: number; toolCalls: number; mcpCalls: number; durationMs: number };
  }>;
  families: ModelFamily[];
  agents: Agent[];
  matches: Match[];
  latestDecisiveId: string | null;
};

export type HarnessRecord = {
  games: number;
  graded: number;
  wins: number;
  draws: number;
  losses: number;
  voids: number;
  points: number;
  scorePct: number;
};
