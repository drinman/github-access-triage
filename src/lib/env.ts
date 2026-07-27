import { AppError } from "@/lib/errors";

export function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new AppError(
      "CONFIGURATION_ERROR",
      `The server is missing required configuration: ${name}.`,
      500,
    );
  }
  return value;
}

export function appBaseUrl(requestUrl?: string): string {
  const configured = process.env.APP_BASE_URL?.replace(/\/$/, "");
  if (configured) {
    return configured;
  }

  if (requestUrl) {
    return new URL(requestUrl).origin;
  }

  if (process.env.VERCEL_URL) {
    return `https://${process.env.VERCEL_URL}`;
  }

  return "http://localhost:3000";
}
