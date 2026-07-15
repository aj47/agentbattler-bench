export function comparisonPairs(agents, pairing) {
  if (pairing === 'reference') {
    const reference = agents.find((agent) => agent.role === 'reference');
    if (!reference) throw new Error('Reference pairing requires a reference agent');
    return agents.filter((agent) => agent !== reference).map((challenger) => [reference, challenger]);
  }
  if (!['all-pairs', 'cross-model', 'cross-harness', 'cross-harness-all'].includes(pairing)) throw new Error(`Unsupported pairing mode: ${pairing}`);
  const pairs = [];
  for (let first = 0; first < agents.length; first += 1) {
    for (let second = first + 1; second < agents.length; second += 1) {
      if (pairing === 'cross-model') {
        const firstModel = agents[first].provenance?.modelRequested;
        const secondModel = agents[second].provenance?.modelRequested;
        if (!firstModel || !secondModel) throw new Error('Cross-model pairing requires modelRequested provenance');
        if (firstModel === secondModel) continue;
      }
      if (pairing === 'cross-harness') {
        const firstModel = agents[first].provenance?.modelRequested;
        const secondModel = agents[second].provenance?.modelRequested;
        const firstHarness = agents[first].provenance?.harness;
        const secondHarness = agents[second].provenance?.harness;
        if (!firstModel || !secondModel || !firstHarness || !secondHarness) {
          throw new Error('Cross-harness pairing requires modelRequested and harness provenance');
        }
        if (firstModel !== secondModel || firstHarness === secondHarness) continue;
      }
      if (pairing === 'cross-harness-all') {
        const firstHarness = agents[first].provenance?.harness;
        const secondHarness = agents[second].provenance?.harness;
        if (!firstHarness || !secondHarness) {
          throw new Error('Cross-harness-all pairing requires harness provenance');
        }
        if (firstHarness === secondHarness) continue;
      }
      pairs.push([agents[first], agents[second]]);
    }
  }
  return pairs;
}
