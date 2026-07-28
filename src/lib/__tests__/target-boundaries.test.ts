import { afterEach, describe, expect, it, vi } from "vitest";

import { POST } from "@/app/api/access-requests/route";

const validRequest = {
  githubUsername: "octocat",
  repository: "drinman/private-access-demo",
  requestedPermission: "write",
  reason: "Complete the scoped take-home acceptance check.",
  slackChannel: "C0BKXAWH6SK",
  requestId: "scope-check",
};

afterEach(() => {
  vi.unstubAllEnvs();
});

function configureTargets(): void {
  vi.stubEnv("WEBHOOK_SECRET", "test-webhook-secret");
  vi.stubEnv(
    "DEMO_GITHUB_REPOSITORY",
    "Drinman/Private-Access-Demo",
  );
  vi.stubEnv("DEMO_SLACK_CHANNEL_ID", "C0BKXAWH6SK");
}

async function post(body: object): Promise<Response> {
  return POST(
    new Request("http://localhost/api/access-requests", {
      method: "POST",
      headers: {
        Authorization: "Bearer test-webhook-secret",
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    }),
  );
}

describe("configured demo targets", () => {
  it("rejects another repository before a store or provider is created", async () => {
    configureTargets();

    const response = await post({
      ...validRequest,
      repository: "drinman/another-private-repo",
    });

    expect(response.status).toBe(422);
    await expect(response.json()).resolves.toMatchObject({
      status: "failed",
      error: { code: "GITHUB_REPOSITORY_NOT_ALLOWED" },
    });
  });

  it("rejects another Slack channel before a store or provider is created", async () => {
    configureTargets();

    const response = await post({
      ...validRequest,
      slackChannel: "C0123456789",
    });

    expect(response.status).toBe(422);
    await expect(response.json()).resolves.toMatchObject({
      status: "failed",
      error: { code: "SLACK_CHANNEL_NOT_ALLOWED" },
    });
  });
});
