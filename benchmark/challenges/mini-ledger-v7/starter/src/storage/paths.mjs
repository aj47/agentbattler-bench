import path from 'node:path';

export const ROOT = process.cwd();
export const ARTIFACT_MANIFEST = path.join(ROOT, 'var', 'artifact-manifest.json');
export const STATE = path.join(ROOT, 'ledger.json');
export const TEMPORARY_STATE = path.join(ROOT, 'ledger.json.tmp');
export const LOCK = path.join(ROOT, 'ledger.lock');
export const ARCHIVE_SNAPSHOT = path.join(ROOT, 'var', 'archive', 'snapshot.json');
export const SNAPSHOT = path.join(ROOT, 'ledger.snapshot.json');
