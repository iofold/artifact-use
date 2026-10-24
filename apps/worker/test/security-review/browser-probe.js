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
  const main = "http://localhost:18849";
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
    "http://a-victim.localhost:18849/go/victim-abcdef/private.txt",
    { credentials: "include" },
  );
  const delegation = await probe("/_au/agent-token", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ artifact_key: "victim-abcdef" }),
  });
  const own = await probe("/go/attacker-abcdef/private.txt");
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
  };
  if (
    foreign.status !== 404 ||
    delegation.status !== 404 ||
    !trusted.blocked ||
    !file.blocked ||
    !otherHost.blocked ||
    own.status !== 200 ||
    !result.storageWorks
  )
    throw new Error(JSON.stringify(result));
  return result;
})();
