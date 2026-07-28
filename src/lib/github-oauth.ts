import { appBaseUrl, requireEnv } from "@/lib/env";
import {
  createOAuthState,
  createPkceVerifier,
} from "@/lib/oauth-state";
import { pkceChallenge } from "@/lib/providers";
import type { KeyValueStore } from "@/lib/store";

export async function createGitHubUserOAuthUrl(input: {
  store: KeyValueStore;
  requestUrl: string;
  sessionHash: string;
  installationId: number;
}): Promise<URL> {
  if (
    !Number.isSafeInteger(input.installationId) ||
    input.installationId <= 0
  ) {
    throw new Error("Invalid installation id");
  }

  const codeVerifier = createPkceVerifier();
  const state = await createOAuthState(input.store, {
    kind: "github-user",
    sessionHash: input.sessionHash,
    installationId: input.installationId,
    codeVerifier,
  });
  const redirectUri = `${appBaseUrl(input.requestUrl)}/api/integrations/github/callback`;
  const target = new URL("https://github.com/login/oauth/authorize");
  target.searchParams.set("client_id", requireEnv("GITHUB_CLIENT_ID"));
  target.searchParams.set("redirect_uri", redirectUri);
  target.searchParams.set("state", state);
  target.searchParams.set("code_challenge", pkceChallenge(codeVerifier));
  target.searchParams.set("code_challenge_method", "S256");
  return target;
}
