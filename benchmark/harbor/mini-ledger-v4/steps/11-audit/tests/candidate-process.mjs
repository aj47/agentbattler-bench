export function candidateSpawnOptions() {
  const rawUid = process.env.AGENTBATTLER_CANDIDATE_UID;
  if (rawUid === undefined) return {};
  const uid = Number(rawUid);
  const gid = Number(process.env.AGENTBATTLER_CANDIDATE_GID ?? rawUid);
  if (!Number.isSafeInteger(uid) || uid < 1 || !Number.isSafeInteger(gid) || gid < 1) {
    throw new Error('Candidate UID/GID must be positive integers');
  }
  return { uid, gid };
}
