import { createHash } from "node:crypto";

import { createAppAuth } from "@octokit/auth-app";
import { request as octokitRequest } from "@octokit/request";

import { decryptSecret, encryptSecret } from "@/lib/crypto";
import type {
  Decision,
  GitHubConnection,
  GitHubPermissionResult,
  NormalizedAccessRequest,
  SlackConnection,
  SlackPostResult,
} from "@/lib/domain";
import { STORE_KEYS } from "@/lib/domain";
import { requireEnv } from "@/lib/env";
import { AppError } from "@/lib/errors";
import { interpretPermission } from "@/lib/permissions";
import type { KeyValueStore } from "@/lib/store";

const GITHUB_API_VERSION = "2026-03-10";
const PROVIDER_TIMEOUT_MS = 10_000;
const SLACK_AUTH_ERRORS = new Set([
  "invalid_auth",
  "token_revoked",
  "token_expired",
  "account_inactive",
  "not_authed",
  "missing_scope",
]);

type JsonObject = Record<string, unknown>;

function providerSignal(): AbortSignal {
  return AbortSignal.timeout(PROVIDER_TIMEOUT_MS);
}

async function safeJson(response: Response): Promise<JsonObject> {
  try {
    const value: unknown = await response.json();
    if (
      typeof value !== "object" ||
      value === null ||
      Array.isArray(value)
    ) {
      return {};
    }
    return value as JsonObject;
  } catch {
    return {};
  }
}

function nonemptyString(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const normalized = value.trim();
  return normalized.length > 0 ? normalized : null;
}

function parseRepository(repository: string): {
  owner: string;
  name: string;
} {
  const segments = repository.split("/");
  const [owner, name] = segments;
  const validSegment = /^[A-Za-z0-9_.-]+$/;
  if (
    segments.length !== 2 ||
    !owner ||
    !name ||
    owner === "." ||
    owner === ".." ||
    name === "." ||
    name === ".." ||
    !validSegment.test(owner) ||
    !validSegment.test(name)
  ) {
    throw new AppError(
      "VALIDATION_ERROR",
      "The repository must contain a valid owner and name.",
      400,
    );
  }
  return { owner, name };
}

function numericStatus(error: unknown): number | null {
  if (
    typeof error === "object" &&
    error !== null &&
    "status" in error &&
    typeof error.status === "number"
  ) {
    return error.status;
  }
  return null;
}

function isAbortError(error: unknown): boolean {
  return (
    error instanceof DOMException &&
    (error.name === "AbortError" || error.name === "TimeoutError")
  );
}

function githubHeaders(token: string): HeadersInit {
  return {
    Accept: "application/vnd.github+json",
    Authorization: `Bearer ${token}`,
    "X-GitHub-Api-Version": GITHUB_API_VERSION,
    "User-Agent": "github-access-triage",
  };
}

async function mintGitHubToken(
  installationId: number,
): Promise<string> {
  const { name: repositoryName } = parseRepository(
    requireEnv("DEMO_GITHUB_REPOSITORY"),
  );
  try {
    const auth = createAppAuth({
      appId: requireEnv("GITHUB_APP_ID"),
      privateKey: requireEnv("GITHUB_PRIVATE_KEY").replace(/\\n/g, "\n"),
      installationId,
      request: octokitRequest.defaults({
        request: { signal: providerSignal() },
      }),
    });
    const result = await auth({
      type: "installation",
      repositoryNames: [repositoryName],
      permissions: { metadata: "read" },
    });
    return result.token;
  } catch (error) {
    const status = numericStatus(error);
    if (isAbortError(error) || status === null || status >= 500) {
      throw new AppError(
        "GITHUB_PROVIDER_UNAVAILABLE",
        "GitHub could not be reached while minting a scoped token. Retry the request.",
        502,
        { cause: error },
      );
    }
    throw new AppError(
      "GITHUB_CONNECTION_REQUIRED",
      "The GitHub App installation is no longer available. Reconnect GitHub.",
      503,
      {
        credentialInvalid: status === 401 || status === 404,
        cause: error,
      },
    );
  }
}

