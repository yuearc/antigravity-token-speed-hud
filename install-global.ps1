# Token & Speed Installer for Local Antigravity
$ErrorActionPreference = "Stop"

$scriptRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$pluginSrc = Join-Path $scriptRoot ".agents\plugins\token-speed"
$globalPluginsDir = Join-Path $env:USERPROFILE ".gemini\config\plugins\token-speed"

Write-Host "Installing token-speed plugin (with token_hud sidecar) to: $globalPluginsDir"
New-Item -ItemType Directory -Force -Path $globalPluginsDir | Out-Null
Copy-Item -Path (Join-Path $pluginSrc "*") -Destination $globalPluginsDir -Recurse -Force

Write-Host ""
Write-Host "Done! Next steps:" -ForegroundColor Green
Write-Host "1. Open Customizations / Plugins in Antigravity and make sure 'token-speed' is enabled."
Write-Host "2. Click the '+' menu in the right Auxiliary Pane and select 'Token & Speed HUD'."
