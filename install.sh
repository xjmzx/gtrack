#!/bin/bash
# Build gtrack and install it to /Applications, then relaunch. macOS only.
#
#   ./install.sh               # build (release) + quit + install + relaunch
#   ./install.sh --skip-build  # reinstall the last build without rebuilding
#
# Or via npm:  npm run install:app
#
# Why this exists rather than `make install`: that target is Linux's — it drops a
# bare binary in ~/.local/bin next to a .desktop entry. On macOS that gives you
# no Info.plist, no icon, no bundle identifier and nothing Finder or the Dock
# will treat as an app. macOS wants the .app bundle, which means a full
# `tauri build` rather than the `--no-bundle` one `make build` does.
set -euo pipefail
cd "$(dirname "$0")"

if [[ "$(uname)" != "Darwin" ]]; then
  echo "install.sh is macOS-only (installs a .app to /Applications)." >&2
  echo "On Linux use: make install" >&2
  exit 1
fi

APP_NAME="gtrack.app"
BUILT="src-tauri/target/release/bundle/macos/$APP_NAME"

if [[ "${1:-}" != "--skip-build" ]]; then
  # `npm run tauri` resolves the CLI out of node_modules/.bin, so on a fresh
  # clone this fails with "tauri: command not found" — which reads like a
  # missing global tool rather than "you have not installed deps yet".
  # Checking for the CLI itself, not just the directory, also catches a
  # half-finished install.
  if [[ ! -x node_modules/.bin/tauri ]]; then
    echo "--- Installing npm dependencies (first build here) ---"
    npm install
  fi
  echo "--- Building gtrack (release) ---"
  npm run tauri build
fi

if [[ ! -d "$BUILT" ]]; then
  echo "No built app at $BUILT — run without --skip-build first." >&2
  exit 1
fi

echo "--- Quitting running gtrack (if any) ---"
osascript -e 'quit app "gtrack"' 2>/dev/null || pkill -x gtrack 2>/dev/null || true
sleep 1

echo "--- Installing to /Applications ---"
rm -rf "/Applications/$APP_NAME"
cp -R "$BUILT" "/Applications/$APP_NAME"

echo "--- Relaunching ---"
open "/Applications/$APP_NAME"

VER=$(/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' \
  "/Applications/$APP_NAME/Contents/Info.plist" 2>/dev/null || echo "?")
echo "Installed + relaunched: /Applications/$APP_NAME (v$VER)"

echo
echo "Note: an app launched from Finder does not inherit your shell PATH — it"
echo "gets launchd's, which is /usr/bin:/bin:/usr/sbin:/sbin and nothing more."
echo "gtrack shells out to git, so it appends the usual user bin directories to"
echo "the PATH it hands each git process. That is what reaches the remote"
echo "helpers: a nostr:// remote — or any scheme git does not speak natively —"
echo "needs git-remote-<scheme> on PATH, and the /usr/bin/git shim does not"
echo "carry one. Without it such a remote fetches fine in every terminal on the"
echo "machine and reports 'unreachable' in the window."
echo
echo "Appended, never prepended, so git itself is still that shim — the Xcode"
echo "command-line tools git, not a newer one you may have via Homebrew."
