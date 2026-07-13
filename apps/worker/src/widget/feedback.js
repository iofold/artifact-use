/*
 * Artifact Use — feedback collector widget (light-DOM build).
 *
 * Authored readable; minified at build time into feedback.generated.ts by
 * scripts/build-feedback-widget.mjs (wired through wrangler [build]).
 *
 * Runtime config is read from window.__AU_FEEDBACK__ (set by injectWidget):
 *   { artifactKey: string, abuseUrl?: string }
 *
 * Phase 1 scope:
 *   - Non-destructive close (minimize only; never removes the launcher).
 *   - Launcher unresolved-count badge.
 *   - List-first layout; composer collapsed behind "+ New comment".
 *   - "This page / All pages" scope + "Hide resolved" toggle.
 *   - Page breadcrumb per comment + cross-page navigation (no silent no-op).
 *   - Select-element mode affordance (banner, crosshair, Esc) + safe labelFor.
 *
 * Phase 2 (landed): mounts in an open Shadow DOM host promoted to the top layer
 * via the Popover API (beats artifact z-index / overlays / fullscreen; a foreign
 * modal <dialog> intentionally still wins). Target-resolution ladder: other-page
 * navigate, found+visible scroll+pulse, off-screen scroll, hidden reveal/ghost,
 * missing ghost-at-rect — never a silent no-op.
 *
 * Phase 3 (landed): richer multi-anchor capture (id/selector/text/role) with
 * id->selector->text resolution; page_path + version_id persisted (migration
 * 0002) so untargeted comments scope by page and drift is detectable; Re-anchor
 * action (PATCH target) for stale anchors.
 *
 * Phase 4 (landed): mobile bottom-sheet layout (dvh, drag handle); a11y
 * (role=dialog/list, Esc-to-close, focus on open / return on close, Tab trap,
 * prefers-reduced-motion); persistent numbered pins for all on-page comments.
 */
