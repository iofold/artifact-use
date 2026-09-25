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

export async function sendTokenExpiryEmail(
  env: Env,
  email: string,
  token: { label: string | null; expiresAt: number },
  renewUrl: string,
): Promise<void> {
  if (!env.EMAIL)
    throw new EmailDeliveryError(new Error("email binding missing"));
  const label = token.label || "Agent token";
  const when = new Date(token.expiresAt * 1000).toISOString().slice(0, 10);
  const subject = `Your Artifact Use agent token "${label}" expires on ${when}`;
  const text = [
    `The creator token "${label}" expires on ${when}.`,
    `Agents using it will start receiving 401 token_expired errors after that.`,
    `Mint a replacement (and revoke the old one) here: ${renewUrl}`,
  ].join("\n\n");
  const html = `<p>The creator token <strong>${escapeHtml(label)}</strong> expires on <strong>${when}</strong>.</p>
<p>Agents using it will start receiving <code>401 token_expired</code> errors after that.</p>
<p><a href="${escapeHtml(renewUrl)}">Mint a replacement and revoke the old one</a></p>`;
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
