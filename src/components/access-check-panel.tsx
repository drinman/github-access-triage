"use client";

import { useEffect, useRef, useState } from "react";

import type {
  Decision,
  ReceiptStep,
  RequestedPermission,
} from "@/lib/domain";

const DEFAULT_REASON = "Needs access to diagnose an integration failure";

type ReceiptStatus =
  | "completed"
  | "failed"
  | "partial_failure"
  | "indeterminate";

export type AdminAccessReceipt = {
  status: ReceiptStatus;
  outcome: Decision | null;
  summary?: string;
  runId?: string;
  requestId?: string | null;
  github?: {
    username: string;
    repository: string;
    requestedPermission: RequestedPermission;
    effectivePermission: string | null;
    roleName: string | null;
  };
  slack?: {
    channel: string;
    posted: boolean;
    messageTs: string | null;
  };
  error?: {
    code: string;
    message: string;
    retryAfterSeconds?: number;
  };
  steps?: ReceiptStep[];
};

type ReceiptPresentation = {
  title: string;
  eyebrow: string;
  tone: "success" | "warning" | "error";
  guidance: string | null;
};

export function receiptPresentation(
  receipt: AdminAccessReceipt,
): ReceiptPresentation {
  if (receipt.error?.code === "UNAUTHORIZED") {
    return {
      title: "Session expired",
      eyebrow: "Sign in required",
      tone: "error",
      guidance: "Sign in again before running this request.",
    };
  }
  if (receipt.error?.code === "REQUEST_IN_PROGRESS") {
    return {
      title: "Request already processing",
      eyebrow: "Wait before retrying",
      tone: "warning",
      guidance:
        "Keep this form unchanged and retry after the processing window.",
    };
  }
  if (receipt.error?.code === "IDEMPOTENCY_CONFLICT") {
    return {
      title: "Request identity conflict",
      eyebrow: "Start a new request",
      tone: "error",
      guidance:
        "This submission identity was already used for different inputs.",
    };
  }
  if (receipt.error?.code === "SLACK_DELIVERY_UNKNOWN") {
    return {
      title: "Slack delivery is unknown",
      eyebrow: "Do not retry automatically",
      tone: "warning",
      guidance:
        "Check the configured Slack channel before submitting another request.",
    };
  }
  if (receipt.status === "indeterminate") {
    return {
      title: "Delivery could not be confirmed",
      eyebrow: "Manual verification required",
      tone: "warning",
      guidance:
        "Keep the request ID and inspect Slack before deciding whether to retry.",
    };
  }
  if (receipt.status === "partial_failure") {
    return {
      title: "Slack posted; finalization is incomplete",
      eyebrow: "Partial completion",
      tone: "warning",
      guidance:
        "Do not create a new request ID. Use the receipt guidance before retrying.",
    };
  }
  if (receipt.status === "failed") {
    return {
      title: "Access check failed",
      eyebrow: "No confirmed handoff",
      tone: "error",
      guidance: receipt.error?.message ?? "Review the setup and try again.",
    };
  }
  if (receipt.outcome === "approval_needed") {
    return {
      title: "Approval needed",
      eyebrow: "Manual handoff posted",
      tone: "success",
      guidance: "A person must review the request and decide whether to grant access.",
    };
  }
  if (receipt.outcome === "already_sufficient") {
    return {
      title: "Access already sufficient",
      eyebrow: "Informational handoff posted",
      tone: "success",
      guidance: "No GitHub permission change is needed.",
    };
  }
  return {
    title: "Manual review required",
    eyebrow: "Custom role detected",
    tone: "warning",
    guidance: "Review the custom GitHub role before changing access.",
  };
}

export function mustPreserveSubmissionIdentity(
  receipt: AdminAccessReceipt | null,
  transportError: string | null,
): boolean {
  if (transportError) {
    return true;
  }
  if (!receipt) {
    return false;
  }

  return (
    receipt.status === "partial_failure" ||
    receipt.status === "indeterminate" ||
    receipt.error?.code === "SLACK_DELIVERY_UNKNOWN" ||
    receipt.error?.code === "REQUEST_IN_PROGRESS"
  );
}

