import Link from "next/link";

export type ConnectionState = "connected" | "disconnected" | "invalid";

export type IntegrationSnapshot = {
  status: ConnectionState;
  lastVerifiedAt: string | null;
  label?: string;
};

export type DocketSnapshot = {
  github: IntegrationSnapshot;
  slack: IntegrationSnapshot;
  lastSuccessfulRunAt: string | null;
};

type AccessDocketProps = {
  snapshot: DocketSnapshot;
  demoChannelId?: string;
};

type FlowStepProps = {
  number: string;
  title: string;
  description: string;
  children: React.ReactNode;
  isLast?: boolean;
};

const statusCopy: Record<ConnectionState, string> = {
  connected: "Connected",
  disconnected: "Not connected",
  invalid: "Needs attention",
};

function formatTimestamp(value: string | null) {
  if (!value) {
    return "No verification recorded";
  }

  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short",
  }).format(new Date(value));
}

function StatusPill({ status }: { status: ConnectionState }) {
  return (
    <span className="status-pill" data-state={status}>
      <span className="status-pill__dot" aria-hidden="true" />
      {statusCopy[status]}
    </span>
  );
}

function FlowStep({
  number,
  title,
  description,
  children,
  isLast = false,
}: FlowStepProps) {
  return (
    <section className="flow-step" aria-labelledby={`step-${number}-title`}>
      <div className="flow-step__rail" aria-hidden="true">
        <span>{number}</span>
        {isLast ? null : <i />}
      </div>
      <div className="flow-step__body">
        <header className="flow-step__header">
          <div>
            <p className="eyebrow">Step {number}</p>
            <h2 id={`step-${number}-title`}>{title}</h2>
          </div>
          <p>{description}</p>
        </header>
        {children}
      </div>
    </section>
  );
}

function ProviderGlyph({ provider }: { provider: "github" | "slack" }) {
  if (provider === "github") {
    return (
      <span className="provider-glyph provider-glyph--github" aria-hidden="true">
        GH
      </span>
    );
  }

  return (
    <span className="provider-glyph provider-glyph--slack" aria-hidden="true">
      <i />
      <i />
      <i />
      <i />
    </span>
  );
}

function IntegrationCard({
  provider,
  eyebrow,
  title,
  detail,
  snapshot,
  connectHref,
}: {
  provider: "github" | "slack";
  eyebrow: string;
  title: string;
  detail: string;
  snapshot: IntegrationSnapshot;
  connectHref: string;
}) {
  const isConnected = snapshot.status === "connected";
  const actionLabel = isConnected ? `Reconnect ${title}` : `Connect ${title}`;

  return (
    <article className="integration-card" data-state={snapshot.status}>
      <div className="integration-card__topline">
        <ProviderGlyph provider={provider} />
        <StatusPill status={snapshot.status} />
      </div>

      <div className="integration-card__title">
        <p className="eyebrow">{eyebrow}</p>
        <h3>{title}</h3>
        <p>{detail}</p>
      </div>

      <dl className="integration-card__facts">
        <div>
          <dt>Credential</dt>
          <dd>{provider === "github" ? "Installation ID" : "Encrypted bot token"}</dd>
        </div>
        <div>
          <dt>Last verified</dt>
          <dd>{formatTimestamp(snapshot.lastVerifiedAt)}</dd>
        </div>
        {snapshot.label ? (
          <div>
            <dt>{provider === "github" ? "Installation" : "Workspace"}</dt>
            <dd>{snapshot.label}</dd>
          </div>
        ) : null}
      </dl>

      <Link className="button button--secondary" href={connectHref}>
        {actionLabel}
        <span aria-hidden="true">↗</span>
      </Link>
    </article>
  );
}

function Safeguard({
  number,
  title,
  copy,
}: {
  number: string;
  title: string;
  copy: string;
}) {
  return (
    <li className="safeguard">
      <span className="safeguard__number">{number}</span>
      <div>
        <h3>{title}</h3>
        <p>{copy}</p>
      </div>
    </li>
  );
}

