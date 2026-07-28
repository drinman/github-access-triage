import { createHash, randomUUID } from "node:crypto";

import type { NextRequest } from "next/server";
import { cookies } from "next/headers";

import {
  signToken,
  type SignedTokenPayload,
  timingSafeStringEqual,
  verifySignedToken,
} from "@/lib/crypto";
import { requireEnv } from "@/lib/env";

export const ADMIN_COOKIE = "access_triage_admin";
const SESSION_LIFETIME_SECONDS = 8 * 60 * 60;
const ADMIN_SESSION_KEYS = new Set([
  "sessionId",
  "issuedAt",
  "expiresAt",
]);
const UUID_V4_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

type AdminSession = {
  sessionId: string;
  issuedAt: number;
  expiresAt: number;
};

function isAdminSession(payload: SignedTokenPayload): payload is AdminSession {
  if (
    typeof payload !== "object" ||
    payload === null ||
    Array.isArray(payload)
  ) {
    return false;
  }

  const keys = Object.keys(payload);
  return (
    keys.length === ADMIN_SESSION_KEYS.size &&
    keys.every((key) => ADMIN_SESSION_KEYS.has(key)) &&
    typeof payload.sessionId === "string" &&
    UUID_V4_PATTERN.test(payload.sessionId) &&
    Number.isSafeInteger(payload.issuedAt) &&
    Number.isSafeInteger(payload.expiresAt) &&
    payload.issuedAt >= 0 &&
    payload.expiresAt === payload.issuedAt + SESSION_LIFETIME_SECONDS
  );
}

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
  const payload = verifySignedToken<SignedTokenPayload>(
    token,
    requireEnv("SESSION_SECRET"),
  );
  return payload && isAdminSession(payload) ? payload : null;
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
