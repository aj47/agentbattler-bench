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
    telemetryPublished?: boolean;
    modelRequested: string;
    harnessVersion: string;
    durationMs: number | null;
    turns: number | null;
    toolCalls: number | null;
    toolBreakdown: Record<string, number>;
    mcpCalls: number | null;
    inputTokens: number | null;
    cachedInputTokens: number | null;
    outputTokens: number | null;
    reasoningTokens: number | null;
    totalTokens: number | null;
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
    telemetryPublished?: boolean;
    totalTokens: number | null;
    medianTokens: number | null;
    totalDurationMs: number | null;
    medianDurationMs: number | null;
    toolCalls: number | null;
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

export type HarnessModelEntrant = {
  id: string;
  rank: number;
  harness: string;
  harnessDisplayName: string;
  harnessVersion: string;
  familyId: string;
  familyDisplayName: string;
  model: string;
  artifacts: Array<{
    id: string;
    displayName: string;
    games: number;
    wins: number;
    draws: number;
    losses: number;
    points: number;
    scorePct: number;
  }>;
  games: number;
  wins: number;
  draws: number;
  losses: number;
  points: number;
  scorePct: number;
  artifactScore: { minimum: number; median: number; maximum: number };
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
    overall: { codex: HarnessRecord; pi: HarnessRecord; claude: HarnessRecord; games: number };
    allCrossHarnessGames: number;
    models: Array<{
      id: string;
      displayName: string;
      model: string;
      games: number;
      codex: HarnessRecord;
      pi: HarnessRecord;
      claude: HarnessRecord;
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
  dotAgentsPlacement?: DotAgentsPlacement;
  terminalChallenge?: TerminalChallengeLane | null;
};

export type TerminalChallengeLane = {
  id: string;
  title: string;
  updatedAt: string;
  challengeId: string;
  challengeSha256: string;
  scheduleId: string;
  scheduleSha256: string;
  matrix: {
    harnesses: string[];
    models: string[];
    generationsPerCombo: number;
    repeats: number;
    seeds: number[];
    expectedRuns: number;
  };
  coverage: Array<{
    comboId: string;
    harness: string;
    harnessVersion: string;
    model: string;
    generations: number;
  }>;
  expectedRuns: number;
  completedRuns: number;
  missingRuns: number;
  invalidRuns: number;
  scoring: {
    maxPoints: number;
    visibleStagePoints: number;
    holdoutPoints: number;
    tieTolerancePoints: number;
  };
  protocol: {
    humanIntervention: string;
    maxWallTimeMs: number;
    maxWorkspaceBytes: number;
    network: string;
    sameSession: boolean;
    sameWorkspace: boolean;
    turns: number;
  };
  stages: Array<{ id: string; order: number; points: number; title: string }>;
  combos: Array<{
    comboId: string;
    harness: string;
    harnessDisplayName: string;
    harnessVersion: string;
    model: string;
    modelFamilyId: string;
    averageScore: number;
    medianScore: number;
    minimumScore: number;
    maximumScore: number;
    averageDurationMs: number;
    totalDurationMs: number;
    stagePassRates: Array<{ id: string; title: string; passed: number; total: number }>;
    runs: Array<{
      runKey: string;
      artifactId: string;
      comboId: string;
      generationIndex: number;
      harness: string;
      harnessVersion: string;
      model: string;
      modelFamilyId: string;
      durationMs: number;
      endedAt: string;
      scorePct: number;
      visiblePoints: number;
      holdoutPoints: number;
      passedStages: number;
      totalStages: number;
      holdoutPassed: number;
      holdoutTotal: number;
      usage: { cachedInputTokens?: number; inputTokens?: number; outputTokens?: number; reasoningTokens?: number };
      stages: Array<{ id: string; passed: boolean }>;
      trace: null | { path: string; bytes: number; sha256: string; sourceBytes: number };
    }>;
  }>;
  tracePublication: null | {
    manifestSha256: string;
    runs: number;
    turns: number;
    sourceBytes: number;
    publishedBytes: number;
    omittedStreamingEvents: number;
    redactions: number;
  };
  standings: Array<{ rank: number; comboId: string | null; scorePoints: number; rating: number }>;
  status: 'scheduled' | 'complete';
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

export type PlacementRecord = {
  games: number;
  wins: number;
  draws: number;
  losses: number;
  points: number;
  scorePct: number;
};

export type DotAgentsPlacement = PlacementRecord & {
  harness: 'dotagents-mono';
  displayName: string;
  resultSha256: string;
  resultSha256Short: string;
  updatedAt: string;
  warning: string;
  featuredMatchId: string | null;
  timeoutDecisions: {
    total: number;
    benefited: number;
    incurred: number;
    scoreWithoutTimeouts: number;
  };
  opponents: Array<PlacementRecord & {
    id: string;
    displayName: string;
  }>;
  models: Array<PlacementRecord & {
    id: string;
    displayName: string;
    model: string;
    matchupWins: number;
    matchupLosses: number;
    opponents: Array<PlacementRecord & {
      id: string;
      displayName: string;
    }>;
    featuredMatchId: string | null;
  }>;
};
