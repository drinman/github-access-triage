import type {
  Decision,
  GitHubPermissionResult,
  RequestedPermission,
  StandardPermission,
} from "@/lib/domain";
import { STANDARD_PERMISSIONS } from "@/lib/domain";

const standardSet = new Set<string>(STANDARD_PERMISSIONS);

export function interpretPermission(
  roleName: string | null | undefined,
  legacyPermission: string | null | undefined,
): GitHubPermissionResult {
  if (roleName) {
    if (standardSet.has(roleName)) {
      return {
        effectivePermission: roleName as StandardPermission,
        roleName,
        isCustomRole: false,
      };
    }
    return {
      effectivePermission: null,
      roleName,
      isCustomRole: true,
    };
  }

  const permission = legacyPermission ?? "none";
  if (standardSet.has(permission)) {
    return {
      effectivePermission: permission as StandardPermission,
      roleName: null,
      isCustomRole: false,
    };
  }

  return {
    effectivePermission: null,
    roleName: permission,
    isCustomRole: true,
  };
}

export function decideAccess(
  permission: GitHubPermissionResult,
  requested: RequestedPermission,
): Decision {
  if (permission.isCustomRole || !permission.effectivePermission) {
    return "manual_review";
  }

  const currentRank = STANDARD_PERMISSIONS.indexOf(
    permission.effectivePermission,
  );
  const requestedRank = STANDARD_PERMISSIONS.indexOf(requested);
  return currentRank >= requestedRank
    ? "already_sufficient"
    : "approval_needed";
}
