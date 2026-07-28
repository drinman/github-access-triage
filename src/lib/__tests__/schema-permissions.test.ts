import { describe, expect, it } from "vitest";

import { AppError } from "@/lib/errors";
import { decideAccess, interpretPermission } from "@/lib/permissions";
import {
  parseAccessRequest,
  parseAdminAccessRequest,
  parseConfiguredAccessTargets,
} from "@/lib/schema";

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

describe("admin request parsing", () => {
  const adminRequest = {
    githubUsername: " Test-User ",
    requestedPermission: "write",
    reason: " Diagnose the issue ",
    submissionId: "550E8400-E29B-41D4-A716-446655440000",
  };

  it("strictly validates and normalizes the admin-only fields", () => {
    expect(parseAdminAccessRequest(adminRequest)).toEqual({
      githubUsername: "test-user",
      requestedPermission: "write",
      reason: "Diagnose the issue",
      submissionId: "550e8400-e29b-41d4-a716-446655440000",
    });
  });

  it.each([
    { ...adminRequest, submissionId: "not-a-uuid" },
    { ...adminRequest, repository: "owner/repo" },
    { ...adminRequest, slackChannel: "C0123456789" },
    { ...adminRequest, includeDetails: true },
    { ...adminRequest, unknown: true },
  ])("rejects invalid or caller-controlled fields", (input) => {
    expect(() => parseAdminAccessRequest(input)).toThrow(AppError);
  });
});

describe("configured target parsing", () => {
  it("normalizes a valid configured repository", () => {
    expect(
      parseConfiguredAccessTargets({
        repository: " Owner/Repo ",
        slackChannel: "C0123456789",
      }),
    ).toEqual({
      repository: "owner/repo",
      slackChannel: "C0123456789",
    });
  });

  it("reports invalid target configuration as a server error", () => {
    expect(() =>
      parseConfiguredAccessTargets({
        repository: "owner/..",
        slackChannel: "C0123456789",
      }),
    ).toThrow(
      expect.objectContaining({
        code: "CONFIGURATION_ERROR",
        httpStatus: 500,
      }),
    );
  });
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
