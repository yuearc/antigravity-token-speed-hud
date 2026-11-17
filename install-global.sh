#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PLUGIN_SRC="$SCRIPT_DIR/.agents/plugins/telemetry-hud"
GLOBAL_DIR="${HOME}/.gemini/config/plugins/telemetry-hud"

echo "Installing telemetry-hud plugin (with token_hud sidecar) to: $GLOBAL_DIR"
mkdir -p "$GLOBAL_DIR"
cp -R "$PLUGIN_SRC"/. "$GLOBAL_DIR"/

echo ""
echo "Done! Next steps:"
echo "1. Open Customizations / Plugins in Antigravity and make sure 'telemetry-hud' is enabled."
echo "2. Click the '+' menu in the right Auxiliary Pane and select 'Token & Speed HUD'."
