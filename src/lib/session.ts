import { createHash, randomUUID } from "node:crypto";

import type { NextRequest } from "next/server";
import { cookies } from "next/headers";

import {
  signToken,
  timingSafeStringEqual,
  verifySignedToken,
} from "@/lib/crypto";
import { requireEnv } from "@/lib/env";

export const ADMIN_COOKIE = "access_triage_admin";
const SESSION_LIFETIME_SECONDS = 8 * 60 * 60;

type AdminSession = {
  sessionId: string;
  issuedAt: number;
  expiresAt: number;
};

export function createAdminSession(now = Date.now()): string {
  const issuedAt = Math.floor(now / 1000);
  return signToken(
    {
      sessionId: randomUUID(),
      issuedAt,
      expiresAt: issuedAt + SESSION_LIFETIME_SECONDS,
    },
    requireEnv("SESSION_SECRET"),
  );
}

export function verifyAdminPassword(supplied: string): boolean {
  return timingSafeStringEqual(supplied, requireEnv("ADMIN_PASSWORD"));
}

export function readAdminSessionToken(
  token: string | undefined,
): AdminSession | null {
  return verifySignedToken<AdminSession>(
    token,
    requireEnv("SESSION_SECRET"),
  );
}

export async function getAdminSession(): Promise<AdminSession | null> {
  const cookieStore = await cookies();
  return readAdminSessionToken(cookieStore.get(ADMIN_COOKIE)?.value);
}

export function getRequestAdminSession(request: NextRequest): AdminSession | null {
  return readAdminSessionToken(request.cookies.get(ADMIN_COOKIE)?.value);
}

export function sessionBinding(session: AdminSession): string {
  return createHash("sha256").update(session.sessionId).digest("hex");
}

export const adminCookieOptions = {
  httpOnly: true,
  secure: process.env.NODE_ENV === "production",
  sameSite: "lax" as const,
  path: "/",
  maxAge: SESSION_LIFETIME_SECONDS,
};
