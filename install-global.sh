#!/usr/bin/env bash
set -euo pipefail

# macOS global installer for Token & Speed (pending macOS verification)
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PLUGIN_SRC="$SCRIPT_DIR/.agents/plugins/token-speed"
GLOBAL_DIR="${HOME}/.gemini/config/plugins/token-speed"

echo "Installing token-speed plugin (with token_hud sidecar) to: $GLOBAL_DIR"
mkdir -p "$GLOBAL_DIR"
cp -R "$PLUGIN_SRC"/. "$GLOBAL_DIR"/

echo ""
echo "Done! Next steps:"
echo "1. Open Customizations / Plugins in Antigravity and make sure 'token-speed' is enabled."
echo "2. Click the '+' menu in the right Auxiliary Pane and select 'Token & Speed HUD'."
