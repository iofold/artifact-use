import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

// The widget is a classic script (the harness injects its raw source), so the
// target-context helpers live inside it between markers and are evaluated
// here against a minimal DOM stand-in.
async function loadHelpers(): Promise<{
  contextFor: (
    e: FakeEl,
    doc: FakeDoc,
    win: unknown,
  ) => Record<string, unknown>;
  describeTarget: (t: Record<string, unknown> | null) => string;
}> {
  const source = await readFile("apps/worker/src/widget/feedback.js", "utf8");
  const start = source.indexOf("// [au-target-context:start]");
  const end = source.indexOf("// [au-target-context:end]");
  assert.ok(start > 0 && end > start, "target-context block is marked");
  const block = source.slice(start, end);
  return new Function(`${block}\nreturn { contextFor, describeTarget };`)();
}

class FakeEl {
  localName: string;
  attrs: Record<string, string>;
  children: FakeEl[];
  parent: FakeEl | null = null;
  ownText: string;
  currentSrc = "";
  constructor(
    tag: string,
    attrs: Record<string, string> = {},
    children: FakeEl[] = [],
    text = "",
  ) {
    this.localName = tag;
    this.attrs = attrs;
    this.children = children;
    this.ownText = text;
    for (const c of children) c.parent = this;
  }
  getAttribute(name: string): string | null {
    return name in this.attrs ? this.attrs[name]! : null;
  }
  get textContent(): string {
    return this.ownText + this.children.map((c) => c.textContent).join("");
  }
  get previousElementSibling(): FakeEl | null {
    const sibs = this.parent?.children || [];
    const i = sibs.indexOf(this);
    return i > 0 ? sibs[i - 1]! : null;
  }
  matches(selector: string): boolean {
    return selector.split(",").some((part) => {
      const s = part.trim();
      if (s.startsWith("[")) return s.slice(1, -1) in this.attrs;
      return s === this.localName;
    });
  }
  closest(selector: string): FakeEl | null {
    for (let n: FakeEl | null = this; n; n = n.parent)
      if (n.matches(selector)) return n;
    return null;
  }
  descendants(): FakeEl[] {
    const out: FakeEl[] = [];
    for (const c of this.children) out.push(c, ...c.descendants());
    return out;
  }
  querySelector(selector: string): FakeEl | null {
    return this.descendants().find((d) => d.matches(selector)) || null;
  }
  querySelectorAll(selector: string): FakeEl[] {
    return this.descendants().filter((d) => d.matches(selector));
  }
  root(): FakeEl {
    let n: FakeEl = this;
    while (n.parent) n = n.parent;
    return n;
  }
  compareDocumentPosition(other: FakeEl): number {
    const order = [this.root(), ...this.root().descendants()];
    const a = order.indexOf(this);
    const b = order.indexOf(other);
    let mask = b > a ? 4 : 2;
    for (let n = other.parent; n; n = n.parent) if (n === this) mask |= 16;
    return mask;
  }
}

class FakeDoc {
  constructor(
    public body: FakeEl,
    public title = "",
  ) {}
  querySelectorAll(selector: string): FakeEl[] {
    return this.body.querySelectorAll(selector);
  }
}

const h = (tag: string, text: string, attrs = {}) =>
  new FakeEl(tag, attrs, [], text);
const win = { innerWidth: 1280, innerHeight: 720, devicePixelRatio: 2 };

test("an image-grid cell reads as the image it holds under its heading", async () => {
  const { contextFor, describeTarget } = await loadHelpers();
  const pngCell = new FakeEl("div", {}, [
    new FakeEl("img", { src: "/assets/hero-loop-v2.png?w=800#top", alt: "" }),
  ]);
  const source = new FakeEl("source", { src: "/media/hero%20loop-v2.mp4" });
  const mp4Cell = new FakeEl("div", {}, [new FakeEl("video", {}, [source])]);
  const body = new FakeEl("body", {}, [
    h("h1", "Landing options"),
    h("h2", "Option A"),
    new FakeEl("p", {}, [], "text"),
    h("h2", "Option B"),
    new FakeEl("div", { class: "grid" }, [pngCell, mp4Cell]),
    h("h2", "Option C"),
  ]);
  const doc = new FakeDoc(body, "  Landing   review ");
  const png = contextFor(pngCell, doc, win);
  assert.deepEqual(png, {
    tag: "div",
    src: "hero-loop-v2.png",
    heading: "Option B",
    index: 1,
    page_title: "Landing review",
    viewport: { w: 1280, h: 720, dpr: 2 },
  });
  assert.equal(
    describeTarget({ label: "div", ...png }),
    "image: hero-loop-v2.png under ‘Option B’",
  );
  const mp4 = contextFor(mp4Cell, doc, win);
  assert.equal(mp4.src, "hero loop-v2.mp4");
  assert.equal(mp4.index, 2);
  assert.equal(
    describeTarget({ label: "div", ...mp4 }),
    "video: hero loop-v2.mp4 under ‘Option B’",
  );
});

