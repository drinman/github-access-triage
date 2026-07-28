import { renderToStaticMarkup } from "react-dom/server";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

import { GET as githubCallback } from "@/app/api/integrations/github/callback/route";
import { GET as githubConnect } from "@/app/api/integrations/github/connect/route";
import { GET as githubSetup } from "@/app/api/integrations/github/setup/route";
import {
  AccessDocket,
  type DocketSnapshot,
} from "@/components/access-docket";
import type { GitHubConnection } from "@/lib/domain";
import { STORE_KEYS } from "@/lib/domain";
import {
  consumeOAuthState,
  createOAuthState,
} from "@/lib/oauth-state";
import {
  ADMIN_COOKIE,
  createAdminSession,
  readAdminSessionToken,
  sessionBinding,
} from "@/lib/session";
import { getStore, MemoryStore } from "@/lib/store";

vi.mock("@/lib/store", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/store")>();
  return {
    ...actual,
    getStore: vi.fn(),
  };
});

const connection: GitHubConnection = {
  version: 1,
  provider: "github",
  status: "connected",
  installationId: 12345,
  accountLogin: "demo-owner",
  accountType: "User",
  repositorySelection: "selected",
  connectedAt: "2026-07-28T16:00:00.000Z",
  lastVerifiedAt: "2026-07-28T16:00:00.000Z",
};

let store: MemoryStore;

function authenticatedRequest(
  url: string,
  token = createAdminSession(),
): NextRequest {
  return new NextRequest(url, {
    headers: {
      cookie: `${ADMIN_COOKIE}=${token}`,
    },
  });
}

function bindingFor(request: NextRequest): string {
  const token = request.cookies.get(ADMIN_COOKIE)?.value;
  const session = readAdminSessionToken(token);
  if (!session) {
    throw new Error("Expected an authenticated test request");
  }
  return sessionBinding(session);
}

beforeEach(() => {
  vi.stubEnv("SESSION_SECRET", "test-session-secret");
  vi.stubEnv("GITHUB_APP_SLUG", "access-docket");
  vi.stubEnv("GITHUB_CLIENT_ID", "github-client-id");
  vi.stubEnv("GITHUB_CLIENT_SECRET", "github-client-secret");
  vi.stubEnv("APP_BASE_URL", "https://access.example");
  store = new MemoryStore();
  vi.mocked(getStore).mockReturnValue(store);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("GitHub reconnect routes", () => {
  it("reverifies an existing installation without reopening installation setup", async () => {
    await store.set(STORE_KEYS.githubConnection, connection);
    const request = authenticatedRequest(
      "https://access.example/api/integrations/github/connect",
    );

    const response = await githubConnect(request);
    const target = new URL(response.headers.get("location") ?? "");

    expect(target.origin + target.pathname).toBe(
      "https://github.com/login/oauth/authorize",
    );
    expect(target.searchParams.get("code_challenge_method")).toBe("S256");
    const state = await consumeOAuthState(
      store,
      target.searchParams.get("state"),
      "github-user",
      bindingFor(request),
    );
    expect(state).toMatchObject({
      installationId: connection.installationId,
    });
    expect(state.codeVerifier).toBeTruthy();
  });

  it.each([
    "https://access.example/api/integrations/github/connect",
    "https://access.example/api/integrations/github/connect?mode=install",
  ])(
    "uses installation setup when no reusable installation is selected: %s",
    async (url) => {
      if (url.includes("mode=install")) {
        await store.set(STORE_KEYS.githubConnection, connection);
      }
      const request = authenticatedRequest(url);

      const response = await githubConnect(request);
      const target = new URL(response.headers.get("location") ?? "");

      expect(target.origin + target.pathname).toBe(
        "https://github.com/apps/access-docket/installations/new",
      );
      await expect(
        consumeOAuthState(
          store,
          target.searchParams.get("state"),
          "github-install",
          bindingFor(request),
        ),
      ).resolves.toMatchObject({ kind: "github-install" });
    },
  );

  it("continues an installation callback through the same PKCE user OAuth flow", async () => {
    const token = createAdminSession();
    const request = authenticatedRequest(
      "https://access.example/api/integrations/github/setup",
      token,
    );
    const state = await createOAuthState(store, {
      kind: "github-install",
      sessionHash: bindingFor(request),
    });
    const callbackRequest = authenticatedRequest(
      `https://access.example/api/integrations/github/setup?installation_id=777&state=${encodeURIComponent(state)}`,
      token,
    );

    const response = await githubSetup(callbackRequest);
    const target = new URL(response.headers.get("location") ?? "");

    expect(target.origin + target.pathname).toBe(
      "https://github.com/login/oauth/authorize",
    );
    const oauthState = await consumeOAuthState(
      store,
      target.searchParams.get("state"),
      "github-user",
      bindingFor(request),
    );
    expect(oauthState).toMatchObject({ installationId: 777 });
    expect(oauthState.codeVerifier).toBeTruthy();
  });

  it("preserves the prior connection when reverification fails", async () => {
    await store.set(STORE_KEYS.githubConnection, connection);
    const token = createAdminSession();
    const request = authenticatedRequest(
      "https://access.example/api/integrations/github/callback",
      token,
    );
    const state = await createOAuthState(store, {
      kind: "github-user",
      sessionHash: bindingFor(request),
      installationId: connection.installationId,
      codeVerifier: "test-code-verifier",
    });
    const callbackRequest = authenticatedRequest(
      `https://access.example/api/integrations/github/callback?code=bad-code&state=${encodeURIComponent(state)}`,
      token,
    );
    const fetchMock = vi.fn(async () =>
      Response.json({ error: "bad_verification_code" }, { status: 400 }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const response = await githubCallback(callbackRequest);

    expect(response.headers.get("location")).toBe(
      "https://access.example/?connectionError=github",
    );
    await expect(
      store.get<GitHubConnection>(STORE_KEYS.githubConnection),
    ).resolves.toEqual(connection);
    expect(fetchMock).toHaveBeenCalledOnce();
  });
});

describe("GitHub connection controls", () => {
  const connectedSnapshot: DocketSnapshot = {
    github: {
      status: "connected",
      lastVerifiedAt: connection.lastVerifiedAt,
      label: connection.accountLogin,
    },
    slack: {
      status: "disconnected",
      lastVerifiedAt: null,
    },
    lastSuccessfulRunAt: null,
  };

  it("offers reverify and an explicit installation-scope change separately", () => {
    const markup = renderToStaticMarkup(
      <AccessDocket snapshot={connectedSnapshot} />,
    );

    expect(markup).toContain("Reverify GitHub");
    expect(markup).toContain("Change installation scope");
    expect(markup).toContain(
      "/api/integrations/github/connect?mode=install",
    );
  });
});
