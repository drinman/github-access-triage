import { NextRequest, NextResponse } from "next/server";

import { ADMIN_COOKIE, adminCookieOptions } from "@/lib/session";

export async function POST(request: NextRequest): Promise<NextResponse> {
  const response = NextResponse.redirect(new URL("/login", request.url), {
    status: 303,
  });
  response.cookies.set(ADMIN_COOKIE, "", {
    ...adminCookieOptions,
    maxAge: 0,
  });
  return response;
}
