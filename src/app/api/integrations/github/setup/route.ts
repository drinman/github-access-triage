import { NextRequest, NextResponse } from "next/server";

import { createGitHubUserOAuthUrl } from "@/lib/github-oauth";
import { consumeOAuthState } from "@/lib/oauth-state";
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
    const store = getStore();
    const state = request.nextUrl.searchParams.get("state");
    const installationId = Number.parseInt(
      request.nextUrl.searchParams.get("installation_id") ?? "",
      10,
    );
    if (!Number.isSafeInteger(installationId) || installationId <= 0) {
      throw new Error("Invalid installation id");
    }

    await consumeOAuthState(
      store,
      state,
      "github-install",
      sessionBinding(session),
    );

    const target = await createGitHubUserOAuthUrl({
      store,
      requestUrl: request.url,
      sessionHash: sessionBinding(session),
      installationId,
    });
    return NextResponse.redirect(target);
  } catch {
    return NextResponse.redirect(
      new URL("/?connectionError=github", request.url),
    );
  }
}
