// Run after navigating the same browser to the trusted /go/victim-abcdef/ URL.
(async () => {
  const context = await (
    await fetch("/_au/artifact-context?artifact_key=victim-abcdef")
  ).json();
  const comments = await (
    await fetch("/_au/comments?artifact_key=victim-abcdef")
  ).json();
  const grant = await fetch("/_au/agent-token", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ artifact_key: "victim-abcdef" }),
  });
  const token = await grant.json();
  async function loadScript(url) {
    return new Promise((resolve) => {
      const script = document.createElement("script");
      script.src = url;
      script.onload = () => resolve(true);
      script.onerror = () => resolve(false);
      document.head.append(script);
    });
  }
  const ownScript = await loadScript("/go/victim-abcdef/private.js");
  const publicOrigin = new URL(location.origin);
  publicOrigin.hostname = publicOrigin.hostname.replace(
    /^a-victim\./,
    "a-attacker.",
  );
  const publicScript = await loadScript(
    `${publicOrigin.origin}/go/attacker-abcdef/public.js`,
  );
  const result = {
    origin: location.origin,
    role: context.role,
    privateCommentsVisible: JSON.stringify(comments).includes(
      "PRIVATE_OTHER_CUSTOMER_COMMENT",
    ),
    delegationStatus: grant.status,
    tokenIssued: !!token.token,
    otherArtifactStorageVisible:
      localStorage.getItem("isolation-test") !== null,
    widgetPresent: !!document.querySelector("[data-au-widget]"),
    privateScriptWorks:
      ownScript && window.__auditPrivateScript === "PRIVATE_SCRIPT_BYTES",
    publicScriptReusable: publicScript && window.__auditPublicScript === true,
  };
  if (
    result.role !== "publisher" ||
    !result.privateCommentsVisible ||
    !result.tokenIssued ||
    result.otherArtifactStorageVisible ||
    !result.widgetPresent ||
    !result.privateScriptWorks ||
    !result.publicScriptReusable
  )
    throw new Error(JSON.stringify(result));
  return result;
})();
