import { NextRequest, NextResponse } from "next/server";

import { STORE_KEYS } from "@/lib/domain";
import { appBaseUrl } from "@/lib/env";
import { consumeOAuthState } from "@/lib/oauth-state";
import { exchangeAndVerifySlack } from "@/lib/providers";
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
    await consumeOAuthState(
      getStore(),
      request.nextUrl.searchParams.get("state"),
      "slack",
      sessionBinding(session),
    );
    const code = request.nextUrl.searchParams.get("code");
    if (!code) {
      throw new Error("Missing Slack code");
    }
    const connection = await exchangeAndVerifySlack({
      code,
      redirectUri: `${appBaseUrl(request.url)}/api/integrations/slack/callback`,
    });
    await getStore().set(STORE_KEYS.slackConnection, connection);
    return NextResponse.redirect(new URL("/?connected=slack", request.url));
  } catch {
    return NextResponse.redirect(
      new URL("/?connectionError=slack", request.url),
    );
  }
}
