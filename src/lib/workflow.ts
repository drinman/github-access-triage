import { randomUUID } from "node:crypto";

import type {
  GitHubConnection,
  GitHubPermissionResult,
  InternalReceipt,
  NormalizedAccessRequest,
  ProcessingRecord,
  PublicReceipt,
  ReceiptStep,
  ReplayableRecord,
  SlackConnection,
} from "@/lib/domain";
import { STORE_KEYS } from "@/lib/domain";
import { AppError, toAppError } from "@/lib/errors";
import { fingerprintBusinessInput } from "@/lib/crypto";
import {
  acquireRequestId,
  releaseRequestId,
  storeReplayableReceipt,
} from "@/lib/idempotency";
import { decideAccess } from "@/lib/permissions";
import type {
  GitHubProvider,
  SlackProvider,
} from "@/lib/providers";
import type { KeyValueStore } from "@/lib/store";

export type WorkflowResult = {
  receipt: PublicReceipt;
  httpStatus: number;
  replayed: boolean;
};

export type WorkflowDependencies = {
  store: KeyValueStore;
  github: GitHubProvider;
  slack: SlackProvider;
  now?: () => Date;
  createId?: () => string;
};

function projectReceipt(
  receipt: InternalReceipt,
  includeDetails: boolean,
): PublicReceipt {
  if (includeDetails) {
    return receipt;
  }
  const compact: PublicReceipt = { ...receipt };
  delete compact.steps;
  return compact;
}

function summaryForDecision(
  decision: InternalReceipt["outcome"],
): string {
  switch (decision) {
    case "approval_needed":
      return "The requester has less access than requested. Slack received a manual approval handoff.";
    case "already_sufficient":
      return "The requester already has sufficient access. Slack received an informational message.";
    case "manual_review":
      return "GitHub returned a custom role. Slack received a manual-review message.";
    default:
      return "The request did not reach Slack.";
  }
}

function createFailureReceipt(input: {
  request: NormalizedAccessRequest;
  runId: string;
  requestedAt: string;
  completedAt: string;
  error: AppError;
  permission: GitHubPermissionResult | null;
  steps: ReceiptStep[];
}): InternalReceipt {
  return {
    status: "failed",
    outcome: null,
    runId: input.runId,
    requestId: input.request.requestId ?? null,
    requestedAt: input.requestedAt,
    completedAt: input.completedAt,
    summary: input.error.message,
    github: {
      username: input.request.githubUsername,
      repository: input.request.repository,
      requestedPermission: input.request.requestedPermission,
      effectivePermission:
        input.permission?.effectivePermission ?? null,
      roleName: input.permission?.roleName ?? null,
    },
    slack: {
      channel: input.request.slackChannel,
      posted: false,
      messageTs: null,
    },
    error: {
      code: input.error.code,
      message: input.error.message,
      ...(input.error.retryAfterSeconds !== undefined
        ? { retryAfterSeconds: input.error.retryAfterSeconds }
        : {}),
    },
    steps: input.steps,
  };
}

function connectionError(
  provider: "github" | "slack",
): AppError {
  if (provider === "github") {
    return new AppError(
      "GITHUB_CONNECTION_REQUIRED",
      "Connect or reconnect GitHub before running the workflow.",
      503,
    );
  }
  return new AppError(
    "SLACK_CONNECTION_REQUIRED",
    "Connect or reconnect Slack before running the workflow.",
    503,
  );
}

