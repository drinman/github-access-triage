import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";

function toBase64Url(value: Buffer | string): string {
  return Buffer.from(value).toString("base64url");
}

function fromBase64Url(value: string): Buffer {
  return Buffer.from(value, "base64url");
}

function equalStrings(left: string, right: string): boolean {
  const leftDigest = createHash("sha256").update(left, "utf8").digest();
  const rightDigest = createHash("sha256").update(right, "utf8").digest();
  return timingSafeEqual(leftDigest, rightDigest);
}

export function verifyBearerHeader(
  authorization: string | null,
  expectedSecret: string,
): boolean {
  if (!authorization) {
    return false;
  }

  const match = /^Bearer ([^\s]+)$/.exec(authorization);
  if (!match) {
    return false;
  }

  return equalStrings(match[1], expectedSecret);
}

export function fingerprintBusinessInput(input: {
  githubUsername: string;
  repository: string;
  requestedPermission: string;
  reason: string;
  slackChannel: string;
}): string {
  const canonical = JSON.stringify({
    githubUsername: input.githubUsername,
    repository: input.repository,
    requestedPermission: input.requestedPermission,
    reason: input.reason,
    slackChannel: input.slackChannel,
  });
  return createHash("sha256").update(canonical).digest("hex");
}

function parseEncryptionKey(encodedKey: string): Buffer {
  const key = Buffer.from(encodedKey, "base64");
  if (key.length !== 32) {
    throw new Error(
      "TOKEN_ENCRYPTION_KEY must be a base64-encoded 32-byte key.",
    );
  }
  return key;
}

export function encryptSecret(
  plaintext: string,
  encodedKey: string,
  aad?: string,
): string {
  const key = parseEncryptionKey(encodedKey);
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  if (aad) {
    cipher.setAAD(Buffer.from(aad, "utf8"));
  }
  const ciphertext = Buffer.concat([
    cipher.update(plaintext, "utf8"),
    cipher.final(),
  ]);
  const authTag = cipher.getAuthTag();
  return ["v1", toBase64Url(iv), toBase64Url(authTag), toBase64Url(ciphertext)].join(
    ".",
  );
}

export function decryptSecret(
  envelope: string,
  encodedKey: string,
  aad?: string,
): string {
  const [version, ivValue, tagValue, ciphertextValue, extra] =
    envelope.split(".");
  if (
    version !== "v1" ||
    !ivValue ||
    !tagValue ||
    !ciphertextValue ||
    extra
  ) {
    throw new Error("Encrypted token envelope is invalid.");
  }

  const decipher = createDecipheriv(
    "aes-256-gcm",
    parseEncryptionKey(encodedKey),
    fromBase64Url(ivValue),
  );
  if (aad) {
    decipher.setAAD(Buffer.from(aad, "utf8"));
  }
  decipher.setAuthTag(fromBase64Url(tagValue));
  const plaintext = Buffer.concat([
    decipher.update(fromBase64Url(ciphertextValue)),
    decipher.final(),
  ]);
  return plaintext.toString("utf8");
}

export type SignedTokenPayload = Record<string, unknown> & {
  issuedAt: number;
  expiresAt: number;
};

export function signToken(
  payload: SignedTokenPayload,
  secret: string,
): string {
  const encodedPayload = toBase64Url(JSON.stringify(payload));
  const signature = createHmac("sha256", secret)
    .update(encodedPayload)
    .digest("base64url");
  return `${encodedPayload}.${signature}`;
}

export function verifySignedToken<T extends SignedTokenPayload>(
  token: string | undefined,
  secret: string,
  now = Date.now(),
): T | null {
  if (!token) {
    return null;
  }

  const [payloadValue, signatureValue, extra] = token.split(".");
  if (!payloadValue || !signatureValue || extra) {
    return null;
  }

  const expectedSignature = createHmac("sha256", secret)
    .update(payloadValue)
    .digest("base64url");
  if (!equalStrings(signatureValue, expectedSignature)) {
    return null;
  }

  try {
    const payload = JSON.parse(fromBase64Url(payloadValue).toString("utf8")) as T;
    if (
      typeof payload.expiresAt !== "number" ||
      payload.expiresAt <= Math.floor(now / 1000)
    ) {
      return null;
    }
    return payload;
  } catch {
    return null;
  }
}

export function timingSafeStringEqual(
  supplied: string,
  expected: string,
): boolean {
  return equalStrings(supplied, expected);
}
