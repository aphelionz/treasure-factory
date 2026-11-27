# CLAUDE.md

Treasure Factory is a Myst-like click-through game built from photos of a
handmade miniature, plus a browser editor for its hotspots. See README.md for
how it works. Mark reviews and merges most PRs from a phone, so a PR must be
easy to judge from its description, the CI checks, and the screenshot comment.

## Hard rules

- **No dependencies.** `app/` is plain ES modules served as static files. No
  npm packages, bundlers, frameworks, or CDN scripts in the game or editor. No
  `package.json` in the repo. Dev tools (Playwright in CI) are installed per run
  with `--no-save`.
- **Never commit the original photos** (the room folders at the repo root, ~1 GB,
  the only copies). Only `build-assets.sh` output in `app/images/` is committed.
- **Portrait only, never crop-to-fill.** Hotspot coordinates are normalized 0..1
  fractions of the photo. Changing how the photo is fitted on screen moves every
  hotspot. All coordinate math goes through `app/geometry.js`, shared by the
  player and the editor.
- **scene.json is content, not code.** Mark authors it in the editor, which
  commits straight to `main`. Don't rewrite or reformat it in a code PR unless
  the task is about it. If you change its shape, bump `schemaVersion`, update
  `app/validate.js`, and keep the engine able to load the current file.
- **The hosted editor commits to `main` with a fine-grained token kept in the
  browser.** Never log, commit, or send that token anywhere except api.github.com.
- `.github/workflows/pages.yml` deploys `app/` to GitHub Pages on every push to
  `main`. Anything merged is live within minutes.

## Before opening a PR

Run both checks. CI runs them too and a PR with red checks should not merge.

```
node scripts/check-scene.mjs     # scene.json + images integrity (no install needed)
node scripts/smoke.mjs           # needs Playwright: npm i --no-save playwright && npx playwright install chromium
```

`smoke.mjs` plays a few rooms on a phone-sized screen, opens the editor, fails
on any console error or 404, and writes screenshots to `dist/smoke/`. Look at
them. CI posts the same screenshots as a comment on the PR.

If you add a field to scene.json or a new action type, add a check for it in
`app/validate.js`. The editor runs the same validator before every save.

## PR description

Lead with what changes for the player or for Mark in the editor, in plain
words. Say what you tested and on which screen size. Call out anything that
touches `scene.json`, `geometry.js`, the deploy workflow, or the editor's save
path, since those can break the live game.
