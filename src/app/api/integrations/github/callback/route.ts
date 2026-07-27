import { NextRequest, NextResponse } from "next/server";

import { STORE_KEYS } from "@/lib/domain";
import { appBaseUrl } from "@/lib/env";
import { consumeOAuthState } from "@/lib/oauth-state";
import {
  exchangeGitHubOAuthCode,
  verifyGitHubInstallation,
} from "@/lib/providers";
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

  try {
    const state = await consumeOAuthState(
      getStore(),
      request.nextUrl.searchParams.get("state"),
      "github-user",
      sessionBinding(session),
    );
    const code = request.nextUrl.searchParams.get("code");
    if (!code || !state.codeVerifier || !state.installationId) {
      throw new Error("Missing GitHub callback values");
    }
    const redirectUri = `${appBaseUrl(request.url)}/api/integrations/github/callback`;
    const userToken = await exchangeGitHubOAuthCode({
      code,
      codeVerifier: state.codeVerifier,
      redirectUri,
    });
    const connection = await verifyGitHubInstallation({
      installationId: state.installationId,
      userToken,
    });
    await getStore().set(STORE_KEYS.githubConnection, connection);
    return NextResponse.redirect(new URL("/?connected=github", request.url));
  } catch {
    return NextResponse.redirect(
      new URL("/?connectionError=github", request.url),
    );
  }
}
