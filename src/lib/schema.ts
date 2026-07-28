import { z } from "zod";

import type {
  NormalizedAccessRequest,
  RequestedPermission,
} from "@/lib/domain";
import { REQUESTED_PERMISSIONS } from "@/lib/domain";
import { AppError } from "@/lib/errors";

const githubUsernamePattern =
  /^(?!-)(?!.*--)[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/;
const repositoryPattern = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const slackChannelPattern = /^[CG][A-Z0-9]{8,20}$/;

function hasSafeRepositorySegments(repository: string): boolean {
  return repository
    .split("/")
    .every((segment) => segment !== "." && segment !== "..");
}

const githubUsernameSchema = z
  .string()
  .trim()
  .min(1)
  .max(39)
  .regex(githubUsernamePattern);
const repositorySchema = z
  .string()
  .trim()
  .regex(repositoryPattern)
  .refine(hasSafeRepositorySegments);
const requestedPermissionSchema = z.enum(REQUESTED_PERMISSIONS);
const reasonSchema = z.string().trim().min(1).max(500);
const slackChannelSchema = z.string().trim().regex(slackChannelPattern);

const accessRequestSchema = z
  .object({
    githubUsername: githubUsernameSchema,
    repository: repositorySchema,
    requestedPermission: requestedPermissionSchema,
    reason: reasonSchema,
    slackChannel: slackChannelSchema,
    requestId: z.string().trim().min(1).max(100).optional(),
    includeDetails: z.boolean().optional().default(false),
  })
  .strict();

const adminAccessRequestSchema = z
  .object({
    githubUsername: githubUsernameSchema,
    requestedPermission: requestedPermissionSchema,
    reason: reasonSchema,
    submissionId: z.string().uuid(),
  })
  .strict();

const configuredAccessTargetsSchema = z
  .object({
    repository: repositorySchema,
    slackChannel: slackChannelSchema,
  })
  .strict();

export type NormalizedAdminAccessRequest = {
  githubUsername: string;
  requestedPermission: RequestedPermission;
  reason: string;
  submissionId: string;
};

export type ConfiguredAccessTargets = {
  repository: string;
  slackChannel: string;
};

export function parseAccessRequest(value: unknown): NormalizedAccessRequest {
  const parsed = accessRequestSchema.safeParse(value);
  if (!parsed.success) {
    throw new AppError(
      "VALIDATION_ERROR",
      "The request body did not match the documented contract.",
      400,
    );
  }

  return {
    ...parsed.data,
    githubUsername: parsed.data.githubUsername.toLowerCase(),
    repository: parsed.data.repository.toLowerCase(),
  };
}

export function parseAdminAccessRequest(
  value: unknown,
): NormalizedAdminAccessRequest {
  const parsed = adminAccessRequestSchema.safeParse(value);
  if (!parsed.success) {
    throw new AppError(
      "VALIDATION_ERROR",
      "The request body did not match the admin access-check contract.",
      400,
    );
  }

  return {
    ...parsed.data,
    githubUsername: parsed.data.githubUsername.toLowerCase(),
    submissionId: parsed.data.submissionId.toLowerCase(),
  };
}

export function parseConfiguredAccessTargets(
  value: unknown,
): ConfiguredAccessTargets {
  const parsed = configuredAccessTargetsSchema.safeParse(value);
  if (!parsed.success) {
    throw new AppError(
      "CONFIGURATION_ERROR",
      "The configured demo repository or Slack channel is invalid.",
      500,
    );
  }

  return {
    repository: parsed.data.repository.toLowerCase(),
    slackChannel: parsed.data.slackChannel,
  };
}
