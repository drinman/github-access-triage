import type {
  GitHubConnection,
  SlackConnection,
} from "@/lib/domain";
import { STORE_KEYS } from "@/lib/domain";
import type { KeyValueStore } from "@/lib/store";

export type PublicStatus = {
  status: "ready" | "degraded";
  integrations: {
    github: {
      status: "connected" | "invalid" | "disconnected";
      lastVerifiedAt: string | null;
    };
    slack: {
      status: "connected" | "invalid" | "disconnected";
      lastVerifiedAt: string | null;
    };
  };
  lastSuccessfulRunAt: string | null;
  version: string;
};

export async function readPublicStatus(
  store: KeyValueStore,
): Promise<PublicStatus> {
  const [github, slack, lastSuccessfulRunAt] = await Promise.all([
    store.get<GitHubConnection>(STORE_KEYS.githubConnection),
    store.get<SlackConnection>(STORE_KEYS.slackConnection),
    store.get<string>(STORE_KEYS.lastSuccessfulRunAt),
  ]);

  const githubStatus = github?.status ?? "disconnected";
  const slackStatus = slack?.status ?? "disconnected";

  return {
    status:
      githubStatus === "connected" && slackStatus === "connected"
        ? "ready"
        : "degraded",
    integrations: {
      github: {
        status: githubStatus,
        lastVerifiedAt: github?.lastVerifiedAt ?? null,
      },
      slack: {
        status: slackStatus,
        lastVerifiedAt: slack?.lastVerifiedAt ?? null,
      },
    },
    lastSuccessfulRunAt,
    version:
      process.env.VERCEL_GIT_COMMIT_SHA ??
      process.env.NEXT_PUBLIC_APP_VERSION ??
      "local",
  };
}
