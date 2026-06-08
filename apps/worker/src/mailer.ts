import type { Artifact, Env } from "./types";

export async function sendVerificationEmail(
  env: Env,
  artifact: Artifact,
  email: string,
  code: string,
  magicUrl: string,
): Promise<void> {
  if (!env.RESEND_API_KEY) {
    if (env.ALLOW_DEBUG_CODES === "true") return;
    throw new Error("email delivery is not configured");
  }
  const subject = `Your access code for ${artifact.title}`;
  const html = `<p>Use this code to view <strong>${escapeHtml(artifact.title)}</strong>:</p>
<p style="font-size:24px;font-weight:700;letter-spacing:4px">${code}</p>
<p>Or open this link:</p>
<p><a href="${magicUrl}">${magicUrl}</a></p>`;
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.RESEND_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from: "Artifact Use <artifacts@example.com>",
      to: [email],
      subject,
      html,
    }),
  });
  if (!res.ok)
    throw new Error(`Resend failed: ${res.status} ${await res.text()}`);
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (c) => {
    const map: Record<string, string> = {
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#39;",
    };
    return map[c] || c;
  });
}