(function () {
  if (window.__artifactUseWidget) return;
  window.__artifactUseWidget = true;

  var CFG = window.__AU_FEEDBACK__ || {};
  var artifactKey = CFG.artifactKey || "";
  if (!artifactKey) return;
  var versionId = CFG.versionId || "";
  var abuseUrl = String(CFG.abuseUrl || "");

  // ---- state ----
  var target = null; // element chosen for a NEW comment
  var active = null; // anchor currently highlighted by the marker
  var selecting = false;
  var reanchorFor = null; // comment being re-anchored, if any
  var scope = "page"; // "page" | "all"
  var hideResolved = true;
  var pinsOn = false; // show numbered pins for all on-page comments
  var pinEls = [];
  var allComments = [];

  function strip(p) {
    return String(p || "").replace(/\/+$/, "");
  }
  function samePath(a, b) {
    return strip(a) === strip(b);
  }
  function currentPath() {
    return location.pathname;
  }
  // Is a stored page path actually within THIS artifact? Guards against stray
  // paths (e.g. an agent-posted comment with page_path "/") that would otherwise
  // navigate off the artifact (to the site homepage) when clicked.
  function withinArtifact(p) {
    return String(p || "").indexOf("/" + artifactKey + "/") >= 0;
  }
  function pageLabel(path) {
    if (!path) return "";
    var parts = strip(path).split("/").filter(Boolean);
    var last = parts[parts.length - 1] || "";
    if (!last || last === artifactKey) return "Home";
    return last.replace(/\.html?$/i, "");
  }

  // ---- elements ----
  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined) n.textContent = text;
    return n;
  }
  // Panel-scoped querySelector (panel is assigned below; every caller runs
  // after that). Keeps the many one-off panel lookups terse.
  function $(s) {
    return panel.querySelector(s);
  }
  var btn = el("button", "au-launch");
  btn.appendChild(el("span", "au-launch-label", "Comments"));
  var badge = el("span", "au-badge", "");
  badge.style.display = "none";
  btn.appendChild(badge);

  var panel = el("aside", "au-panel", "");
  var mark = el("div", "au-mark", "");
  var hover = el("div", "au-hover", "");
  var hoverTip = el("div", "au-hover-tip", "");
  var banner = el("div", "au-banner", "");
  var ghost = el("div", "au-ghost", "");
  var ghostLabel = el("span", "au-ghost-label", "");
  ghost.appendChild(ghostLabel);
  var cta = el("div", "au-cta", "");
  cta.innerHTML =
    '<button class="au-cta-main" data-cta-open>🤖 Get your agent to read this</button>' +
    '<button class="au-cta-x" data-cta-dismiss aria-label="Dismiss" title="Dismiss">✕</button>';

  var css = document.createElement("style");
  css.textContent = STYLES();

  [panel, btn, mark, hover, hoverTip, banner, ghost, cta].forEach(function (n) {
    n.dataset.auWidget = "1";
  });

  panel.innerHTML =
    '<div class="au-head"><span class="au-title">Comments</span>' +
    '<div class="au-tools"><button class="au-icon" data-agent title="Hand to your agent" aria-label="Hand to your agent">🤖</button>' +
    '<button class="au-icon" data-min title="Minimize" aria-label="Minimize comments">✕</button></div></div>' +
    '<div class="au-toolbar">' +
    '<div class="au-scope" role="tablist">' +
    '<button class="au-seg is-on" data-scope="page">This page</button>' +
    '<button class="au-seg" data-scope="all">All pages</button>' +
    "</div>" +
    '<label class="au-check"><input type="checkbox" data-hide-resolved checked> Hide resolved</label>' +
    '<label class="au-check"><input type="checkbox" data-pins> Pins</label>' +
    "</div>" +
    '<div class="au-loadbar" data-loadbar></div>' +
    '<div class="au-list" data-list></div>' +
    '<button class="au-new" data-new>+ New comment</button>' +
    '<div class="au-composer" data-composer>' +
    '<div class="au-actions"><button class="au-action" data-select>Select element</button>' +
    '<button class="au-action" data-clear>Clear target</button></div>' +
    '<div class="au-target" data-target></div>' +
    '<textarea class="au-text" data-body placeholder="Leave a comment"></textarea>' +
    '<div class="au-composer-actions"><button class="au-send" data-send>Post comment</button>' +
    '<button class="au-link" data-cancel-new>Cancel</button></div>' +
    '<div class="au-emailgate" data-emailgate>' +
    '<p class="au-muted">Add your email to post comments (one time).</p>' +
    '<input type="email" class="au-emailinput" data-email placeholder="you@example.com" autocomplete="email">' +
    '<div class="au-composer-actions"><button class="au-send" data-email-submit>Continue</button>' +
    '<button class="au-link" data-email-cancel>Cancel</button></div>' +
    "</div>" +
    "</div>" +
    '<div class="au-foot"><a class="au-report" data-report-abuse>Report abuse</a></div>' +
    '<div class="au-agent" data-agent-panel>' +
    '<div class="au-agent-head"><strong>🤖 Hand to your agent</strong>' +
    '<button class="au-link" data-agent-close>Close</button></div>' +
    '<p class="au-muted">Copy this into your AI agent (Claude, Codex, ChatGPT). It can explore this artifact and leave comments over the API — no account needed.</p>' +
    '<textarea class="au-text au-agent-prompt" data-agent-prompt readonly></textarea>' +
    '<div class="au-composer-actions"><button class="au-send" data-agent-copy>Copy prompt</button>' +
    '<button class="au-link" data-agent-copylink>Copy share link</button></div>' +
    "</div>";

  banner.innerHTML =
    '<span class="au-banner-text">Click an element to attach your comment</span>' +
    '<button class="au-banner-cancel" data-cancel-select>Esc to cancel</button>';

  var reportAbuse = $("[data-report-abuse]");
  if (abuseUrl.indexOf("mailto:") === 0) reportAbuse.href = abuseUrl;
  else reportAbuse.parentNode.hidden = true;

  // ---- accessibility roles ----
  panel.setAttribute("role", "dialog");
  panel.setAttribute("aria-label", "Comments");
  panel.setAttribute("aria-modal", "false");
  panel.setAttribute("tabindex", "-1");
  btn.setAttribute("aria-label", "Comments");
  btn.setAttribute("aria-expanded", "false");
  $("[data-list]").setAttribute("role", "list");
  function reduceMotion() {
    return matchMedia("(prefers-reduced-motion:reduce)").matches;
  }
  function smoothScroll() {
    return reduceMotion() ? "auto" : "smooth";
  }

  // ---- target anchoring ----
  function insideWidget(n) {
    return n && n.closest && n.closest("[data-au-widget]");
  }
  function selectorFor(e) {
    if (e.id && document.querySelectorAll("#" + CSS.escape(e.id)).length === 1)
      return "#" + CSS.escape(e.id);
    var a = [];
    for (; e && e.nodeType === 1 && e !== document.body; e = e.parentElement) {
      var n = e.localName,
        i = 1,
        p = e;
      while ((p = p.previousElementSibling)) if (p.localName === n) i++;
      a.unshift(n + ":nth-of-type(" + i + ")");
    }
    return a.length ? "body>" + a.join(">") : "body";
  }
  function clean(s) {
    return String(s || "")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 120);
  }
  // Safe label: never dump descendant <style>/<script> text. Prefer
  // accessible names, then this element's own immediate text nodes only.
  function labelFor(e) {
    var aria = e.getAttribute && e.getAttribute("aria-label");
    if (aria) return clean(aria);
    if (e.alt) return clean(e.alt);
    if (e.title) return clean(e.title);
    var t = immediateText(e);
    if (t) return t;
    return clean(
      (e.getAttribute && e.getAttribute("name")) || e.localName || "element",
    );
  }
  function immediateText(e) {
    var s = "";
    for (var i = 0; i < e.childNodes.length; i++)
      if (e.childNodes[i].nodeType === 3) s += e.childNodes[i].textContent;
    return clean(s);
  }
  // Capture several anchors, most stable first, so the target survives edits.
  function anchorsFor(e) {
    var a = [];
    if (e.id) a.push({ type: "id", value: e.id });
    a.push({ type: "selector", value: selectorFor(e) });
    var txt = immediateText(e);
    if (txt) a.push({ type: "text", value: txt });
    var aria = e.getAttribute && e.getAttribute("aria-label");
    var role = e.getAttribute && e.getAttribute("role");
    if (aria || role)
      a.push({ type: "role", value: role || e.localName, name: aria || txt });
    return a;
  }
  function targetFrom(e) {
    var r = e.getBoundingClientRect();
    return {
      selector: selectorFor(e),
      label: labelFor(e),
      text: immediateText(e),
      path: currentPath(),
      version_id: versionId,
      anchors: anchorsFor(e),
      rect: {
        x: Math.round(r.left + scrollX),
        y: Math.round(r.top + scrollY),
        w: Math.round(r.width),
        h: Math.round(r.height),
      },
    };
  }
  function findByText(txt) {
    if (!txt) return null;
    var want = clean(txt);
    var nodes = document.body.querySelectorAll(
      "button,a,summary,label,h1,h2,h3,h4,h5,th,td,p,li,span,div,[role]",
    );
    for (var i = 0; i < nodes.length && i < 4000; i++)
      if (immediateText(nodes[i]) === want) return nodes[i];
    return null;
  }
  function resolveAnchor(a) {
    try {
      if (a.type === "id") return document.getElementById(a.value);
      if (a.type === "selector") return document.querySelector(a.value);
      if (a.type === "text") return findByText(a.value);
    } catch (e) {}
    return null;
  }
  // Resolve a stored target through its anchors (id -> selector -> text).
  function find(t) {
    if (!t) return null;
    var anchors =
      t.anchors && t.anchors.length
        ? t.anchors
        : t.selector
          ? [{ type: "selector", value: t.selector }]
          : [];
    for (var i = 0; i < anchors.length; i++) {
      var el2 = resolveAnchor(anchors[i]);
      if (el2) return el2;
    }
    return null;
  }

  // ---- marker ----
  function setBox(box, e) {
    var r = e.getBoundingClientRect();
    var v =
      r.width > 0 &&
      r.height > 0 &&
      r.bottom > 0 &&
      r.right > 0 &&
      r.top < innerHeight &&
      r.left < innerWidth;
    if (!v) {
      box.style.display = "none";
      return;
    }
    box.style.display = "block";
    box.style.left = Math.max(0, r.left) + "px";
    box.style.top = Math.max(0, r.top) + "px";
    box.style.width = r.width + "px";
    box.style.height = r.height + "px";
  }
  function update() {
    var e = find(active || target);
    if (e) setBox(mark, e);
    else mark.style.display = "none";
  }
  function pulse() {
    mark.classList.remove("au-pulse");
    void mark.offsetWidth;
    mark.classList.add("au-pulse");
  }

  // ---- composer ----
  function renderTarget() {
    var box = $("[data-target]");
    box.innerHTML = "";
    box.appendChild(el("strong", "", "Target"));
    box.appendChild(
      el(
        "span",
        target ? "" : "au-muted",
        target ? target.label : "No element selected",
      ),
    );
    update();
  }
  function clearTarget() {
    target = null;
    active = null;
    renderTarget();
  }
  function openComposer(open) {
    $("[data-composer]").classList.toggle("is-open", open !== false);
    $("[data-new]").style.display = open === false ? "" : "none";
    if (open !== false) {
      var t = $("[data-body]");
      if (t)
        setTimeout(function () {
          t.focus();
        }, 0);
    }
  }

  // ---- list ----
  function showMessage(text) {
    var list = $("[data-list]");
    list.innerHTML = "";
    list.appendChild(el("div", "au-empty au-muted", text));
  }
  function setBusy(on) {
    panel.classList.toggle("is-busy", !!on);
  }
  function showSkeleton() {
    var list = $("[data-list]");
    list.innerHTML = "";
    for (var i = 0; i < 4; i++) {
      var row = el("div", "au-skel");
      row.appendChild(el("div", "au-skel-line au-skel-meta"));
      row.appendChild(el("div", "au-skel-line au-skel-a"));
      row.appendChild(el("div", "au-skel-line au-skel-b"));
      list.appendChild(row);
    }
  }
  // Disable a button and show a transient label while an async action runs.
  async function withBusy(button, label, fn) {
    if (!button) return fn();
    var prev = button.textContent,
      wasDisabled = button.disabled;
    button.disabled = true;
    button.classList.add("is-busy");
    if (label) button.textContent = label;
    try {
      return await fn();
    } finally {
      button.disabled = wasDisabled;
      button.classList.remove("is-busy");
      button.textContent = prev;
    }
  }
  function refreshBadge() {
    var n = allComments.filter(function (c) {
      return !c.parent_comment_id && !c.resolved_at;
    }).length;
    if (n > 0) {
      badge.textContent = String(n);
      badge.style.display = "";
    } else {
      badge.style.display = "none";
    }
  }
  function visibleForScope(c) {
    if (scope === "all") return true;
    var t = parse(c.target_json);
    var p = (t && t.path) || c.page_path;
    // No page, or a stray path not within this artifact -> show on every page.
    if (!p || !withinArtifact(p)) return true;
    return samePath(p, currentPath());
  }
  async function load() {
    var open = panel.classList.contains("is-open");
    var hasItems = !!$("[data-list] .au-item");
    if (open && !hasItems) showSkeleton();
    setBusy(true);
    try {
      var r = await fetch(
        "/_au/comments?artifact_key=" + encodeURIComponent(artifactKey),
      );
      if (r.status === 401) {
        showMessage("Open through the access prompt to view comments.");
        return;
      }
      if (!r.ok) {
        showMessage("Could not load comments.");
        return;
      }
      var j = await r.json();
      allComments = j.comments || [];
      refreshBadge();
      renderList(allComments);
      renderPins();
    } catch (e) {
      showMessage("Could not load comments.");
    } finally {
      setBusy(false);
    }
  }
  function renderList(items) {
    var list = $("[data-list]");
    list.innerHTML = "";
    var roots = [],
      replies = {};
    items.forEach(function (c) {
      if (c.parent_comment_id) {
        var k = String(c.parent_comment_id);
        (replies[k] || (replies[k] = [])).push(c);
      } else roots.push(c);
    });
    roots = roots.filter(function (c) {
      if (hideResolved && c.resolved_at) return false;
      return visibleForScope(c);
    });
    roots.sort(function (a, b) {
      return Number(b.created_at || b.id) - Number(a.created_at || a.id);
    });
    if (!roots.length) {
      showMessage(
        scope === "page" ? "No comments on this page yet." : "No comments yet.",
      );
      return;
    }
    roots.forEach(function (c) {
      var item = el("div", "au-item" + (c.resolved_at ? " is-resolved" : ""));
      item.dataset.auId = c.id;
      item.setAttribute("role", "listitem");
      item.appendChild(commentNode(c, false));
      item.appendChild(replyBox(c));
      var rs = replies[String(c.id)] || [];
      if (rs.length) {
        var wrap = el("div", "au-replies");
        rs.sort(function (a, b) {
          return Number(a.created_at || a.id) - Number(b.created_at || b.id);
        }).forEach(function (r) {
          wrap.appendChild(commentNode(r, true));
        });
        item.appendChild(wrap);
      }
      list.appendChild(item);
    });
  }
  function commentNode(c, isReply) {
    var wrap = el("div", isReply ? "au-reply" : "au-comment"),
      main = el("button", "au-comment-main"),
      meta = el("div", "au-meta"),
      body = el("div", "au-textline", c.body || ""),
      t = parse(c.target_json);
    main.type = "button";
    // location first, then who.
    var onThisPage = t && (!t.path || samePath(t.path, currentPath()));
    var missingHere = false;
    if (!isReply && t && t.path && !samePath(t.path, currentPath())) {
      var pg = el("span", "au-page", pageLabel(t.path));
      pg.title = "On another page";
      meta.appendChild(pg);
    } else if (!isReply && t && (t.selector || t.anchors) && onThisPage) {
      // Surface anchor health at render time so a stale target is not a surprise.
      var anchorEl = find(t);
      if (!anchorEl) {
        meta.appendChild(
          el("span", "au-chip au-anchor-missing", "⚠ not found"),
        );
        missingHere = true;
      } else if (!isShown(anchorEl))
        meta.appendChild(el("span", "au-chip au-anchor-hidden", "hidden"));
    }
    if (t && t.label) meta.appendChild(el("span", "au-target-label", t.label));
    if (meta.childNodes.length) meta.appendChild(el("span", "au-dot", "·"));
    meta.appendChild(el("span", "au-email", c.email || "Unknown viewer"));
    if (c.resolved_at && !isReply)
      meta.appendChild(el("span", "au-state", "Resolved"));
    main.appendChild(meta);
    main.appendChild(body);
    main.onclick = function () {
      focusComment(c);
    };
    wrap.appendChild(main);
    if (!isReply) {
      var actions = el("div", "au-comment-actions");
      if (t) {
        var locate = el("button", "au-link au-locate", "⌖ Locate");
        locate.type = "button";
        locate.title = "Jump to the element this comment is about";
        locate.onclick = function () {
          focusComment(c);
        };
        actions.appendChild(locate);
      }
      if (missingHere) {
        var rea = el("button", "au-link au-reanchor", "Re-anchor");
        rea.type = "button";
        rea.title = "Pick the element this comment should point to now";
        rea.onclick = function () {
          startReanchor(c);
        };
        actions.appendChild(rea);
      }
      var reply = el("button", "au-link", "Reply"),
        resolve = el("button", "au-link", c.resolved_at ? "Reopen" : "Resolve");
      reply.type = resolve.type = "button";
      reply.onclick = function () {
        toggleReply(c.id);
      };
      resolve.onclick = function () {
        withBusy(resolve, "…", function () {
          return setResolved(c, !c.resolved_at);
        });
      };
      actions.appendChild(reply);
      actions.appendChild(resolve);
      wrap.appendChild(actions);
    }
    return wrap;
  }
  function replyBox(c) {
    var box = el("div", "au-replybox");
    box.setAttribute("data-reply-box", c.id);
    var t = parse(c.target_json),
      area = el("textarea", "au-text au-smalltext"),
      actions = el("div", "au-reply-actions"),
      send = el("button", "au-send", "Send reply"),
      cancel = el("button", "au-link", "Cancel");
    area.placeholder = "Reply";
    send.type = cancel.type = "button";
    send.onclick = function () {
      var body = area.value.trim();
      if (!body) return;
      withBusy(send, "Sending…", async function () {
        if (await postComment({ body: body, parent_id: c.id, target: t }))
          area.value = "";
      });
    };
    cancel.onclick = function () {
      box.classList.remove("is-open");
    };
    actions.appendChild(send);
    actions.appendChild(cancel);
    box.appendChild(area);
    box.appendChild(actions);
    return box;
  }

  // ---- target resolution ladder (never a silent no-op) ----
  function isShown(e) {
    var r = e.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) return false;
    if (e.offsetParent === null && getComputedStyle(e).position !== "fixed")
      return false;
    return true;
  }
  // Open collapsed <details> ancestors so a hidden target can be revealed.
  function revealAncestors(e) {
    for (var p = e; p && p !== document.body; p = p.parentElement) {
      if (p.tagName === "DETAILS" && !p.open) p.open = true;
    }
  }
  function hideGhost() {
    ghost.style.display = "none";
    ghost._rect = null;
  }
  // Recompute the fixed-position ghost box from its stored document rect so it
  // tracks the page as the user scrolls (onViewport), instead of staying glued
  // to the viewport. No-op while hidden so scroll events during the reveal
  // delay or after close() do not resurrect it.
  function positionGhost() {
    var r = ghost._rect;
    if (!r || ghost.style.display === "none") return;
    ghost.style.left = Math.max(0, r.x - scrollX) + "px";
    ghost.style.top = Math.max(0, r.y - scrollY) + "px";
    ghost.style.width = r.w + "px";
    ghost.style.height = r.h + "px";
  }
  // Draw a dashed "ghost" box at the element's last-known document-coordinate
  // rect, for hidden/missing targets we cannot outline directly.
  function showGhost(rect, note) {
    if (!rect || !rect.w || !rect.h) {
      showToast(note || "Target location is unknown.");
      return;
    }
    var targetY = Math.max(0, rect.y - innerHeight / 2 + rect.h / 2);
    scrollTo({ top: targetY, behavior: smoothScroll() });
    ghost._rect = rect;
    setTimeout(function () {
      ghostLabel.textContent = note || "Approximate location";
      ghost.style.display = "block";
      positionGhost();
    }, 300);
  }
  function focusComment(c) {
    var t = parse(c && c.target_json);
    var pagePath = (t && t.path) || (c && c.page_path);
    // 1. Another page WITHIN this artifact -> navigate there with a focus hint.
    //    A stray path (e.g. "/") is treated as the current page, never followed.
    if (
      pagePath &&
      withinArtifact(pagePath) &&
      !samePath(pagePath, currentPath())
    ) {
      location.href = pagePath + "#au=" + c.id;
      return;
    }
    if (!t) return; // untargeted comment on this page: nothing to locate
    setActiveItem(c.id);
    hideGhost();
    mark.style.display = "none";
    active = null;
    var e = find(t);
    if (e) revealAncestors(e);
    if (e && isShown(e)) {
      // 2/3. Found and visible / off-screen -> scroll into view + pulse.
      active = t;
      e.scrollIntoView({ block: "center", behavior: smoothScroll() });
      setTimeout(function () {
        update();
        pulse();
      }, 280);
    } else if (e) {
      // 4. Found but hidden (display:none / 0-size / collapsed) -> ghost at rect.
      showGhost(t.rect, "Target is hidden on this page");
    } else if (t.rect) {
      // 5. Not found (element changed/removed) -> ghost at last-known location.
      showGhost(
        t.rect,
        t.version_id ? "Target missing — page changed" : "Target not found",
      );
    } else {
      showToast("Couldn't locate this element on the current page.");
    }
  }

  // ---- mutations ----
  // One request wrapper for /_au/comments. Injects artifact_key, and turns a
  // network failure into a Response-like { ok:false } so callers never leak an
  // unhandled rejection (postComment/setResolved run without their own catch).
  function api(method, payload) {
    payload.artifact_key = artifactKey;
    return fetch("/_au/comments", {
      method: method,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    }).catch(function () {
      return { ok: false, status: 0 };
    });
  }
  async function postComment(extra) {
    var payload = {
      page_path: currentPath(),
      version_id: versionId,
    };
    for (var k in extra) payload[k] = extra[k];
    var r = await api("POST", payload);
    if (r.status === 401) {
      // No session yet (e.g. a public artifact) — collect an email to mint a
      // session, then retry the post.
      if (!(await collectEmail())) return false;
      r = await api("POST", payload);
    }
    if (!r.ok) {
      showToast("Could not post comment.");
      return false;
    }
    await load();
    return true;
  }
  // Show the inline email field, mint a viewer session via the email gate, and
  // resolve true once authenticated. Used to authorize comments on public
  // artifacts without gating the whole artifact.
  function collectEmail() {
    return new Promise(function (resolve) {
      var box = $("[data-emailgate]");
      var input = $("[data-email]");
      var submit = $("[data-email-submit]");
      var cancel = $("[data-email-cancel]");
      try {
        input.value = localStorage.getItem("au_email") || "";
      } catch (e) {}
      box.classList.add("is-on");
      setTimeout(function () {
        input.focus();
      }, 0);
      function done(v) {
        box.classList.remove("is-on");
        submit.onclick = null;
        cancel.onclick = null;
        resolve(v);
      }
      submit.onclick = async function () {
        var email = input.value.trim();
        if (email.indexOf("@") < 1) {
          input.focus();
          return;
        }
        submit.disabled = true;
        try {
          var r = await fetch("/_au/gate/email", {
            method: "POST",
            headers: {
              Accept: "application/json",
              "Content-Type": "application/x-www-form-urlencoded",
            },
            body:
              "artifact_key=" +
              encodeURIComponent(artifactKey) +
              "&email=" +
              encodeURIComponent(email),
          });
          submit.disabled = false;
          if (!r.ok) {
            showToast("Could not verify email.");
            return;
          }
          try {
            localStorage.setItem("au_email", email);
          } catch (e) {}
          done(true);
        } catch (e) {
          submit.disabled = false;
          showToast("Could not verify email.");
        }
      };
      cancel.onclick = function () {
        done(false);
      };
    });
  }
  async function setResolved(c, resolved) {
    var r = await api("PATCH", { id: c.id, resolved: resolved });
    if (!r.ok) {
      showToast("Could not update comment.");
      return;
    }
    load();
  }
  function toggleReply(id) {
    panel.querySelectorAll(".au-replybox").forEach(function (box) {
      var open =
        box.getAttribute("data-reply-box") === String(id) &&
        !box.classList.contains("is-open");
      box.classList.toggle("is-open", open);
      if (open) {
        var t = box.querySelector("textarea");
        setTimeout(function () {
          if (t) t.focus();
        }, 0);
      }
    });
  }
  function parse(s) {
    try {
      return s ? JSON.parse(s) : null;
    } catch (e) {
      return null;
    }
  }
  function setActiveItem(id) {
    panel.querySelectorAll(".au-item").forEach(function (it) {
      it.classList.toggle("is-active", it.dataset.auId === String(id));
    });
  }

  // ---- persistent pins (all on-page targeted comments at once) ----
  function clearPins() {
    pinEls.forEach(function (p) {
      p.remove();
    });
    pinEls = [];
  }
  function renderPins() {
    clearPins();
    if (!pinsOn) return;
    var n = 0;
    allComments.forEach(function (c) {
      if (c.parent_comment_id) return;
      if (hideResolved && c.resolved_at) return;
      var t = parse(c.target_json);
      if (!t) return;
      if (t.path && !samePath(t.path, currentPath())) return;
      n++;
      var pin = el("button", "au-pin", String(n));
      pin.dataset.auWidget = "1";
      pin.title = c.body ? c.body.slice(0, 80) : "";
      pin._t = t;
      pin.onclick = function () {
        focusComment(c);
      };
      root.appendChild(pin);
      pinEls.push(pin);
    });
    positionPins();
  }
  function positionPins() {
    pinEls.forEach(function (pin) {
      var t = pin._t,
        e = find(t),
        r;
      if (e && isShown(e)) r = e.getBoundingClientRect();
      else if (t.rect)
        r = {
          left: t.rect.x - scrollX,
          top: t.rect.y - scrollY,
          width: t.rect.w,
          height: t.rect.h,
        };
      else {
        pin.style.display = "none";
        return;
      }
      pin.style.display = "flex";
      pin.style.left = Math.max(2, r.left - 9) + "px";
      pin.style.top = Math.max(2, r.top - 9) + "px";
    });
  }

  // ---- toast ----
  var toastEl = null,
    toastTimer = null;
  function showToast(msg) {
    if (!toastEl) {
      toastEl = el("div", "au-toast", "");
      toastEl.dataset.auWidget = "1";
      popover(toastEl);
      root.appendChild(toastEl);
    }
    toastEl.textContent = msg;
    showTop(toastEl);
    toastEl.classList.add("is-on");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () {
      toastEl.classList.remove("is-on");
      hideTop(toastEl);
    }, 3200);
  }

  // ---- hand to agent ----
  var agentShareUrl = "";
  function setAgentOpen(on) {
    $("[data-agent-panel]").classList.toggle("is-open", !!on);
  }
  async function openAgent() {
    setAgentOpen(true);
    var area = $("[data-agent-prompt]");
    area.value = "Generating a secure agent prompt…";
    agentShareUrl = "";
    try {
      var r = await fetch("/_au/agent-token", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ artifact_key: artifactKey }),
      });
      if (!r.ok) {
        area.value =
          r.status === 403
            ? "Verify your email first, then try again."
            : "Could not create an agent token — open this artifact through the access prompt first.";
        return;
      }
      var j = await r.json();
      area.value = j.prompt || "";
      agentShareUrl = j.share_url || "";
    } catch (e) {
      area.value = "Could not create an agent token.";
    }
  }
  // ---- agent CTA (dismissible promo above the launcher) ----
  // Dismiss is per-artifact (not per-origin), so dismissing on one artifact
  // still surfaces the CTA on others.
  var ctaKey = "au_cta_dismissed_" + artifactKey;
  var ctaDismissed = false;
  try {
    ctaDismissed = localStorage.getItem(ctaKey) === "1";
  } catch (e) {}
  function showCta() {
    if (ctaDismissed || panel.classList.contains("is-open")) return;
    cta.classList.add("is-on");
    showTop(cta);
  }
  function hideCta() {
    cta.classList.remove("is-on");
    hideTop(cta);
  }
  function dismissCta() {
    ctaDismissed = true;
    try {
      localStorage.setItem(ctaKey, "1");
    } catch (e) {}
    hideCta();
  }
  function copyText(t) {
    if (!t) return;
    try {
      navigator.clipboard.writeText(t).then(
        function () {
          showToast("Copied to clipboard.");
        },
        function () {
          showToast("Copy failed — select the text and copy manually.");
        },
      );
    } catch (e) {
      showToast("Copy failed — select the text and copy manually.");
    }
  }

  // ---- select element mode ----
  function over(e) {
    if (!selecting || insideWidget(e.target)) return;
    setBox(hover, e.target);
    setHoverTip(e.target);
  }
  function setHoverTip(elm) {
    var r = elm.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) {
      hoverTip.style.display = "none";
      return;
    }
    var tag = elm.localName || "element";
    hoverTip.textContent = labelFor(elm) + "  ·  <" + tag + ">";
    hoverTip.style.display = "block";
    var top = r.top - 26;
    hoverTip.style.top =
      (top < 4 ? Math.min(innerHeight - 24, r.top + 4) : top) + "px";
    hoverTip.style.left = Math.min(Math.max(4, r.left), innerWidth - 60) + "px";
  }
  function pick(e) {
    if (!selecting || insideWidget(e.target)) return;
    e.preventDefault();
    e.stopPropagation();
    var picked = targetFrom(e.target);
    if (reanchorFor) {
      var c = reanchorFor;
      endSelect();
      reanchorComment(c, picked);
      return;
    }
    target = picked;
    active = target;
    endSelect();
    renderTarget();
  }
  function startReanchor(c) {
    reanchorFor = c;
    startSelect();
  }
  async function reanchorComment(c, tgt) {
    var ok = false;
    try {
      var r = await api("PATCH", { id: c.id, target: tgt });
      ok = r.ok;
    } catch (e) {}
    showToast(ok ? "Re-anchored to the new element." : "Could not re-anchor.");
    if (ok) load();
  }
  function onKey(e) {
    if (e.key === "Escape" && selecting) {
      endSelect();
    }
  }
  function startSelect() {
    if (selecting) return;
    selecting = true;
    if (!reanchorFor) openComposer(true);
    banner.querySelector(".au-banner-text").textContent = reanchorFor
      ? "Click the new location for this comment"
      : "Click an element to attach your comment";
    document.documentElement.classList.add("au-selecting");
    banner.classList.add("is-on");
    showTop(banner);
    document.addEventListener("mouseover", over, true);
    document.addEventListener("click", pick, true);
    document.addEventListener("keydown", onKey, true);
  }
  function endSelect() {
    selecting = false;
    reanchorFor = null;
    document.documentElement.classList.remove("au-selecting");
    banner.classList.remove("is-on");
    hideTop(banner);
    hover.style.display = "none";
    hoverTip.style.display = "none";
    document.removeEventListener("mouseover", over, true);
    document.removeEventListener("click", pick, true);
    document.removeEventListener("keydown", onKey, true);
  }

  // ---- open / close (close == minimize; launcher is never removed) ----
  function open() {
    hideCta();
    panel.classList.add("is-open");
    btn.setAttribute("aria-expanded", "true");
    showTop(panel);
    if (!allComments.length) showSkeleton();
    load();
    update();
    setTimeout(function () {
      try {
        panel.focus();
      } catch (e) {}
    }, 0);
  }
  function close() {
    panel.classList.remove("is-open");
    btn.setAttribute("aria-expanded", "false");
    hideTop(panel);
    endSelect();
    mark.style.display = "none";
    hideGhost();
    setAgentOpen(false);
    showCta();
    try {
      btn.focus();
    } catch (e) {}
  }
  // Escape closes the panel; Tab is trapped within it for keyboard users.
  panel.addEventListener("keydown", function (e) {
    if (e.key === "Escape" && !selecting) {
      e.stopPropagation();
      close();
    } else if (e.key === "Tab") {
      trapTab(e);
    }
  });
  function trapTab(e) {
    var nodes = panel.querySelectorAll(
      'button,[href],input,textarea,[tabindex]:not([tabindex="-1"])',
    );
    var list = [];
    for (var i = 0; i < nodes.length; i++)
      if (nodes[i].offsetParent !== null) list.push(nodes[i]);
    if (!list.length) return;
    var first = list[0],
      last = list[list.length - 1],
      act = root.activeElement;
    if (e.shiftKey && act === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && act === last) {
      e.preventDefault();
      first.focus();
    }
  }

  // ---- wire up ----
  btn.onclick = function () {
    if (panel.classList.contains("is-open")) close();
    else open();
  };
  $("[data-min]").onclick = close;
  $("[data-agent]").onclick = openAgent;
  cta.querySelector("[data-cta-open]").onclick = function () {
    open();
    openAgent();
  };
  cta.querySelector("[data-cta-dismiss]").onclick = dismissCta;
  $("[data-agent-close]").onclick = function () {
    setAgentOpen(false);
  };
  $("[data-agent-copy]").onclick = function () {
    copyText($("[data-agent-prompt]").value);
  };
  $("[data-agent-copylink]").onclick = function () {
    copyText(agentShareUrl);
  };
  $("[data-new]").onclick = function () {
    openComposer(true);
  };
  $("[data-cancel-new]").onclick = function () {
    openComposer(false);
    clearTarget();
  };
  $("[data-clear]").onclick = clearTarget;
  $("[data-select]").onclick = startSelect;
  banner.querySelector("[data-cancel-select]").onclick = endSelect;
  $("[data-hide-resolved]").onchange = function (e) {
    hideResolved = !!e.target.checked;
    renderList(allComments);
    renderPins();
  };
  $("[data-pins]").onchange = function (e) {
    pinsOn = !!e.target.checked;
    renderPins();
  };
  panel.querySelectorAll("[data-scope]").forEach(function (b) {
    b.onclick = function () {
      scope = b.getAttribute("data-scope");
      panel.querySelectorAll("[data-scope]").forEach(function (x) {
        x.classList.toggle("is-on", x === b);
      });
      renderList(allComments);
      renderPins();
    };
  });
  $("[data-send]").onclick = function () {
    var t = $("[data-body]"),
      body = t.value.trim(),
      sendBtn = $("[data-send]");
    if (!body) return;
    withBusy(sendBtn, "Sending…", async function () {
      if (await postComment({ body: body, target: target })) {
        t.value = "";
        clearTarget();
        openComposer(false);
      }
    });
  };

  function onViewport() {
    update();
    positionPins();
    positionGhost();
  }
  addEventListener("scroll", onViewport, true);
  addEventListener("resize", onViewport);

  // deep link: #au=<id> opens the panel and focuses that comment after load.
  async function handleDeepLink() {
    var m = /(?:^|[#&])au=(\d+)/.exec(location.hash);
    if (!m) return;
    open();
    // wait for comments
    for (var i = 0; i < 40 && !allComments.length; i++)
      await new Promise(function (r) {
        setTimeout(r, 50);
      });
    var c = allComments.filter(function (x) {
      return String(x.id) === m[1];
    })[0];
    if (c) focusComment(c);
  }

  // ---- mount in an isolated Shadow DOM host, promoted to the top layer ----
  // Shadow DOM stops artifact CSS from hiding/restyling the widget and stops
  // our CSS from leaking. The Popover API puts the launcher/panel/banner above
  // the artifact's own z-index, dialogs, popovers and fullscreen content.
  var host = document.createElement("div");
  host.id = "au-host";
  host.dataset.auWidget = "1";
  var root = host.attachShadow({ mode: "open" });
  root.appendChild(css);
  root.appendChild(mark);
  root.appendChild(hover);
  root.appendChild(hoverTip);
  root.appendChild(banner);
  root.appendChild(ghost);
  root.appendChild(cta);
  root.appendChild(panel);
  root.appendChild(btn);
  document.documentElement.appendChild(host);

  // Crosshair during select mode must style the page (light DOM), so this one
  // rule lives outside the shadow tree.
  var lightCss = document.createElement("style");
  lightCss.dataset.auWidget = "1";
  lightCss.textContent =
    "html.au-selecting,html.au-selecting *{cursor:crosshair!important}";
  document.documentElement.appendChild(lightCss);

  function popover(node) {
    try {
      node.setAttribute("popover", "manual");
    } catch (e) {}
  }
  function showTop(node) {
    try {
      if (
        node.showPopover &&
        node.isConnected &&
        !node.matches(":popover-open")
      )
        node.showPopover();
    } catch (e) {}
  }
  function hideTop(node) {
    try {
      if (node.hidePopover && node.matches(":popover-open")) node.hidePopover();
    } catch (e) {}
  }
  // Re-assert a popover to the TOP of the top-layer stack (last promoted wins).
  function reTop(node) {
    try {
      if (node.matches && node.matches(":popover-open")) {
        node.hidePopover();
        node.showPopover();
      } else showTop(node);
    } catch (e) {}
  }
  // After something else enters the top layer (a dialog/fullscreen), float our
  // visible surfaces back above it.
  function promoteAll() {
    reTop(btn);
    if (panel.classList.contains("is-open")) reTop(panel);
    if (banner.classList.contains("is-on")) reTop(banner);
    if (toastEl && toastEl.classList.contains("is-on")) reTop(toastEl);
  }
  [btn, panel, banner, cta].forEach(popover);
  showTop(btn);

  // Keep the host last in document order and the launcher promoted, even if the
  // artifact appends its own nodes or swaps the top layer.
  var mo = new MutationObserver(function () {
    if (
      !document.fullscreenElement &&
      document.documentElement.lastElementChild !== host
    ) {
      document.documentElement.appendChild(host);
      showTop(btn);
    }
  });
  mo.observe(document.documentElement, { childList: true });
  // Ride into the fullscreen element so we stay visible there too.
  document.addEventListener("fullscreenchange", function () {
    (document.fullscreenElement || document.documentElement).appendChild(host);
    showTop(btn);
    promoteAll();
  });

  renderTarget();
  // prime the badge even while the panel is closed.
  load();
  handleDeepLink();
  // surface the agent CTA shortly after load (unless dismissed / panel open).
  setTimeout(showCta, 1500);

  function STYLES() {
    return [
      ':host{font:13px ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;color:#17201d;letter-spacing:0;line-height:1.4}',
      "*{box-sizing:border-box}",
      "button{font:inherit;color:inherit}",
      "[popover]{position:fixed;inset:auto;margin:0;padding:0;border:0;overflow:visible;background:transparent;width:auto;height:auto;max-width:none;max-height:none}",
      ".au-launch{position:fixed;right:18px;bottom:18px;z-index:2147483647;display:flex;align-items:center;gap:8px;border:0;border-radius:8px;background:#12383b;color:#fff;padding:10px 14px;font-weight:750;box-shadow:0 10px 30px rgba(0,0,0,.2);cursor:pointer}",
      ".au-badge{min-width:20px;height:20px;padding:0 6px;border-radius:10px;background:#f3a712;color:#1b1206;font-size:12px;font-weight:800;display:inline-flex;align-items:center;justify-content:center}",
      ".au-panel{display:none;position:fixed;right:18px;top:18px;z-index:2147483647;width:min(420px,calc(100vw - 36px));height:min(680px,calc(100vh - 36px));background:#fff;border:1px solid #cdd7d4;border-radius:10px;box-shadow:0 24px 70px rgba(0,0,0,.28);overflow:hidden;flex-direction:column}",
      ".au-panel.is-open{display:flex}",
      ".au-head{height:46px;flex:0 0 auto;display:flex;align-items:center;justify-content:space-between;border-bottom:1px solid #e2e8e6;padding:0 8px 0 14px}",
      ".au-title{font-weight:800}",
      ".au-tools{display:flex;gap:6px}",
      ".au-icon{border:0;background:#eef4f2;color:#24312d;border-radius:6px;min-width:32px;height:32px;cursor:pointer;font-size:14px}",
      ".au-icon:hover{background:#dfe9e6}",
      ".au-toolbar{flex:0 0 auto;display:flex;align-items:center;justify-content:space-between;gap:8px;padding:10px 12px;border-bottom:1px solid #eef2f1}",
      ".au-dot{color:#b8c4bf}",
      ".au-scope{display:inline-flex;border:1px solid #cdd9d5;border-radius:7px;overflow:hidden}",
      ".au-seg{border:0;background:#fff;color:#3a4a45;padding:6px 10px;cursor:pointer;font-weight:700}",
      ".au-seg.is-on{background:#12383b;color:#fff}",
      ".au-check{display:inline-flex;align-items:center;gap:6px;color:#52625d;font-weight:600;white-space:nowrap;line-height:1;align-self:center}",
      ".au-list{flex:1 1 auto;overflow:auto;padding:0;scrollbar-gutter:stable}",
      ".au-item.is-active{background:#fff7e6}",
      ".au-item.is-active.is-resolved{background:#fbf6ea}",
      ".au-empty{padding:18px 14px}",
      ".au-item{border-bottom:1px solid #eef1f0;background:#fff}",
      ".au-item:last-child{border-bottom:0}",
      ".au-item.is-resolved{background:#fbfcfb}",
      ".au-comment{display:grid;gap:7px;padding:12px 14px}",
      ".au-reply{display:grid;gap:6px}",
      ".au-comment-main{display:block;width:100%;text-align:left;border:0;background:transparent;color:inherit;padding:0;cursor:pointer}",
      ".au-meta{display:flex;align-items:center;gap:6px;flex-wrap:wrap;font-size:11px;line-height:1.3;color:#687873;margin-bottom:2px}",
      ".au-page{background:#eaf2f0;color:#0f5a5e;font-weight:800;border-radius:4px;padding:1px 6px}",
      ".au-target-label{color:#1f5d61;font-weight:700}",
      ".au-email{color:#81908a}",
      ".au-state{font-weight:800;color:#0f6b6f;margin-left:auto}",
      ".au-textline{white-space:pre-wrap;line-height:1.42;color:#17201d}",
      ".au-item.is-resolved .au-textline{color:#61716c}",
      ".au-comment-actions,.au-reply-actions{display:flex;gap:12px;align-items:center;flex-wrap:wrap}",
      ".au-link{border:0;background:transparent;color:#0f6b6f;font-weight:800;padding:3px 7px;margin:0 -3px;border-radius:6px;cursor:pointer;transition:background .12s}",
      ".au-link:hover{background:#e6f1f0;text-decoration:underline}",
      ".au-link:active{background:#d6e8e6}",
      ".au-locate{color:#0c585b}",
      ".au-reanchor{color:#a3271f}",
      ".au-replies{display:grid;gap:8px;margin:0 14px 12px;padding-left:10px;border-left:2px solid #dfe8e5}",
      ".au-replybox{display:none;margin:0 14px 12px;gap:7px}",
      ".au-replybox.is-open{display:grid}",
      ".au-new{flex:0 0 auto;margin:10px 12px 14px;border:1px dashed #b9c7c2;background:#f6faf9;color:#0f6b6f;border-radius:8px;padding:11px;cursor:pointer;font-weight:800}",
      ".au-composer{display:none;flex:0 0 auto;border-top:1px solid #e2e8e6;padding:12px;gap:10px;background:#fafcfb}",
      ".au-composer.is-open{display:grid}",
      ".au-actions{display:flex;gap:8px}",
      ".au-action{border:1px solid #becbc7;background:#fff;border-radius:6px;padding:8px 10px;cursor:pointer}",
      ".au-target{border:1px solid #dbe4e1;background:#fff;border-radius:6px;padding:9px}",
      ".au-target strong{display:block;font-size:12px;color:#52625d;margin-bottom:3px}",
      ".au-text{width:100%;border:1px solid #c9d5d1;border-radius:6px;padding:9px 10px;resize:vertical;min-height:76px;font:inherit}",
      ".au-smalltext{min-height:54px}",
      ".au-composer-actions{display:flex;gap:12px;align-items:center}",
      ".au-emailgate{display:none;margin-top:10px;padding-top:10px;border-top:1px solid #eef2f1;flex-direction:column;gap:8px}",
      ".au-emailgate.is-on{display:flex}",
      ".au-emailinput{width:100%;border:1px solid #c9d5d1;border-radius:6px;padding:9px 10px;font:inherit;height:40px}",
      ".au-foot{flex:0 0 auto;min-height:44px;border-top:1px solid #eef2f1;padding:0 10px max(0px,env(safe-area-inset-bottom));display:flex;justify-content:flex-end;align-items:center;background:#fafcfb}",
      ".au-report{min-height:44px;padding:0 4px;display:inline-flex;align-items:center;color:#52625d;font-size:13px;font-weight:700;text-decoration:none}",
      ".au-report:hover{text-decoration:underline;color:#0f6b6f}",
      ".au-agent{position:absolute;left:0;right:0;top:46px;bottom:0;display:none;flex-direction:column;gap:10px;padding:12px;background:#fff;z-index:2}",
      ".au-agent.is-open{display:flex}",
      ".au-agent-head{display:flex;align-items:center;justify-content:space-between;font-weight:800}",
      ".au-agent-prompt{flex:1 1 auto;min-height:0;font:12px ui-monospace,SFMono-Regular,Menlo,monospace;white-space:pre-wrap;resize:none;color:#1b2420}",
      ".au-send{border:0;background:#0f6b6f;color:#fff;border-radius:6px;padding:9px 13px;font-weight:800;cursor:pointer}",
      ".au-muted{color:#81908a}",
      ".au-mark,.au-hover{position:fixed;display:none;pointer-events:none;z-index:2147483646;border:2px solid #f3a712;border-radius:6px;box-shadow:0 0 0 9999px rgba(18,56,59,.04)}",
      ".au-hover{border:2px solid #0f6b6f;background:rgba(15,107,111,.12);box-shadow:0 0 0 9999px rgba(18,56,59,.16);transition:top .04s linear,left .04s linear,width .04s linear,height .04s linear}",
      ".au-hover-tip{position:fixed;display:none;z-index:2147483647;pointer-events:none;background:#0f6b6f;color:#fff;font-weight:800;font-size:11px;line-height:1;padding:5px 7px;border-radius:5px;box-shadow:0 6px 16px rgba(0,0,0,.25);max-width:280px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
      ".au-ghost{position:fixed;display:none;pointer-events:none;z-index:2147483646;border:2px dashed #f3a712;border-radius:6px;background:rgba(243,167,18,.08);box-shadow:0 0 0 9999px rgba(18,56,59,.12)}",
      ".au-ghost-label{position:absolute;left:0;top:-22px;background:#b26b00;color:#fff;font-size:11px;font-weight:800;padding:3px 7px;border-radius:5px;white-space:nowrap}",
      ".au-chip{font-weight:800;border-radius:4px;padding:1px 6px}",
      ".au-anchor-missing{background:#fdeaea;color:#a3271f}",
      ".au-anchor-hidden{background:#eef1f0;color:#5a6c66}",
      ".au-pin{position:fixed;display:none;align-items:center;justify-content:center;z-index:2147483646;min-width:22px;height:22px;padding:0 5px;border:2px solid #fff;border-radius:11px;background:#12686d;color:#fff;font-size:12px;font-weight:800;cursor:pointer;box-shadow:0 3px 10px rgba(0,0,0,.3);pointer-events:auto}",
      ".au-pin:hover{background:#0c585b;transform:scale(1.08)}",
      "button:focus-visible,input:focus-visible{outline:2px solid #2a7d82;outline-offset:1px}",
      ".au-launch:hover{background:#0e2d30}",
      ".au-launch:active{transform:translateY(1px)}",
      ".au-icon:active{background:#cfdedb}",
      ".au-seg:hover:not(.is-on){background:#eef4f2}",
      ".au-action:hover{background:#eef5f3;border-color:#9fb4ae}",
      ".au-action:active{background:#e3eeec}",
      ".au-send:hover{background:#0c585b}",
      ".au-send:active{transform:translateY(1px)}",
      ".au-send:disabled,.au-send.is-busy{opacity:.65;cursor:default}",
      ".au-link:disabled,.au-link.is-busy{opacity:.6;cursor:default;text-decoration:none}",
      ".au-new:hover{background:#eef6f4;border-color:#9fb4ae}",
      ".au-item:hover:not(.is-active){background:#f7faf9}",
      ".au-comment-main:hover .au-textline{color:#0c4f53}",
      ".au-loadbar{flex:0 0 auto;height:2px;background:transparent;overflow:hidden}",
      ".au-panel.is-busy .au-loadbar{background:linear-gradient(90deg,transparent,#0f6b6f,transparent);background-size:40% 100%;background-repeat:no-repeat;animation:au-load 1s linear infinite}",
      "@keyframes au-load{0%{background-position:-40% 0}100%{background-position:140% 0}}",
      ".au-skel{padding:12px 14px;border-bottom:1px solid #eef1f0;display:grid;gap:8px}",
      ".au-skel-line{height:10px;border-radius:5px;background:linear-gradient(90deg,#eef2f1 25%,#e2e9e7 37%,#eef2f1 63%);background-size:400% 100%;animation:au-shimmer 1.2s ease-in-out infinite}",
      ".au-skel-meta{width:42%;height:8px}",
      ".au-skel-a{width:92%}",
      ".au-skel-b{width:68%}",
      "@keyframes au-shimmer{0%{background-position:100% 0}100%{background-position:0 0}}",
      "@keyframes au-pulse{0%{box-shadow:0 0 0 0 rgba(243,167,18,.55),0 0 0 9999px rgba(18,56,59,.04)}100%{box-shadow:0 0 0 12px rgba(243,167,18,0),0 0 0 9999px rgba(18,56,59,.04)}}",
      ".au-mark.au-pulse{animation:au-pulse .7s ease-out 1}",
      ".au-banner{position:fixed;left:24px;top:16px;z-index:2147483647;display:none;align-items:center;gap:12px;background:#12383b;color:#fff;border-radius:999px;padding:9px 9px 9px 16px;box-shadow:0 12px 30px rgba(0,0,0,.28);max-width:min(420px,calc(100vw - 48px))}",
      ".au-banner.is-on{display:flex}",
      ".au-banner-text{font-weight:700}",
      ".au-banner-cancel{border:0;background:rgba(255,255,255,.16);color:#fff;border-radius:999px;padding:6px 12px;font-weight:800;cursor:pointer}",
      ".au-toast{position:fixed;left:50%;bottom:74px;transform:translateX(-50%) translateY(8px);z-index:2147483647;background:#1b2420;color:#fff;border-radius:8px;padding:10px 14px;font-weight:700;box-shadow:0 12px 30px rgba(0,0,0,.3);opacity:0;pointer-events:none;transition:opacity .18s,transform .18s}",
      ".au-toast.is-on{opacity:1;transform:translateX(-50%) translateY(0)}",
      ".au-cta{position:fixed;right:18px;bottom:70px;z-index:2147483647;display:none;align-items:stretch;max-width:300px;background:#12383b;color:#fff;border-radius:12px;box-shadow:0 12px 34px rgba(0,0,0,.28);overflow:hidden}",
      ".au-cta.is-on{display:flex;animation:au-cta-in .35s ease-out,au-cta-bob 3.4s ease-in-out .7s infinite}",
      ".au-cta-main{border:0;background:transparent;color:#fff;font:inherit;font-weight:750;font-size:13px;line-height:1.25;text-align:left;padding:11px 4px 11px 14px;cursor:pointer}",
      ".au-cta-main:hover{background:rgba(255,255,255,.07)}",
      ".au-cta-x{border:0;background:transparent;color:#9fc9c4;font-size:12px;padding:0 11px;cursor:pointer}",
      ".au-cta-x:hover{color:#fff}",
      "@keyframes au-cta-in{from{opacity:0;transform:translateY(10px) scale(.96)}to{opacity:1;transform:translateY(0) scale(1)}}",
      "@keyframes au-cta-bob{0%,100%{transform:translateY(0)}50%{transform:translateY(-3px)}}",
      // Mobile: the panel becomes a bottom sheet (dvh keeps it above the keyboard).
      "@media (max-width:640px){.au-panel{left:0;right:0;bottom:0;top:auto;width:100%;height:82dvh;max-height:82dvh;border-radius:16px 16px 0 0;border-bottom:0}.au-panel::before{content:'';position:absolute;left:50%;top:7px;transform:translateX(-50%);width:38px;height:4px;border-radius:2px;background:#cdd9d5}.au-head{padding-top:8px}.au-launch{right:12px;bottom:12px}.au-cta{right:12px;bottom:64px;max-width:calc(100vw - 24px)}.au-banner{left:8px;right:8px;max-width:none}.au-toolbar{flex-wrap:wrap}}",
      // Respect reduced-motion preferences.
      "@media (prefers-reduced-motion:reduce){.au-mark.au-pulse,.au-skel-line,.au-panel.is-busy .au-loadbar,.au-pin:hover,.au-cta.is-on{animation:none;transition:none}}",
    ].join("");
  }
})();
