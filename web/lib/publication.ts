import rawPublication from '../generated/publication.json';

type AgentEvidence = {
  tracePath: string;
  sessionPath: string;
  viewerUrl: string;
  sessionUrl: string;
  sessionDownloadUrl: string;
  cliEventsUrl: string;
  cliEventsDownloadUrl: string;
};

export type Publication = {
  snapshotId: string | null;
  snapshotSha256: string | null;
  datasetUrl: string | null;
  datasetRevision: string | null;
  releaseUrl: string | null;
  archiveUrl: string | null;
  agents: Record<string, AgentEvidence>;
};

export const publication = rawPublication as Publication;
