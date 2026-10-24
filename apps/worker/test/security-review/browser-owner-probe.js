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
  };
  if (
    result.role !== "publisher" ||
    !result.privateCommentsVisible ||
    !result.tokenIssued ||
    result.otherArtifactStorageVisible ||
    !result.widgetPresent
  )
    throw new Error(JSON.stringify(result));
  return result;
})();
