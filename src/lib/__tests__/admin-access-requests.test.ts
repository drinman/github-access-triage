import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { POST } from "@/app/api/admin/access-requests/route";
import {
  ADMIN_COOKIE,
  createAdminSession,
} from "@/lib/session";
import { createOAuthState } from "@/lib/oauth-state";
import { MemoryStore } from "@/lib/store";

const serviceMocks = vi.hoisted(() => ({
  runConfiguredAccessRequest: vi.fn(),
}));

vi.mock("@/lib/access-request-service", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/lib/access-request-service")>();
  return {
    ...actual,
    runConfiguredAccessRequest: serviceMocks.runConfiguredAccessRequest,
  };
});

const submissionId = "550e8400-e29b-41d4-a716-446655440000";
const validBody = {
  githubUsername: " Test-User ",
  requestedPermission: "write",
  reason: " Diagnose an integration failure ",
  submissionId,
};

function workflowResult(replayed = false) {
  return {
    httpStatus: 200,
    replayed,
    receipt: {
      status: "completed",
      outcome: "approval_needed",
      runId: "run-1",
      requestId: `admin:${submissionId}`,
      requestedAt: "2026-07-28T20:00:00.000Z",
      completedAt: "2026-07-28T20:00:01.000Z",
      summary: "Slack received a manual approval handoff.",
      github: {
        username: "test-user",
        repository: "owner/repo",
        requestedPermission: "write",
        effectivePermission: "read",
        roleName: "read",
      },
      slack: {
        channel: "C0123456789",
        posted: true,
        messageTs: "123.456",
      },
      steps: [],
    },
  };
}

function adminRequest(options: {
  token?: string | null;
  origin?: string | null;
  contentType?: string | null;
  body?: string;
} = {}): NextRequest {
  const headers = new Headers();
  const token =
    options.token === undefined ? createAdminSession() : options.token;
  if (token !== null) {
    headers.set("cookie", `${ADMIN_COOKIE}=${token}`);
  }
  const origin =
    options.origin === undefined ? "https://access.example" : options.origin;
  if (origin !== null) {
    headers.set("origin", origin);
  }
  const contentType =
    options.contentType === undefined
      ? "application/json"
      : options.contentType;
  if (contentType !== null) {
    headers.set("content-type", contentType);
  }

  return new NextRequest(
    "https://access.example/api/admin/access-requests",
    {
      method: "POST",
      headers,
      body: options.body ?? JSON.stringify(validBody),
    },
  );
}

beforeEach(() => {
  vi.stubEnv("SESSION_SECRET", "test-session-secret");
  vi.stubEnv("APP_BASE_URL", "https://access.example");
  vi.stubEnv("DEMO_GITHUB_REPOSITORY", " Owner/Repo ");
  vi.stubEnv("DEMO_SLACK_CHANNEL_ID", "C0123456789");
  serviceMocks.runConfiguredAccessRequest.mockReset();
  serviceMocks.runConfiguredAccessRequest.mockResolvedValue(workflowResult());
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("admin access-request boundary", () => {
  it.each([
    ["missing", null],
    ["tampered", "not-a-signed-session"],
  ])("rejects a %s admin session before parsing", async (_label, token) => {
    const response = await POST(
      adminRequest({
        token,
        origin: null,
        contentType: null,
        body: "not-json",
      }),
    );

    expect(response.status).toBe(401);
    expect(response.headers.get("cache-control")).toBe("no-store");
    await expect(response.json()).resolves.toMatchObject({
      status: "failed",
      error: { code: "UNAUTHORIZED" },
    });
    expect(serviceMocks.runConfiguredAccessRequest).not.toHaveBeenCalled();
  });

  it("rejects a correctly signed OAuth state token as an admin session", async () => {
    const oauthState = await createOAuthState(
      new MemoryStore(),
      {
        kind: "slack",
        sessionHash: "signed-oauth-state",
      },
    );

    const response = await POST(adminRequest({ token: oauthState }));

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toMatchObject({
      status: "failed",
      error: { code: "UNAUTHORIZED" },
    });
    expect(serviceMocks.runConfiguredAccessRequest).not.toHaveBeenCalled();
  });

  it("requires the exact configured origin", async () => {
    const response = await POST(
      adminRequest({ origin: "https://access.example.evil.invalid" }),
    );

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "FORBIDDEN" },
    });
    expect(serviceMocks.runConfiguredAccessRequest).not.toHaveBeenCalled();
  });

  it.each([null, "text/plain", "application/problem+json"])(
    "requires application/json: %s",
    async (contentType) => {
      const response = await POST(adminRequest({ contentType }));

      expect(response.status).toBe(415);
      await expect(response.json()).resolves.toMatchObject({
        error: { code: "UNSUPPORTED_MEDIA_TYPE" },
      });
      expect(serviceMocks.runConfiguredAccessRequest).not.toHaveBeenCalled();
    },
  );

  it.each([
    { repository: "attacker/repo" },
    { slackChannel: "C9999999999" },
    { includeDetails: false },
    { unknown: true },
  ])("rejects unknown or caller-controlled fields: %j", async (extra) => {
    const response = await POST(
      adminRequest({
        body: JSON.stringify({ ...validBody, ...extra }),
      }),
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "VALIDATION_ERROR" },
    });
    expect(serviceMocks.runConfiguredAccessRequest).not.toHaveBeenCalled();
  });

  it("injects fixed targets and returns a detailed replayable receipt", async () => {
    serviceMocks.runConfiguredAccessRequest.mockResolvedValue(
      workflowResult(true),
    );

    const response = await POST(
      adminRequest({ contentType: "application/json; charset=utf-8" }),
    );

    expect(serviceMocks.runConfiguredAccessRequest).toHaveBeenCalledOnce();
    expect(serviceMocks.runConfiguredAccessRequest).toHaveBeenCalledWith({
      githubUsername: "test-user",
      repository: "owner/repo",
      requestedPermission: "write",
      reason: "Diagnose an integration failure",
      slackChannel: "C0123456789",
      requestId: `admin:${submissionId}`,
      includeDetails: true,
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("idempotency-replayed")).toBe("true");
    await expect(response.json()).resolves.toMatchObject({
      status: "completed",
      requestId: `admin:${submissionId}`,
      steps: [],
    });
  });
});
