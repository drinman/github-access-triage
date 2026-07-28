import { randomBytes } from "node:crypto";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { encryptSecret } from "@/lib/crypto";
import type {
  Decision,
  GitHubPermissionResult,
  NormalizedAccessRequest,
  SlackConnection,
} from "@/lib/domain";
import { LiveSlackProvider } from "@/lib/providers";
import { MemoryStore } from "@/lib/store";

const encryptionKey = randomBytes(32).toString("base64");
const connection: SlackConnection = {
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
const request: NormalizedAccessRequest = {
  githubUsername: "test-user",
  repository: "owner/repo",
  requestedPermission: "write",
  reason: "Diagnose an integration failure",
  slackChannel: "C0123456789",
  requestId: "demo",
  includeDetails: true,
};
const standardPermission: GitHubPermissionResult = {
  effectivePermission: "read",
  roleName: "read",
  isCustomRole: false,
};
const customPermission: GitHubPermissionResult = {
  effectivePermission: null,
  roleName: "security-reviewer",
  isCustomRole: true,
};
const settingsLink =
  "<https://github.com/owner/repo/settings/access|Open repository access settings>";

type SlackBlock = {
  type?: unknown;
  text?: {
    type?: unknown;
    text?: unknown;
  };
};

type SlackPayload = {
  text?: unknown;
  blocks?: SlackBlock[];
  unfurl_links?: unknown;
  unfurl_media?: unknown;
};

function parseSlackPayload(fetchMock: ReturnType<typeof vi.fn>): SlackPayload {
  const init = fetchMock.mock.calls[0]?.[1] as RequestInit | undefined;
  expect(init?.body).toBeTypeOf("string");
  return JSON.parse(init?.body as string) as SlackPayload;
}

function mrkdwnText(payload: SlackPayload): string[] {
  return (
    payload.blocks
      ?.filter((block) => block.text?.type === "mrkdwn")
      .map((block) => block.text?.text)
      .filter((text): text is string => typeof text === "string") ?? []
  );
}

async function postAndReadPayload(
  decision: Decision,
  permission: GitHubPermissionResult,
): Promise<SlackPayload> {
  const fetchMock = vi.fn(async () =>
    new Response(JSON.stringify({ ok: true, ts: "123.456" }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }),
  );
  vi.stubGlobal("fetch", fetchMock);

  await new LiveSlackProvider(new MemoryStore()).postAccessRequest(
    connection,
    request,
    decision,
    permission,
    "run",
  );

  expect(fetchMock).toHaveBeenCalledOnce();
  return parseSlackPayload(fetchMock);
}

beforeEach(() => {
  vi.stubEnv("TOKEN_ENCRYPTION_KEY", encryptionKey);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("Slack access request message", () => {
  it("provides the exact manual approval handoff and keeps link unfurls off", async () => {
    const payload = await postAndReadPayload(
      "approval_needed",
      standardPermission,
    );

    expect(payload.text).toBe(
      "GitHub access request demo: Manual approval required for test-user on owner/repo; current access read, requested access write. Next step: Review this request. If approved, grant the requested access in GitHub: https://github.com/owner/repo/settings/access. This workflow does not change permissions automatically.",
    );
    expect(payload.blocks).toContainEqual({
      type: "header",
      text: {
        type: "plain_text",
        text: "GitHub access · Manual approval required",
      },
    });
    expect(mrkdwnText(payload)).toEqual([
      `*Next step:* Review this request. If approved, grant the requested access in GitHub: ${settingsLink}.\nThis workflow does not change permissions automatically.`,
    ]);
    expect(payload).toMatchObject({
      unfurl_links: false,
      unfurl_media: false,
    });
  });

  it("links manual review to the repository custom-role settings", async () => {
    const payload = await postAndReadPayload(
      "manual_review",
      customPermission,
    );

    expect(mrkdwnText(payload)).toEqual([
      `*Next step:* Review the custom role in GitHub settings: ${settingsLink}.\nThis workflow does not change permissions automatically.`,
    ]);
    expect(payload.text).toBe(
      "GitHub access request demo: Manual review for test-user on owner/repo; current access Custom role: security-reviewer, requested access write. Next step: Review the custom role in GitHub settings: https://github.com/owner/repo/settings/access. This workflow does not change permissions automatically.",
    );
  });

  it("requires no action and includes no settings link when access is sufficient", async () => {
    const payload = await postAndReadPayload(
      "already_sufficient",
      standardPermission,
    );

    expect(mrkdwnText(payload)).toEqual([
      "*Next step:* No action required. The requester already has sufficient access.",
    ]);
    expect(payload.text).toBe(
      "GitHub access request demo: Already sufficient for test-user on owner/repo; current access read, requested access write. Next step: No action required. The requester already has sufficient access.",
    );
    expect(JSON.stringify(payload)).not.toContain("/settings/access");
    expect(JSON.stringify(payload)).not.toContain(
      "Open repository access settings",
    );
  });
});
