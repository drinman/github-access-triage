import { NextResponse } from "next/server";

import { readPublicStatus } from "@/lib/status";
import { getStore } from "@/lib/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(): Promise<NextResponse> {
  try {
    const status = await readPublicStatus(getStore());
    return NextResponse.json(status, {
      headers: { "Cache-Control": "no-store" },
    });
  } catch {
    return NextResponse.json(
      {
        status: "degraded",
        integrations: {
          github: { status: "disconnected", lastVerifiedAt: null },
          slack: { status: "disconnected", lastVerifiedAt: null },
        },
        lastSuccessfulRunAt: null,
        version:
          process.env.VERCEL_GIT_COMMIT_SHA ??
          process.env.NEXT_PUBLIC_APP_VERSION ??
          "local",
      },
      {
        status: 503,
        headers: { "Cache-Control": "no-store" },
      },
    );
  }
}
