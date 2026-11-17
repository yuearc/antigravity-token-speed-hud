$ErrorActionPreference = "SilentlyContinue"
try {
  $raw = [Console]::In.ReadToEnd()
  if ($raw -and $raw.Trim()) {
    $data = $raw | ConvertFrom-Json
    $conv = [string]($data.conversationId)
    if ($conv) { $conv = $conv.Trim() }

    if ($conv -and ($conv -match '^[0-9a-fA-F-]{8,}$')) {
      $tp = [string]($data.transcriptPath)
      $dir = $env:PLUGIN_DATA
      if (-not $dir -and $tp) {
        $d = Split-Path -Parent $tp
        while ($d -and ($d -ne (Split-Path -Parent $d))) {
          if ((Split-Path -Leaf $d) -eq 'brain') {
            $dir = Join-Path (Join-Path (Split-Path -Parent $d) 'plugin_data') 'telemetry-hud'
            break
          }
          $d = Split-Path -Parent $d
        }
      }
      if (-not $dir) {
        $dir = Join-Path (Join-Path (Join-Path $env:USERPROFILE '.gemini') 'antigravity') 'plugin_data\telemetry-hud'
      }

      [System.IO.Directory]::CreateDirectory($dir) | Out-Null

      $mtime = 0
      $size = -1
      if ($tp -and (Test-Path -LiteralPath $tp)) {
        $fi = Get-Item -LiteralPath $tp
        if ($fi) {
          $mtime = ([DateTimeOffset]::new($fi.LastWriteTimeUtc)).ToUnixTimeMilliseconds()
          $size = [int64]$fi.Length
        }
      }

      $reason = [string]($data.terminationReason)
      if ($reason) { $reason = $reason.ToUpperInvariant() } else { $reason = '' }

      $payload = @{
        conversationId = $conv
        terminationReason = $reason
        stoppedAt = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
        transcriptMtime = $mtime
        transcriptSize = $size
      } | ConvertTo-Json -Compress

      $outPath = Join-Path $dir "$conv.json"
      [System.IO.File]::WriteAllText($outPath, $payload, [System.Text.UTF8Encoding]::new($false))
    }
  }
} catch {
  # Never fail Stop hook
}
[Console]::Out.Write("{}`n")
