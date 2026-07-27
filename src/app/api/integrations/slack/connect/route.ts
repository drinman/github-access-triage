import { NextRequest, NextResponse } from "next/server";

import { appBaseUrl, requireEnv } from "@/lib/env";
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
    kind: "slack",
    sessionHash: sessionBinding(session),
  });
  const target = new URL("https://slack.com/oauth/v2/authorize");
  target.searchParams.set("client_id", requireEnv("SLACK_CLIENT_ID"));
  target.searchParams.set("scope", "chat:write");
  target.searchParams.set("state", state);
  target.searchParams.set(
    "redirect_uri",
    `${appBaseUrl(request.url)}/api/integrations/slack/callback`,
  );
  return NextResponse.redirect(target);
}