test("captions come from alt, aria-label, title, figcaption, svg title or a labelled ancestor, in that order", async () => {
  const { contextFor, describeTarget } = await loadHelpers();
  const img = new FakeEl("img", { src: "/a/b/shot.jpg", alt: "Hero shot" });
  const aria = new FakeEl("div", { "aria-label": "Revenue chart" });
  const titled = new FakeEl("canvas", { title: "Burn-down" });
  const line = new FakeEl("line", {});
  const svg = new FakeEl("svg", {}, [h("title", "Revenue by month"), line]);
  const capLine = new FakeEl("path", {});
  const figure = new FakeEl("figure", {}, [
    new FakeEl("svg", {}, [capLine]),
    h("figcaption", "Churn by cohort"),
  ]);
  const inner = new FakeEl("span", {});
  const labelledWrap = new FakeEl(
    "section",
    { "aria-label": "Pricing table" },
    [inner],
  );
  const body = new FakeEl("body", {}, [
    h("h2", "Results"),
    img,
    aria,
    titled,
    svg,
    figure,
    labelledWrap,
  ]);
  const doc = new FakeDoc(body, "Doc");
  assert.equal(contextFor(img, doc, win).caption, "Hero shot");
  assert.equal(
    describeTarget({ label: "img", ...contextFor(img, doc, win) }),
    "image: Hero shot under ‘Results’",
  );
  assert.equal(contextFor(aria, doc, win).caption, "Revenue chart");
  assert.equal(contextFor(titled, doc, win).caption, "Burn-down");
  assert.equal(contextFor(line, doc, win).caption, "Revenue by month");
  assert.equal(
    describeTarget({ label: "line", ...contextFor(line, doc, win) }),
    "chart: Revenue by month under ‘Results’",
  );
  assert.equal(contextFor(capLine, doc, win).caption, "Churn by cohort");
  assert.equal(contextFor(inner, doc, win).caption, "Pricing table");
  // data: and blob: sources carry nothing worth quoting.
  const inline = new FakeEl("img", { src: "data:image/png;base64,AAAA" });
  body.children.push(inline);
  inline.parent = body;
  assert.equal(contextFor(inline, doc, win).src, undefined);
});

test("the heading is the element's own h1-h3 or the last one before it; none before the first heading", async () => {
  const { contextFor } = await loadHelpers();
  const early = new FakeEl("p", {});
  const inHeading = new FakeEl("em", {});
  const heading = new FakeEl("h3", {}, [h("span", "Step "), inHeading], "");
  inHeading.ownText = "two";
  const after = new FakeEl("p", {});
  const body = new FakeEl("body", {}, [
    early,
    h("h1", "Guide"),
    h("h2", "Setup"),
    heading,
    after,
    h("h2", "Later"),
  ]);
  const doc = new FakeDoc(body);
  assert.equal(contextFor(early, doc, null).heading, undefined);
  assert.equal(contextFor(inHeading, doc, null).heading, "Step two");
  assert.equal(contextFor(after, doc, null).heading, "Step two");
  assert.equal(contextFor(after, doc, null).viewport, undefined);
});

test("labels that already say something stay as they are; bare tags gain their heading and index", async () => {
  const { describeTarget } = await loadHelpers();
  // v2 targets (no context) render exactly as before.
  assert.equal(describeTarget({ label: "Total revenue" }), "Total revenue");
  assert.equal(describeTarget({ label: "div" }), "div");
  assert.equal(describeTarget(null), "");
  assert.equal(
    describeTarget({
      label: "Save changes",
      tag: "button",
      heading: "Settings",
    }),
    "Save changes",
  );
  assert.equal(
    describeTarget({ label: "div", tag: "div", heading: "Pricing" }),
    "div under ‘Pricing’",
  );
  assert.equal(
    describeTarget({ label: "img", tag: "img", index: 3, heading: "Gallery" }),
    "image #3 under ‘Gallery’",
  );
  assert.equal(
    describeTarget({ label: "Q3 total", tag: "td", caption: "Revenue table" }),
    "Revenue table",
  );
  assert.equal(
    describeTarget({ label: "Pricing", tag: "h2", heading: "Pricing" }),
    "Pricing",
  );
});

test("the widget sends the context with every new anchor", async () => {
  const source = await readFile("apps/worker/src/widget/feedback.js", "utf8");
  assert.match(source, /var ctx = contextFor\(e, document, window\)/);
  assert.match(source, /describeTarget\(t\)/, "list rows use the description");
  assert.match(source, /sent_to_agent: !!on/, "Send to agent patches the flag");
  assert.match(source, /"via agent"/, "agent-written comments are labelled");
  assert.match(source, /Sent to agent · picked up/);
  assert.match(source, /checked this page/, "presence line");
  assert.match(source, /&wait=25/, "the open panel long-polls");
});
