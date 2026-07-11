import type { Env } from "./types";
import { siteBaseUrl } from "./util";

export interface AbuseReportContext {
  artifactKey: string;
  artifactUrl: string;
}

export function abuseMailbox(env: Env): string | null {
  const email = String(env.ABUSE_EMAIL || "")
    .trim()
    .toLowerCase();
  return validMailbox(email) ? email : null;
}

export function abuseMailto(
  env: Env,
  context?: AbuseReportContext,
): string | null {
  const email = abuseMailbox(env);
  if (!email) return null;

  const subject = context
    ? `Report abuse: ${context.artifactKey}`
    : "Report abuse";
  const body = context
    ? [
        `Artifact key: ${context.artifactKey}`,
        `Artifact URL: ${context.artifactUrl}`,
        "",
        "Describe the issue and include any supporting evidence:",
      ].join("\n")
    : [
        `Service URL: ${siteBaseUrl(env)}`,
        "",
        "Include the exact URL, a description of the issue, and any supporting evidence:",
      ].join("\n");
  const query = new URLSearchParams({ subject, body });
  return `mailto:${email}?${query.toString()}`;
}

function validMailbox(email: string): boolean {
  return (
    email.length <= 320 &&
    /^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9](?:[a-z0-9.-]{0,251}[a-z0-9])?\.[a-z]{2,63}$/i.test(
      email,
    )
  );
}
