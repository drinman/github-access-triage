import { describe, expect, it, vi } from "vitest";

import type {
  GitHubConnection,
  GitHubPermissionResult,
  NormalizedAccessRequest,
  SlackConnection,
} from "@/lib/domain";
import { STORE_KEYS } from "@/lib/domain";
import { AppError } from "@/lib/errors";
import type {
  GitHubProvider,
  SlackProvider,
} from "@/lib/providers";
import { MemoryStore } from "@/lib/store";
import { executeAccessRequest } from "@/lib/workflow";

const request: NormalizedAccessRequest = {
  githubUsername: "test-user",
  repository: "owner/repo",
  requestedPermission: "write",
  reason: "Diagnose an integration failure",
  slackChannel: "C0123456789",
  requestId: "demo-001",
  includeDetails: false,
};

const githubConnection: GitHubConnection = {
  version: 1,
  provider: "github",
  status: "connected",
  installationId: 123,
  accountLogin: "owner",
  accountType: "Organization",
  repositorySelection: "selected",
  connectedAt: "2026-07-27T00:00:00.000Z",
  lastVerifiedAt: "2026-07-27T00:00:00.000Z",
};

const slackConnection: SlackConnection = {
  version: 1,
  provider: "slack",
  status: "connected",
  encryptedBotToken: "encrypted",
  teamId: "T1",
  teamName: "Demo",
  botUserId: "U1",
  scopes: ["chat:write"],
  connectedAt: "2026-07-27T00:00:00.000Z",
  lastVerifiedAt: "2026-07-27T00:00:00.000Z",
};

async function connectedStore(): Promise<MemoryStore> {
  const store = new MemoryStore();
  await store.set(STORE_KEYS.githubConnection, githubConnection);
  await store.set(STORE_KEYS.slackConnection, slackConnection);
  return store;
}

function providers(options?: {
  githubError?: AppError;
  slackError?: AppError;
  customRole?: boolean;
}) {
  const github: GitHubProvider = {
    readEffectivePermission: vi.fn(async (): Promise<GitHubPermissionResult> => {
      if (options?.githubError) {
        throw options.githubError;
      }
      if (options?.customRole) {
        return {
          effectivePermission: null,
          roleName: "security-manager",
          isCustomRole: true,
        };
      }
      return {
        effectivePermission: "read",
        roleName: "read",
        isCustomRole: false,
      };
    }),
  };
  const slack: SlackProvider = {
    postAccessRequest: vi.fn(async () => {
      if (options?.slackError) {
        throw options.slackError;
      }
      return { messageTs: "123.456" };
    }),
  };
  return { github, slack };
}

function fixedDependencies(
  store: MemoryStore,
  providerSet: ReturnType<typeof providers>,
) {
  let id = 0;
  return {
    store,
    ...providerSet,
    now: () => new Date("2026-07-27T20:55:00.000Z"),
    createId: () => `id-${++id}`,
  };
}

describe("workflow", () => {
  it("posts once, persists success, and replays with a new projection", async () => {
    const store = await connectedStore();
    const providerSet = providers();
    const first = await executeAccessRequest(
      request,
      fixedDependencies(store, providerSet),
    );
    expect(first).toMatchObject({
      httpStatus: 200,
      replayed: false,
      receipt: {
        status: "completed",
        outcome: "approval_needed",
        slack: { posted: true, messageTs: "123.456" },
      },
    });
    expect(first.receipt.steps).toBeUndefined();

    const replay = await executeAccessRequest(
      { ...request, includeDetails: true },
      fixedDependencies(store, providerSet),
    );
    expect(replay.replayed).toBe(true);
    expect(replay.receipt.runId).toBe(first.receipt.runId);
    expect(replay.receipt.steps).toBeDefined();
    expect(providerSet.slack.postAccessRequest).toHaveBeenCalledTimes(1);
  });

  it("keeps repository and user errors distinct and never calls Slack", async () => {
    const store = await connectedStore();
    const providerSet = providers({
      githubError: new AppError(
        "GITHUB_REPOSITORY_NOT_ACCESSIBLE",
        "Repository unavailable",
        404,
      ),
    });
    const result = await executeAccessRequest(
      request,
      fixedDependencies(store, providerSet),
    );
    expect(result).toMatchObject({
      httpStatus: 404,
      receipt: {
        status: "failed",
        error: { code: "GITHUB_REPOSITORY_NOT_ACCESSIBLE" },
      },
    });
    expect(providerSet.slack.postAccessRequest).not.toHaveBeenCalled();
  });

  it.each([
    [
      "SLACK_BOT_NOT_IN_CHANNEL",
      422,
      "Invite the bot",
    ],
    ["SLACK_CHANNEL_NOT_FOUND", 422, "Channel unavailable"],
    ["SLACK_RATE_LIMITED", 429, "Rate limited"],
  ])("returns %s as failed and immediately releases the ID", async (code, status, message) => {
    const store = await connectedStore();
    const firstProviders = providers({
      slackError: new AppError(code, message, status, {
        retryAfterSeconds: code === "SLACK_RATE_LIMITED" ? 30 : undefined,
      }),
    });
    const first = await executeAccessRequest(
      request,
      fixedDependencies(store, firstProviders),
    );
    expect(first.receipt).toMatchObject({
      status: "failed",
      error: { code },
      slack: { posted: false },
    });

    const retryProviders = providers();
    const retry = await executeAccessRequest(
      request,
      fixedDependencies(store, retryProviders),
    );
    expect(retry.receipt.status).toBe("completed");
    expect(retryProviders.slack.postAccessRequest).toHaveBeenCalledOnce();
  });

  it("routes custom roles to manual review", async () => {
    const store = await connectedStore();
    const result = await executeAccessRequest(
      request,
      fixedDependencies(store, providers({ customRole: true })),
    );
    expect(result.receipt.outcome).toBe("manual_review");
  });

  it("stores partial_failure before a noncritical metadata write", async () => {
    class LastSuccessFailingStore extends MemoryStore {
      override async set<T>(
        key: string,
        value: T,
        ttlSeconds?: number,
      ): Promise<void> {
        if (key === STORE_KEYS.lastSuccessfulRunAt) {
          throw new Error("metadata unavailable");
        }
        return super.set(key, value, ttlSeconds);
      }
    }
    const store = new LastSuccessFailingStore();
    await store.set(STORE_KEYS.githubConnection, githubConnection);
    await store.set(STORE_KEYS.slackConnection, slackConnection);
    const providerSet = providers();

    const result = await executeAccessRequest(
      request,
      fixedDependencies(store, providerSet),
    );
    expect(result).toMatchObject({
      httpStatus: 200,
      receipt: {
        status: "partial_failure",
        slack: { posted: true },
      },
    });

    const replay = await executeAccessRequest(
      request,
      fixedDependencies(store, providerSet),
    );
    expect(replay.replayed).toBe(true);
    expect(replay.receipt.status).toBe("partial_failure");
    expect(providerSet.slack.postAccessRequest).toHaveBeenCalledOnce();
  });

  it("returns degraded dependency errors without provider calls", async () => {
    const store = new MemoryStore();
    const providerSet = providers();
    const result = await executeAccessRequest(
      request,
      fixedDependencies(store, providerSet),
    );
    expect(result).toMatchObject({
      httpStatus: 503,
      receipt: {
        status: "failed",
        error: { code: "GITHUB_CONNECTION_REQUIRED" },
      },
    });
    expect(providerSet.github.readEffectivePermission).not.toHaveBeenCalled();
  });
});