export async function executeAccessRequest(
  request: NormalizedAccessRequest,
  dependencies: WorkflowDependencies,
): Promise<WorkflowResult> {
  const now = dependencies.now ?? (() => new Date());
  const createId = dependencies.createId ?? randomUUID;
  const runId = createId();
  const operationId = createId();
  const requestedAt = now().toISOString();
  const fingerprint = fingerprintBusinessInput(request);
  let ownedRecord: ProcessingRecord | null = null;
  let permission: GitHubPermissionResult | null = null;
  let slackConfirmed = false;
  const steps: ReceiptStep[] = [
    {
      name: "validation",
      status: "completed",
      detail: "Request authenticated, validated, and normalized.",
    },
    {
      name: "github",
      status: "not_attempted",
      detail: "GitHub lookup was not attempted.",
    },
    {
      name: "slack",
      status: "not_attempted",
      detail: "Slack post was not attempted.",
    },
    {
      name: "receipt",
      status: "not_attempted",
      detail: request.requestId
        ? "No replayable receipt was stored."
        : "No requestId was supplied. No replay protection is available.",
    },
  ];

  try {
    if (request.requestId) {
      const acquired = await acquireRequestId(
        dependencies.store,
        request.requestId,
        fingerprint,
        operationId,
        requestedAt,
      );
      if (acquired.kind === "replay") {
        return {
          receipt: projectReceipt(
            acquired.record.receipt,
            request.includeDetails,
          ),
          httpStatus: 200,
          replayed: true,
        };
      }
      ownedRecord = acquired.record;
    }

    const [githubConnection, slackConnection] = await Promise.all([
      dependencies.store.get<GitHubConnection>(
        STORE_KEYS.githubConnection,
      ),
      dependencies.store.get<SlackConnection>(STORE_KEYS.slackConnection),
    ]);

    if (!githubConnection || githubConnection.status !== "connected") {
      throw connectionError("github");
    }
    if (!slackConnection || slackConnection.status !== "connected") {
      throw connectionError("slack");
    }

    try {
      permission = await dependencies.github.readEffectivePermission(
        githubConnection,
        request,
      );
      steps[1] = {
        name: "github",
        status: "completed",
        detail: permission.isCustomRole
          ? "GitHub returned a custom role; no rank was inferred."
          : `Effective permission resolved as ${
              permission.effectivePermission ?? "none"
            }.`,
      };
    } catch (error) {
      const githubError = toAppError(error);
      steps[1] = {
        name: "github",
        status: "failed",
        detail: githubError.message,
      };
      throw githubError;
    }

    const decision = decideAccess(permission, request.requestedPermission);
    let messageTs: string;
    try {
      const posted = await dependencies.slack.postAccessRequest(
        slackConnection,
        request,
        decision,
        permission,
        runId,
      );
      messageTs = posted.messageTs;
      slackConfirmed = true;
      steps[2] = {
        name: "slack",
        status: "completed",
        detail: "Slack confirmed the message was posted.",
      };
    } catch (error) {
      const slackError = toAppError(error);
      steps[2] = {
        name: "slack",
        status: "failed",
        detail: slackError.message,
      };
      throw slackError;
    }

    const completedAt = now().toISOString();
    const completedReceipt: InternalReceipt = {
      status: "completed",
      outcome: decision,
      runId,
      requestId: request.requestId ?? null,
      requestedAt,
      completedAt,
      summary: summaryForDecision(decision),
      github: {
        username: request.githubUsername,
        repository: request.repository,
        requestedPermission: request.requestedPermission,
        effectivePermission: permission.effectivePermission,
        roleName: permission.roleName,
      },
      slack: {
        channel: request.slackChannel,
        posted: true,
        messageTs,
      },
      steps: [
        ...steps.slice(0, 3),
        {
          name: "receipt",
          status: request.requestId ? "completed" : "not_attempted",
          detail: request.requestId
            ? "A replayable result was stored for 24 hours."
            : "No requestId was supplied. No replay protection is available; retrying may post a duplicate Slack message.",
        },
      ],
    };

    const partialReceipt: InternalReceipt = {
      ...completedReceipt,
      status: "partial_failure",
      summary: request.requestId
        ? "Slack posted the message, but post-delivery finalization did not complete."
        : "Slack posted the message, but post-delivery finalization did not complete. No requestId was supplied, so retrying may post a duplicate.",
      error: {
        code: "POST_DELIVERY_FINALIZATION_FAILED",
        message: request.requestId
          ? "Slack confirmed the message. The stored result prevents a duplicate post."
          : "Slack confirmed the message, but no requestId was supplied, so no replay protection is available. Do not retry automatically.",
      },
      steps: [
        ...steps.slice(0, 3),
        {
          name: "receipt",
          status: request.requestId ? "completed" : "not_attempted",
          detail: request.requestId
            ? "A replay-safe post-delivery result was stored before final metadata updates."
            : "No requestId was supplied. No replayable receipt exists, and retrying may duplicate the Slack post.",
        },
      ],
    };

    let provisional: ReplayableRecord | null = null;
    if (request.requestId && ownedRecord) {
      try {
        provisional = await storeReplayableReceipt(
          dependencies.store,
          request.requestId,
          ownedRecord,
          fingerprint,
          operationId,
          partialReceipt,
        );
      } catch {
        provisional = null;
      }
      if (!provisional) {
        const unconfirmedReceipt: InternalReceipt = {
          ...partialReceipt,
          status: "indeterminate",
          summary:
            "Slack posted, but the app could not confirm replay protection.",
          error: {
            code: "RECEIPT_PERSISTENCE_UNCONFIRMED",
            message:
              "Slack posted, but replay protection could not be confirmed. Do not retry automatically.",
          },
          steps: [
            ...steps.slice(0, 3),
            {
              name: "receipt",
              status: "failed",
              detail:
                "Slack posted, but the replayable receipt could not be confirmed.",
            },
          ],
        };
        return {
          receipt: projectReceipt(
            unconfirmedReceipt,
            request.includeDetails,
          ),
          httpStatus: 200,
          replayed: false,
        };
      }
    }

    try {
      await dependencies.store.set(
        STORE_KEYS.lastSuccessfulRunAt,
        completedAt,
      );
    } catch {
      return {
        receipt: projectReceipt(partialReceipt, request.includeDetails),
        httpStatus: 200,
        replayed: false,
      };
    }

    if (request.requestId && provisional) {
      let finalRecord: ReplayableRecord | null = null;
      try {
        finalRecord = await storeReplayableReceipt(
          dependencies.store,
          request.requestId,
          provisional,
          fingerprint,
          operationId,
          completedReceipt,
        );
      } catch {
        finalRecord = null;
      }
      if (!finalRecord) {
        return {
          receipt: projectReceipt(partialReceipt, request.includeDetails),
          httpStatus: 200,
          replayed: false,
        };
      }
    }

    return {
      receipt: projectReceipt(completedReceipt, request.includeDetails),
      httpStatus: 200,
      replayed: false,
    };
  } catch (error) {
    const appError = toAppError(error);

    if (
      ownedRecord &&
      request.requestId &&
      !slackConfirmed &&
      !appError.ambiguousDelivery
    ) {
      try {
        await releaseRequestId(
          dependencies.store,
          request.requestId,
          ownedRecord,
        );
      } catch {
        // The five-minute TTL is the fallback if cleanup cannot be confirmed.
      }
    }

    if (steps[1].status === "not_attempted") {
      steps[1].detail =
        appError.code === "GITHUB_CONNECTION_REQUIRED"
          ? "GitHub was not connected."
          : "GitHub lookup was not attempted.";
    }
    if (steps[2].status === "not_attempted") {
      steps[2].detail = "Slack was not called.";
    }

    const failureReceipt = createFailureReceipt({
      request,
      runId,
      requestedAt,
      completedAt: now().toISOString(),
      error: appError,
      permission,
      steps,
    });

    if (appError.ambiguousDelivery) {
      const indeterminateReceipt: InternalReceipt = {
        ...failureReceipt,
        status: "indeterminate",
        slack: {
          ...failureReceipt.slack,
          posted: null,
        },
      };

      if (request.requestId && ownedRecord) {
        indeterminateReceipt.steps[3] = {
          name: "receipt",
          status: "completed",
          detail:
            "An indeterminate delivery result was stored for 24 hours. Retrying this requestId will not post to Slack again.",
        };

        let stored: ReplayableRecord | null = null;
        try {
          stored = await storeReplayableReceipt(
            dependencies.store,
            request.requestId,
            ownedRecord,
            fingerprint,
            operationId,
            indeterminateReceipt,
          );
        } catch {
          stored = null;
        }

        if (!stored) {
          indeterminateReceipt.steps[3] = {
            name: "receipt",
            status: "failed",
            detail:
              "The indeterminate delivery result could not be stored for replay.",
          };
        }
      }

      return {
        receipt: projectReceipt(
          indeterminateReceipt,
          request.includeDetails,
        ),
        httpStatus: appError.httpStatus,
        replayed: false,
      };
    }

    return {
      receipt: projectReceipt(failureReceipt, request.includeDetails),
      httpStatus: appError.httpStatus,
      replayed: false,
    };
  }
}