async function readGitHubInstallationMetadata(
  installationId: number,
): Promise<JsonObject> {
  let response: Response;
  try {
    const auth = createAppAuth({
      appId: requireEnv("GITHUB_APP_ID"),
      privateKey: requireEnv("GITHUB_PRIVATE_KEY").replace(/\\n/g, "\n"),
    });
    const appAuthentication = await auth({ type: "app" });
    response = await fetch(
      `https://api.github.com/app/installations/${installationId}`,
      {
        headers: githubHeaders(appAuthentication.token),
        cache: "no-store",
        signal: providerSignal(),
      },
    );
  } catch (error) {
    throw new AppError(
      "GITHUB_INSTALLATION_NOT_VERIFIED",
      "GitHub could not be reached while verifying this installation.",
      502,
      { cause: error },
    );
  }
  if (!response.ok) {
    throw new AppError(
      "GITHUB_INSTALLATION_NOT_VERIFIED",
      "The GitHub App could not verify this installation.",
      403,
    );
  }
  return safeJson(response);
}

async function markGitHubInvalid(
  store: KeyValueStore,
  connection: GitHubConnection,
): Promise<void> {
  await store.compareAndSet(
    STORE_KEYS.githubConnection,
    connection,
    {
      ...connection,
      status: "invalid" as const,
    },
  );
}

async function markSlackInvalid(
  store: KeyValueStore,
  connection: SlackConnection,
): Promise<void> {
  await store.compareAndSet(
    STORE_KEYS.slackConnection,
    connection,
    {
      ...connection,
      status: "invalid" as const,
    },
  );
}

export interface GitHubProvider {
  readEffectivePermission(
    connection: GitHubConnection,
    request: NormalizedAccessRequest,
  ): Promise<GitHubPermissionResult>;
}

export interface SlackProvider {
  postAccessRequest(
    connection: SlackConnection,
    request: NormalizedAccessRequest,
    decision: Decision,
    permission: GitHubPermissionResult,
    runId: string,
  ): Promise<SlackPostResult>;
}

