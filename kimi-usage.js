#!/usr/bin/env node
'use strict';
/**
 * kimi-usage — Kimi Code CLI 本地用量 Dashboard（零依赖单文件）。
 *
 * 扫描 ~/.kimi-code/sessions/** 的 wire.jsonl（支持 KIMI_CODE_HOME / --home），
 * 默认启动实时 Dashboard（node:http + SSE，自动开浏览器，无连接 60s 自动退出），
 * 或 --export 生成自包含静态 HTML。
 * 另有 Coding Plan 额度卡：轮询 Kimi Code CLI 本地 server 的 /api/v1/oauth/usage
 * （Bearer <home>/server.token，端口默认 58627，可用 KIMI_USAGE_SERVER_URL 覆盖整个 URL）；
 * server 未运行、请求失败或响应结构不符时整卡自动隐藏。
 *
 * Usage: node kimi-usage.js [--days N] [--home PATH] [--port N] [--no-open] [--export FILE]
 */
const http = require('node:http');
const https = require('node:https');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { exec } = require('node:child_process');

const USAGE_MARK = '"usage.record"';
const IDLE_MS = parseInt(process.env.KIMI_USAGE_IDLE_MS || '60000', 10);
const POLL_MS = 2000;
const QUOTA_POLL_MS = 45000;   // 额度接口轮询间隔（30-60 秒）
const QUOTA_TIMEOUT_MS = 10000;
const QUOTA_URL = process.env.KIMI_USAGE_SERVER_URL
  || 'http://127.0.0.1:58627/api/v1/oauth/usage';

// ---------------------------------------------------------------- CLI 参数

function parseArgs(argv) {
  const args = { days: 30, home: null, port: 0, open: true, export: null, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--days') args.days = parseInt(argv[++i], 10) || 30;
    else if (a === '--home') args.home = argv[++i];
    else if (a === '--port') args.port = parseInt(argv[++i], 10) || 0;
    else if (a === '--no-open') args.open = false;
    else if (a === '--export') args.export = argv[++i];
    else if (a === '--help' || a === '-h') args.help = true;
    else { console.error(`未知参数: ${a}`); args.help = true; }
  }
  return args;
}

const HELP = `kimi-usage — Kimi Code 本地用量 Dashboard（零依赖）

用法:
  kimi-usage                 启动实时 Dashboard 并打开浏览器
  kimi-usage --export out.html  导出自包含静态 HTML（不开服务）

选项:
  --days N       只统计最近 N 天（默认 30）
  --home PATH    Kimi Code 数据根目录（默认 $KIMI_CODE_HOME 或 ~/.kimi-code）
  --port N       服务端口（默认 0，随机）
  --no-open      不自动打开浏览器
  --export FILE  导出静态 HTML 后退出
  --help         显示本帮助

按 Ctrl+C 停止；浏览器全部关闭 60 秒后自动退出。`;

// ---------------------------------------------------------------- 数据层

function resolveHome(cliHome) {
  if (cliHome) return path.resolve(cliHome);
  if (process.env.KIMI_CODE_HOME) return path.resolve(process.env.KIMI_CODE_HOME);
  return path.join(os.homedir(), '.kimi-code');
}

function loadSessionIndex(indexPath) {
  const map = new Map();
  let text;
  try { text = fs.readFileSync(indexPath, 'utf8'); } catch { return map; }
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      const rec = JSON.parse(line);
      if (rec.sessionId && rec.workDir) map.set(rec.sessionId, rec.workDir);
    } catch { /* 跳过坏行 */ }
  }
  return map;
}

function walkWireFiles(root) {
  const out = [];
  const stack = [root];
  while (stack.length) {
    const dir = stack.pop();
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) stack.push(p);
      else if (e.name === 'wire.jsonl') out.push(p);
    }
  }
  return out;
}

function sessionIdFromPath(p) {
  for (const part of p.split(path.sep)) {
    if (part.startsWith('session_')) return part;
  }
  return '(unknown)';
}

/** 解析一行 wire.jsonl，返回 [t, model, input, output, cacheRead, cacheCreation] 或 null */
function parseUsageLine(line) {
  if (!line.includes(USAGE_MARK)) return null;
  let rec;
  try { rec = JSON.parse(line); } catch { return null; }
  if (rec.type !== 'usage.record' || rec.usageScope !== 'turn') return null;
  if (typeof rec.time !== 'number') return null;
  const u = rec.usage || {};
  return [
    Math.trunc(rec.time),
    rec.model || '(unknown)',
    u.inputOther | 0,
    u.output | 0,
    u.inputCacheRead | 0,
    u.inputCacheCreation | 0,
  ];
}

/**
 * 读取文件自 st.offset 以来的新增字节，返回完整行列表。
 * st: { offset, lineBuf } —— lineBuf 缓冲不完整的行尾（Buffer）。
 * 文件被截断（size < offset）时自动从头重读。
 */
function readNewLines(filePath, st) {
  let fd;
  try { fd = fs.openSync(filePath, 'r'); } catch { return []; }
  let size;
  try { size = fs.fstatSync(fd).size; } catch { fs.closeSync(fd); return []; }
  let start = st.offset;
  if (size < start) { start = 0; st.lineBuf = Buffer.alloc(0); }
  const len = size - start;
  let chunk = Buffer.alloc(0);
  if (len > 0) {
    chunk = Buffer.allocUnsafe(len);
    try { fs.readSync(fd, chunk, 0, len, start); } catch { fs.closeSync(fd); return []; }
  }
  fs.closeSync(fd);
  st.offset = size;
  if (chunk.length === 0 && st.lineBuf.length === 0) return [];
  const data = st.lineBuf.length ? Buffer.concat([st.lineBuf, chunk]) : chunk;
  const lastNl = data.lastIndexOf(0x0a);
  if (lastNl === -1) { st.lineBuf = Buffer.from(data); return []; }
  st.lineBuf = Buffer.from(data.subarray(lastNl + 1)); // 拷贝，避免持有整文件缓冲
  const lines = data.toString('utf8', 0, lastNl).split('\n');
  return lines;
}

// ---------------------------------------------------------------- 聚合

