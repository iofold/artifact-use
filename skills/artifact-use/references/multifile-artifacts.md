# Multi-file Artifacts

Use a multi-file artifact when a single HTML file would become brittle, oversized, or hostile to future revision.

## When To Split

- The artifact has many images, PDFs, audio/video files, fonts, or large data files.
- A data-driven UI needs separate `data/*.js` or `data/*.json` files for maintainability.
- A library should be vendored locally instead of loaded from a CDN.
- Binary files would otherwise be base64-embedded into HTML.
- The artifact is a static site or folder that already has multiple files.
- The single-file version would be too large for comfortable review or inline MCP transport.

Prefer one self-contained HTML file for small tools. Split only when the artifact becomes clearer or more reliable.

## Folder Shape

```text
artifact-dir/
  index.html
  assets/
    screenshot-1.jpg
    diagram.svg
  data/
    app-data.js
  lib/
    marked.min.js
```

Rules:

- Keep `index.html` as the entrypoint unless the user has a clear reason for another path.
- Use relative paths such as `./assets/example.jpg` and `./data/app-data.js`.
- Do not use leading slash paths; they will point at the Artifact Use host root, not the artifact folder.
- Do not use reserved paths or segments: `_au`, `_iof`, leading `_`, `cdn-cgi`, `.`, `..`, empty segments, or control characters.
- Keep filenames URL-safe and stable. Prefer lower-case hyphen-case for authored assets.
- Add alt text for meaningful images. Mark decorative images with empty alt text.

## Data Modules

For local data that should load without a build step, prefer one of these:

```html
<script src="./data/teardown.js"></script>
```

```js
window.TEARDOWN_DATA = { vendors: [] };
```

Or use modules:

```html
<script type="module">
  import { DATA } from "./data/app-data.js";
  render(DATA);
</script>
```

If using `fetch("./data/data.json")`, verify through a local HTTP server. Some browser file URLs block or behave differently for fetches.

## Assets And Dependencies

- Optimize large images before publishing; avoid shipping unused screenshots.
- Keep videos embedded from a stable provider unless the file is small enough and explicitly intended to be hosted.
- Vendor libraries into `lib/` when CDN blocking would break the artifact or the exact version matters.
- Use pinned CDN URLs only when the dependency is small, stable, and clearly lowers implementation risk.
- Show a readable fallback when data, image, or library loading fails.

## Publishing Path

- Use `artifact_upload_session` when the agent can read the folder and run shell/curl.
- Use local stdio MCP `artifact_publish` with `dir`, or CLI `publish-folder`, when available.
- Use remote MCP `artifact_publish.files` only for small inline multi-file payloads. It consumes MCP request size and may put file bytes into model/tool context.
- Run a dry-run for large or generated folders when using the CLI.

## Multi-file QA

- Serve the folder locally before publishing:

```bash
python3 -m http.server 8765 -d artifact-dir
```

- Open `http://127.0.0.1:8765/` and verify main routes, assets, images, data files, and console behavior.
- After publishing, open the hosted URL and verify at least one asset/data request succeeds from the Artifact Use URL.
