import { renderToStaticMarkup } from "react-dom/server";

import { describe, expect, it } from "vitest";

import {
  AccessCheckPanel,
  type AdminAccessReceipt,
  mustPreserveSubmissionIdentity,
  receiptPresentation,
} from "@/components/access-check-panel";

function receipt(
  overrides: Partial<AdminAccessReceipt>,
): AdminAccessReceipt {
  return {
    status: "completed",
    outcome: "approval_needed",
    ...overrides,
  };
}

describe("admin access check panel", () => {
  it("renders the ready defaults and locked deployment scope", () => {
    const markup = renderToStaticMarkup(
      <AccessCheckPanel
        githubReady
        slackReady
        repository="drinman/private-access-demo"
        slackChannel="C0BKXAWH6SK"
        slackTeamId="T0123456789"
      />,
    );

    expect(markup).toContain('value="octocat"');
    expect(markup).toContain("Needs access to diagnose an integration failure");
    expect(markup).toContain('<option value="write" selected="">Write</option>');
    expect(markup).toContain("drinman/private-access-demo");
    expect(markup).toContain(
      "https://app.slack.com/client/T0123456789/C0BKXAWH6SK",
    );
    expect(markup).toContain("one real Slack");
    expect(markup).toContain("Run access check");
    expect(markup).not.toContain('name="repository"');
    expect(markup).not.toContain('name="slackChannel"');
    expect(markup).not.toContain("WEBHOOK_SECRET");
  });

  it("disables submission until both providers are connected", () => {
    const markup = renderToStaticMarkup(
      <AccessCheckPanel
        githubReady
        slackReady={false}
        repository="drinman/private-access-demo"
        slackChannel="C0BKXAWH6SK"
        slackTeamId=""
      />,
    );

    expect(markup).toContain("Connect Slack before running a check.");
    expect(markup).toContain("<fieldset disabled=");
    expect(markup).toContain('type="submit" disabled=""');
  });
});

describe("access receipt presentation", () => {
  it.each([
    [
      receipt({ outcome: "approval_needed" }),
      "Approval needed",
      "success",
    ],
    [
      receipt({ outcome: "already_sufficient" }),
      "Access already sufficient",
      "success",
    ],
    [
      receipt({ outcome: "manual_review" }),
      "Manual review required",
      "warning",
    ],
    [
      receipt({ status: "partial_failure" }),
      "Slack posted; finalization is incomplete",
      "warning",
    ],
    [
      receipt({ status: "indeterminate" }),
      "Delivery could not be confirmed",
      "warning",
    ],
    [
      receipt({
        status: "failed",
        outcome: null,
        error: { code: "UNAUTHORIZED", message: "Unauthorized" },
      }),
      "Session expired",
      "error",
    ],
    [
      receipt({
        status: "failed",
        outcome: null,
        error: {
          code: "REQUEST_IN_PROGRESS",
          message: "Still processing",
        },
      }),
      "Request already processing",
      "warning",
    ],
    [
      receipt({
        status: "failed",
        outcome: null,
        error: {
          code: "IDEMPOTENCY_CONFLICT",
          message: "Identity conflict",
        },
      }),
      "Request identity conflict",
      "error",
    ],
    [
      receipt({
        status: "indeterminate",
        outcome: null,
        error: {
          code: "SLACK_DELIVERY_UNKNOWN",
          message: "Delivery unknown",
        },
      }),
      "Slack delivery is unknown",
      "warning",
    ],
  ] as const)(
    "maps a receipt to clear operator copy",
    (value, title, tone) => {
      expect(receiptPresentation(value)).toMatchObject({ title, tone });
    },
  );

  it.each([
    [receipt({ status: "partial_failure" }), null],
    [receipt({ status: "indeterminate" }), null],
    [
      receipt({
        status: "failed",
        outcome: null,
        error: {
          code: "SLACK_DELIVERY_UNKNOWN",
          message: "Delivery unknown",
        },
      }),
      null,
    ],
    [
      receipt({
        status: "failed",
        outcome: null,
        error: {
          code: "REQUEST_IN_PROGRESS",
          message: "Still processing",
        },
      }),
      null,
    ],
    [null, "The browser did not receive a receipt."],
  ] as const)(
    "keeps the submission identity pinned for uncertain delivery",
    (value, transportError) => {
      expect(
        mustPreserveSubmissionIdentity(value, transportError),
      ).toBe(true);
    },
  );

  it("allows a new identity after a completed or deterministic result", () => {
    expect(
      mustPreserveSubmissionIdentity(
        receipt({ status: "completed" }),
        null,
      ),
    ).toBe(false);
    expect(
      mustPreserveSubmissionIdentity(
        receipt({
          status: "failed",
          outcome: null,
          error: {
            code: "GITHUB_USER_NOT_FOUND",
            message: "User not found",
          },
        }),
        null,
      ),
    ).toBe(false);
  });
});
