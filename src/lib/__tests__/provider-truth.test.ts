import { randomBytes } from "node:crypto";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { encryptSecret } from "@/lib/crypto";
import type {
  GitHubConnection,
  NormalizedAccessRequest,
  SlackConnection,
} from "@/lib/domain";
import {
  exchangeAndVerifySlack,
  LiveGitHubProvider,
  LiveSlackProvider,
  verifyGitHubInstallation,
} from "@/lib/providers";
import { MemoryStore } from "@/lib/store";

const providerMocks = vi.hoisted(() => ({
  auth: vi.fn(),
  createAppAuth: vi.fn(),
  requestDefaults: vi.fn(),
}));

vi.mock("@octokit/auth-app", () => ({
  createAppAuth: providerMocks.createAppAuth,
}));

vi.mock("@octokit/request", () => ({
  request: { defaults: providerMocks.requestDefaults },
}));

const githubConnection: GitHubConnection = {
  version: 1,
  provider: "github",
  status: "connected",
  installationId: 123,
  accountLogin: "owner",
  accountType: "Organization",
  repositorySelection: "selected",
  connectedAt: "2026-07-27T20:00:00.000Z",
  lastVerifiedAt: "2026-07-27T20:00:00.000Z",
};

const request: NormalizedAccessRequest = {
  githubUsername: "test-user",
  repository: "owner/repo",
  requestedPermission: "write",
  reason: "Diagnose an integration failure",
  slackChannel: "C0123456789",
  requestId: "demo",
  includeDetails: true,
};

const encryptionKey = randomBytes(32).toString("base64");
const slackConnection: SlackConnection = {
  version: 1,
  provider: "slack",
  status: "connected",
  encryptedBotToken: encryptSecret(
    "xoxb-test-token",
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

const permission = {
  effectivePermission: "read" as const,
  roleName: "read",
  isCustomRole: false,
};

beforeEach(() => {
  providerMocks.auth.mockReset();
  providerMocks.auth.mockResolvedValue({ token: "github-token" });
  providerMocks.createAppAuth.mockReset();
  providerMocks.createAppAuth.mockReturnValue(providerMocks.auth);
  providerMocks.requestDefaults.mockReset();
  providerMocks.requestDefaults.mockReturnValue(vi.fn());

  vi.stubEnv("GITHUB_APP_ID", "123");
  vi.stubEnv("GITHUB_PRIVATE_KEY", "test-private-key");
  vi.stubEnv("DEMO_GITHUB_REPOSITORY", "owner/repo");
  vi.stubEnv("TOKEN_ENCRYPTION_KEY", encryptionKey);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("GitHub provider truth boundary", () => {
  it("rejects unsafe repository segments before minting a token or building a URL", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      new LiveGitHubProvider(new MemoryStore()).readEffectivePermission(
        githubConnection,
        { ...request, repository: "owner/.." },
      ),
    ).rejects.toMatchObject({
      code: "VALIDATION_ERROR",
      httpStatus: 400,
    });
    expect(providerMocks.createAppAuth).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("mints a repository-scoped metadata token and rejects malformed permission JSON", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response("{}", { status: 200 }))
      .mockResolvedValueOnce(new Response("{}", { status: 200 }))
      .mockResolvedValueOnce(
        new Response(JSON.stringify(null), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      );
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      new LiveGitHubProvider(new MemoryStore()).readEffectivePermission(
        githubConnection,
        request,
      ),
    ).rejects.toMatchObject({
      code: "GITHUB_PROVIDER_ERROR",
      httpStatus: 502,
    });

    expect(providerMocks.auth).toHaveBeenCalledWith({
      type: "installation",
      repositoryNames: ["repo"],
      permissions: { metadata: "read" },
    });
    expect(providerMocks.requestDefaults).toHaveBeenCalledWith({
      request: { signal: expect.any(AbortSignal) },
    });
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      "https://api.github.com/repos/owner/repo",
      "https://api.github.com/users/test-user",
      "https://api.github.com/repos/owner/repo/collaborators/test-user/permission",
    ]);
    for (const [, options] of fetchMock.mock.calls) {
      expect(options.signal).toBeInstanceOf(AbortSignal);
    }
  });

  it("returns a retryable provider error when a GitHub read times out", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new DOMException("timed out", "TimeoutError");
      }),
    );

    await expect(
      new LiveGitHubProvider(new MemoryStore()).readEffectivePermission(
        githubConnection,
        request,
      ),
    ).rejects.toMatchObject({
      code: "GITHUB_PROVIDER_UNAVAILABLE",
      httpStatus: 502,
    });
  });

  it("rejects an all-repositories installation", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(
          new Response(
            JSON.stringify({
              total_count: 1,
              repositories: [{ full_name: "owner/repo" }],
            }),
            { status: 200 },
          ),
        )
        .mockResolvedValueOnce(
          new Response(
            JSON.stringify({
              repository_selection: "all",
              account: { login: "owner", type: "Organization" },
            }),
            { status: 200 },
          ),
        ),
    );

    await expect(
      verifyGitHubInstallation({
        installationId: 123,
        userToken: "user-token",
      }),
    ).rejects.toMatchObject({
      code: "GITHUB_REPOSITORY_SCOPE_REQUIRED",
      httpStatus: 403,
    });
    expect(providerMocks.auth).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: "installation" }),
    );
  });

  it("accepts only the configured selected repository", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(
          new Response(
            JSON.stringify({
              total_count: 1,
              repositories: [{ full_name: "Owner/Repo" }],
            }),
            { status: 200 },
          ),
        )
        .mockResolvedValueOnce(
          new Response(
            JSON.stringify({
              repository_selection: "selected",
              account: { login: "owner", type: "Organization" },
            }),
            { status: 200 },
          ),
        ),
    );

    await expect(
      verifyGitHubInstallation({
        installationId: 123,
        userToken: "user-token",
        now: new Date("2026-07-28T17:00:00.000Z"),
      }),
    ).resolves.toMatchObject({
      status: "connected",
      installationId: 123,
      accountLogin: "owner",
      repositorySelection: "selected",
      lastVerifiedAt: "2026-07-28T17:00:00.000Z",
    });
    expect(providerMocks.auth).toHaveBeenCalledWith({
      type: "installation",
      repositoryNames: ["repo"],
      permissions: { metadata: "read" },
    });
  });

  it("rejects a selected installation that includes another repository", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(
          new Response(
            JSON.stringify({
              total_count: 2,
              repositories: [
                { full_name: "owner/repo" },
                { full_name: "owner/another-private-repo" },
              ],
            }),
            { status: 200 },
          ),
        )
        .mockResolvedValueOnce(
          new Response(
            JSON.stringify({
              repository_selection: "selected",
              account: { login: "owner", type: "Organization" },
            }),
            { status: 200 },
          ),
        ),
    );

    await expect(
      verifyGitHubInstallation({
        installationId: 123,
        userToken: "user-token",
      }),
    ).rejects.toMatchObject({
      code: "GITHUB_REPOSITORY_SCOPE_REQUIRED",
      httpStatus: 403,
    });
    expect(providerMocks.auth).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: "installation" }),
    );
  });
});

