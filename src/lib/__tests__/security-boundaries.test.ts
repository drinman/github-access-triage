import { randomBytes } from "node:crypto";

import { afterEach, describe, expect, it, vi } from "vitest";

import { POST } from "@/app/api/access-requests/route";
import { encryptSecret } from "@/lib/crypto";
import type { SlackConnection } from "@/lib/domain";
import { AppError } from "@/lib/errors";
import {
  consumeOAuthState,
  createOAuthState,
} from "@/lib/oauth-state";
import { LiveSlackProvider } from "@/lib/providers";
import { MemoryStore } from "@/lib/store";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("public trigger boundary", () => {
  it.each([null, "Basic secret", "Bearer wrong", "Bearer secret-extra"])(
    "rejects an invalid credential before parsing the body",
    async (authorization) => {
      vi.stubEnv("WEBHOOK_SECRET", "secret");
      const headers = new Headers();
      if (authorization) {
        headers.set("Authorization", authorization);
      }
      const response = await POST(
        new Request("http://localhost/api/access-requests", {
          method: "POST",
          headers,
          body: "not-json",
        }),
      );
      expect(response.status).toBe(401);
      const body = await response.text();
      expect(body).toContain("UNAUTHORIZED");
      expect(body).not.toContain("secret");
    },
  );

  it("authenticates before returning a JSON validation error", async () => {
    vi.stubEnv("WEBHOOK_SECRET", "secret");
    const response = await POST(
      new Request("http://localhost/api/access-requests", {
        method: "POST",
        headers: { Authorization: "Bearer secret" },
        body: "not-json",
      }),
    );
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      status: "failed",
      error: { code: "VALIDATION_ERROR" },
    });
  });
});

describe("OAuth state boundary", () => {
  it("is signed, session-bound, expiring, and single-use", async () => {
    vi.stubEnv("SESSION_SECRET", "state-signing-secret");
    const store = new MemoryStore();
    const state = await createOAuthState(
      store,
      { kind: "slack", sessionHash: "session-a" },
    );

    await expect(
      consumeOAuthState(store, state, "slack", "session-b"),
    ).rejects.toMatchObject({ code: "INVALID_OAUTH_STATE" });
    await expect(
      consumeOAuthState(store, state, "slack", "session-a"),
    ).resolves.toMatchObject({ kind: "slack" });
    await expect(
      consumeOAuthState(store, state, "slack", "session-a"),
    ).rejects.toMatchObject({ code: "INVALID_OAUTH_STATE" });
  });
});

describe("Slack provider boundary", () => {
  const encryptionKey = randomBytes(32).toString("base64");
  const token = "xoxb-never-return-this-token";
  const connection: SlackConnection = {
    version: 1,
    provider: "slack",
    status: "connected",
    encryptedBotToken: encryptSecret(
      token,
      encryptionKey,
      "slack:T1:v1",
    ),
    teamId: "T1",
    teamName: "Demo",
    botUserId: "U1",
    scopes: ["chat:write"],
    connectedAt: "2026-07-27T20:00:00.000Z",
    lastVerifiedAt: "2026-07-27T20:00:00.000Z",
  };
  const request = {
    githubUsername: "user",
    repository: "owner/repo",
    requestedPermission: "write" as const,
    reason: "diagnose",
    slackChannel: "C0123456789",
    requestId: "demo",
    includeDetails: true,
  };
  const permission = {
    effectivePermission: "read" as const,
    roleName: "read",
    isCustomRole: false,
  };

  it("maps membership errors without leaking the token", async () => {
    vi.stubEnv("TOKEN_ENCRYPTION_KEY", encryptionKey);
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ ok: false, error: "not_in_channel" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const provider = new LiveSlackProvider(new MemoryStore());
    let caught: unknown;
    try {
      await provider.postAccessRequest(
        connection,
        request,
        "approval_needed",
        permission,
        "run",
      );
    } catch (error) {
      caught = error;
    }
    expect(caught).toMatchObject({
      code: "SLACK_BOT_NOT_IN_CHANNEL",
    } satisfies Partial<AppError>);
    expect(JSON.stringify(caught)).not.toContain(token);
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("reads Retry-After and makes no automatic retry", async () => {
    vi.stubEnv("TOKEN_ENCRYPTION_KEY", encryptionKey);
    const fetchMock = vi.fn(async () =>
      new Response("", {
        status: 429,
        headers: { "Retry-After": "17" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      new LiveSlackProvider(new MemoryStore()).postAccessRequest(
        connection,
        request,
        "approval_needed",
        permission,
        "run",
      ),
    ).rejects.toMatchObject({
      code: "SLACK_RATE_LIMITED",
      retryAfterSeconds: 17,
    });
    expect(fetchMock).toHaveBeenCalledOnce();
  });
});