export class LiveGitHubProvider implements GitHubProvider {
  constructor(
    private readonly store: KeyValueStore,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async readEffectivePermission(
    connection: GitHubConnection,
    request: NormalizedAccessRequest,
  ): Promise<GitHubPermissionResult> {
    const { owner, name } = parseRepository(request.repository);
    const encodedOwner = encodeURIComponent(owner);
    const encodedName = encodeURIComponent(name);
    let currentConnection = connection;
    let token: string;
    try {
      token = await mintGitHubToken(connection.installationId);
    } catch (error) {
      if (error instanceof AppError && error.credentialInvalid) {
        try {
          await markGitHubInvalid(this.store, connection);
        } catch {
          // Preserve the provider error if status persistence is unavailable.
        }
      }
      throw error;
    }

    const call = async (path: string) => {
      try {
        return await fetch(`https://api.github.com${path}`, {
          headers: githubHeaders(token),
          cache: "no-store",
          signal: providerSignal(),
        });
      } catch (error) {
        throw new AppError(
          "GITHUB_PROVIDER_UNAVAILABLE",
          "GitHub could not be reached. Retry the request.",
          502,
          { cause: error },
        );
      }
    };

    const repositoryResponse = await call(
      `/repos/${encodedOwner}/${encodedName}`,
    );

    if (repositoryResponse.status === 404) {
      throw new AppError(
        "GITHUB_REPOSITORY_NOT_ACCESSIBLE",
        "The repository was not found or is not accessible to the GitHub App.",
        404,
      );
    }
    await this.assertGitHubResponse(repositoryResponse, currentConnection);
    currentConnection = await this.refreshVerification(currentConnection);

    const userResponse = await call(
      `/users/${encodeURIComponent(request.githubUsername)}`,
    );
    if (userResponse.status === 404) {
      throw new AppError(
        "GITHUB_USER_NOT_FOUND",
        "The supplied GitHub user was not found.",
        404,
      );
    }
    await this.assertGitHubResponse(userResponse, currentConnection);

    const permissionResponse = await call(
      `/repos/${encodedOwner}/${encodedName}/collaborators/${encodeURIComponent(
        request.githubUsername,
      )}/permission`,
    );
    if (permissionResponse.status === 404) {
      return interpretPermission("none", "none");
    }
    await this.assertGitHubResponse(permissionResponse, currentConnection);
    const body = await safeJson(permissionResponse);
    const roleName = nonemptyString(body.role_name);
    const legacyPermission = nonemptyString(body.permission);
    if (!roleName && !legacyPermission) {
      throw new AppError(
        "GITHUB_PROVIDER_ERROR",
        "GitHub returned an invalid permission response.",
        502,
      );
    }

    return interpretPermission(roleName, legacyPermission);
  }

  private async assertGitHubResponse(
    response: Response,
    connection: GitHubConnection,
  ): Promise<void> {
    if (response.ok) {
      return;
    }
    if (response.status === 401) {
      try {
        await markGitHubInvalid(this.store, connection);
      } catch {
        // Preserve the provider error if status persistence is unavailable.
      }
      throw new AppError(
        "GITHUB_CONNECTION_REQUIRED",
        "GitHub rejected the installation credentials. Reconnect GitHub.",
        503,
        { credentialInvalid: true },
      );
    }
    if (
      response.status === 403 &&
      response.headers.get("x-ratelimit-remaining") === "0"
    ) {
      throw new AppError(
        "GITHUB_RATE_LIMITED",
        "GitHub rate-limited the permission lookup. Retry later.",
        502,
      );
    }
    throw new AppError(
      "GITHUB_PROVIDER_ERROR",
      "GitHub could not complete the permission lookup.",
      502,
    );
  }

  private async refreshVerification(
    connection: GitHubConnection,
  ): Promise<GitHubConnection> {
    const refreshed: GitHubConnection = {
      ...connection,
      status: "connected",
      lastVerifiedAt: this.now().toISOString(),
    };
    try {
      const updated = await this.store.compareAndSet(
        STORE_KEYS.githubConnection,
        connection,
        refreshed,
      );
      return updated ? refreshed : connection;
    } catch {
      // Verification freshness is noncritical to the access decision.
      return connection;
    }
  }
}

function slackAad(teamId: string): string {
  return `slack:${teamId}:v1`;
}

function decisionLabel(decision: Decision): string {
  switch (decision) {
    case "approval_needed":
      return "Manual approval required";
    case "already_sufficient":
      return "Already sufficient";
    case "manual_review":
      return "Manual review";
  }
}

function githubRepositorySettingsUrl(repository: string): string {
  const { owner, name } = parseRepository(repository);
  return `https://github.com/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/settings/access`;
}

function slackNextStep(
  request: NormalizedAccessRequest,
  decision: Decision,
): string {
  if (decision === "already_sufficient") {
    return "*Next step:* No action required. The requester already has sufficient access.";
  }

  const settingsUrl = githubRepositorySettingsUrl(request.repository);
  if (decision === "approval_needed") {
    return `*Next step:* Review this request. If approved, grant the requested access in GitHub: <${settingsUrl}|Open repository access settings>.\nThis workflow does not change permissions automatically.`;
  }

  return `*Next step:* Review the custom role in GitHub settings: <${settingsUrl}|Open repository access settings>.\nThis workflow does not change permissions automatically.`;
}

function slackFallbackNextStep(
  request: NormalizedAccessRequest,
  decision: Decision,
): string {
  if (decision === "already_sufficient") {
    return "Next step: No action required. The requester already has sufficient access.";
  }

  const settingsUrl = githubRepositorySettingsUrl(request.repository);
  if (decision === "approval_needed") {
    return `Next step: Review this request. If approved, grant the requested access in GitHub: ${settingsUrl}. This workflow does not change permissions automatically.`;
  }

  return `Next step: Review the custom role in GitHub settings: ${settingsUrl}. This workflow does not change permissions automatically.`;
}

function effectiveAccessLabel(
  permission: GitHubPermissionResult,
): string {
  return permission.isCustomRole
    ? `Custom role: ${permission.roleName ?? "unknown"}`
    : (permission.effectivePermission ?? "none");
}

function buildSlackBlocks(
  request: NormalizedAccessRequest,
  decision: Decision,
  permission: GitHubPermissionResult,
  runId: string,
): JsonObject[] {
  const effective = effectiveAccessLabel(permission);

  return [
    {
      type: "header",
      text: {
        type: "plain_text",
        text: `GitHub access · ${decisionLabel(decision)}`,
      },
    },
    {
      type: "section",
      fields: [
        {
          type: "plain_text",
          text: `Requester\n${request.githubUsername}`,
        },
        {
          type: "plain_text",
          text: `Repository\n${request.repository}`,
        },
        {
          type: "plain_text",
          text: `Current access\n${effective}`,
        },
        {
          type: "plain_text",
          text: `Requested access\n${request.requestedPermission}`,
        },
      ],
    },
    {
      type: "section",
      text: {
        type: "plain_text",
        text: `Reason\n${request.reason}`,
      },
    },
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: slackNextStep(request, decision),
      },
    },
    {
      type: "context",
      elements: [
        {
          type: "plain_text",
          text: `Request ${request.requestId ?? runId}`,
        },
      ],
    },
  ];
}

