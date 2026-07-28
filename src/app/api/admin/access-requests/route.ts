import { NextRequest, NextResponse } from "next/server";

import {
  createConfiguredAdminAccessRequest,
  runConfiguredAccessRequest,
} from "@/lib/access-request-service";
import { requireEnv } from "@/lib/env";
import { AppError, toAppError } from "@/lib/errors";
import { parseAdminAccessRequest } from "@/lib/schema";
import { getRequestAdminSession } from "@/lib/session";

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

function configuredAppOrigin(): string {
  const configured = requireEnv("APP_BASE_URL");
  try {
    return new URL(configured).origin;
  } catch (error) {
    throw new AppError(
      "CONFIGURATION_ERROR",
      "APP_BASE_URL must be a valid absolute URL.",
      500,
      { cause: error },
    );
  }
}

function isApplicationJson(contentType: string | null): boolean {
  return (
    contentType?.split(";", 1)[0]?.trim().toLowerCase() === "application/json"
  );
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  try {
    if (!getRequestAdminSession(request)) {
      return errorResponse(
        new AppError(
          "UNAUTHORIZED",
          "A valid admin session is required.",
          401,
        ),
      );
    }
  } catch (error) {
    return errorResponse(toAppError(error));
  }

  let expectedOrigin: string;
  try {
    expectedOrigin = configuredAppOrigin();
  } catch (error) {
    return errorResponse(toAppError(error));
  }
  if (request.headers.get("origin") !== expectedOrigin) {
    return errorResponse(
      new AppError(
        "FORBIDDEN",
        "The request origin did not match this deployment.",
        403,
      ),
    );
  }

  if (!isApplicationJson(request.headers.get("content-type"))) {
    return errorResponse(
      new AppError(
        "UNSUPPORTED_MEDIA_TYPE",
        "The request body must use application/json.",
        415,
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

  try {
    const draft = parseAdminAccessRequest(rawBody);
    const input = createConfiguredAdminAccessRequest(draft);
    const result = await runConfiguredAccessRequest(input);
    return NextResponse.json(result.receipt, {
      status: result.httpStatus,
      headers: {
        "Cache-Control": "no-store",
        ...(result.replayed
          ? { "Idempotency-Replayed": "true" }
          : {}),
      },
    });
  } catch (error) {
    return errorResponse(toAppError(error));
  }
}
