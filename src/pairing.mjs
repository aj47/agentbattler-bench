export function comparisonPairs(agents, pairing) {
  if (pairing === 'reference') {
    const reference = agents.find((agent) => agent.role === 'reference');
    if (!reference) throw new Error('Reference pairing requires a reference agent');
    return agents.filter((agent) => agent !== reference).map((challenger) => [reference, challenger]);
  }
  if (!['all-pairs', 'cross-model'].includes(pairing)) throw new Error(`Unsupported pairing mode: ${pairing}`);
  const pairs = [];
  for (let first = 0; first < agents.length; first += 1) {
    for (let second = first + 1; second < agents.length; second += 1) {
      if (pairing === 'cross-model') {
        const firstModel = agents[first].provenance?.modelRequested;
        const secondModel = agents[second].provenance?.modelRequested;
        if (!firstModel || !secondModel) throw new Error('Cross-model pairing requires modelRequested provenance');
        if (firstModel === secondModel) continue;
      }
      pairs.push([agents[first], agents[second]]);
    }
  }
  return pairs;
}
