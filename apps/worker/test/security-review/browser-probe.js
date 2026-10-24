// Run on the synthetic attacker's isolated host, via agent-browser eval --stdin.
(async () => {
  async function probe(url, init = {}) {
    try {
      const response = await fetch(url, init);
      const body = await response.text();
      return {
        status: response.status,
        secret:
          body.includes("PRIVATE_OTHER_CUSTOMER_COMMENT") ||
          body.includes("PRIVATE_FILE_BYTES"),
        token: /"token":"/.test(body),
      };
    } catch {
      return { blocked: true };
    }
  }
  const main =
    document.body.getAttribute("data-audit-main") || "http://localhost:18849";
  const otherOrigin = new URL(location.origin);
  otherOrigin.hostname = otherOrigin.hostname.replace(
    /^a-attacker\./,
    "a-victim.",
  );
  const foreign = await probe("/_au/comments?artifact_key=victim-abcdef", {
    referrerPolicy: "no-referrer",
  });
  const trusted = await probe(
    `${main}/_au/comments?artifact_key=victim-abcdef`,
    { credentials: "include", referrerPolicy: "no-referrer" },
  );
  const file = await probe(`${main}/go/victim-abcdef/private.txt`, {
    credentials: "include",
    headers: { Accept: "text/html" },
  });
  const otherHost = await probe(
    `${otherOrigin.origin}/go/victim-abcdef/private.txt`,
    { credentials: "include" },
  );
  const delegation = await probe("/_au/agent-token", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ artifact_key: "victim-abcdef" }),
  });
  const own = await probe("/go/attacker-abcdef/private.txt");
  delete window.__auditPrivateScript;
  const privateScriptLoaded = await new Promise((resolve) => {
    const script = document.createElement("script");
    script.src = `${otherOrigin.origin}/go/victim-abcdef/private.js`;
    script.onload = () => resolve(true);
    script.onerror = () => resolve(false);
    document.head.append(script);
  });
  localStorage.setItem("isolation-test", "attacker");
  const result = {
    origin: location.origin,
    foreign,
    trusted,
    file,
    otherHost,
    delegation,
    ownFileStatus: own.status,
    storageWorks: localStorage.getItem("isolation-test") === "attacker",
    privateScriptBlocked:
      !privateScriptLoaded && window.__auditPrivateScript === undefined,
  };
  if (
    foreign.status !== 404 ||
    delegation.status !== 404 ||
    !trusted.blocked ||
    !file.blocked ||
    !otherHost.blocked ||
    own.status !== 200 ||
    !result.storageWorks ||
    !result.privateScriptBlocked
  )
    throw new Error(JSON.stringify(result));
  return result;
})();
