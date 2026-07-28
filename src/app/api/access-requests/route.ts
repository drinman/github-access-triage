import { NextResponse } from "next/server";

import { verifyBearerHeader } from "@/lib/crypto";
import { requireEnv } from "@/lib/env";
import { AppError, toAppError } from "@/lib/errors";
import {
  LiveGitHubProvider,
  LiveSlackProvider,
} from "@/lib/providers";
import { parseAccessRequest } from "@/lib/schema";
import { getStore } from "@/lib/store";
import { executeAccessRequest } from "@/lib/workflow";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function errorResponse(error: AppError): NextResponse {
  return NextResponse.json(
    {
      status: "failed",
      outcome: null,
      error: {
        code: error.code,
        message: error.message,
        ...(error.retryAfterSeconds !== undefined
          ? { retryAfterSeconds: error.retryAfterSeconds }
          : {}),
      },
    },
    {
      status: error.httpStatus,
      headers: { "Cache-Control": "no-store" },
    },
  );
}

export async function POST(request: Request): Promise<NextResponse> {
  let expectedSecret: string;
  try {
    expectedSecret = requireEnv("WEBHOOK_SECRET");
  } catch (error) {
    return errorResponse(toAppError(error));
  }

  if (
    !verifyBearerHeader(
      request.headers.get("authorization"),
      expectedSecret,
    )
  ) {
    return errorResponse(
      new AppError(
        "UNAUTHORIZED",
        "A valid Bearer credential is required.",
        401,
      ),
    );
  }

  let rawBody: unknown;
  try {
    rawBody = await request.json();
  } catch {
    return errorResponse(
      new AppError(
        "VALIDATION_ERROR",
        "The request body must be valid JSON.",
        400,
      ),
    );
  }

  let input;
  try {
    input = parseAccessRequest(rawBody);
  } catch (error) {
    return errorResponse(toAppError(error));
  }

  let demoRepository: string;
  let demoSlackChannel: string;
  try {
    demoRepository = requireEnv("DEMO_GITHUB_REPOSITORY")
      .trim()
      .toLowerCase();
    demoSlackChannel = requireEnv("DEMO_SLACK_CHANNEL_ID").trim();
  } catch (error) {
    return errorResponse(toAppError(error));
  }

  if (input.repository !== demoRepository) {
    return errorResponse(
      new AppError(
        "GITHUB_REPOSITORY_NOT_ALLOWED",
        "This deployment is limited to its configured demo repository.",
        422,
      ),
    );
  }

  if (input.slackChannel !== demoSlackChannel) {
    return errorResponse(
      new AppError(
        "SLACK_CHANNEL_NOT_ALLOWED",
        "This deployment is limited to its configured demo Slack channel.",
        422,
      ),
    );
  }

  const store = getStore();
  const result = await executeAccessRequest(input, {
    store,
    github: new LiveGitHubProvider(store),
    slack: new LiveSlackProvider(store),
  });

  return NextResponse.json(result.receipt, {
    status: result.httpStatus,
    headers: {
      "Cache-Control": "no-store",
      ...(result.replayed
        ? { "Idempotency-Replayed": "true" }
        : {}),
    },
  });
}
