import { randomBytes } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  decryptSecret,
  encryptSecret,
  fingerprintBusinessInput,
  verifyBearerHeader,
} from "@/lib/crypto";

describe("webhook authentication", () => {
  it.each([
    null,
    "",
    "Basic demo-secret",
    "Bearer",
    "Bearer wrong",
    "bearer demo-secret",
  ])("rejects an invalid Authorization header: %s", (header) => {
    expect(verifyBearerHeader(header, "demo-secret")).toBe(false);
  });

  it("accepts only an exact Bearer value", () => {
    expect(
      verifyBearerHeader("Bearer demo-secret", "demo-secret"),
    ).toBe(true);
  });
});

describe("secret encryption", () => {
  const key = randomBytes(32).toString("base64");

  it("round-trips a token without storing plaintext", () => {
    const encrypted = encryptSecret("xoxb-sensitive", key, "slack:T1:v1");
    expect(encrypted).not.toContain("xoxb-sensitive");
    expect(decryptSecret(encrypted, key, "slack:T1:v1")).toBe(
      "xoxb-sensitive",
    );
  });

  it("uses a fresh IV and fails closed when tampered", () => {
    const first = encryptSecret("same-token", key, "slack:T1:v1");
    const second = encryptSecret("same-token", key, "slack:T1:v1");
    expect(first).not.toBe(second);

    const parts = first.split(".");
    parts[3] = `${parts[3][0] === "A" ? "B" : "A"}${parts[3].slice(1)}`;
    expect(() =>
      decryptSecret(parts.join("."), key, "slack:T1:v1"),
    ).toThrow();
    expect(() =>
      decryptSecret(first, key, "slack:other-workspace:v1"),
    ).toThrow();
  });
});

it("fingerprints business inputs in a stable field order", () => {
  const first = fingerprintBusinessInput({
    githubUsername: "person",
    repository: "owner/repo",
    requestedPermission: "write",
    reason: "diagnose",
    slackChannel: "C0123456789",
  });
  const second = fingerprintBusinessInput({
    githubUsername: "person",
    repository: "owner/repo",
    requestedPermission: "write",
    reason: "diagnose",
    slackChannel: "C0123456789",
  });
  expect(first).toBe(second);
});
