import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { signToken } from "@/lib/crypto";
import {
  createAdminSession,
  readAdminSessionToken,
} from "@/lib/session";

const issuedAt = Math.floor(Date.now() / 1000);
const expiresAt = issuedAt + 8 * 60 * 60;

beforeEach(() => {
  vi.stubEnv("SESSION_SECRET", "test-session-secret");
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("admin session token purpose boundary", () => {
  it("accepts a valid admin session", () => {
    expect(readAdminSessionToken(createAdminSession())).toMatchObject({
      sessionId: expect.any(String),
      issuedAt: expect.any(Number),
      expiresAt: expect.any(Number),
    });
  });

  it.each([
    {
      nonce: "oauth-state-nonce",
      kind: "slack",
      issuedAt,
      expiresAt,
    },
    {
      sessionId: "550e8400-e29b-41d4-a716-446655440000",
      issuedAt,
      expiresAt,
      kind: "another-token-purpose",
    },
    {
      sessionId: "not-a-v4-uuid",
      issuedAt,
      expiresAt,
    },
    {
      sessionId: "550e8400-e29b-41d4-a716-446655440000",
      issuedAt,
      expiresAt: expiresAt + 1,
    },
  ])("rejects another signed token shape: %j", (payload) => {
    const token = signToken(payload, "test-session-secret");
    expect(readAdminSessionToken(token)).toBeNull();
  });
});