function pad2(n) { return String(n).padStart(2, '0'); }
function dateStr(d) { return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`; }
function projectName(wd) {
  if (!wd || wd === '(unknown)') return '(unknown)';
  const base = wd.replace(/[\\/]+$/, '').split(/[\\/]/).pop();
  return base || wd;
}

function buildData(state, days) {
  const now = Date.now();
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const dayList = [];
  for (let i = days - 1; i >= 0; i--) dayList.push(dateStr(new Date(today.getTime() - i * 86400000)));
  const daySet = new Set(dayList);
  const todayStr = dayList[dayList.length - 1];

  const daily = new Map(dayList.map(d => [d, { input: 0, output: 0, cacheRead: 0, cacheCreation: 0, requests: 0 }]));
  const hourly = Array.from({ length: 24 }, () => ({ input: 0, output: 0, cacheRead: 0, cacheCreation: 0, requests: 0 }));
  const dailyModel = new Map();          // date -> Map(model -> total)
  const modelTotal = new Map();
  const projectTotal = new Map();        // key: name + '' + path
  const calDaily = new Map();            // dateStr -> {total, requests}，不受 --days 窗口限制
  const sessions = new Map();

  for (const row of state.records) {
    const rec = row.rec;
    const t = rec[0], model = rec[1], inp = rec[2], out = rec[3], cr = rec[4], cc = rec[5];
    const dt = new Date(t);
    const d = dateStr(dt);
    const ce = calDaily.get(d) || { total: 0, requests: 0 };
    ce.total += inp + out + cr + cc; ce.requests += 1;
    calDaily.set(d, ce);
    if (!daySet.has(d)) continue;
    const total = inp + out + cr + cc;
    const dd = daily.get(d);
    dd.input += inp; dd.output += out; dd.cacheRead += cr; dd.cacheCreation += cc; dd.requests += 1;
    if (d === todayStr) {
      const h = hourly[dt.getHours()];
      h.input += inp; h.output += out; h.cacheRead += cr; h.cacheCreation += cc; h.requests += 1;
    }
    if (!dailyModel.has(d)) dailyModel.set(d, new Map());
    const dm = dailyModel.get(d);
    dm.set(model, (dm.get(model) || 0) + total);
    modelTotal.set(model, (modelTotal.get(model) || 0) + total);
    const wd = state.sessionIndex.get(row.sid) || '(unknown)';
    const proj = projectName(wd);
    const pk = proj + ' ' + wd;
    projectTotal.set(pk, (projectTotal.get(pk) || 0) + total);

    let s = sessions.get(row.sid);
    if (!s) {
      s = { sessionId: row.sid, project: proj, workDir: wd, models: new Set(),
            input: 0, output: 0, cacheRead: 0, cacheCreation: 0, requests: 0,
            first: t, last: t, total: 0 };
      sessions.set(row.sid, s);
    }
    s.models.add(model);
    s.input += inp; s.output += out; s.cacheRead += cr; s.cacheCreation += cc;
    s.requests += 1; s.first = Math.min(s.first, t); s.last = Math.max(s.last, t); s.total += total;
  }

  const dailyOut = dayList.map(d => {
    const dd = daily.get(d);
    const denom = dd.input + dd.cacheRead + dd.cacheCreation;
    return {
      date: d,
      input: dd.input, output: dd.output, cacheRead: dd.cacheRead, cacheCreation: dd.cacheCreation,
      total: dd.input + dd.output + dd.cacheRead + dd.cacheCreation,
      requests: dd.requests,
      cacheHitRate: denom ? +(dd.cacheRead / denom).toFixed(4) : 0,
    };
  });

  const models = [...modelTotal.keys()].sort((a, b) => modelTotal.get(b) - modelTotal.get(a));
  const dailyModelOut = {};
  for (const d of dayList) {
    const dm = dailyModel.get(d) || new Map();
    dailyModelOut[d] = models.map(m => dm.get(m) || 0);
  }
  const modelRank = models.map(m => ({ model: m, total: modelTotal.get(m) }));
  const projectRank = [...projectTotal.entries()]
    .map(([k, total]) => { const i = k.indexOf(' '); return { name: k.slice(0, i), path: k.slice(i + 1), total }; })
    .sort((a, b) => b.total - a.total);
  const sessionRows = [...sessions.values()]
    .sort((a, b) => b.total - a.total)
    .map(s => ({
      sessionId: s.sessionId, project: s.project, workDir: s.workDir,
      models: [...s.models].sort(),
      input: s.input, output: s.output, cacheRead: s.cacheRead, cacheCreation: s.cacheCreation,
      requests: s.requests, first: s.first, last: s.last, total: s.total,
    }));

  const weekTotal = dailyOut.slice(-7).reduce((s, d) => s + d.total, 0);
  const prevWeekTotal = days >= 14 ? dailyOut.slice(-14, -7).reduce((s, d) => s + d.total, 0) : 0;
  const sumInput = dailyOut.reduce((s, d) => s + d.input, 0);
  const sumCr = dailyOut.reduce((s, d) => s + d.cacheRead, 0);
  const sumCc = dailyOut.reduce((s, d) => s + d.cacheCreation, 0);
  const denom = sumInput + sumCr + sumCc;
  const dt2 = new Date(now);
  const calStart = dateStr(new Date(today.getTime() - 364 * 86400000));
  const fmtNow = `${dt2.getFullYear()}-${pad2(dt2.getMonth() + 1)}-${pad2(dt2.getDate())} ${pad2(dt2.getHours())}:${pad2(dt2.getMinutes())}:${pad2(dt2.getSeconds())}`;

  return {
    generatedAt: fmtNow,
    days,
    dateRange: `${dayList[0]} ~ ${dayList[dayList.length - 1]}`,
    dayList,
    daily: dailyOut,
    todayHourly: hourly.map(h => ({
      input: h.input, output: h.output, cacheRead: h.cacheRead,
      total: h.input + h.output + h.cacheRead + h.cacheCreation,
      requests: h.requests,
    })),
    models,
    dailyModel: dailyModelOut,
    modelRank,
    projectRank,
    calendar: {
      range: [calStart, todayStr],
      days: [...calDaily.entries()].map(([d, v]) => [d, v.total, v.requests]),
    },
    sessions: sessionRows,
    kpi: {
      weekTotal,
      prevWeekTotal,
      weekOverWeek: prevWeekTotal ? +((weekTotal - prevWeekTotal) / prevWeekTotal).toFixed(4) : null,
      todayTotal: dailyOut[dailyOut.length - 1].total,
      cacheHitRate: denom ? +(sumCr / denom).toFixed(4) : 0,
      activeSessions: sessions.size,
    },
    quota: state.quota || null,
  };
}

// ---------------------------------------------------------------- 额度（Coding Plan）
// 凭 <home>/server.token（仅用于 Bearer 鉴权，绝不打印明文）轮询 Kimi Code CLI
// 本地 server 的 /api/v1/oauth/usage 代理路由。任何异常（token 缺失、server 不在、
// 网络失败/超时、非 200、code!==0、kind!=="ok"、整体结构不符）都把 state.quota
// 置为 null —— 前端据此整卡隐藏，不影响本地日志解析。
// 响应信封：{ code: 0, data: { kind: "ok", summary: {window,used,limit,reset_at},
//           limits: [...] } }；summary 与 limits[].window 为 {duration, unit}。

const QUOTA_UNIT_LABEL = { hour: '小时', day: '今日', week: '本周', month: '本月' };

function loadServerToken(home) {
  let text;
  try { text = fs.readFileSync(path.join(home, 'server.token'), 'utf8'); } catch { return null; }
  const t = text.trim();
  return t ? t : null;
}

/** window {duration, unit} → 中文标签；无法识别返回 null */
function quotaWindowLabel(w) {
  if (!w || typeof w !== 'object') return null;
  const unit = w.unit;
  if (typeof unit !== 'string' || !QUOTA_UNIT_LABEL[unit]) return null;
  if (unit === 'hour') {
    const d = typeof w.duration === 'number' && isFinite(w.duration) && w.duration > 0 ? w.duration : null;
    return d ? `${d} 小时` : '小时';
  }
  return QUOTA_UNIT_LABEL[unit];
}

/** reset_at 容错：epoch 秒/毫秒、纯数字字符串、ISO 日期字符串；解析失败返回 null */
function normalizeResetMs(v) {
  let n = null;
  if (typeof v === 'number' && isFinite(v)) n = v;
  else if (typeof v === 'string' && /^\d+(\.\d+)?$/.test(v)) n = parseFloat(v);
  else if (typeof v === 'string' && v) {
    const t = Date.parse(v);
    return isNaN(t) ? null : t;
  }
  if (n == null) return null;
  return n < 1e12 ? n * 1000 : n; // 秒级时间戳转毫秒
}

/** 校验并解析 usage 响应；整体结构不符（code!==0 / kind!=="ok"）返回 null；
 *  summary 或单个 limits[] 项字段缺失/非法时按缺行处理，不整卡隐藏；
 *  limits[] 与 summary 按 duration-unit 去重（limits 在前，保留先出现的 = limits 优先） */
function parseQuota(body) {
  if (!body || typeof body !== 'object') return null;
  if (body.code !== 0) return null;
  const data = body.data;
  if (!data || typeof data !== 'object' || data.kind !== 'ok') return null;

  const windows = [];
  if (Array.isArray(data.limits)) {
    windows.push(...data.limits.filter(w => w && typeof w === 'object'));
  }
  if (data.summary && typeof data.summary === 'object') windows.push(data.summary);

  const rows = [];
  const seen = new Set();
  for (const w of windows) {
    const key = `${w.window && w.window.duration || ''}-${w.window && w.window.unit || ''}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const label = quotaWindowLabel(w.window);
    if (!label) continue;
    const used = w.used, limit = w.limit;
    if (typeof used !== 'number' || !isFinite(used) || used < 0) continue;
    if (typeof limit !== 'number' || !isFinite(limit) || limit <= 0) continue;
    rows.push({ key, label, used, limit, ratio: used / limit, resetMs: normalizeResetMs(w.reset_at) });
  }
  return { rows, fetchedAt: Date.now() };
}

