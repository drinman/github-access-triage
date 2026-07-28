import { NextRequest, NextResponse } from "next/server";

import type { GitHubConnection } from "@/lib/domain";
import { STORE_KEYS } from "@/lib/domain";
import { requireEnv } from "@/lib/env";
import { createGitHubUserOAuthUrl } from "@/lib/github-oauth";
import { createOAuthState } from "@/lib/oauth-state";
import {
  getRequestAdminSession,
  sessionBinding,
} from "@/lib/session";
import { getStore } from "@/lib/store";

export const runtime = "nodejs";

export async function GET(request: NextRequest): Promise<NextResponse> {
  const session = getRequestAdminSession(request);
  if (!session) {
    return NextResponse.redirect(new URL("/login", request.url));
  }

  const store = getStore();
  const changeInstallation =
    request.nextUrl.searchParams.get("mode") === "install";
  const existingConnection = changeInstallation
    ? null
    : await store.get<GitHubConnection>(STORE_KEYS.githubConnection);

  if (existingConnection) {
    const target = await createGitHubUserOAuthUrl({
      store,
      requestUrl: request.url,
      sessionHash: sessionBinding(session),
      installationId: existingConnection.installationId,
    });
    return NextResponse.redirect(target);
  }

  const state = await createOAuthState(store, {
    kind: "github-install",
    sessionHash: sessionBinding(session),
  });
  const target = new URL(
    `https://github.com/apps/${requireEnv("GITHUB_APP_SLUG")}/installations/new`,
  );
  target.searchParams.set("state", state);
  return NextResponse.redirect(target);
}
