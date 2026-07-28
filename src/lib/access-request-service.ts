import type { NormalizedAccessRequest } from "@/lib/domain";
import { requireEnv } from "@/lib/env";
import { AppError } from "@/lib/errors";
import {
  LiveGitHubProvider,
  LiveSlackProvider,
} from "@/lib/providers";
import {
  parseConfiguredAccessTargets,
  type ConfiguredAccessTargets,
  type NormalizedAdminAccessRequest,
} from "@/lib/schema";
import { getStore } from "@/lib/store";
import {
  executeAccessRequest,
  type WorkflowResult,
} from "@/lib/workflow";

export function readConfiguredAccessTargets(): ConfiguredAccessTargets {
  return parseConfiguredAccessTargets({
    repository: requireEnv("DEMO_GITHUB_REPOSITORY"),
    slackChannel: requireEnv("DEMO_SLACK_CHANNEL_ID"),
  });
}

export function createConfiguredAdminAccessRequest(
  input: NormalizedAdminAccessRequest,
): NormalizedAccessRequest {
  const targets = readConfiguredAccessTargets();
  return {
    githubUsername: input.githubUsername,
    repository: targets.repository,
    requestedPermission: input.requestedPermission,
    reason: input.reason,
    slackChannel: targets.slackChannel,
    requestId: `admin:${input.submissionId}`,
    includeDetails: true,
  };
}

export function assertConfiguredAccessTargets(
  input: NormalizedAccessRequest,
): void {
  const targets = readConfiguredAccessTargets();
  if (input.repository !== targets.repository) {
    throw new AppError(
      "GITHUB_REPOSITORY_NOT_ALLOWED",
      "This deployment is limited to its configured demo repository.",
      422,
    );
  }

  if (input.slackChannel !== targets.slackChannel) {
    throw new AppError(
      "SLACK_CHANNEL_NOT_ALLOWED",
      "This deployment is limited to its configured demo Slack channel.",
      422,
    );
  }
}

export async function runConfiguredAccessRequest(
  input: NormalizedAccessRequest,
): Promise<WorkflowResult> {
  assertConfiguredAccessTargets(input);

  const store = getStore();
  return executeAccessRequest(input, {
    store,
    github: new LiveGitHubProvider(store),
    slack: new LiveSlackProvider(store),
  });
}
