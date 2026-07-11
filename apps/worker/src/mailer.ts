import type { Artifact, Env } from "./types";
import { escapeHtml } from "./util";

export class EmailDeliveryError extends Error {
  readonly cause: unknown;

  constructor(cause: unknown) {
    super("verification email delivery failed");
    this.name = "EmailDeliveryError";
    this.cause = cause;
  }
}

export async function sendVerificationEmail(
  env: Env,
  artifact: Artifact,
  email: string,
  code: string,
  magicUrl: string,
): Promise<void> {
  if (!env.EMAIL) {
    if (env.ALLOW_DEBUG_CODES === "true") return;
    throw new EmailDeliveryError(new Error("email binding missing"));
  }
  const subject = `Your access code for ${artifact.title}`;
  const text = [
    `Use this code to view ${artifact.title}: ${code}`,
    `Open this link: ${magicUrl}`,
  ].join("\n\n");
  const html = `<p>Use this code to view <strong>${escapeHtml(artifact.title)}</strong>:</p>
<p style="font-size:24px;font-weight:700;letter-spacing:4px">${code}</p>
<p>Or open this link:</p>
<p><a href="${escapeHtml(magicUrl)}">${escapeHtml(magicUrl)}</a></p>`;
  try {
    await env.EMAIL.send({
      from: {
        email: env.MAIL_FROM || "artifacts@example.com",
        name: env.MAIL_FROM_NAME || "Artifact Use",
      },
      to: email,
      subject,
      text,
      html,
    });
  } catch (error) {
    throw new EmailDeliveryError(error);
  }
}
