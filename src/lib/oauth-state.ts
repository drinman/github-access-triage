import { randomBytes } from "node:crypto";

import {
  signToken,
  type SignedTokenPayload,
  verifySignedToken,
} from "@/lib/crypto";
import { requireEnv } from "@/lib/env";
import { AppError } from "@/lib/errors";
import type { KeyValueStore } from "@/lib/store";

const STATE_TTL_SECONDS = 10 * 60;

export type OAuthStateKind = "github-install" | "github-user" | "slack";

type OAuthStateRecord = {
  version: 1;
  nonce: string;
  kind: OAuthStateKind;
  sessionHash: string;
  installationId?: number;
  codeVerifier?: string;
  createdAt: string;
};

type StateTokenPayload = SignedTokenPayload & {
  nonce: string;
  kind: OAuthStateKind;
};

function key(nonce: string): string {
  return `access-triage:oauth-state:${nonce}`;
}

export async function createOAuthState(
  store: KeyValueStore,
  input: Omit<OAuthStateRecord, "version" | "nonce" | "createdAt">,
  now = Date.now(),
): Promise<string> {
  const nonce = randomBytes(24).toString("base64url");
  const issuedAt = Math.floor(now / 1000);
  const record: OAuthStateRecord = {
    version: 1,
    nonce,
    createdAt: new Date(now).toISOString(),
    ...input,
  };
  await store.set(key(nonce), record, STATE_TTL_SECONDS);

  return signToken(
    {
      nonce,
      kind: record.kind,
      issuedAt,
      expiresAt: issuedAt + STATE_TTL_SECONDS,
    },
    requireEnv("SESSION_SECRET"),
  );
}

export async function consumeOAuthState(
  store: KeyValueStore,
  token: string | null,
  expectedKind: OAuthStateKind,
  expectedSessionHash: string,
): Promise<OAuthStateRecord> {
  const payload = verifySignedToken<StateTokenPayload>(
    token ?? undefined,
    requireEnv("SESSION_SECRET"),
  );
  if (!payload || payload.kind !== expectedKind) {
    throw new AppError(
      "INVALID_OAUTH_STATE",
      "The connection attempt expired or could not be verified.",
      400,
    );
  }

  const record = await store.get<OAuthStateRecord>(key(payload.nonce));
  if (
    !record ||
    record.kind !== expectedKind ||
    record.sessionHash !== expectedSessionHash
  ) {
    throw new AppError(
      "INVALID_OAUTH_STATE",
      "The connection attempt expired or could not be verified.",
      400,
    );
  }

  const consumed = await store.compareAndDelete(key(payload.nonce), record);
  if (!consumed) {
    throw new AppError(
      "INVALID_OAUTH_STATE",
      "The connection attempt was already used.",
      400,
    );
  }
  return record;
}

export function createPkceVerifier(): string {
  return randomBytes(48).toString("base64url");
}
