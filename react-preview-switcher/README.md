# React Preview Switcher

Wrapper CLI that orchestrates `react-cloner` and `react-tree`, launches the cloned Expo project, and lets you hot-swap the preview root from a Blessed terminal UI.

## Features

- Builds sibling tools on demand (tree + cloner)
- Generates visual clone with mirror-all, rewrites `PreviewRoot` import in the cloned base file
- Installs dependencies automatically in the cloned output
- Starts Expo Web (`npx expo start --web --port <port>`) inside the cloned folder and streams logs
- Runs `react-tree` on the original base file, renders the component hierarchy in a scrollable list
- Press ↑/↓ or `j/k` to navigate, `Enter`/`o` to switch preview root, `r` to rebuild, `q` to quit
- `--watch` mode rebuilds on source changes (full clone + install + Expo restart)
- Diagnostics helpers (`--diagnostic-seconds`, `--auto-open`) for headless environments

## Installation

```
cd ReactMaker/react-preview-switcher
npm install
npm run build
```

## Usage

```
node dist/cli.js \
  --project-root /path/to/project \
  --base-file app/index.tsx \
  --target-component app/components/MainPage.tsx \
  --out /tmp/preview-app \
  --framework expo-router \
  --ignore app/components/ui,app/components/layout \
  --watch
```

This single command:
1. Ensures sibling CLIs are built
2. Runs the cloner with mirror-all
3. Installs dependencies in `--out`
4. Starts Expo web inside `--out`
5. Runs `react-tree` and opens the interactive switcher UI

## Key Flags

| Flag | Description |
| --- | --- |
| `--project-root` | Absolute path to original app root |
| `--base-file` | Base file (relative to project root) passed to both cloner + tree |
| `--target-component` | Default component mirrored during clone |
| `--ignore` | Comma-separated ignore list (project-relative, auto-normalized for tree) |
| `--out` | Destination folder for the visual clone |
| `--framework` | Currently only `expo-router` |
| `--watch` | Watch original project (top-level directory inferred from base file) and fully rebuild |
| `--port` | Preferred Expo web port (auto-detects free port if taken) |
| `--package-manager` | `npm`, `yarn`, or `pnpm` for dependency install |
| `--diagnostic-seconds` | Auto dump log buffer and exit after N seconds (useful for CI) |
| `--auto-open` | Comma-separated component names to auto-select sequentially (e.g. `JoinedGames,MyGames`) |
| `--no-ui` | Runs console-only mode (no Blessed UI) while still cloning/installing/running Expo |

## Diagnostics Workflow

Capture logs even when terminal resets:
```
node dist/cli.js --no-ui \
  --diagnostic-seconds 20 \
  --auto-open JoinedGames \
  ...etc...
```
The tool keeps an internal rolling log buffer and dumps it on timeout before exiting. Perfect for reproducing crashes like pressing `o`.

## License

[MIT](./LICENSE)
