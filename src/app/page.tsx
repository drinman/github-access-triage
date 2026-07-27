import { redirect } from "next/navigation";

import { AccessDocket, type DocketSnapshot } from "@/components/access-docket";
import type { GitHubConnection, SlackConnection } from "@/lib/domain";
import { STORE_KEYS } from "@/lib/domain";
import { getAdminSession } from "@/lib/session";
import { getStore } from "@/lib/store";

export const dynamic = "force-dynamic";

export default async function Home() {
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

  return (
    <AccessDocket
      snapshot={snapshot}
      demoChannelId={
        process.env.DEMO_SLACK_CHANNEL_ID ?? "Set DEMO_SLACK_CHANNEL_ID"
      }
    />
  );
}
