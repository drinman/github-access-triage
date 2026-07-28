import { describe, expect, it } from "vitest";

import { AppError } from "@/lib/errors";
import { decideAccess, interpretPermission } from "@/lib/permissions";
import { parseAccessRequest } from "@/lib/schema";

const valid = {
  githubUsername: " Test-User ",
  repository: " Owner/Repo ",
  requestedPermission: "write",
  reason: " Diagnose the issue ",
  slackChannel: "C0123456789",
  requestId: " demo-1 ",
  includeDetails: true,
};

describe("request parsing", () => {
  it("strictly validates and normalizes a request", () => {
    expect(parseAccessRequest(valid)).toEqual({
      githubUsername: "test-user",
      repository: "owner/repo",
      requestedPermission: "write",
      reason: "Diagnose the issue",
      slackChannel: "C0123456789",
      requestId: "demo-1",
      includeDetails: true,
    });
  });

  it.each([
    { ...valid, unknown: true },
    { ...valid, repository: "one/two/three" },
    { ...valid, repository: "../rate_limit" },
    { ...valid, repository: "owner/.." },
    { ...valid, repository: "./repo" },
    { ...valid, repository: "owner/." },
    { ...valid, githubUsername: "-invalid" },
    { ...valid, reason: "" },
    { ...valid, slackChannel: "access-requests" },
    { ...valid, includeDetails: "true" },
  ])("rejects invalid input", (input) => {
    expect(() => parseAccessRequest(input)).toThrow(AppError);
  });

  it.each(["owner.name/repo.name", "owner/.github"])(
    "allows valid dotted repository names: %s",
    (repository) => {
      expect(
        parseAccessRequest({ ...valid, repository }).repository,
      ).toBe(repository);
    },
  );
});

describe("permission decisions", () => {
  it.each([
    ["none", "read", "approval_needed"],
    ["read", "write", "approval_needed"],
    ["triage", "triage", "already_sufficient"],
    ["write", "read", "already_sufficient"],
    ["maintain", "admin", "approval_needed"],
    ["admin", "maintain", "already_sufficient"],
  ] as const)("%s requesting %s => %s", (current, requested, expected) => {
    expect(
      decideAccess(interpretPermission(current, "read"), requested),
    ).toBe(expected);
  });

  it("treats an unknown role_name as manual review", () => {
    const permission = interpretPermission("security-manager", "admin");
    expect(permission.isCustomRole).toBe(true);
    expect(decideAccess(permission, "read")).toBe("manual_review");
  });

  it("uses role_name before the lossy legacy permission", () => {
    expect(interpretPermission("maintain", "write")).toMatchObject({
      effectivePermission: "maintain",
      roleName: "maintain",
      isCustomRole: false,
    });
  });
});
