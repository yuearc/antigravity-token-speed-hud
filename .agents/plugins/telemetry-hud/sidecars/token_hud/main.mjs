/**
 * Antigravity Telemetry HUD Sidecar Backend.
 *
 * Read-only sidecar that reads local Antigravity conversation transcripts:
 *   <appData>/brain/<conversationId>/.system_generated/logs/transcript.jsonl
 * Groups chained PLANNER_RESPONSE + GENERIC steps under each USER_INPUT turn
 * so every step maps directly to the user utterance that triggered it.
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SidecarApp, Response } from 'sidecar_sdk';

const __dirname = dirname(fileURLToPath(import.meta.url));
const STATIC = {
  '/styles.css': ['styles.css', 'text/css; charset=utf-8'],
  '/app.js': ['app.js', 'application/javascript; charset=utf-8'],
};

const ID_RE = /^[0-9a-f-]{8,}$/i;
const WAIT_TOOLS = new Set(['exit_plan_mode', 'ask_question', 'swarm_wait']);
const CANCELLED_STATUSES = new Set(['CANCELLED', 'CANCELED', 'ABORTED', 'STOPPED']);
const ERROR_STATUSES = new Set(['ERROR', 'FAILED']);
const STALE_IDLE_MS = 60_000;

// Preserves measured final-reply durations observed live via file mtime
// before a later USER_INPUT arrives (key: `${conv}:${stepIndex}`).
const finalReplyDurCache = new Map();

function safeReaddir(path) {
  try {
    return readdirSync(path);
  } catch {
    return [];
  }
}

function statOf(path) {
  try {
    const s = statSync(path);
    return { mtime: s.mtimeMs, size: s.size };
  } catch {
    return { mtime: 0, size: -1 };
  }
}

function findAppDataDirs() {
  const dataDir = process.env.ANTIGRAVITY_EXECUTABLE_DATA_DIR;
  if (dataDir) {
    for (let d = dataDir; d !== dirname(d); d = dirname(d)) {
      if (basename(d) !== 'sidecar_data') continue;
      const appData = dirname(d);
      return existsSync(join(appData, 'brain')) ? [appData] : [];
    }
    return [];
  }
  const root = join(homedir(), '.gemini');
  const dirs = safeReaddir(root).sort().map((name) => join(root, name));
  return dirs.filter((c) => existsSync(join(c, 'brain')));
}

const transcriptPath = (appData, conv) =>
  join(appData, 'brain', conv, '.system_generated', 'logs', 'transcript.jsonl');

function locateTranscript(conv) {
  if (!conv || !ID_RE.test(conv)) return null;
  for (const appData of findAppDataDirs()) {
    const path = transcriptPath(appData, conv);
    if (existsSync(path)) return { appData, path };
  }
  return null;
}

function readStopState(conv, appData) {
  if (!conv || !ID_RE.test(conv)) return null;
  const candidates = [];
  if (process.env.PLUGIN_DATA) candidates.push(join(process.env.PLUGIN_DATA, `${conv}.json`));
  if (appData) candidates.push(join(appData, 'plugin_data', 'telemetry-hud', `${conv}.json`));
  for (const dir of findAppDataDirs()) {
    const p = join(dir, 'plugin_data', 'telemetry-hud', `${conv}.json`);
    if (!candidates.includes(p)) candidates.push(p);
  }
  let newest = null;
  for (const file of candidates) {
    try {
      if (!existsSync(file)) continue;
      const obj = JSON.parse(readFileSync(file, 'utf-8'));
      if (obj && Number.isFinite(obj.stoppedAt)) {
        if (!newest || obj.stoppedAt > newest.stoppedAt) newest = obj;
      }
    } catch {
      // Ignore partial or malformed stop state files
    }
  }
  return newest;
}

function evaluateLiveState(conv, appData, st, lastEntryMeta) {
  if (!lastEntryMeta) {
    return { active: false, turnState: 'idle', terminationReason: '' };
  }

  const stopState = readStopState(conv, appData);
  if (stopState) {
    const sizeMatches =
      Number.isFinite(stopState.transcriptSize) &&
      stopState.transcriptSize >= 0 &&
      stopState.transcriptSize === st.size &&
      st.mtime <= (stopState.transcriptMtime || 0) + 250;
    const timeMatches =
      (!Number.isFinite(stopState.transcriptSize) || stopState.transcriptSize < 0) &&
      st.mtime <= stopState.stoppedAt + 100 &&
      lastEntryMeta.createdAtMs <= stopState.stoppedAt + 100;
    if (sizeMatches || timeMatches) {
      const reason = String(stopState.terminationReason || '').toUpperCase();
      if (reason === 'USER_CANCELED') {
        return { active: false, turnState: 'cancelled', terminationReason: reason };
      }
      if (reason === 'ERROR') {
        return { active: false, turnState: 'error', terminationReason: reason };
      }
      return { active: false, turnState: 'idle', terminationReason: reason };
    }
  }

  if (CANCELLED_STATUSES.has(lastEntryMeta.status)) {
    return { active: false, turnState: 'cancelled', terminationReason: lastEntryMeta.status };
  }
  if (ERROR_STATUSES.has(lastEntryMeta.status)) {
    return { active: false, turnState: 'error', terminationReason: lastEntryMeta.status };
  }

  if (lastEntryMeta.type === 'PLANNER_RESPONSE') {
    if (lastEntryMeta.isWaitStep) {
      return { active: false, turnState: 'waiting_user', terminationReason: '' };
    }
    if (!lastEntryMeta.hasToolCalls) {
      return { active: false, turnState: 'idle', terminationReason: '' };
    }
  }

  const potentiallyInFlight =
    lastEntryMeta.type === 'USER_INPUT' ||
    lastEntryMeta.type === 'GENERIC' ||
    (lastEntryMeta.type === 'PLANNER_RESPONSE' && lastEntryMeta.hasToolCalls);

  if (!potentiallyInFlight) {
    return { active: false, turnState: 'idle', terminationReason: '' };
  }

  const lastActivityMs = Math.max(st.mtime || 0, lastEntryMeta.createdAtMs || 0);
  if (lastActivityMs > 0 && Date.now() - lastActivityMs > STALE_IDLE_MS) {
    return { active: false, turnState: 'stale', terminationReason: 'STALE_IDLE' };
  }

  return { active: true, turnState: 'streaming', terminationReason: '' };
}

function cleanUserContent(raw) {
  const src = String(raw || '');
  const reqMatches = [...src.matchAll(/<USER_REQUEST>\s*([\s\S]*?)\s*<\/USER_REQUEST>/g)];
  const body = reqMatches.length
    ? reqMatches[reqMatches.length - 1][1]
    : src
        .replace(/<ADDITIONAL_METADATA>[\s\S]*?<\/ADDITIONAL_METADATA>/g, ' ')
        .replace(/<USER_SETTINGS_CHANGE>[\s\S]*?<\/USER_SETTINGS_CHANGE>/g, ' ')
        .replace(/<SYSTEM_MESSAGE>[\s\S]*?<\/SYSTEM_MESSAGE>/g, ' ')
        .replace(/<\/?[A-Z_]+>/g, ' ');
  return body.replace(/\s+/g, ' ').trim();
}

function extractTitleSnippet(text) {
  const firstLine = String(text || '').split('\n', 1)[0];
  if (!firstLine) return '';
  try {
    const obj = JSON.parse(firstLine);
    const clean = cleanUserContent(obj?.content || '');
    return clean.length > 56 ? `${clean.slice(0, 55)}…` : clean;
  } catch {
    return '';
  }
}

function unquote(v) {
  if (typeof v !== 'string') return v == null ? '' : String(v);
  const s = v.trim();
  if (s.length >= 2 && s.startsWith('"') && s.endsWith('"')) {
    try {
      return String(JSON.parse(s));
    } catch {
      return s.slice(1, -1);
    }
  }
  return s;
}

function oneLine(s, maxLen = 96) {
  const out = String(s || '').replace(/\s+/g, ' ').trim();
  return out.length > maxLen ? `${out.slice(0, maxLen - 1).trimEnd()}…` : out;
}

function describeToolDetail(tc) {
  const name = String(tc?.name || 'tool');
  const args = tc?.args && typeof tc.args === 'object' ? tc.args : {};
  const summary = unquote(args.toolSummary) || unquote(args.toolAction);
  if (summary) return { name, target: oneLine(summary, 72) };
  const filePath = unquote(args.Path || args.AbsolutePath || args.TargetFile);
  if (filePath) return { name, target: basename(filePath) || oneLine(filePath, 60) };
  if (args.CommandLine) return { name, target: oneLine(unquote(args.CommandLine), 72) };
  if (args.query || args.Query) return { name, target: oneLine(unquote(args.query || args.Query), 72) };
  if (args.ArtifactMetadata?.Summary) return { name, target: oneLine(unquote(args.ArtifactMetadata.Summary), 72) };
  if (args.action) return { name, target: oneLine(`${unquote(args.action)} ${unquote(args.name)}`, 60) };
  if (args.Url) return { name, target: oneLine(unquote(args.Url), 72) };
  return { name, target: '' };
}

function summarizeTools(calls) {
  if (!Array.isArray(calls) || !calls.length) {
    return { tools: 'Final Reply', isWaitStep: false, isFinalReply: true, toolDetails: [] };
  }
  const counts = new Map();
  const toolDetails = [];
  let isWaitStep = false;
  for (const tc of calls) {
    const detail = describeToolDetail(tc);
    toolDetails.push(detail);
    counts.set(detail.name, (counts.get(detail.name) || 0) + 1);
    if (WAIT_TOOLS.has(detail.name)) isWaitStep = true;
  }
  const tools = [...counts.entries()].map(([k, v]) => (v > 1 ? `${k} ×${v}` : k)).join(', ');
  return { tools, isWaitStep, isFinalReply: false, toolDetails };
}

function thinkingSummary(thinking) {
  if (typeof thinking !== 'string' || !thinking.trim()) return '';
  const hs = [...thinking.matchAll(/(?:^|\n)\s*\*\*([^*\n]{3,72})\*\*\s*(?=\n|$)/g)];
  if (hs.length) return oneLine(hs[hs.length - 1][1], 88);
  return oneLine(thinking, 88);
}

function replySummary(content) {
  if (typeof content !== 'string' || !content.trim()) return '';
  return oneLine(content.replace(/[#*`]/g, ''), 96);
}

const metricsCache = new Map();

function buildMetrics(conv, path, appData) {
  const st = statOf(path);
  if (st.size < 0) return null;
  const cacheKey = `${path}|${st.mtime}|${st.size}`;
  const hit = metricsCache.get(conv);
  if (hit && hit.cacheKey === cacheKey) {
    const live = evaluateLiveState(conv, appData, hit.st, hit.lastEntryMeta);
    const etag = `${cacheKey}|${live.active ? 1 : 0}|${live.turnState}|${live.terminationReason}`;
    return { ...hit.baseData, ...live, etag };
  }

  let text = '';
  try {
    text = readFileSync(path, 'utf-8');
  } catch {
    return null;
  }

  const parsed = [];
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const obj = JSON.parse(trimmed);
      if (obj && typeof obj === 'object') parsed.push(obj);
    } catch {
      // Partial line while appending; picked up next poll.
    }
  }

  const turns = [];
  const steps = [];
  let currentTurn = null;
  let totalIn = 0;
  let totalCache = 0;
  let totalOut = 0;
  let totalOutTimed = 0;
  let totalDurTimed = 0;
  let peakTps = 0;
  let latestTps = null;

  const ensureTurn = (fallbackTs) => {
    if (!currentTurn) {
      currentTurn = {
        turnIndex: turns.length + 1,
        created_at: fallbackTs || null,
        userText: '（会话初始上下文）',
        userPreview: '（会话初始上下文）',
        steps: [],
        totalIn: 0,
        totalCache: 0,
        totalOut: 0,
        totalDurSec: 0,
        timedOut: 0,
        timedDur: 0,
      };
      turns.push(currentTurn);
    }
    return currentTurn;
  };

  for (let i = 0; i < parsed.length; i++) {
    const cur = parsed[i];
    if (cur.type === 'USER_INPUT') {
      const clean = cleanUserContent(cur.content) || '(空输入)';
      currentTurn = {
        turnIndex: turns.length + 1,
        created_at: cur.created_at || null,
        userText: clean,
        userPreview: oneLine(clean, 84),
        steps: [],
        totalIn: 0,
        totalCache: 0,
        totalOut: 0,
        totalDurSec: 0,
        timedOut: 0,
        timedDur: 0,
      };
      turns.push(currentTurn);
      continue;
    }

    if (cur.type !== 'PLANNER_RESPONSE') continue;

    const turn = ensureTurn(cur.created_at);
    const next = i + 1 < parsed.length ? parsed[i + 1] : null;
    const stepIdx = Number.isFinite(cur.step_index) ? cur.step_index : i;
    const inTok = Number(cur.input_tokens) || 0;
    const cacheTok = Number(cur.cache_read_tokens) || 0;
    const outTok = Number(cur.output_tokens) || 0;
    const { tools, isWaitStep, isFinalReply, toolDetails } = summarizeTools(cur.tool_calls);

    // Inspect the immediate GENERIC tool result step (if any) for status.
    let toolStatus = '';
    if (!isFinalReply && next && next.type === 'GENERIC') {
      toolStatus = String(next.status || '');
    }

    // Duration calculation:
    // - For chained steps followed by GENERIC/SYSTEM/PLANNER in the same turn,
    //   next.created_at - cur.created_at is the step generation duration.
    // - For a Final Reply (followed by USER_INPUT or EOF), never subtract a later
    //   USER_INPUT timestamp (that includes user idle time). Use mtime only if it
    //   is currently the latest step on disk and within a sane reply window.
    const t0 = Date.parse(cur.created_at || '');
    let durSec = null;
    const cacheId = `${conv}:${stepIdx}`;
    if (next && next.type !== 'USER_INPUT') {
      const t1 = Date.parse(next.created_at || '');
      if (Number.isFinite(t0) && Number.isFinite(t1) && t1 > t0) {
        durSec = (t1 - t0) / 1000;
      }
    } else if (!next && Number.isFinite(t0) && st.mtime > t0) {
      const liveDur = (st.mtime - t0) / 1000;
      if (liveDur > 0 && liveDur <= 180) {
        durSec = liveDur;
        finalReplyDurCache.set(cacheId, durSec);
      }
    } else if (finalReplyDurCache.has(cacheId)) {
      durSec = finalReplyDurCache.get(cacheId);
    }

    const tps = durSec && durSec > 0 && outTok > 0 ? outTok / durSec : null;
    const promptTotal = inTok + cacheTok;
    const cachePct = promptTotal > 0 ? (cacheTok / promptTotal) * 100 : 0;

    totalIn += inTok;
    totalCache += cacheTok;
    totalOut += outTok;
    if (tps !== null && !isWaitStep) {
      totalOutTimed += outTok;
      totalDurTimed += durSec;
      if (tps > peakTps) peakTps = tps;
    }
    if (tps !== null) latestTps = tps;

    const stepObj = {
      step: stepIdx,
      turnIndex: turn.turnIndex,
      chainIndex: turn.steps.length + 1,
      userPreview: turn.userPreview,
      created_at: cur.created_at || null,
      in_tok: inTok,
      cache_tok: cacheTok,
      out_tok: outTok,
      prompt_total: promptTotal,
      cache_pct: Number(cachePct.toFixed(1)),
      dur_sec: durSec !== null ? Number(durSec.toFixed(1)) : null,
      tps: tps !== null ? Number(tps.toFixed(1)) : null,
      tools,
      tool_details: toolDetails,
      tool_status: toolStatus,
      is_wait: isWaitStep,
      is_final_reply: isFinalReply,
      thinking_summary: thinkingSummary(cur.thinking),
      reply_summary: isFinalReply ? replySummary(cur.content) : '',
    };

    steps.push(stepObj);
    turn.steps.push(stepObj);
    turn.totalIn += inTok;
    turn.totalCache += cacheTok;
    turn.totalOut += outTok;
    if (durSec !== null && !isWaitStep) {
      turn.totalDurSec += durSec;
      turn.timedOut += outTok;
      turn.timedDur += durSec;
    }
  }

  const formattedTurns = turns.map((t) => {
    const pSum = t.totalIn + t.totalCache;
    const cPct = pSum > 0 ? (t.totalCache / pSum) * 100 : 0;
    const avg = t.timedDur > 0 ? t.timedOut / t.timedDur : null;
    const latestStep = t.steps[t.steps.length - 1] || null;
    return {
      turnIndex: t.turnIndex,
      created_at: t.created_at,
      userText: t.userText,
      userPreview: t.userPreview,
      stepCount: t.steps.length,
      totalIn: t.totalIn,
      totalCache: t.totalCache,
      totalOut: t.totalOut,
      cachePct: Number(cPct.toFixed(1)),
      totalDurSec: Number(t.totalDurSec.toFixed(1)),
      avgTps: avg !== null ? Number(avg.toFixed(1)) : null,
      latestCtx: latestStep ? latestStep.prompt_total : 0,
      steps: t.steps,
    };
  });

  const lastEntry = parsed[parsed.length - 1] || null;
  const lastEntryMeta = lastEntry
    ? {
        type: String(lastEntry.type || ''),
        status: String(lastEntry.status || '').toUpperCase(),
        createdAtMs: Date.parse(lastEntry.created_at || '') || 0,
        hasToolCalls: Array.isArray(lastEntry.tool_calls) && lastEntry.tool_calls.length > 0,
        isWaitStep:
          lastEntry.type === 'PLANNER_RESPONSE' && summarizeTools(lastEntry.tool_calls).isWaitStep,
      }
    : null;

  const promptSum = totalIn + totalCache;
  const overallCachePct = promptSum > 0 ? (totalCache / promptSum) * 100 : 0;
  const avgTps = totalDurTimed > 0 ? totalOutTimed / totalDurTimed : 0;
  const latest = steps[steps.length - 1] || null;

  const baseData = {
    conversationId: conv,
    mtime: st.mtime,
    snippet: extractTitleSnippet(text),
    summary: {
      turnCount: formattedTurns.length,
      stepCount: steps.length,
      totalIn,
      totalCache,
      totalOut,
      promptSum,
      overallCachePct: Number(overallCachePct.toFixed(1)),
      estSavedPct: Number((overallCachePct * 0.9).toFixed(1)),
      latestTps: latestTps !== null ? Number(latestTps.toFixed(1)) : null,
      avgTps: Number(avgTps.toFixed(1)),
      peakTps: Number(peakTps.toFixed(1)),
      ctxUsed: latest ? latest.prompt_total : 0,
    },
    turns: formattedTurns,
    steps,
  };

  if (metricsCache.size > 100) metricsCache.clear();
  metricsCache.set(conv, { cacheKey, st, lastEntryMeta, baseData });

  const live = evaluateLiveState(conv, appData, st, lastEntryMeta);
  const etag = `${cacheKey}|${live.active ? 1 : 0}|${live.turnState}|${live.terminationReason}`;
  return { ...baseData, ...live, etag };
}

const app = new SidecarApp();

app.page('/', () => readFileSync(join(__dirname, 'index.html'), 'utf-8'));

for (const [route, [file, contentType]] of Object.entries(STATIC)) {
  app.api(route, () => new Response(readFileSync(join(__dirname, file), 'utf-8'), { contentType }), 'GET');
}

app.api(
  '/api/metrics',
  (data) => {
    const conv = String(data?.conversationId || app.config.conversationId || '').trim();
    if (!conv || !ID_RE.test(conv)) {
      return { conversationId: null, empty: true, reason: 'no_conversation' };
    }
    const located = locateTranscript(conv);
    if (!located) {
      return { conversationId: conv, empty: true, reason: 'no_transcript' };
    }
    const metrics = buildMetrics(conv, located.path, located.appData);
    if (!metrics) {
      return { conversationId: conv, empty: true, reason: 'unreadable' };
    }
    if (data.etag && data.etag === metrics.etag) {
      return { conversationId: conv, unchanged: true, etag: metrics.etag };
    }
    return metrics;
  },
  'GET'
);

app.run();