function githubSettingsUrl(repository: string): string | null {
  const [owner, name, extra] = repository.split("/");
  if (!owner || !name || extra) {
    return null;
  }
  return `https://github.com/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/settings/access`;
}

function slackChannelUrl(teamId: string, channelId: string): string {
  return `https://app.slack.com/client/${encodeURIComponent(teamId)}/${encodeURIComponent(channelId)}`;
}

function humanize(value: string | null | undefined): string {
  if (!value) {
    return "Not resolved";
  }
  return value.replaceAll("_", " ");
}

function ReceiptResult({
  receipt,
  replayed,
  repository,
  slackChannel,
  slackTeamId,
  resultRef,
}: {
  receipt: AdminAccessReceipt;
  replayed: boolean;
  repository: string;
  slackChannel: string;
  slackTeamId: string;
  resultRef: React.RefObject<HTMLElement | null>;
}) {
  const presentation = receiptPresentation(receipt);
  const role = presentation.tone === "success" ? "status" : "alert";
  const settingsUrl =
    receipt.outcome === "approval_needed" ||
    receipt.outcome === "manual_review"
      ? githubSettingsUrl(receipt.github?.repository ?? repository)
      : null;
  const currentAccess =
    receipt.github?.roleName ??
    receipt.github?.effectivePermission ??
    "Not resolved";

  return (
    <section
      className="access-receipt"
      data-tone={presentation.tone}
      aria-labelledby="access-receipt-title"
      role={role}
      ref={resultRef}
      tabIndex={-1}
    >
      <header className="access-receipt__header">
        <div>
          <p className="eyebrow">{presentation.eyebrow}</p>
          <h4 id="access-receipt-title">{presentation.title}</h4>
        </div>
        <span className="access-receipt__status">
          {replayed ? "Replayed safely" : humanize(receipt.status)}
        </span>
      </header>

      {replayed ? (
        <p className="access-receipt__replay">
          The stored receipt was returned. No second Slack message was posted.
        </p>
      ) : null}

      <p className="access-receipt__summary">
        {receipt.summary ??
          receipt.error?.message ??
          "The server returned a contextual receipt."}
      </p>

      {presentation.guidance ? (
        <p className="access-receipt__guidance">{presentation.guidance}</p>
      ) : null}

      <dl className="access-receipt__facts">
        <div>
          <dt>Outcome</dt>
          <dd>{humanize(receipt.outcome)}</dd>
        </div>
        <div>
          <dt>Current access</dt>
          <dd>{humanize(currentAccess)}</dd>
        </div>
        <div>
          <dt>Requested</dt>
          <dd>{humanize(receipt.github?.requestedPermission)}</dd>
        </div>
        <div>
          <dt>Slack</dt>
          <dd>{receipt.slack?.posted ? "Posted" : "Not confirmed"}</dd>
        </div>
        <div>
          <dt>Slack timestamp</dt>
          <dd>{receipt.slack?.messageTs ?? "Not available"}</dd>
        </div>
        <div>
          <dt>Request ID</dt>
          <dd>{receipt.requestId ?? "Not available"}</dd>
        </div>
        <div>
          <dt>Run ID</dt>
          <dd>{receipt.runId ?? "Not available"}</dd>
        </div>
        {receipt.error ? (
          <div>
            <dt>Error code</dt>
            <dd>{receipt.error.code}</dd>
          </div>
        ) : null}
      </dl>

      <div className="access-receipt__links">
        {slackTeamId ? (
          <a
            href={slackChannelUrl(slackTeamId, slackChannel)}
            target="_blank"
            rel="noreferrer"
          >
            Open Slack channel
            <span aria-hidden="true">↗</span>
          </a>
        ) : null}
        {settingsUrl ? (
          <a href={settingsUrl} target="_blank" rel="noreferrer">
            Open GitHub access settings
            <span aria-hidden="true">↗</span>
          </a>
        ) : null}
        {receipt.error?.code === "UNAUTHORIZED" ? (
          <a href="/login">Sign in again</a>
        ) : null}
      </div>

      {receipt.steps?.length ? (
        <ol className="access-receipt__steps" aria-label="Execution steps">
          {receipt.steps.map((step) => (
            <li key={step.name} data-state={step.status}>
              <span>{humanize(step.name)}</span>
              <strong>{humanize(step.status)}</strong>
              <p>{step.detail}</p>
            </li>
          ))}
        </ol>
      ) : null}

      <details className="access-receipt__raw">
        <summary>Raw JSON receipt</summary>
        <pre>{JSON.stringify(receipt, null, 2)}</pre>
      </details>
    </section>
  );
}

