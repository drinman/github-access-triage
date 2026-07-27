import { NextRequest, NextResponse } from "next/server";

import { requireEnv } from "@/lib/env";
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

  const state = await createOAuthState(getStore(), {
    kind: "github-install",
    sessionHash: sessionBinding(session),
  });
  const target = new URL(
    `https://github.com/apps/${requireEnv("GITHUB_APP_SLUG")}/installations/new`,
  );
  target.searchParams.set("state", state);
  return NextResponse.redirect(target);
}
