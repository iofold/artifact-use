#!/usr/bin/env bash
# Synthetic HTTPS documents are intercepted; no real domain or account is used.
set -euo pipefail
audit_session="${1:-au-cookie-boundary}"
trap 'agent-browser --session "$audit_session" close >/dev/null 2>&1 || true' EXIT
agent-browser --session "$audit_session" --args '--no-sandbox' open about:blank
agent-browser --session "$audit_session" network route 'https://*.audit.invalid/*' --body '{"synthetic":true}'
agent-browser --session "$audit_session" open https://a-victim.audit.invalid/setup
agent-browser --session "$audit_session" eval 'document.cookie="au_art_cookie=real; Secure; Path=/"; document.cookie="__Host-au_art_cookie=real; Secure; Path=/"; true'
agent-browser --session "$audit_session" open https://a-attacker.audit.invalid/
agent-browser --session "$audit_session" eval 'document.cookie="au_art_cookie=attacker; Domain=audit.invalid; Path=/_au; Secure"; document.cookie="__Host-au_art_cookie=attacker; Domain=audit.invalid; Path=/; Secure"; true'
agent-browser --session "$audit_session" open https://a-victim.audit.invalid/_au/comments
agent-browser --session "$audit_session" eval '(()=>{const c=document.cookie.split("; ");const ordinary=c.find(x=>x.startsWith("au_art_cookie="));const protectedCookie=c.find(x=>x.startsWith("__Host-au_art_cookie="));if(ordinary!=="au_art_cookie=attacker"||protectedCookie!=="__Host-au_art_cookie=real")throw Error("cookie boundary failed");return {legacyCookieShadowed:true,hostCookieProtected:true}})()'
