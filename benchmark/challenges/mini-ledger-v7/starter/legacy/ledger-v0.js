// RETIRED: not imported by bin/ledger.mjs or any src module.
export function readNewestArchive(files) {
  return [...files].sort((left, right) => right.capturedAt.localeCompare(left.capturedAt))[0] ?? null;
}