export class LiveSlackProvider implements SlackProvider {
  constructor(
    private readonly store: KeyValueStore,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async postAccessRequest(
    connection: SlackConnection,
    request: NormalizedAccessRequest,
    decision: Decision,
    permission: GitHubPermissionResult,
    runId: string,
  ): Promise<SlackPostResult> {
    const token = decryptSecret(
      connection.encryptedBotToken,
      requireEnv("TOKEN_ENCRYPTION_KEY"),
      slackAad(connection.teamId),
    );

    let response: Response;
    try {
      response = await fetch("https://slack.com/api/chat.postMessage", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json; charset=utf-8",
        },
        body: JSON.stringify({
          channel: request.slackChannel,
          text: `GitHub access request ${request.requestId ?? runId}: ${decisionLabel(decision)} for ${request.githubUsername} on ${request.repository}; current access ${effectiveAccessLabel(permission)}, requested access ${request.requestedPermission}. ${slackFallbackNextStep(request, decision)}`,
          blocks: buildSlackBlocks(
            request,
            decision,
            permission,
            runId,
          ),
          unfurl_links: false,
          unfurl_media: false,
        }),
        cache: "no-store",
        signal: providerSignal(),
      });
    } catch (error) {
      throw new AppError(
        "SLACK_DELIVERY_UNKNOWN",
        "Slack did not confirm delivery. The request is held briefly to reduce duplicate risk.",
        502,
        { ambiguousDelivery: true, cause: error },
      );
    }

    if (response.status === 429) {
      const retryAfterSeconds = Number.parseInt(
        response.headers.get("retry-after") ?? "0",
        10,
      );
      throw new AppError(
        "SLACK_RATE_LIMITED",
        "Slack rate-limited the post. Retry after the indicated delay.",
        429,
        {
          retryAfterSeconds: Number.isFinite(retryAfterSeconds)
            ? retryAfterSeconds
            : undefined,
        },
      );
    }

    const body = await safeJson(response);
    const providerCode = nonemptyString(body.error);
    if (response.ok && body.ok === true) {
      const messageTs = nonemptyString(body.ts);
      if (!messageTs) {
        throw new AppError(
          "SLACK_DELIVERY_UNKNOWN",
          "Slack accepted the request but did not return a message identifier.",
          502,
          { ambiguousDelivery: true },
        );
      }

      try {
        await this.store.compareAndSet(
          STORE_KEYS.slackConnection,
          connection,
          {
            ...connection,
            status: "connected" as const,
            lastVerifiedAt: this.now().toISOString(),
          },
        );
      } catch {
        // Receipt persistence is the first critical write after this method returns.
      }

      return { messageTs };
    }

    const explicitRejection = body.ok === false && providerCode !== null;
    if (!response.ok || explicitRejection) {
      const rejectionCode = providerCode ?? "unknown_error";
      if (SLACK_AUTH_ERRORS.has(rejectionCode)) {
        try {
          await markSlackInvalid(this.store, connection);
        } catch {
          // Preserve the provider error if status persistence is unavailable.
        }
        throw new AppError(
          "SLACK_CONNECTION_REQUIRED",
          "Slack rejected the stored credentials. Reconnect Slack.",
          503,
          { credentialInvalid: true },
        );
      }
      if (rejectionCode === "not_in_channel") {
        throw new AppError(
          "SLACK_BOT_NOT_IN_CHANNEL",
          "The Slack bot is not a member of the supplied channel. Invite it or use the demo channel documented in the README.",
          422,
        );
      }
      if (rejectionCode === "channel_not_found") {
        throw new AppError(
          "SLACK_CHANNEL_NOT_FOUND",
          "The supplied Slack channel was not found or is not accessible to the connected bot.",
          422,
        );
      }
      if (
        response.status >= 500 ||
        rejectionCode === "internal_error" ||
        rejectionCode === "fatal_error"
      ) {
        throw new AppError(
          "SLACK_DELIVERY_UNKNOWN",
          "Slack did not confirm whether the message was posted. The request is held briefly to reduce duplicate risk.",
          502,
          { ambiguousDelivery: true },
        );
      }
      throw new AppError(
        "SLACK_POST_REJECTED",
        "Slack rejected the message. No message was confirmed.",
        502,
      );
    }

