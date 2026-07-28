export const STANDARD_PERMISSIONS = [
  "none",
  "read",
  "triage",
  "write",
  "maintain",
  "admin",
] as const;

export const REQUESTED_PERMISSIONS = [
  "read",
  "triage",
  "write",
  "maintain",
  "admin",
] as const;

export type StandardPermission = (typeof STANDARD_PERMISSIONS)[number];
export type RequestedPermission = (typeof REQUESTED_PERMISSIONS)[number];
export type Decision =
  | "approval_needed"
  | "already_sufficient"
  | "manual_review";
export type ExecutionStatus =
  | "completed"
  | "failed"
  | "partial_failure"
  | "indeterminate";

export type NormalizedAccessRequest = {
  githubUsername: string;
  repository: string;
  requestedPermission: RequestedPermission;
  reason: string;
  slackChannel: string;
  requestId?: string;
  includeDetails: boolean;
};

export type ReceiptStep = {
  name: "validation" | "github" | "slack" | "receipt";
  status: "completed" | "failed" | "not_attempted";
  detail: string;
};

export type ReceiptError = {
  code: string;
  message: string;
  retryAfterSeconds?: number;
};

export type InternalReceipt = {
  status: ExecutionStatus;
  outcome: Decision | null;
  runId: string;
  requestId: string | null;
  requestedAt: string;
  completedAt: string;
  summary: string;
  github: {
    username: string;
    repository: string;
    requestedPermission: RequestedPermission;
    effectivePermission: string | null;
    roleName: string | null;
  };
  slack: {
    channel: string;
    posted: boolean | null;
    messageTs: string | null;
  };
  error?: ReceiptError;
  steps: ReceiptStep[];
};

export type PublicReceipt = Omit<InternalReceipt, "steps"> & {
  steps?: ReceiptStep[];
};

export type ProcessingRecord = {
  state: "processing";
  fingerprint: string;
  operationId: string;
  startedAt: string;
};

export type ReplayableRecord = {
  state: "replayable";
  fingerprint: string;
  operationId: string;
  receipt: InternalReceipt;
};

export type IdempotencyRecord = ProcessingRecord | ReplayableRecord;

export type ConnectionStatus = "connected" | "invalid";

export type GitHubConnection = {
  version: 1;
  provider: "github";
  status: ConnectionStatus;
  installationId: number;
  accountLogin: string;
  accountType: "User" | "Organization";
  repositorySelection: "all" | "selected";
  connectedAt: string;
  lastVerifiedAt: string;
};

export type SlackConnection = {
  version: 1;
  provider: "slack";
  status: ConnectionStatus;
  encryptedBotToken: string;
  teamId: string;
  teamName: string;
  botUserId: string | null;
  scopes: string[];
  connectedAt: string;
  lastVerifiedAt: string;
};

export type GitHubPermissionResult = {
  effectivePermission: StandardPermission | null;
  roleName: string | null;
  isCustomRole: boolean;
};

export type SlackPostResult = {
  messageTs: string;
};

export const STORE_KEYS = {
  githubConnection: "access-triage:connection:github",
  slackConnection: "access-triage:connection:slack",
  lastSuccessfulRunAt: "access-triage:meta:last-successful-run-at",
  idempotency: (requestId: string) =>
    `access-triage:idempotency:${requestId}`,
} as const;
