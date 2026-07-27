import { describe, expect, it } from "vitest";

import {
  acquireRequestId,
  releaseRequestId,
  storeReplayableReceipt,
} from "@/lib/idempotency";
import { AppError } from "@/lib/errors";
import { MemoryStore } from "@/lib/store";

describe("idempotency ownership", () => {
  it("distinguishes in-progress requests from fingerprint conflicts", async () => {
    const store = new MemoryStore();
    await acquireRequestId(
      store,
      "demo",
      "fingerprint-a",
      "owner-a",
      "2026-07-27T00:00:00.000Z",
    );

    await expect(
      acquireRequestId(
        store,
        "demo",
        "fingerprint-a",
        "owner-b",
        "2026-07-27T00:00:01.000Z",
      ),
    ).rejects.toMatchObject({ code: "REQUEST_IN_PROGRESS" } satisfies Partial<AppError>);

    await expect(
      acquireRequestId(
        store,
        "demo",
        "fingerprint-b",
        "owner-b",
        "2026-07-27T00:00:01.000Z",
      ),
    ).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" } satisfies Partial<AppError>);
  });

  it("does not let an expired owner delete a newer lock", async () => {
    let clock = 0;
    const store = new MemoryStore(() => clock);
    const first = await acquireRequestId(
      store,
      "demo",
      "fingerprint",
      "owner-a",
      "2026-07-27T00:00:00.000Z",
    );
    expect(first.kind).toBe("acquired");

    clock = 301_000;
    const second = await acquireRequestId(
      store,
      "demo",
      "fingerprint",
      "owner-b",
      "2026-07-27T00:05:01.000Z",
    );
    expect(second.kind).toBe("acquired");

    if (first.kind !== "acquired" || second.kind !== "acquired") {
      throw new Error("Expected acquired records");
    }
    expect(await releaseRequestId(store, "demo", first.record)).toBe(false);
    await expect(
      acquireRequestId(
        store,
        "demo",
        "fingerprint",
        "owner-c",
        "2026-07-27T00:05:02.000Z",
      ),
    ).rejects.toMatchObject({ code: "REQUEST_IN_PROGRESS" });
  });

  it("stores and returns a replayable full receipt", async () => {
    const store = new MemoryStore();
    const acquired = await acquireRequestId(
      store,
      "demo",
      "fingerprint",
      "owner",
      "2026-07-27T00:00:00.000Z",
    );
    if (acquired.kind !== "acquired") {
      throw new Error("Expected acquired record");
    }
    const receipt = {
      status: "completed" as const,
      outcome: "approval_needed" as const,
      runId: "run",
      requestId: "demo",
      requestedAt: "start",
      completedAt: "end",
      summary: "done",
      github: {
        username: "user",
        repository: "owner/repo",
        requestedPermission: "write" as const,
        effectivePermission: "read",
        roleName: "read",
      },
      slack: {
        channel: "C0123456789",
        posted: true,
        messageTs: "123.456",
      },
      steps: [],
    };
    await storeReplayableReceipt(
      store,
      "demo",
      acquired.record,
      "fingerprint",
      "owner",
      receipt,
    );
    const replay = await acquireRequestId(
      store,
      "demo",
      "fingerprint",
      "other-owner",
      "later",
    );
    expect(replay).toMatchObject({
      kind: "replay",
      record: { receipt: { runId: "run" } },
    });
  });
});
