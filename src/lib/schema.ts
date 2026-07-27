import { z } from "zod";

import type { NormalizedAccessRequest } from "@/lib/domain";
import { REQUESTED_PERMISSIONS } from "@/lib/domain";
import { AppError } from "@/lib/errors";

const githubUsernamePattern =
  /^(?!-)(?!.*--)[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/;
const repositoryPattern = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const slackChannelPattern = /^[CG][A-Z0-9]{8,20}$/;

const accessRequestSchema = z
  .object({
    githubUsername: z.string().trim().min(1).max(39).regex(githubUsernamePattern),
    repository: z.string().trim().regex(repositoryPattern),
    requestedPermission: z.enum(REQUESTED_PERMISSIONS),
    reason: z.string().trim().min(1).max(500),
    slackChannel: z.string().trim().regex(slackChannelPattern),
    requestId: z.string().trim().min(1).max(100).optional(),
    includeDetails: z.boolean().optional().default(false),
  })
  .strict();

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
