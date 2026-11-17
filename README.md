# Antigravity Telemetry HUD (`telemetry-hud`)

**English** | [简体中文](README.zh-CN.md)

A lightweight, zero-external-dependency real-time performance and token telemetry sidecar plugin for **Google Antigravity**. Built around high-density observability and Linear / Langfuse trace card conventions, it surfaces live generation throughput (`tok/s`), Prefix Cache hit rate, context pressure, and per-turn chained tool-call breakdowns.

---

## Key Features

- **Live Throughput & Cache Telemetry**
  - **Per-Step Output Speed (`tok/s`)**: Reads `output_tokens` and step duration from local `transcript.jsonl` `PLANNER_RESPONSE` entries to compute latest-step speed, session average, and peak throughput.
  - **Prefix Cache Hit Rate**: Calculates `cache_read_tokens / (input_tokens + cache_read_tokens)` along with estimated cache cost savings.
  - **Fixed Bottom HUD Status Bar**: Compact single-line status bar (`● LIVE | In | Cache | Out | ⚡ tok/s | Saved %`).
- **Context Window Pressure & Quick Compaction**
  - Displays current prompt footprint against selectable **`1M`** or **`200K`** context limits.
  - Includes a **Compact Context** action button that copies `/compact` to your clipboard with an inline toast so you can paste and trigger native compaction immediately.
- **Interactive Trend Chart & Chained Trace Views**
  - **Clickable Trend Chart**: High-DPI Canvas visualization plotting step `tok/s` bars and cache hit % line; hover for tooltips and **click any blue bar to jump straight to, expand, and highlight its corresponding Turn and Step card**.
  - **Dual Inspection Views**: Switch seamlessly between turn-grouped **Chained Trace View (`Turns`)** and flat tabular **Step Breakdown (`Steps`)**.
  - **Semantic Status Cards**: Step cards use 3px left status rails and soft category pills to distinguish intermediate tool steps, final replies, wait-for-input steps, errors, and tool categories (read/search, edit/write, command execution, web lookup).
- **Instant Cancellation Detection & Strict Single-Conversation Lock**
  - Strictly locks telemetry to the active Antigravity conversation (`conversationId`), never mixing transcripts from other sessions.
  - Combines a native `Stop` hook ([hooks.json](.agents/plugins/telemetry-hud/hooks.json)) with a `60s` silence staleness fallback so canceling a response (`USER_CANCELED`) or interrupting a tool chain immediately transitions the HUD to `CANCELLED` / `IDLE` instead of hanging on waiting.
- **100% Local Read-Only Privacy**
  - Reads only local Antigravity `transcript.jsonl` logs and plugin state under `plugin_data/telemetry-hud/<conv>.json`—**zero outbound network calls** and **zero external CDN scripts or fonts**.

---

## Repository Structure

```text
antigravity-telemetry-hud/
├── .agents/
│   └── plugins/
│       └── telemetry-hud/
│           ├── plugin.json                # Plugin manifest
│           ├── hooks.json                 # Antigravity Stop hook config (instant cancel detection)
│           ├── assets/
│           │   └── logo.svg               # Plugin SVG icon
│           ├── scripts/
│           │   └── stop-state.ps1         # Stop hook state writer (Windows PowerShell)
│           └── sidecars/
│               └── token_hud/
│                   ├── package.json
│                   ├── sidecar.json       # Sidecar entrypoint & permissions
│                   ├── main.mjs           # Local read-only HTTP/API backend (Node ESM + sidecar_sdk)
│                   ├── index.html         # HUD document shell
│                   ├── styles.css         # Host-theme-adaptive CSS variables styling
│                   └── app.js             # Keyed DOM reconciliation, numeric tweening & Canvas chart
├── install-global.ps1                     # Windows global installer
├── install-global.sh                      # macOS / Linux global installer
├── .gitignore
├── .gitattributes
├── LICENSE                                # MIT License
├── README.md                              # English documentation
└── README.zh-CN.md                        # Simplified Chinese documentation
```

---

## Installation & Usage

### Prerequisites
- **Antigravity** installed (provides the built-in `sidecar_sdk` runtime).
- Out-of-the-box instant `Stop` hook tracking uses PowerShell on Windows; macOS / Linux installations fall back cleanly to the built-in `60s` inactivity detection and historical cancellation labeling.

### Option 1: Install Globally (Recommended, Available Across All Projects)

**Windows (PowerShell):**
```powershell
git clone https://github.com/yuearc/antigravity-telemetry-hud.git
cd antigravity-telemetry-hud
.\install-global.ps1
```

**macOS / Linux:**
```bash
git clone https://github.com/yuearc/antigravity-telemetry-hud.git
cd antigravity-telemetry-hud
chmod +x install-global.sh
./install-global.sh
```

The installer copies the plugin into `~/.gemini/config/plugins/telemetry-hud/`. Next:
1. Open **Customizations / Plugins** in Antigravity and ensure **Antigravity Telemetry HUD (`telemetry-hud`)** is enabled.
2. Open the **`+`** menu in the right-hand Auxiliary Pane and select **Token & Speed HUD**.

### Option 2: Load as a Workspace Plugin
1. Open the cloned `antigravity-telemetry-hud` directory directly as a Workspace in Antigravity.
2. Enable **`telemetry-hud`** in the Plugins list.
3. Open **Token & Speed HUD** from the Auxiliary Pane **`+`** menu.

---

## Privacy & Security

- The sidecar backend reads only the local `transcript.jsonl` belonging to the active `conversationId`; no prompts, responses, or metrics ever leave your machine.
- The `Stop` hook stores only a timestamp and termination reason enum under local `plugin_data/telemetry-hud/`, with no chat content persistence.

## License

Released under the [MIT License](LICENSE).