/** GET usage 接口；cb(err, body) 只回调一次 */
function fetchQuotaUsage(token, timeoutMs, cb) {
  let done = false;
  const once = (err, body) => { if (!done) { done = true; cb(err, body); } };
  let url;
  try { url = new URL(QUOTA_URL); } catch { return once(new Error(`KIMI_USAGE_SERVER_URL 非法: ${QUOTA_URL}`)); }
  const lib = url.protocol === 'https:' ? https : http;
  let req;
  try {
    req = lib.request(url, {
      method: 'GET',
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
      timeout: timeoutMs,
    }, (res) => {
      if (res.statusCode !== 200) { res.resume(); return once(new Error(`HTTP ${res.statusCode}`)); }
      const chunks = [];
      let size = 0;
      res.on('data', (c) => {
        size += c.length;
        if (size > 1024 * 1024) { req.destroy(new Error('响应过大')); return; }
        chunks.push(c);
      });
      res.on('end', () => {
        let body;
        try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { return once(new Error('响应不是合法 JSON')); }
        once(null, body);
      });
      res.on('error', once);
    });
  } catch (err) { return once(err); } // token 含非法 header 字符等同步抛错归一为回调，不让异常逃出 Promise executor
  req.on('timeout', () => req.destroy(new Error('请求超时')));
  req.on('error', once);
  req.end();
}

/** 单次额度刷新；永不 reject，结果写入 state.quota（失败为 null），状态切换时仅打一行日志 */
function refreshQuotaOnce(state) {
  return new Promise((resolve) => {
    const done = (q, err) => {
      state.quota = q;
      const ok = !!q;
      if (ok !== state.quotaOk) {
        state.quotaOk = ok;
        if (ok) console.log('已获取 Coding Plan 额度数据。');
        else console.log(`额度信息不可用（${err && err.message ? err.message : err}），不展示额度卡。`);
      }
      resolve();
    };
    try {
      const token = loadServerToken(state.home);
      if (!token) return done(null, new Error('server.token 缺失或为空'));
      fetchQuotaUsage(token, QUOTA_TIMEOUT_MS, (err, body) => {
        if (err) return done(null, err);
        const q = parseQuota(body);
        if (!q) return done(null, new Error('响应结构不符预期'));
        done(q);
      });
    } catch (err) {
      done(null, err); // executor 内任何同步异常（如 token 读取抛错）也不允许 reject
    }
  });
}

