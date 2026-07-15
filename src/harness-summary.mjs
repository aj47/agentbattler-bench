function harnessRecord(games, harness) {
  let wins = 0; let draws = 0; let losses = 0; let voids = 0;
  for (const game of games) {
    if (game.final.outcome === 'void') { voids += 1; continue; }
    if (game.final.outcome === '1/2-1/2') { draws += 1; continue; }
    const winner = game.final.outcome === '1-0' ? game.agents.w : game.agents.b;
    if (winner.provenance.harness === harness) wins += 1;
    else losses += 1;
  }
  const graded = wins + draws + losses;
  const points = wins + draws * 0.5;
  return { games: games.length, graded, wins, draws, losses, voids, points, scorePct: graded ? Math.round((points / graded) * 10000) / 100 : 0 };
}

export function summarizeHarnessComparison(games) {
  const controlled = games.filter((game) => game.agents.w.provenance.modelRequested === game.agents.b.provenance.modelRequested);
  const modelIds = ['terra', 'sol', 'luna'];
  return {
    scope: 'same-model direct games isolate the harness variable',
    overall: {
      codex: harnessRecord(controlled, 'codex-cli'),
      pi: harnessRecord(controlled, 'pi-coding-agent'),
      games: controlled.length,
    },
    allCrossHarnessGames: games.length,
    models: modelIds.map((id) => {
      const model = `gpt-5.6-${id}`;
      const subset = controlled.filter((game) => game.agents.w.provenance.modelRequested === model);
      return {
        id,
        displayName: `GPT-5.6 ${id[0].toUpperCase()}${id.slice(1)}`,
        model,
        games: subset.length,
        codex: harnessRecord(subset, 'codex-cli'),
        pi: harnessRecord(subset, 'pi-coding-agent'),
      };
    }),
  };
}
