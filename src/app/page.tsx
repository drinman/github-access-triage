import { redirect } from "next/navigation";

import { AccessDocket, type DocketSnapshot } from "@/components/access-docket";
import type { GitHubConnection, SlackConnection } from "@/lib/domain";
import { STORE_KEYS } from "@/lib/domain";
import { getAdminSession } from "@/lib/session";
import { getStore } from "@/lib/store";

export const dynamic = "force-dynamic";

type HomeProps = {
  searchParams?: Promise<{
    connected?: string;
    connectionError?: string;
  }>;
};

export default async function Home({ searchParams }: HomeProps) {
  const session = await getAdminSession();
  if (!session) {
    redirect("/login");
  }

  const store = getStore();
  const [github, slack, lastSuccessfulRunAt] = await Promise.all([
    store.get<GitHubConnection>(STORE_KEYS.githubConnection),
    store.get<SlackConnection>(STORE_KEYS.slackConnection),
    store.get<string>(STORE_KEYS.lastSuccessfulRunAt),
  ]);

  const snapshot: DocketSnapshot = {
    github: {
      status: github?.status ?? "disconnected",
      lastVerifiedAt: github?.lastVerifiedAt ?? null,
      label: github?.accountLogin,
    },
    slack: {
      status: slack?.status ?? "disconnected",
      lastVerifiedAt: slack?.lastVerifiedAt ?? null,
      label: slack?.teamName,
    },
    lastSuccessfulRunAt,
  };
  const params = searchParams ? await searchParams : undefined;
  const provider = params?.connected ?? params?.connectionError;
  const notice = params?.connected
    ? {
        tone: "success" as const,
        message: `${provider === "github" ? "GitHub" : "Slack"} connected and verified. Runtime state was replaced without a redeploy.`,
      }
    : params?.connectionError
      ? {
          tone: "error" as const,
          message: `${provider === "github" ? "GitHub" : "Slack"} could not be verified. The prior working connection, if any, was left unchanged.`,
        }
      : undefined;

  return (
    <AccessDocket
      snapshot={snapshot}
      notice={notice}
      demoChannelId={
        process.env.DEMO_SLACK_CHANNEL_ID ?? "Set DEMO_SLACK_CHANNEL_ID"
      }
    />
  );
}
