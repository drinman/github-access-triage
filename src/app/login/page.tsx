import type { Metadata } from "next";
import Link from "next/link";

export const metadata: Metadata = {
  title: "Admin sign in",
  robots: {
    index: false,
    follow: false,
  },
};

type LoginPageProps = {
  searchParams?: Promise<{
    error?: string;
  }>;
};

export default async function LoginPage({ searchParams }: LoginPageProps) {
  const params = searchParams ? await searchParams : undefined;
  const hasError = params?.error === "invalid";

  return (
    <main className="login-shell">
      <div className="login-grid" aria-hidden="true" />

      <section className="login-intro">
        <Link className="wordmark wordmark--light" href="/" aria-label="Access Docket home">
          <span className="wordmark__mark">AD</span>
          <span className="wordmark__text">Access Docket</span>
        </Link>

        <div className="login-intro__copy">
          <p className="eyebrow eyebrow--light">Restricted setup surface</p>
          <h1>Keep the workflow connected. Keep the boundary explicit.</h1>
          <p>
            This console changes runtime connections for GitHub and Slack. The public
            trigger remains separate and independently authenticated.
          </p>
        </div>

        <dl className="login-facts" aria-label="Console security notes">
          <div>
            <dt>Session</dt>
            <dd>Signed, secure cookie</dd>
          </div>
          <div>
            <dt>Provider tokens</dt>
            <dd>Never rendered here</dd>
          </div>
        </dl>
      </section>

      <section className="login-panel" aria-labelledby="login-heading">
        <div className="login-panel__inner">
          <p className="folio">ADMIN / 01</p>
          <h2 id="login-heading">Open the setup console</h2>
          <p className="login-panel__lede">
            Enter the shared admin password to connect or replace an integration.
          </p>

          {hasError ? (
            <p className="form-notice form-notice--error" role="alert">
              That password was not accepted. Try again.
            </p>
          ) : null}

          <form className="login-form" action="/api/admin/login" method="post">
            <div className="field">
              <label htmlFor="password">Admin password</label>
              <input
                id="password"
                name="password"
                type="password"
                autoComplete="current-password"
                required
                autoFocus
                aria-describedby="password-note"
              />
              <p id="password-note">The password is not stored in this browser.</p>
            </div>

            <button className="button button--primary button--wide" type="submit">
              Continue to setup
              <span aria-hidden="true">↗</span>
            </button>
          </form>

          <div className="login-panel__footer">
            <span className="lock-indicator" aria-hidden="true" />
            <span>Private administration</span>
            <Link href="/api/status">View public status</Link>
          </div>
        </div>
      </section>
    </main>
  );
}