export function AccessDocket({
  snapshot,
  demoChannelId = "Set in README",
}: AccessDocketProps) {
  const isReady =
    snapshot.github.status === "connected" && snapshot.slack.status === "connected";

  return (
    <div className="app-shell">
      <header className="site-header">
        <Link className="wordmark" href="/" aria-label="Access Docket home">
          <span className="wordmark__mark">AD</span>
          <span className="wordmark__text">Access Docket</span>
        </Link>

        <div className="site-header__meta">
          <span className="environment-label">Production setup</span>
          <span className="header-rule" aria-hidden="true" />
          <span className="lock-indicator" aria-hidden="true" />
          <span>Admin surface</span>
          <form action="/api/admin/logout" method="post">
            <button className="header-signout" type="submit">
              Sign out
            </button>
          </form>
        </div>
      </header>

      <main>
        <section className="hero" aria-labelledby="page-title">
          <div className="hero__index" aria-hidden="true">
            01 / SETUP
          </div>
          <div className="hero__copy">
            <p className="eyebrow">GitHub access request triage</p>
            <h1 id="page-title">
              Govern the handoff
              <br />
              <em>without slowing it down.</em>
            </h1>
          </div>
          <div className="hero__summary">
            <p>
              Verify effective repository access, then place one approval-ready
              message in Slack. Human judgment stays in the loop.
            </p>
            <div className="readiness" data-ready={isReady}>
              <span className="readiness__signal" aria-hidden="true">
                <i />
                <i />
                <i />
              </span>
              <div>
                <span>Workflow readiness</span>
                <strong>{isReady ? "Ready to receive" : "Setup required"}</strong>
              </div>
            </div>
          </div>
        </section>

        <div className="docket-layout">
          <div className="docket-flow">
            <FlowStep
              number="01"
              title="Read the live context"
              description="Install the GitHub App on only the repositories this workflow may inspect."
            >
              <IntegrationCard
                provider="github"
                eyebrow="Source integration"
                title="GitHub"
                detail="Reads repository metadata and the requester's effective permission. It cannot change access."
                snapshot={snapshot.github}
                connectHref="/api/integrations/github/connect"
              />
            </FlowStep>

            <FlowStep
              number="02"
              title="Open the human boundary"
              description="Connect the workspace where reviewers already make access decisions."
            >
              <IntegrationCard
                provider="slack"
                eyebrow="Action integration"
                title="Slack"
                detail="Posts one approval-ready message. It does not grant GitHub permissions or retry silently."
                snapshot={snapshot.slack}
                connectHref="/api/integrations/slack/connect"
              />
            </FlowStep>

            <FlowStep
              number="03"
              title="Expose the governed trigger"
              description="Once both connections are healthy, authenticated callers can submit access requests."
              isLast
            >
              <article className="endpoint-card">
                <div className="endpoint-card__heading">
                  <div>
                    <p className="eyebrow">Public interface</p>
                    <h3>
                      <span>POST</span> /api/access-requests
                    </h3>
                  </div>
                  <span className="endpoint-card__auth">Bearer protected</span>
                </div>

                <div className="endpoint-card__body">
                  <div className="endpoint-card__note">
                    <span>Demo channel</span>
                    <strong>{demoChannelId}</strong>
                    <p>
                      Invite the bot before testing another channel. Slack membership
                      errors return an actionable receipt.
                    </p>
                  </div>

                  <dl className="endpoint-stats">
                    <div>
                      <dt>Replay window</dt>
                      <dd>24 hours</dd>
                    </div>
                    <div>
                      <dt>Processing lock</dt>
                      <dd>5 minutes</dd>
                    </div>
                    <div>
                      <dt>Last success</dt>
                      <dd>{formatTimestamp(snapshot.lastSuccessfulRunAt)}</dd>
                    </div>
                  </dl>
                </div>

                <div className="endpoint-card__footer">
                  <Link href="/api/status">
                    Inspect public status
                    <span aria-hidden="true">↗</span>
                  </Link>
                  <code>GET /api/status</code>
                </div>
              </article>
            </FlowStep>
          </div>

          <aside className="safeguards" aria-labelledby="safeguards-title">
            <div className="safeguards__heading">
              <p className="folio">CONTROL / 03</p>
              <h2 id="safeguards-title">Contained safeguards</h2>
              <p>
                The assignment stays small. These controls protect its three exposed
                boundaries.
              </p>
            </div>

            <ol>
              <Safeguard
                number="01"
                title="Authenticated trigger"
                copy="A timing-safe Bearer check protects the public workflow endpoint."
              />
              <Safeguard
                number="02"
                title="Encrypted Slack token"
                copy="The bot token is encrypted before it enters runtime storage."
              />
              <Safeguard
                number="03"
                title="Replay protection"
                copy="A confirmed Slack post is stored and replayed instead of duplicated."
              />
            </ol>

            <div className="scope-note">
              <p className="eyebrow">Intentionally absent</p>
              <p>Queues, run history, auto-retries, multi-tenancy, and permission writes.</p>
            </div>
          </aside>
        </div>
      </main>

      <footer className="site-footer">
        <p>Access Docket / GitHub → Slack</p>
        <p>Latest known provider state. No live probe on page load.</p>
      </footer>
    </div>
  );
}
