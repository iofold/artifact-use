/*
 * Artifact Use — feedback collector widget (light-DOM build).
 *
 * Authored readable; minified at build time into feedback.generated.ts by
 * scripts/build-feedback-widget.mjs (wired through wrangler [build]).
 *
 * Runtime config is read from window.__AU_FEEDBACK__ (set by injectWidget):
 *   { artifactKey: string }
 *
 * Phase 1 scope (see docs/FEEDBACK_UX_PLAN.md):
 *   - Non-destructive close (minimize only; never removes the launcher).
 *   - Launcher unresolved-count badge.
 *   - List-first layout; composer collapsed behind "+ New feedback".
 *   - "This page / All pages" scope + "Hide resolved" toggle.
 *   - Page breadcrumb per comment + cross-page navigation (no silent no-op).
 *   - Select-element mode affordance (banner, crosshair, Esc) + safe labelFor.
 *
 * Deferred to Phase 2/3: Shadow DOM + Popover top-layer, richer anchors +
 * version-drift, re-anchor, mobile bottom sheet, a11y.
 */
(function () {
  if (window.__artifactUseWidget) return;
  window.__artifactUseWidget = true;

  var CFG = window.__AU_FEEDBACK__ || {};
  var artifactKey = CFG.artifactKey || "";
  if (!artifactKey) return;

  // ---- state ----
  var target = null; // element chosen for a NEW comment
  var active = null; // anchor currently highlighted by the marker
  var selecting = false;
  var scope = "page"; // "page" | "all"
  var hideResolved = true;
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
  var btn = el("button", "au-launch");
  btn.appendChild(el("span", "au-launch-label", "Feedback"));
  var badge = el("span", "au-badge", "");
  badge.style.display = "none";
  btn.appendChild(badge);

  var panel = el("aside", "au-panel", "");
  var mark = el("div", "au-mark", "");
  var hover = el("div", "au-hover", "");
  var hoverTip = el("div", "au-hover-tip", "");
  var banner = el("div", "au-banner", "");

  var css = document.createElement("style");
  css.textContent = STYLES();

  [panel, btn, mark, hover, hoverTip, banner].forEach(function (n) {
    n.dataset.auWidget = "1";
  });

  panel.innerHTML =
    '<div class="au-head"><span class="au-title">Feedback</span>' +
    '<div class="au-tools"><button class="au-icon" data-min title="Minimize" aria-label="Minimize feedback">✕</button></div></div>' +
    '<div class="au-toolbar">' +
    '<div class="au-scope" role="tablist">' +
    '<button class="au-seg is-on" data-scope="page">This page</button>' +
    '<button class="au-seg" data-scope="all">All pages</button>' +
    "</div>" +
    '<label class="au-check"><input type="checkbox" data-hide-resolved checked> Hide resolved</label>' +
    "</div>" +
    '<div class="au-loadbar" data-loadbar></div>' +
    '<div class="au-list" data-list></div>' +
    '<button class="au-new" data-new>+ New feedback</button>' +
    '<div class="au-composer" data-composer>' +
    '<div class="au-actions"><button class="au-action" data-select>Select element</button>' +
    '<button class="au-action" data-clear>Clear target</button></div>' +
    '<div class="au-target" data-target></div>' +
    '<textarea class="au-text" data-body placeholder="Leave feedback"></textarea>' +
    '<div class="au-composer-actions"><button class="au-send" data-send>Send feedback</button>' +
    '<button class="au-link" data-cancel-new>Cancel</button></div>' +
    "</div>";

  banner.innerHTML =
    '<span class="au-banner-text">Click an element to attach feedback</span>' +
    '<button class="au-banner-cancel" data-cancel-select>Esc to cancel</button>';

  // ---- target anchoring ----
  function insideWidget(n) {
    return n && n.closest && n.closest("[data-au-widget]");
  }
  function cssEsc(s) {
    return window.CSS && CSS.escape
      ? CSS.escape(s)
      : String(s).replace(/[^a-zA-Z0-9_-]/g, function (c) {
          return "\\" + c;
        });
  }
  function selectorFor(e) {
    if (e.id && document.querySelectorAll("#" + cssEsc(e.id)).length === 1)
      return "#" + cssEsc(e.id);
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
    var t = "";
    for (var i = 0; i < e.childNodes.length; i++) {
      var n = e.childNodes[i];
      if (n.nodeType === 3) t += n.textContent;
    }
    t = clean(t);
    if (t) return t;
    return clean(
      (e.getAttribute && e.getAttribute("name")) || e.localName || "element",
    );
  }
  function targetFrom(e) {
    var r = e.getBoundingClientRect();
    return {
      selector: selectorFor(e),
      label: labelFor(e),
      path: currentPath(),
      rect: {
        x: Math.round(r.left + scrollX),
        y: Math.round(r.top + scrollY),
        w: Math.round(r.width),
        h: Math.round(r.height),
      },
    };
  }
  function find(t) {
    try {
      return t && t.selector ? document.querySelector(t.selector) : null;
    } catch (e) {
      return null;
    }
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
    var box = panel.querySelector("[data-target]");
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
  function openComposer(open) {
    panel
      .querySelector("[data-composer]")
      .classList.toggle("is-open", open !== false);
    panel.querySelector("[data-new]").style.display =
      open === false ? "" : "none";
    if (open !== false) {
      var t = panel.querySelector("[data-body]");
      if (t)
        setTimeout(function () {
          t.focus();
        }, 0);
    }
  }

  // ---- list ----
  function showMessage(text) {
    var list = panel.querySelector("[data-list]");
    list.innerHTML = "";
    list.appendChild(el("div", "au-empty au-muted", text));
  }
  function setBusy(on) {
    panel.classList.toggle("is-busy", !!on);
  }
  function showSkeleton() {
    var list = panel.querySelector("[data-list]");
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
  function unresolvedRootCount(items) {
    var n = 0;
    items.forEach(function (c) {
      if (!c.parent_comment_id && !c.resolved_at) n++;
    });
    return n;
  }
  function refreshBadge() {
    var n = unresolvedRootCount(allComments);
    if (n > 0) {
      badge.textContent = String(n);
      badge.style.display = "";
    } else {
      badge.style.display = "none";
    }
  }
  function visibleForScope(c) {
    var t = parse(c.target_json);
    if (scope === "all") return true;
    // "This page": targeted comments on this page, plus untargeted (no page yet).
    if (!t || !t.path) return true;
    return samePath(t.path, currentPath());
  }
  async function load() {
    var open = panel.classList.contains("is-open");
    var hasItems = !!panel.querySelector("[data-list] .au-item");
    if (open && !hasItems) showSkeleton();
    setBusy(true);
    try {
      var r = await fetch(
        "/_au/comments?artifact_key=" + encodeURIComponent(artifactKey),
      );
      if (r.status === 401) {
        showMessage("Open through the access prompt to view feedback.");
        return;
      }
      if (!r.ok) {
        showMessage("Could not load feedback.");
        return;
      }
      var j = await r.json();
      allComments = j.comments || [];
      refreshBadge();
      renderList(allComments);
    } catch (e) {
      showMessage("Could not load feedback.");
    } finally {
      setBusy(false);
    }
  }
  function renderList(items) {
    var list = panel.querySelector("[data-list]");
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
        scope === "page" ? "No feedback on this page yet." : "No feedback yet.",
      );
      return;
    }
    roots.forEach(function (c) {
      var item = el("div", "au-item" + (c.resolved_at ? " is-resolved" : ""));
      item.dataset.auId = c.id;
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
    if (!isReply && t && t.path && !samePath(t.path, currentPath())) {
      var pg = el("span", "au-page", pageLabel(t.path));
      pg.title = "On another page";
      meta.appendChild(pg);
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

  // ---- focus / navigation (no silent no-op) ----
  function focusComment(c) {
    var t = parse(c && c.target_json);
    if (!t) return;
    // Cross-page: navigate to the page this comment belongs to.
    if (t.path && !samePath(t.path, currentPath())) {
      location.href = t.path + "#au=" + c.id;
      return;
    }
    setActiveItem(c.id);
    active = t;
    var e = find(t);
    if (e) {
      e.scrollIntoView({ block: "center", behavior: "smooth" });
      setTimeout(function () {
        update();
        pulse();
      }, 260);
    } else {
      // Same page but the element is gone/renamed (full resolver is Phase 2).
      mark.style.display = "none";
      showToast("Couldn't locate this element on the current page.");
    }
  }

  // ---- mutations ----
  async function postComment(extra) {
    var payload = { artifact_key: artifactKey };
    for (var k in extra) payload[k] = extra[k];
    var r = await fetch("/_au/comments", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (!r.ok) {
      showToast("Could not send feedback.");
      return false;
    }
    await load();
    return true;
  }
  async function setResolved(c, resolved) {
    var r = await fetch("/_au/comments", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        artifact_key: artifactKey,
        id: c.id,
        resolved: resolved,
      }),
    });
    if (!r.ok) {
      showToast("Could not update feedback.");
      return;
    }
    load();
  }
  function toggleReply(id) {
    Array.prototype.forEach.call(
      panel.querySelectorAll(".au-replybox"),
      function (box) {
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
      },
    );
  }
  function parse(s) {
    try {
      return s ? JSON.parse(s) : null;
    } catch (e) {
      return null;
    }
  }
  function setActiveItem(id) {
    Array.prototype.forEach.call(
      panel.querySelectorAll(".au-item"),
      function (it) {
        it.classList.toggle("is-active", it.dataset.auId === String(id));
      },
    );
  }

  // ---- toast ----
  var toastEl = null,
    toastTimer = null;
  function showToast(msg) {
    if (!toastEl) {
      toastEl = el("div", "au-toast", "");
      toastEl.dataset.auWidget = "1";
      document.documentElement.appendChild(toastEl);
    }
    toastEl.textContent = msg;
    toastEl.classList.add("is-on");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () {
      toastEl.classList.remove("is-on");
    }, 3200);
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
    target = targetFrom(e.target);
    active = target;
    endSelect();
    renderTarget();
  }
  function onKey(e) {
    if (e.key === "Escape" && selecting) {
      endSelect();
    }
  }
  function startSelect() {
    if (selecting) return;
    selecting = true;
    openComposer(true);
    document.documentElement.classList.add("au-selecting");
    banner.classList.add("is-on");
    document.addEventListener("mouseover", over, true);
    document.addEventListener("click", pick, true);
    document.addEventListener("keydown", onKey, true);
  }
  function endSelect() {
    selecting = false;
    document.documentElement.classList.remove("au-selecting");
    banner.classList.remove("is-on");
    hover.style.display = "none";
    hoverTip.style.display = "none";
    document.removeEventListener("mouseover", over, true);
    document.removeEventListener("click", pick, true);
    document.removeEventListener("keydown", onKey, true);
  }

  // ---- open / close (close == minimize; launcher is never removed) ----
  function open() {
    panel.classList.add("is-open");
    if (!allComments.length) showSkeleton();
    load();
    update();
  }
  function close() {
    panel.classList.remove("is-open");
    endSelect();
    mark.style.display = "none";
  }

  // ---- wire up ----
  btn.onclick = function () {
    if (panel.classList.contains("is-open")) close();
    else open();
  };
  panel.querySelector("[data-min]").onclick = close;
  panel.querySelector("[data-new]").onclick = function () {
    openComposer(true);
  };
  panel.querySelector("[data-cancel-new]").onclick = function () {
    openComposer(false);
    target = null;
    active = null;
    renderTarget();
  };
  panel.querySelector("[data-clear]").onclick = function () {
    target = null;
    active = null;
    renderTarget();
  };
  panel.querySelector("[data-select]").onclick = startSelect;
  banner.querySelector("[data-cancel-select]").onclick = endSelect;
  panel.querySelector("[data-hide-resolved]").onchange = function (e) {
    hideResolved = !!e.target.checked;
    renderList(allComments);
  };
  Array.prototype.forEach.call(
    panel.querySelectorAll("[data-scope]"),
    function (b) {
      b.onclick = function () {
        scope = b.getAttribute("data-scope");
        Array.prototype.forEach.call(
          panel.querySelectorAll("[data-scope]"),
          function (x) {
            x.classList.toggle("is-on", x === b);
          },
        );
        renderList(allComments);
      };
    },
  );
  panel.querySelector("[data-send]").onclick = function () {
    var t = panel.querySelector("[data-body]"),
      body = t.value.trim(),
      sendBtn = panel.querySelector("[data-send]");
    if (!body) return;
    withBusy(sendBtn, "Sending…", async function () {
      if (await postComment({ body: body, target: target })) {
        t.value = "";
        target = null;
        active = null;
        renderTarget();
        openComposer(false);
      }
    });
  };

  addEventListener("scroll", update, true);
  addEventListener("resize", update);

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

  document.documentElement.appendChild(css);
  document.documentElement.appendChild(mark);
  document.documentElement.appendChild(hover);
  document.documentElement.appendChild(hoverTip);
  document.documentElement.appendChild(banner);
  document.documentElement.appendChild(panel);
  document.documentElement.appendChild(btn);
  renderTarget();
  // prime the badge even while the panel is closed.
  load();
  handleDeepLink();

  function STYLES() {
    return [
      '[data-au-widget]{font:13px ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;color:#17201d;letter-spacing:0;box-sizing:border-box}',
      "[data-au-widget] *{box-sizing:border-box}",
      "[data-au-widget] button{font:inherit}",
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
      ".au-send{border:0;background:#0f6b6f;color:#fff;border-radius:6px;padding:9px 13px;font-weight:800;cursor:pointer}",
      ".au-muted{color:#81908a}",
      ".au-mark,.au-hover{position:fixed;display:none;pointer-events:none;z-index:2147483646;border:2px solid #f3a712;border-radius:6px;box-shadow:0 0 0 9999px rgba(18,56,59,.04)}",
      ".au-hover{border:2px solid #0f6b6f;background:rgba(15,107,111,.12);box-shadow:0 0 0 9999px rgba(18,56,59,.16);transition:top .04s linear,left .04s linear,width .04s linear,height .04s linear}",
      ".au-hover-tip{position:fixed;display:none;z-index:2147483647;pointer-events:none;background:#0f6b6f;color:#fff;font-weight:800;font-size:11px;line-height:1;padding:5px 7px;border-radius:5px;box-shadow:0 6px 16px rgba(0,0,0,.25);max-width:280px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
      "[data-au-widget] button:focus-visible,[data-au-widget] input:focus-visible{outline:2px solid #2a7d82;outline-offset:1px}",
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
      "html.au-selecting,html.au-selecting *{cursor:crosshair !important}",
      ".au-banner{position:fixed;left:24px;top:16px;z-index:2147483647;display:none;align-items:center;gap:12px;background:#12383b;color:#fff;border-radius:999px;padding:9px 9px 9px 16px;box-shadow:0 12px 30px rgba(0,0,0,.28);max-width:min(420px,calc(100vw - 48px))}",
      ".au-banner.is-on{display:flex}",
      ".au-banner-text{font-weight:700}",
      ".au-banner-cancel{border:0;background:rgba(255,255,255,.16);color:#fff;border-radius:999px;padding:6px 12px;font-weight:800;cursor:pointer}",
      ".au-toast{position:fixed;left:50%;bottom:74px;transform:translateX(-50%) translateY(8px);z-index:2147483647;background:#1b2420;color:#fff;border-radius:8px;padding:10px 14px;font-weight:700;box-shadow:0 12px 30px rgba(0,0,0,.3);opacity:0;pointer-events:none;transition:opacity .18s,transform .18s}",
      ".au-toast.is-on{opacity:1;transform:translateX(-50%) translateY(0)}",
    ].join("");
  }
})();
