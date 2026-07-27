import { describe, expect, it } from "vitest";

import type { GitHubConnection, SlackConnection } from "@/lib/domain";
import { STORE_KEYS } from "@/lib/domain";
import { readPublicStatus } from "@/lib/status";
import { MemoryStore } from "@/lib/store";

it("returns a stable degraded status before setup", async () => {
  const status = await readPublicStatus(new MemoryStore());
  expect(status).toMatchObject({
    status: "degraded",
    integrations: {
      github: { status: "disconnected", lastVerifiedAt: null },
      slack: { status: "disconnected", lastVerifiedAt: null },
    },
    lastSuccessfulRunAt: null,
  });
});

describe("ready status", () => {
  it("uses stored verification state without provider calls", async () => {
    const store = new MemoryStore();
    const github: GitHubConnection = {
      version: 1,
      provider: "github",
      status: "connected",
      installationId: 1,
      accountLogin: "owner",
      accountType: "Organization",
      repositorySelection: "selected",
      connectedAt: "2026-07-27T20:00:00.000Z",
      lastVerifiedAt: "2026-07-27T20:55:00.000Z",
    };
    const slack: SlackConnection = {
      version: 1,
      provider: "slack",
      status: "connected",
      encryptedBotToken: "ciphertext-only",
      teamId: "T1",
      teamName: "Demo",
      botUserId: "U1",
      scopes: ["chat:write"],
      connectedAt: "2026-07-27T20:00:00.000Z",
      lastVerifiedAt: "2026-07-27T21:01:00.000Z",
    };
    await store.set(STORE_KEYS.githubConnection, github);
    await store.set(STORE_KEYS.slackConnection, slack);
    await store.set(
      STORE_KEYS.lastSuccessfulRunAt,
      "2026-07-27T21:05:00.000Z",
    );

    const status = await readPublicStatus(store);
    expect(status.status).toBe("ready");
    expect(status.lastSuccessfulRunAt).toBe(
      "2026-07-27T21:05:00.000Z",
    );
    expect(JSON.stringify(status)).not.toContain("ciphertext-only");
    expect(JSON.stringify(status)).not.toContain("owner");
    expect(JSON.stringify(status)).not.toContain("Demo");
  });
});
