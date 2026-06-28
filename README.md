# Treasure Factory

A Myst-like click-through game built from photographs of the handmade "Treasure
Factory / DA SPOT" miniature, plus a browser-based tool for authoring the
clickable navigation.

## Workflow

| Step | Command |
|---|---|
| Optimize photos -> WebP + manifest | `./build-assets.sh` |
| Play / author (local) | `./scripts/serve.sh`, then open http://localhost:8080 |
| Author hotspots (Chrome/Edge only) | open http://localhost:8080/editor.html |
| Package for itch.io | `./scripts/package-web.sh` |
| Desktop build (mac) | see "Desktop / Steam" below |

The originals live in `Gold and green/`, `Snax room/`, `Yellow Room/` and are
never modified. The build writes only into `app/images/`.

## How it works

- `app/scene.json` is the scene graph: nodes (one photo each) + hotspots
  (clickable regions with normalized 0..1 coordinates) + actions (v1: `goto`).
- `app/engine.js` plays it. `app/editor.js` edits it (writes `scene.json` via
  the browser File System Access API; Chrome or Edge only).
- `app/geometry.js` holds the coordinate math both share, so a hotspot drawn in
  the editor is clickable at the exact same spot in the player, at any size.

## Desktop / Steam

`src-tauri/` is already configured: the frontend is the static `app/` folder,
there is no Node build step, and the icon is generated from the exterior photo.

```
cargo install tauri-cli --version "^2.0.0" --locked   # one-time
cargo tauri dev      # run the app in a desktop window
cargo tauri build    # produce .app + .dmg in src-tauri/target/release/bundle/
```

Windows and Linux binaries come from CI: push a tag like `v0.1.0` to run
[.github/workflows/release.yml](.github/workflows/release.yml) (a
`tauri-apps/tauri-action` matrix). Cross-compiling them from a Mac is not reliable,
which is why each OS builds on its own runner.