// ---------------------------------------------------------------- 页面模板

const LIVE_SCRIPT = `<script>
(function () {
  if (!window.EventSource) return;
  var es = new EventSource('/events');
  var pending = null, timer = null, dot = document.getElementById('liveDot');
  es.onopen = function () { if (dot) dot.style.display = 'inline'; };
  es.onmessage = function (ev) {
    try { pending = JSON.parse(ev.data); } catch (e) { return; }
    if (!timer) timer = setTimeout(function () {
      if (pending) renderAll(pending);
      pending = null; timer = null;
    }, 1000);
  };
})();
</script>`;

const HTML_TEMPLATE = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Kimi Code 用量 Dashboard</title>
<script src="https://cdn.jsdelivr.net/npm/echarts@5/dist/echarts.min.js"></script>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body {
    background: #0f1115; color: #d6d9e0;
    font-family: "Segoe UI", "Microsoft YaHei", system-ui, sans-serif;
    padding: 24px 32px 48px;
  }
  header { margin-bottom: 24px; }
  header h1 { font-size: 22px; font-weight: 600; color: #f0f2f5; }
  header .meta { margin-top: 6px; font-size: 13px; color: #7a8194; }
  #liveDot { display: none; color: #4cc38a; font-weight: 600; }
  .kpi-row { display: flex; gap: 16px; flex-wrap: wrap; margin-bottom: 24px; }
  .kpi-card {
    flex: 1 1 160px; background: #161a22; border: 1px solid #232836;
    border-radius: 10px; padding: 16px 18px;
  }
  .kpi-card .label { font-size: 12px; color: #7a8194; margin-bottom: 8px; }
  .kpi-card .value { font-size: 24px; font-weight: 600; color: #f0f2f5; font-variant-numeric: tabular-nums; }
  .kpi-card .sub { font-size: 12px; margin-top: 6px; color: #7a8194; }
  .kpi-card .sub .up { color: #4cc38a; }
  .kpi-card .sub .down { color: #e5484d; }
  .quota-card { margin-bottom: 24px; }
  .quota-row { display: flex; align-items: center; gap: 12px; }
  .quota-row + .quota-row { margin-top: 12px; }
  .quota-label { flex: none; width: 96px; font-size: 13px; color: #c9cedb; }
  .quota-track { flex: 1; height: 10px; background: #1e2330; border-radius: 5px; overflow: hidden; }
  .quota-fill { height: 100%; border-radius: 5px; background: #5b8def; transition: width .4s; }
  .quota-fill.warn { background: #e5a545; }
  .quota-fill.hot { background: #e5484d; }
  .quota-meta { flex: none; width: 300px; text-align: right; font-size: 12px; color: #7a8194; font-variant-numeric: tabular-nums; }
  .quota-meta b { color: #d6d9e0; font-weight: 600; }
  .grid { display: grid; grid-template-columns: 1fr 1fr; gap: 20px; }
  .card {
    background: #161a22; border: 1px solid #232836; border-radius: 10px;
    padding: 18px; margin-bottom: 20px;
  }
  .card h2 { font-size: 15px; font-weight: 600; color: #c9cedb; margin-bottom: 12px; }
  .chart { width: 100%; height: 320px; }
  .chart.tall { height: 380px; }
  .chart.cal { height: 210px; }
  .full { grid-column: 1 / -1; }
  table { width: 100%; border-collapse: collapse; font-size: 12px; font-variant-numeric: tabular-nums; }
  th, td { padding: 7px 10px; text-align: right; border-bottom: 1px solid #232836; white-space: nowrap; }
  th { color: #7a8194; font-weight: 500; position: sticky; top: 0; background: #161a22; }
  th.sortable { cursor: pointer; user-select: none; }
  th.sortable:hover { color: #c9cedb; }
  td.l, th.l { text-align: left; }
  tbody tr:hover { background: #1c2130; }
  .table-wrap { max-height: 560px; overflow-y: auto; }
  * { scrollbar-width: thin; scrollbar-color: #2e3548 transparent; }
  ::-webkit-scrollbar { width: 8px; height: 8px; }
  ::-webkit-scrollbar-track { background: transparent; }
  ::-webkit-scrollbar-thumb { background: #2e3548; border-radius: 4px; }
  ::-webkit-scrollbar-thumb:hover { background: #3d4560; }
  .mono { font-family: Consolas, monospace; font-size: 11px; color: #8a91a5; }
  @media (max-width: 1100px) { .grid { grid-template-columns: 1fr; } }
</style>
</head>
<body>
<header>
  <h1>Kimi Code 用量 Dashboard</h1>
  <div class="meta"><span id="meta"></span><span id="liveDot"> · ● 实时更新中</span></div>
</header>

<div class="card full quota-card" id="quotaCard" style="display:none">
  <h2>额度（Coding Plan）</h2>
  <div id="quotaBody"></div>
</div>

<div class="kpi-row" id="kpiRow"></div>

<div class="grid">
  <div class="card full"><h2>每日 Token 趋势</h2><div id="chartDaily" class="chart tall"></div></div>
  <div class="card full"><h2>今日 Token 趋势（按小时）</h2><div id="chartTodayHourly" class="chart"></div></div>
  <div class="card"><h2>模型占比</h2><div id="chartModelPie" class="chart"></div></div>
  <div class="card"><h2>每日 × 模型</h2><div id="chartModelDaily" class="chart"></div></div>
  <div class="card"><h2>缓存命中率（按日）</h2><div id="chartHitRate" class="chart"></div></div>
  <div class="card"><h2>项目排行（Top 15）</h2><div id="chartProjects" class="chart"></div></div>
  <div class="card full"><h2>每日活动（近一年，按日）</h2><div id="chartCalendar" class="chart cal"></div></div>
  <div class="card full"><h2>会话明细（点击 开始/结束/Total 表头排序，最多 200 行）</h2>
    <div class="table-wrap"><table id="sessionTable"></table></div>
  </div>
</div>

<script>
function renderAll(DATA) {

var fmt = function (n) { return n == null ? '-' : Math.round(n).toLocaleString('en-US'); };
var fmtCN = function (n) {
  if (n == null) return '';
  if (n >= 1e8) return '≈ ' + (n / 1e8).toFixed(1) + ' 亿';
  if (n >= 1e4) return '≈ ' + (n / 1e4).toFixed(1) + ' 万';
  return '';
};
var fmtPct = function (x) { return x == null ? '-' : (x * 100).toFixed(1) + '%'; };
var abbrev = function (v) {
  if (v >= 1e9) return (v / 1e9).toFixed(1) + 'B';
  if (v >= 1e6) return (v / 1e6).toFixed(1) + 'M';
  if (v >= 1e3) return (v / 1e3).toFixed(0) + 'K';
  return v;
};
var fmtTime = function (ms) {
  var d = new Date(ms);
  var p = function (n) { return String(n).padStart(2, '0'); };
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
};

var fmtReset = function (ms, now) {
  if (!ms) return '—';
  var m = Math.round((ms - now) / 60000);
  if (m <= 0) return '已重置';
  if (m < 60) return m + ' 分钟后重置';
  if (m < 48 * 60) return (Math.round(m / 6) / 10) + ' 小时后重置';
  return Math.round(m / 1440) + ' 天后重置';
};

document.getElementById('meta').textContent =
  '数据范围：' + DATA.dateRange + '（最近 ' + DATA.days + ' 天） · 更新于：' + DATA.generatedAt + ' · 数据源：~/.kimi-code/sessions';

// KPI 卡片
(function () {
  var k = DATA.kpi;
  var wowHtml = '-', wowCls = '';
  if (k.weekOverWeek != null) {
    var pct = (k.weekOverWeek * 100).toFixed(1);
    wowCls = k.weekOverWeek >= 0 ? 'up' : 'down';
    wowHtml = '<span class="' + wowCls + '">' + (k.weekOverWeek >= 0 ? '+' : '') + pct + '% vs 上周</span>';
  }
  var cards = [
    ['本周 Tokens（7 天）', fmt(k.weekTotal), fmtCN(k.weekTotal)],
    ['今日 Tokens', fmt(k.todayTotal), fmtCN(k.todayTotal)],
    ['总缓存命中率', fmtPct(k.cacheHitRate), ''],
    ['活跃会话数', fmt(k.activeSessions), ''],
    ['上周同期', fmt(k.prevWeekTotal), (fmtCN(k.prevWeekTotal) ? fmtCN(k.prevWeekTotal) + ' · ' : '') + wowHtml],
  ];
  document.getElementById('kpiRow').innerHTML = cards.map(function (c) {
    return '<div class="kpi-card"><div class="label">' + c[0] + '</div><div class="value">' + c[1] + '</div><div class="sub">' + c[2] + '</div></div>';
  }).join('');
})();

// 额度卡：DATA.quota 缺失/不可用时整卡隐藏（display:none 且清空内容，无占位残留）
(function () {
  var card = document.getElementById('quotaCard');
  var body = document.getElementById('quotaBody');
  var q = DATA.quota;
  if (!q || !q.rows || !q.rows.length) {
    card.style.display = 'none';
    body.innerHTML = '';
    return;
  }
  var now = Date.now();
  body.innerHTML = q.rows.map(function (r) {
    var pct = r.ratio * 100;
    var cls = pct >= 85 ? ' hot' : (pct >= 60 ? ' warn' : '');
    return '<div class="quota-row">' +
      '<div class="quota-label">' + r.label + '</div>' +
      '<div class="quota-track"><div class="quota-fill' + cls + '" style="width:' + Math.min(100, pct) + '%"></div></div>' +
      '<div class="quota-meta"><b>' + pct.toFixed(1) + '%</b> 已用（' + fmt(r.used) + '/' + fmt(r.limit) + '）· <span data-reset="' + (r.resetMs || '') + '">' + fmtReset(r.resetMs, now) + '</span></div>' +
      '</div>';
  }).join('');
  card.style.display = '';
})();

// 额度重置倒计时本地每 30 秒刷新，不依赖服务端推送
if (!renderAll.quotaTimer) {
  renderAll.quotaTimer = setInterval(function () {
    var spans = document.querySelectorAll('#quotaBody span[data-reset]');
    var now = Date.now();
    for (var i = 0; i < spans.length; i++) {
      spans[i].textContent = fmtReset(+spans[i].getAttribute('data-reset'), now);
    }
  }, 30000);
}

var baseAxis = {
  axisLabel: { color: '#8a91a5' },
  axisLine: { lineStyle: { color: '#2a3040' } },
  splitLine: { lineStyle: { color: '#1e2330' } },
};
var baseTooltip = { backgroundColor: '#1c2130', borderColor: '#2a3040', textStyle: { color: '#d6d9e0' } };
var days = DATA.dayList;
var shortDays = days.map(function (d) { return d.slice(5); });
var opts = {};

// 1. 每日 token 趋势（堆叠柱）
opts.chartDaily = {
  tooltip: Object.assign({}, baseTooltip, { trigger: 'axis',
    formatter: function (ps) {
      var i = ps[0].dataIndex, d = DATA.daily[i];
      var html = '<b>' + d.date + '</b><br>';
      ps.forEach(function (p) { html += p.marker + p.seriesName + ': ' + fmt(p.value) + '<br>'; });
      html += '合计: ' + fmt(d.total) + '<br>请求数: ' + fmt(d.requests) + '<br>缓存命中率: ' + fmtPct(d.cacheHitRate);
      return html;
    } }),
  legend: { textStyle: { color: '#8a91a5' } },
  grid: { left: 60, right: 20, top: 40, bottom: 30 },
  xAxis: Object.assign({ type: 'category', data: shortDays }, baseAxis),
  yAxis: { type: 'value', axisLabel: Object.assign({}, baseAxis.axisLabel, { formatter: abbrev }), splitLine: baseAxis.splitLine },
  series: [
    { name: 'input', type: 'bar', stack: 't', data: DATA.daily.map(function (d) { return d.input; }), itemStyle: { color: '#5b8def' } },
    { name: 'output', type: 'bar', stack: 't', data: DATA.daily.map(function (d) { return d.output; }), itemStyle: { color: '#4cc38a' } },
    { name: 'cacheRead', type: 'bar', stack: 't', data: DATA.daily.map(function (d) { return d.cacheRead; }), itemStyle: { color: '#9b7ede' } },
  ],
};

// 2. 今日 token 趋势（按小时，堆叠柱）
opts.chartTodayHourly = {
  tooltip: Object.assign({}, baseTooltip, { trigger: 'axis',
    formatter: function (ps) {
      var i = ps[0].dataIndex, h = DATA.todayHourly[i];
      var html = '<b>' + String(i).padStart(2, '0') + ':00 - ' + String(i).padStart(2, '0') + ':59</b><br>';
      ps.forEach(function (p) { if (p.value) html += p.marker + p.seriesName + ': ' + fmt(p.value) + '<br>'; });
      html += '合计: ' + fmt(h.total) + '<br>请求数: ' + fmt(h.requests);
      return html;
    } }),
  legend: { textStyle: { color: '#8a91a5' } },
  grid: { left: 60, right: 20, top: 40, bottom: 30 },
  xAxis: Object.assign({ type: 'category', data: DATA.todayHourly.map(function (_, i) { return String(i).padStart(2, '0'); }) }, baseAxis),
  yAxis: { type: 'value', axisLabel: Object.assign({}, baseAxis.axisLabel, { formatter: abbrev }), splitLine: baseAxis.splitLine },
  series: [
    { name: 'input', type: 'bar', stack: 't', data: DATA.todayHourly.map(function (h) { return h.input; }), itemStyle: { color: '#5b8def' } },
    { name: 'output', type: 'bar', stack: 't', data: DATA.todayHourly.map(function (h) { return h.output; }), itemStyle: { color: '#4cc38a' } },
    { name: 'cacheRead', type: 'bar', stack: 't', data: DATA.todayHourly.map(function (h) { return h.cacheRead; }), itemStyle: { color: '#9b7ede' } },
  ],
};

// 3. 模型占比饼图
(function () {
  var topModels = DATA.modelRank.slice(0, 8);
  var otherTotal = DATA.modelRank.slice(8).reduce(function (s, m) { return s + m.total; }, 0);
  var pieData = topModels.map(function (m) { return { name: m.model, value: m.total }; });
  if (otherTotal > 0) pieData.push({ name: '其他', value: otherTotal });
  opts.chartModelPie = {
    tooltip: Object.assign({}, baseTooltip, { formatter: function (p) { return p.name + '<br>' + fmt(p.value) + ' (' + p.percent + '%)'; } }),
    legend: { bottom: 0, textStyle: { color: '#8a91a5', fontSize: 11 } },
    series: [{
      type: 'pie', radius: ['38%', '65%'], center: ['50%', '45%'],
      label: { color: '#8a91a5', fontSize: 11, formatter: '{b}' },
      data: pieData,
    }],
  };
})();

// 3. 每日 × 模型 堆叠柱
(function () {
  var piePalette = ['#5b8def', '#4cc38a', '#9b7ede', '#e5a545', '#e5484d', '#3bc9db', '#f47ab8', '#94a3b8'];
  opts.chartModelDaily = {
    tooltip: Object.assign({}, baseTooltip, { trigger: 'axis',
      formatter: function (ps) {
        var html = '<b>' + days[ps[0].dataIndex] + '</b><br>';
        ps.forEach(function (p) { if (p.value) html += p.marker + p.seriesName + ': ' + fmt(p.value) + '<br>'; });
        return html;
      } }),
    legend: { top: 0, textStyle: { color: '#8a91a5', fontSize: 11 } },
    grid: { left: 60, right: 20, top: 64, bottom: 30 },
    xAxis: Object.assign({ type: 'category', data: shortDays }, baseAxis),
    yAxis: { type: 'value', axisLabel: Object.assign({}, baseAxis.axisLabel, { formatter: abbrev }), splitLine: baseAxis.splitLine },
    series: DATA.models.map(function (m, i) {
      return {
        name: m, type: 'bar', stack: 'm',
        data: days.map(function (d) { return DATA.dailyModel[d][i]; }),
        itemStyle: { color: piePalette[i % piePalette.length] },
      };
    }),
  };
})();

// 4. 缓存命中率折线
opts.chartHitRate = {
  tooltip: Object.assign({}, baseTooltip, { trigger: 'axis',
    formatter: function (ps) { return days[ps[0].dataIndex] + '<br>命中率: ' + (ps[0].value * 100).toFixed(1) + '%'; } }),
  grid: { left: 50, right: 20, top: 30, bottom: 30 },
  xAxis: Object.assign({ type: 'category', data: shortDays }, baseAxis),
  yAxis: { type: 'value', min: 0, max: 1, axisLabel: Object.assign({}, baseAxis.axisLabel, { formatter: function (v) { return (v * 100).toFixed(0) + '%'; } }), splitLine: baseAxis.splitLine },
  series: [{
    type: 'line', smooth: true, data: DATA.daily.map(function (d) { return d.cacheHitRate; }),
    lineStyle: { color: '#4cc38a', width: 2 }, itemStyle: { color: '#4cc38a' },
    areaStyle: { color: 'rgba(76,195,138,0.12)' },
  }],
};

// 5. 项目排行横向条形图
(function () {
  var top = DATA.projectRank.slice(0, 15).reverse();
  opts.chartProjects = {
    tooltip: Object.assign({}, baseTooltip, { formatter: function (p) { return top[p.dataIndex].path + '<br>' + fmt(p.value); } }),
    grid: { left: 10, right: 60, top: 10, bottom: 10, containLabel: true },
    xAxis: { type: 'value', axisLabel: Object.assign({}, baseAxis.axisLabel, { formatter: abbrev }), splitLine: baseAxis.splitLine },
    yAxis: Object.assign({ type: 'category', data: top.map(function (p) { return p.name; }) }, baseAxis, { axisLabel: Object.assign({}, baseAxis.axisLabel, { width: 140, overflow: 'truncate' }) }),
    series: [{
      type: 'bar', data: top.map(function (p) { return p.total; }), itemStyle: { color: '#5b8def', borderRadius: [0, 3, 3, 0] },
      label: { show: true, position: 'right', color: '#8a91a5', formatter: function (p) { return abbrev(p.value); } },
    }],
  };
})();

// 6. 每日活动日历热力图（GitHub 贡献图风格，近一年）
(function () {
  var max = 0;
  DATA.calendar.days.forEach(function (d) { if (d[1] > max) max = d[1]; });
  opts.chartCalendar = {
    tooltip: Object.assign({}, baseTooltip, {
      formatter: function (p) {
        return '<b>' + p.data[0] + '</b><br>total: ' + fmt(p.data[1]) + '<br>请求数: ' + fmt(p.data[2]);
      } }),
    visualMap: {
      min: 0, max: max || 1, dimension: 1, show: true, orient: 'horizontal',
      right: 10, bottom: 0, text: ['多', '少'], textStyle: { color: '#7a8194' },
      itemWidth: 12, itemHeight: 90,
      inRange: { color: ['#181d28', '#1f3a5f', '#2f6bc4', '#5b8def', '#9db9f5'] },
    },
    calendar: {
      top: 35, left: 55, right: 20, bottom: 40,
      orient: 'horizontal', range: DATA.calendar.range,
      cellSize: ['auto', 16], firstDayOfWeek: 0,
      yearLabel: { show: false },
      monthLabel: { color: '#8a91a5', fontSize: 11, nameMap: ['1月', '2月', '3月', '4月', '5月', '6月', '7月', '8月', '9月', '10月', '11月', '12月'] },
      dayLabel: { color: '#8a91a5', fontSize: 11, nameMap: ['', '周一', '', '周三', '', '周五', ''] },
      splitLine: { show: false },
      itemStyle: { color: '#181d28', borderColor: '#0f1115', borderWidth: 3 },
    },
    series: [{ type: 'heatmap', coordinateSystem: 'calendar', data: DATA.calendar.days }],
  };
})();


Object.keys(opts).forEach(function (id) {
  if (!renderAll.charts[id]) renderAll.charts[id] = echarts.init(document.getElementById(id));
  renderAll.charts[id].setOption(opts[id], true);
});

// 7. 会话明细表
(function () {
  var sortState = { key: 'total', dir: -1 };
  var table = document.getElementById('sessionTable');
  function th(key, label, cls) {
    var arrow = sortState.key === key ? (sortState.dir < 0 ? ' ▼' : ' ▲') : '';
    return '<th class="sortable ' + cls + '" data-key="' + key + '">' + label + arrow + '</th>';
  }
  function render() {
    var rows = DATA.sessions.slice().sort(function (a, b) {
      return (a[sortState.key] - b[sortState.key]) * sortState.dir;
    }).slice(0, 200);
    var head = '<thead><tr>' +
      '<th class="l">Session</th><th class="l">项目</th><th class="l">模型</th>' +
      '<th>Input</th><th>Output</th><th>CacheRead</th>' +
      '<th>请求数</th>' + th('first', '开始', 'l') + th('last', '结束', 'l') + th('total', 'Total', '') + '</tr></thead>';
    var body = rows.map(function (s) {
      return '<tr>' +
        '<td class="l mono" title="' + s.sessionId + '">' + s.sessionId.replace('session_', '').slice(0, 8) + '…</td>' +
        '<td class="l" title="' + s.workDir + '">' + s.project + '</td>' +
        '<td class="l mono" title="' + s.models.join(', ') + '">' + (s.models.length > 1 ? s.models.length + ' 个模型' : s.models[0]) + '</td>' +
        '<td>' + fmt(s.input) + '</td><td>' + fmt(s.output) + '</td><td>' + fmt(s.cacheRead) + '</td>' +
        '<td>' + fmt(s.requests) + '</td>' +
        '<td class="l mono">' + fmtTime(s.first) + '</td><td class="l mono">' + fmtTime(s.last) + '</td>' +
        '<td><b>' + fmt(s.total) + '</b></td></tr>';
    }).join('');
    table.innerHTML = head + '<tbody>' + body + '</tbody>';
  }
  table.addEventListener('click', function (e) {
    var t = e.target.closest('th.sortable');
    if (!t) return;
    var key = t.getAttribute('data-key');
    if (sortState.key === key) sortState.dir = -sortState.dir;
    else { sortState.key = key; sortState.dir = -1; }
    render();
  });
  render();
})();

}
renderAll.charts = {};
window.addEventListener('resize', function () {
  Object.keys(renderAll.charts).forEach(function (id) { renderAll.charts[id].resize(); });
});
renderAll(__DATA__);
</script>
__LIVE__
</body>
</html>
`;

function renderHtml(dataJson, live) {
  return HTML_TEMPLATE
    .replace('__DATA__', dataJson)
    .replace('__LIVE__', live ? LIVE_SCRIPT : '');
}

function safeJson(data) {
  return JSON.stringify(data).replace(/</g, '\\u003c');
}

// ---------------------------------------------------------------- 扫描与状态

function createState(home) {
  return {
    home,
    sessionsRoot: path.join(home, 'sessions'),
    indexPath: path.join(home, 'session_index.jsonl'),
    sessionIndex: new Map(),
    indexMtime: 0,
    records: [],        // [{ sid, rec }]
    fileStates: new Map(), // wirePath -> { offset, lineBuf }
    dataJson: '{}',
    data: null,
    quota: null,       // 最近一次成功的额度快照（parseQuota 返回值），失败为 null
    quotaOk: null,     // 上次额度刷新是否成功（用于状态切换时打一行日志）
  };
}

function reloadIndexIfNeeded(state) {
  let mtime = 0;
  try { mtime = fs.statSync(state.indexPath).mtimeMs; } catch { /* 无索引 */ }
  if (mtime !== state.indexMtime) {
    state.sessionIndex = loadSessionIndex(state.indexPath);
    state.indexMtime = mtime;
    return true;
  }
  return false;
}

/** 扫描全部 wire.jsonl 的新增内容；返回新增记录条数 */
function pollWireFiles(state) {
  const files = walkWireFiles(state.sessionsRoot);
  let added = 0;
  for (const f of files) {
    let st = state.fileStates.get(f);
    if (!st) { st = { offset: 0, lineBuf: Buffer.alloc(0) }; state.fileStates.set(f, st); }
    const lines = readNewLines(f, st);
    if (!lines.length) continue;
    const sid = sessionIdFromPath(f);
    for (const line of lines) {
      const rec = parseUsageLine(line);
      if (rec) { state.records.push({ sid, rec }); added++; }
    }
  }
  return added;
}

function fullScan(state) {
  const t0 = Date.now();
  reloadIndexIfNeeded(state);
  const added = pollWireFiles(state);
  return { added, elapsed: ((Date.now() - t0) / 1000).toFixed(1), files: state.fileStates.size };
}

// ---------------------------------------------------------------- 浏览器

function openBrowser(url) {
  const cmd = process.platform === 'win32'
    ? `start "" "${url}"`
    : process.platform === 'darwin'
      ? `open "${url}"`
      : `xdg-open "${url}"`;
  exec(cmd, () => { /* 忽略失败 */ });
}

// ---------------------------------------------------------------- 主流程

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) { console.log(HELP); process.exit(0); }

  const home = resolveHome(args.home);
  if (!fs.existsSync(home) || !fs.statSync(home).isDirectory()) {
    console.error(`错误：数据目录不存在: ${home}`);
    console.error('可用 --home 或 KIMI_CODE_HOME 环境变量指定 Kimi Code 数据根目录。');
    process.exit(1);
  }

  const state = createState(home);
  console.log(`数据目录: ${home}`);
  console.log('正在扫描 wire.jsonl …');
  const scan = fullScan(state);
  console.log(`扫描完成：${scan.files} 个 wire.jsonl，${state.records.length} 条 turn 级记录（${scan.elapsed}s）`);

  // --export：静态导出后退出
  if (args.export) {
    refreshQuotaOnce(state).then(() => { // 导出时刻的额度快照；失败为 null，导出不带额度卡
      const data = buildData(state, args.days);
      const html = renderHtml(safeJson(data), false);
      const out = path.resolve(args.export);
      fs.mkdirSync(path.dirname(out), { recursive: true });
      fs.writeFileSync(out, html, 'utf8');
      const k = data.kpi;
      console.log(`\n=== 汇总（最近 ${args.days} 天，${data.dateRange}） ===`);
      console.log(`本周(7天) total : ${k.weekTotal.toLocaleString('en-US')}`);
      console.log(`今日 total      : ${k.todayTotal.toLocaleString('en-US')}`);
      console.log(`总缓存命中率    : ${(k.cacheHitRate * 100).toFixed(1)}%`);
      console.log(`活跃会话数      : ${k.activeSessions}`);
      if (data.quota) {
        console.log(`\n=== 额度（导出时刻） ===`);
        for (const r of data.quota.rows) console.log(`  ${r.label}: ${(r.ratio * 100).toFixed(1)}%（${r.used}/${r.limit}）`);
      }
      console.log(`\n已导出: ${out}`);
      process.exit(0);
    });
    return;
  }

  // 服务模式
  const clients = new Set();
  let idleTimer = null;

  function refreshData() {
    state.data = buildData(state, args.days);
    state.dataJson = safeJson(state.data);
  }
  refreshData();

  function broadcast() {
    const frame = `data: ${state.dataJson}\n\n`;
    for (const res of clients) {
      try { res.write(frame); } catch { /* 客户端异常由 close 处理 */ }
    }
  }

  function armIdle() {
    if (idleTimer || clients.size > 0) return;
    idleTimer = setTimeout(() => {
      console.log('\n浏览器连接已全部断开超过 ' + Math.round(IDLE_MS / 1000) + ' 秒，自动退出。');
      process.exit(0);
    }, IDLE_MS);
    if (idleTimer.unref) idleTimer.unref();
  }

  const server = http.createServer((req, res) => {
    const url = (req.url || '/').split('?')[0];
    if (url === '/events') {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
      });
      res.write(`data: ${state.dataJson}\n\n`); // 初始数据帧
      clients.add(res);
      if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; }
      req.on('close', () => { clients.delete(res); armIdle(); });
      return;
    }
    if (url === '/' || url === '/index.html') {
      const html = renderHtml(state.dataJson, true);
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(html);
      return;
    }
    res.writeHead(404); res.end('not found');
  });

  server.on('error', (err) => {
    console.error(`服务启动失败: ${err.message}`);
    process.exit(1);
  });

  server.listen(args.port, '127.0.0.1', () => {
    const port = server.address().port;
    const url = `http://127.0.0.1:${port}/`;
    console.log(`\nDashboard 已启动: ${url}`);
    console.log('每 2 秒检测新用量并实时推送到页面。按 Ctrl+C 停止。');
    if (args.open) {
      openBrowser(url);
      armIdle(); // 浏览器一直打不开时也能自动退出
    }
  });

  // 心跳，防止代理/浏览器断开空闲 SSE
  const heartbeat = setInterval(() => {
    for (const res of clients) { try { res.write(': ping\n\n'); } catch { /* ignore */ } }
  }, 15000);
  if (heartbeat.unref) heartbeat.unref();

  // 增量轮询
  const poll = setInterval(() => {
    const indexChanged = reloadIndexIfNeeded(state);
    const added = pollWireFiles(state);
    if (added > 0 || indexChanged) {
      refreshData();
      if (clients.size > 0) broadcast();
      const k = state.data.kpi;
      console.log(`[+${added} 条] 今日 ${k.todayTotal.toLocaleString('en-US')} tokens · 推送 ${clients.size} 个页面`);
    }
  }, POLL_MS);
  if (poll.unref) poll.unref();

  // 额度轮询（独立于日志扫描）；额度数据变化时重建数据帧并随 SSE 推送
  async function pollQuota() {
    const prev = state.quota && state.quota.fetchedAt;
    await refreshQuotaOnce(state);
    if ((state.quota && state.quota.fetchedAt) !== prev) {
      refreshData();
      if (clients.size > 0) broadcast();
    }
  }
  pollQuota();
  const quotaTimer = setInterval(pollQuota, QUOTA_POLL_MS);
  if (quotaTimer.unref) quotaTimer.unref();

  process.on('SIGINT', () => {
    console.log('\n已停止。');
    process.exit(0);
  });
}

main();
