import { NextRequest, NextResponse } from "next/server";

import { appBaseUrl, requireEnv } from "@/lib/env";
import {
  consumeOAuthState,
  createOAuthState,
  createPkceVerifier,
} from "@/lib/oauth-state";
import { pkceChallenge } from "@/lib/providers";
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
    const state = request.nextUrl.searchParams.get("state");
    const installationId = Number.parseInt(
      request.nextUrl.searchParams.get("installation_id") ?? "",
      10,
    );
    if (!Number.isSafeInteger(installationId) || installationId <= 0) {
      throw new Error("Invalid installation id");
    }

    await consumeOAuthState(
      getStore(),
      state,
      "github-install",
      sessionBinding(session),
    );

    const codeVerifier = createPkceVerifier();
    const oauthState = await createOAuthState(getStore(), {
      kind: "github-user",
      sessionHash: sessionBinding(session),
      installationId,
      codeVerifier,
    });
    const redirectUri = `${appBaseUrl(request.url)}/api/integrations/github/callback`;
    const target = new URL("https://github.com/login/oauth/authorize");
    target.searchParams.set("client_id", requireEnv("GITHUB_CLIENT_ID"));
    target.searchParams.set("redirect_uri", redirectUri);
    target.searchParams.set("state", oauthState);
    target.searchParams.set("code_challenge", pkceChallenge(codeVerifier));
    target.searchParams.set("code_challenge_method", "S256");
    return NextResponse.redirect(target);
  } catch {
    return NextResponse.redirect(
      new URL("/?connectionError=github", request.url),
    );
  }
}