export function AccessCheckPanel({
  githubReady,
  slackReady,
  repository,
  slackChannel,
  slackTeamId,
}: {
  githubReady: boolean;
  slackReady: boolean;
  repository: string;
  slackChannel: string;
  slackTeamId: string;
}) {
  const isReady = githubReady && slackReady;
  const [pending, setPending] = useState(false);
  const [hasAttempted, setHasAttempted] = useState(false);
  const [result, setResult] = useState<{
    receipt: AdminAccessReceipt;
    replayed: boolean;
  } | null>(null);
  const [transportError, setTransportError] = useState<string | null>(null);
  const submissionIdRef = useRef<string | null>(null);
  const attemptedRef = useRef(false);
  const submittingRef = useRef(false);
  const resultRef = useRef<HTMLElement>(null);
  const usernameRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (result || transportError) {
      resultRef.current?.focus();
    }
  }, [result, transportError]);

  function clearAttemptAfterBusinessEdit() {
    if (!attemptedRef.current || pending) {
      return;
    }
    if (
      mustPreserveSubmissionIdentity(
        result?.receipt ?? null,
        transportError,
      )
    ) {
      return;
    }
    submissionIdRef.current = null;
    attemptedRef.current = false;
    setHasAttempted(false);
    setResult(null);
    setTransportError(null);
  }

  function startNewRequest() {
    submissionIdRef.current = null;
    attemptedRef.current = false;
    setHasAttempted(false);
    setResult(null);
    setTransportError(null);
    usernameRef.current?.focus();
  }

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!isReady || submittingRef.current) {
      return;
    }

    submittingRef.current = true;
    setPending(true);
    setResult(null);
    setTransportError(null);
    attemptedRef.current = true;
    setHasAttempted(true);
    submissionIdRef.current ??= crypto.randomUUID();

    const form = new FormData(event.currentTarget);
    const body = {
      githubUsername: String(form.get("githubUsername") ?? ""),
      requestedPermission: String(
        form.get("requestedPermission") ?? "write",
      ),
      reason: String(form.get("reason") ?? ""),
      submissionId: submissionIdRef.current,
    };

    try {
      const response = await fetch("/api/admin/access-requests", {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const receipt = (await response.json()) as AdminAccessReceipt;
      setResult({
        receipt,
        replayed:
          response.headers.get("Idempotency-Replayed")?.toLowerCase() ===
          "true",
      });
    } catch {
      setTransportError(
        `The browser did not receive a receipt. Keep submission ${submissionIdRef.current} and retry this unchanged request; the app will reuse that identity.`,
      );
    } finally {
      submittingRef.current = false;
      setPending(false);
    }
  }

  const missingProviders = [
    ...(!githubReady ? ["GitHub"] : []),
    ...(!slackReady ? ["Slack"] : []),
  ];
  const canStartNewRequest =
    result !== null &&
    result.receipt.error?.code !== "UNAUTHORIZED" &&
    !mustPreserveSubmissionIdentity(result.receipt, transportError);

  return (
    <article className="access-check" data-ready={isReady}>
      <header className="access-check__header">
        <div>
          <p className="eyebrow">Admin runbook</p>
          <h3>Check a live access request</h3>
          <p>
            Read the configured GitHub repository, compare effective access, and
            return the complete execution receipt.
          </p>
        </div>
        <span className="access-check__auth">Session protected</span>
      </header>

      <dl className="access-check__scope" aria-label="Locked deployment scope">
        <div>
          <dt>Repository</dt>
          <dd>{repository}</dd>
        </div>
        <div>
          <dt>Slack destination</dt>
          <dd>
            {slackTeamId ? (
              <a
                href={slackChannelUrl(slackTeamId, slackChannel)}
                target="_blank"
                rel="noreferrer"
              >
                {slackChannel}
                <span aria-hidden="true">↗</span>
              </a>
            ) : (
              slackChannel
            )}
          </dd>
        </div>
      </dl>

      <p className="access-check__warning" id="access-check-warning">
        <span aria-hidden="true" />
        Running this check makes live provider calls and can post one real Slack
        message. It never changes GitHub access.
      </p>

      {!isReady ? (
        <p className="access-check__blocked" role="status">
          Connect {missingProviders.join(" and ")} before running a check.
        </p>
      ) : null}

      <form
        className="access-check__form"
        onSubmit={submit}
        onChange={clearAttemptAfterBusinessEdit}
        aria-describedby="access-check-warning"
      >
        <fieldset disabled={pending || !isReady}>
          <legend>Request parameters</legend>
          <div className="access-check__fields">
            <div className="field">
              <label htmlFor="github-username">GitHub username</label>
              <input
                ref={usernameRef}
                id="github-username"
                name="githubUsername"
                type="text"
                defaultValue="octocat"
                required
                maxLength={39}
                autoComplete="off"
                aria-describedby="github-username-note"
              />
              <p id="github-username-note">
                The GitHub login whose effective access should be checked.
              </p>
            </div>

            <div className="field">
              <label htmlFor="requested-permission">
                Requested permission
              </label>
              <select
                id="requested-permission"
                name="requestedPermission"
                defaultValue="write"
              >
                <option value="read">Read</option>
                <option value="triage">Triage</option>
                <option value="write">Write</option>
                <option value="maintain">Maintain</option>
                <option value="admin">Admin</option>
              </select>
              <p>Compared against GitHub&apos;s effective repository role.</p>
            </div>

            <div className="field field--wide">
              <label htmlFor="access-reason">Reason</label>
              <textarea
                id="access-reason"
                name="reason"
                defaultValue={DEFAULT_REASON}
                required
                maxLength={500}
                rows={4}
                aria-describedby="access-reason-note"
              />
              <p id="access-reason-note">
                This context appears in the reviewer handoff. Maximum 500
                characters.
              </p>
            </div>
          </div>
        </fieldset>

        <div className="access-check__actions">
          <button
            className="button button--primary"
            type="submit"
            disabled={!isReady || pending}
          >
            {pending ? "Checking GitHub…" : "Run access check"}
            <span aria-hidden="true">→</span>
          </button>
          {hasAttempted && canStartNewRequest ? (
            <button
              className="button button--secondary"
              type="button"
              onClick={startNewRequest}
              disabled={pending}
            >
              Start a new request
            </button>
          ) : null}
        </div>
      </form>

      {pending ? (
        <p className="access-check__pending" role="status" aria-live="polite">
          Checking GitHub and waiting for Slack confirmation…
        </p>
      ) : null}

      {transportError ? (
        <section
          className="access-receipt"
          data-tone="warning"
          role="alert"
          ref={resultRef}
          tabIndex={-1}
          aria-labelledby="transport-error-title"
        >
          <header className="access-receipt__header">
            <div>
              <p className="eyebrow">Response not received</p>
              <h4 id="transport-error-title">Delivery status is unknown</h4>
            </div>
            <span className="access-receipt__status">Do not use a new ID</span>
          </header>
          <p className="access-receipt__summary">{transportError}</p>
          <div className="access-receipt__links">
            {slackTeamId ? (
              <a
                href={slackChannelUrl(slackTeamId, slackChannel)}
                target="_blank"
                rel="noreferrer"
              >
                Check Slack channel
                <span aria-hidden="true">↗</span>
              </a>
            ) : null}
          </div>
        </section>
      ) : null}

      {result ? (
        <ReceiptResult
          receipt={result.receipt}
          replayed={result.replayed}
          repository={repository}
          slackChannel={slackChannel}
          slackTeamId={slackTeamId}
          resultRef={resultRef}
        />
      ) : null}
    </article>
  );
}