    throw new AppError(
      "SLACK_DELIVERY_UNKNOWN",
      "Slack returned a malformed delivery response. The request is held briefly to reduce duplicate risk.",
      502,
      { ambiguousDelivery: true },
    );
  }
}

export async function exchangeGitHubOAuthCode(input: {
  code: string;
  codeVerifier: string;
  redirectUri: string;
}): Promise<string> {
  let response: Response;
  try {
    response = await fetch("https://github.com/login/oauth/access_token", {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        client_id: requireEnv("GITHUB_CLIENT_ID"),
        client_secret: requireEnv("GITHUB_CLIENT_SECRET"),
        code: input.code,
        code_verifier: input.codeVerifier,
        redirect_uri: input.redirectUri,
      }),
      cache: "no-store",
      signal: providerSignal(),
    });
  } catch (error) {
    throw new AppError(
      "GITHUB_OAUTH_FAILED",
      "GitHub could not be reached during OAuth. Retry the connection.",
      502,
      { cause: error },
    );
  }
  const body = await safeJson(response);
  if (!response.ok || typeof body.access_token !== "string") {
    throw new AppError(
      "GITHUB_OAUTH_FAILED",
      "GitHub could not verify the installation.",
      502,
    );
  }
  return body.access_token;
}

export async function verifyGitHubInstallation(input: {
  installationId: number;
  userToken: string;
  now?: Date;
}): Promise<GitHubConnection> {
  let userResponse: Response;
  try {
    userResponse = await fetch(
      `https://api.github.com/user/installations/${input.installationId}/repositories?per_page=100`,
      {
        headers: githubHeaders(input.userToken),
        cache: "no-store",
        signal: providerSignal(),
      },
    );
  } catch (error) {
    throw new AppError(
      "GITHUB_INSTALLATION_NOT_VERIFIED",
      "GitHub could not be reached while verifying this installation.",
      502,
      { cause: error },
    );
  }
  if (!userResponse.ok) {
    throw new AppError(
      "GITHUB_INSTALLATION_NOT_VERIFIED",
      "The signed-in GitHub user could not verify this installation.",
      403,
    );
  }
  const userBody = await safeJson(userResponse);
  const installation = await readGitHubInstallationMetadata(
    input.installationId,
  );
  const repositorySelection =
    (installation.repository_selection ??
      userBody.repository_selection) === "all"
      ? "all"
      : "selected";
  if (repositorySelection === "all") {
    throw new AppError(
      "GITHUB_REPOSITORY_SCOPE_REQUIRED",
      "Configure the GitHub App installation for only the demo repository.",
      403,
    );
  }
  const configuredRepository = requireEnv("DEMO_GITHUB_REPOSITORY")
    .trim()
    .toLowerCase();
  const selectedRepositories = Array.isArray(userBody.repositories)
    ? userBody.repositories
        .map((repository) =>
          typeof repository === "object" &&
          repository !== null &&
          !Array.isArray(repository)
            ? nonemptyString((repository as JsonObject).full_name)
            : null,
        )
        .filter((repository): repository is string => repository !== null)
        .map((repository) => repository.toLowerCase())
    : null;
  if (
    userBody.total_count !== 1 ||
    selectedRepositories?.length !== 1 ||
    selectedRepositories[0] !== configuredRepository
  ) {
    throw new AppError(
      "GITHUB_REPOSITORY_SCOPE_REQUIRED",
      "Configure the GitHub App installation for only the demo repository.",
      403,
    );
  }
  const account =
    typeof installation.account === "object" && installation.account
      ? (installation.account as JsonObject)
      : {};

  // Also prove the App can mint an installation token before replacing state.
  await mintGitHubToken(input.installationId);
  const verifiedAt = (input.now ?? new Date()).toISOString();
  return {
    version: 1,
    provider: "github",
    status: "connected",
    installationId: input.installationId,
    accountLogin:
      typeof account.login === "string" ? account.login : "GitHub installation",
    accountType:
      account.type === "Organization" ? "Organization" : "User",
    repositorySelection,
    connectedAt: verifiedAt,
    lastVerifiedAt: verifiedAt,
  };
}

