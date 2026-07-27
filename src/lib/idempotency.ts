import type {
  IdempotencyRecord,
  InternalReceipt,
  ProcessingRecord,
  ReplayableRecord,
} from "@/lib/domain";
import { STORE_KEYS } from "@/lib/domain";
import { AppError } from "@/lib/errors";
import type { KeyValueStore } from "@/lib/store";

export const PROCESSING_TTL_SECONDS = 5 * 60;
export const REPLAY_TTL_SECONDS = 24 * 60 * 60;

export type AcquireResult =
  | { kind: "acquired"; record: ProcessingRecord }
  | { kind: "replay"; record: ReplayableRecord };

export async function acquireRequestId(
  store: KeyValueStore,
  requestId: string,
  fingerprint: string,
  operationId: string,
  startedAt: string,
): Promise<AcquireResult> {
  const key = STORE_KEYS.idempotency(requestId);
  const record: ProcessingRecord = {
    state: "processing",
    fingerprint,
    operationId,
    startedAt,
  };

  for (let attempt = 0; attempt < 2; attempt += 1) {
    if (await store.setIfAbsent(key, record, PROCESSING_TTL_SECONDS)) {
      return { kind: "acquired", record };
    }

    const existing = await store.get<IdempotencyRecord>(key);
    if (!existing) {
      continue;
    }

    if (existing.fingerprint !== fingerprint) {
      throw new AppError(
        "IDEMPOTENCY_CONFLICT",
        "This requestId was already used with different business inputs.",
        409,
      );
    }

    if (existing.state === "processing") {
      throw new AppError(
        "REQUEST_IN_PROGRESS",
        "A request with this requestId is still processing.",
        409,
      );
    }

    return { kind: "replay", record: existing };
  }

  throw new AppError(
    "REQUEST_IN_PROGRESS",
    "A request with this requestId is still processing.",
    409,
  );
}

export async function releaseRequestId(
  store: KeyValueStore,
  requestId: string,
  ownedRecord: ProcessingRecord,
): Promise<boolean> {
  return store.compareAndDelete(
    STORE_KEYS.idempotency(requestId),
    ownedRecord,
  );
}

export async function storeReplayableReceipt(
  store: KeyValueStore,
  requestId: string,
  expected: ProcessingRecord | ReplayableRecord,
  fingerprint: string,
  operationId: string,
  receipt: InternalReceipt,
): Promise<ReplayableRecord | null> {
  const next: ReplayableRecord = {
    state: "replayable",
    fingerprint,
    operationId,
    receipt,
  };
  const stored = await store.compareAndSet(
    STORE_KEYS.idempotency(requestId),
    expected,
    next,
    REPLAY_TTL_SECONDS,
  );
  return stored ? next : null;
}