describe("Slack provider truth boundary", () => {
  it.each([
    { ok: true },
    { ok: true, ts: " " },
    { ok: false },
    { ok: "true", ts: "123.456" },
    null,
    [],
  ])("treats malformed 2xx JSON as an ambiguous delivery: %j", async (body) => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(JSON.stringify(body), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      ),
    );

    await expect(
      new LiveSlackProvider(new MemoryStore()).postAccessRequest(
        slackConnection,
        request,
        "approval_needed",
        permission,
        "run",
      ),
    ).rejects.toMatchObject({
      code: "SLACK_DELIVERY_UNKNOWN",
      ambiguousDelivery: true,
    });
  });

  it("uses a deterministic rejection only for ok false with a nonempty error", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(
          JSON.stringify({ ok: false, error: "message_too_long" }),
          { status: 200 },
        ),
      ),
    );

    await expect(
      new LiveSlackProvider(new MemoryStore()).postAccessRequest(
        slackConnection,
        request,
        "approval_needed",
        permission,
        "run",
      ),
    ).rejects.toMatchObject({
      code: "SLACK_POST_REJECTED",
      ambiguousDelivery: false,
    });
  });

  it("treats a Slack POST timeout as an ambiguous delivery", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new DOMException("timed out", "TimeoutError");
      }),
    );

    await expect(
      new LiveSlackProvider(new MemoryStore()).postAccessRequest(
        slackConnection,
        request,
        "approval_needed",
        permission,
        "run",
      ),
    ).rejects.toMatchObject({
      code: "SLACK_DELIVERY_UNKNOWN",
      ambiguousDelivery: true,
    });
  });
});

describe("Slack OAuth least privilege", () => {
  it.each([
    [
      { token_type: "user", scope: "chat:write" },
      "SLACK_TOKEN_TYPE_REQUIRED",
    ],
    [
      { token_type: "bot", scope: "chat:write,channels:read" },
      "SLACK_SCOPE_REQUIRED",
    ],
  ])("rejects an overbroad or non-bot grant", async (grant, code) => {
    vi.stubEnv("SLACK_CLIENT_ID", "client");
    vi.stubEnv("SLACK_CLIENT_SECRET", "secret");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(
          JSON.stringify({
            ok: true,
            access_token: "xoxb-test",
            team: { id: "T1", name: "Demo" },
            ...grant,
          }),
          { status: 200 },
        ),
      ),
    );

    await expect(
      exchangeAndVerifySlack({
        code: "code",
        redirectUri: "https://example.com/callback",
      }),
    ).rejects.toMatchObject({ code, httpStatus: 403 });
  });

  it("accepts only a bot token with exactly chat:write and gives each call a fresh timeout", async () => {
    vi.stubEnv("SLACK_CLIENT_ID", "client");
    vi.stubEnv("SLACK_CLIENT_SECRET", "secret");
    const signals: AbortSignal[] = [];
    const fetchMock = vi.fn(
      async (_url: string | URL | Request, options?: RequestInit) => {
        signals.push(options?.signal as AbortSignal);
        if (signals.length === 1) {
          return new Response(
            JSON.stringify({
              ok: true,
              access_token: "xoxb-test",
              token_type: "bot",
              scope: "chat:write",
              team: { id: "T1", name: "Demo" },
            }),
            { status: 200 },
          );
        }
        return new Response(JSON.stringify({ ok: true, user_id: "U1" }), {
          status: 200,
        });
      },
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      exchangeAndVerifySlack({
        code: "code",
        redirectUri: "https://example.com/callback",
      }),
    ).resolves.toMatchObject({
      teamId: "T1",
      scopes: ["chat:write"],
    });
    expect(signals).toHaveLength(2);
    expect(signals[0]).toBeInstanceOf(AbortSignal);
    expect(signals[1]).toBeInstanceOf(AbortSignal);
    expect(signals[0]).not.toBe(signals[1]);
  });
});