type SlackOAuthResponse = {
  ok?: boolean;
  access_token?: string;
  token_type?: string;
  scope?: string;
  bot_user_id?: string;
  team?: { id?: string; name?: string };
  error?: string;
  refresh_token?: string;
  expires_in?: number;
};

export async function exchangeAndVerifySlack(input: {
  code: string;
  redirectUri: string;
  now?: Date;
}): Promise<SlackConnection> {
  const credentials = Buffer.from(
    `${requireEnv("SLACK_CLIENT_ID")}:${requireEnv("SLACK_CLIENT_SECRET")}`,
  ).toString("base64");
  let response: Response;
  try {
    response = await fetch("https://slack.com/api/oauth.v2.access", {
      method: "POST",
      headers: {
        Authorization: `Basic ${credentials}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({
        code: input.code,
        redirect_uri: input.redirectUri,
      }),
      cache: "no-store",
      signal: providerSignal(),
    });
  } catch (error) {
    throw new AppError(
      "SLACK_OAUTH_FAILED",
      "Slack could not be reached during OAuth. Retry the connection.",
      502,
      { cause: error },
    );
  }
  const body = (await safeJson(response)) as SlackOAuthResponse;

  if (
    !response.ok ||
    body.ok !== true ||
    !body.access_token ||
    !body.team?.id
  ) {
    throw new AppError(
      "SLACK_OAUTH_FAILED",
      "Slack could not complete the connection.",
      502,
    );
  }
  if (body.refresh_token || body.expires_in) {
    throw new AppError(
      "SLACK_TOKEN_ROTATION_UNSUPPORTED",
      "Disable Slack token rotation for this scoped demo before reconnecting.",
      400,
    );
  }
  if (body.token_type !== "bot") {
    throw new AppError(
      "SLACK_TOKEN_TYPE_REQUIRED",
      "The Slack connection must return a bot token.",
      403,
    );
  }

  const grantedScopes = (body.scope ?? "")
    .split(",")
    .map((scope) => scope.trim())
    .filter(Boolean);
  const scopes = [...new Set(grantedScopes)];
  if (scopes.length !== 1 || scopes[0] !== "chat:write") {
    throw new AppError(
      "SLACK_SCOPE_REQUIRED",
      "The Slack connection must grant only chat:write.",
      403,
    );
  }

  let authTestResponse: Response;
  try {
    authTestResponse = await fetch("https://slack.com/api/auth.test", {
      method: "POST",
      headers: { Authorization: `Bearer ${body.access_token}` },
      cache: "no-store",
      signal: providerSignal(),
    });
  } catch (error) {
    throw new AppError(
      "SLACK_OAUTH_FAILED",
      "Slack could not verify the bot token. Retry the connection.",
      502,
      { cause: error },
    );
  }
  const authTest = await safeJson(authTestResponse);
  if (!authTestResponse.ok || authTest.ok !== true) {
    throw new AppError(
      "SLACK_OAUTH_FAILED",
      "Slack returned a token that could not be verified.",
      502,
    );
  }

  const verifiedAt = (input.now ?? new Date()).toISOString();
  return {
    version: 1,
    provider: "slack",
    status: "connected",
    encryptedBotToken: encryptSecret(
      body.access_token,
      requireEnv("TOKEN_ENCRYPTION_KEY"),
      slackAad(body.team.id),
    ),
    teamId: body.team.id,
    teamName: body.team.name ?? "Slack workspace",
    botUserId:
      typeof authTest.user_id === "string"
        ? authTest.user_id
        : (body.bot_user_id ?? null),
    scopes,
    connectedAt: verifiedAt,
    lastVerifiedAt: verifiedAt,
  };
}

export function pkceChallenge(verifier: string): string {
  return createHash("sha256").update(verifier).digest("base64url");
}
