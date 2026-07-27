import { NextRequest, NextResponse } from "next/server";

import {
  ADMIN_COOKIE,
  adminCookieOptions,
  createAdminSession,
  verifyAdminPassword,
} from "@/lib/session";

export const runtime = "nodejs";

export async function POST(request: NextRequest): Promise<NextResponse> {
  const form = await request.formData();
  const password = form.get("password");
  if (typeof password !== "string" || !verifyAdminPassword(password)) {
    return NextResponse.redirect(new URL("/login?error=invalid", request.url), {
      status: 303,
    });
  }

  const response = NextResponse.redirect(new URL("/", request.url), {
    status: 303,
  });
  response.cookies.set(ADMIN_COOKIE, createAdminSession(), adminCookieOptions);
  return response;
}
