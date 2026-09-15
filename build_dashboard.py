#!/usr/bin/env python3
"""Zero-dependency local usage analytics dashboard for Kimi Code CLI.

Scans wire.jsonl session logs under ~/.kimi-code (override with the
KIMI_CODE_HOME env var or --home) and generates a self-contained HTML report.

Usage: python build_dashboard.py [--days N] [--home PATH] [--out FILE] [--open]
"""

import argparse
import json
import os
import sys
import time
from collections import defaultdict
from datetime import datetime, timedelta
from pathlib import Path

CACHE_FILE = Path(__file__).resolve().parent / ".usage-cache.json"
SCRIPT_DIR = Path(__file__).resolve().parent

USAGE_MARK = b'"usage.record"'


def resolve_home(cli_home=None):
    """Kimi Code data root: --home > $KIMI_CODE_HOME > ~/.kimi-code."""
    if cli_home:
        return Path(cli_home).expanduser()
    env = os.environ.get("KIMI_CODE_HOME")
    if env:
        return Path(env).expanduser()
    return Path.home() / ".kimi-code"


def load_session_index(index_path):
    """sessionId -> workDir"""
    mapping = {}
    if not index_path.exists():
        return mapping
    with open(index_path, "r", encoding="utf-8", errors="replace") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                rec = json.loads(line)
            except json.JSONDecodeError:
                continue
            sid = rec.get("sessionId")
            wd = rec.get("workDir")
            if sid and wd:
                mapping[sid] = wd
    return mapping


def find_wire_files(sessions_root):
    files = []
    if not sessions_root.is_dir():
        return files
    for root, _dirs, names in os.walk(sessions_root):
        if "wire.jsonl" in names:
            files.append(os.path.join(root, "wire.jsonl"))
    return files


def session_id_from_path(path):
    parts = Path(path).parts
    for p in parts:
        if p.startswith("session_"):
            return p
    return "(unknown)"


def parse_wire_file(path):
    """流式逐行扫描，返回 turn 级 usage.record 列表。

    每条记录: [time_ms, model, input, output, cacheRead, cacheCreation]
    """
    records = []
    with open(path, "rb") as f:
        for line in f:
            if USAGE_MARK not in line:
                continue
            try:
                rec = json.loads(line)
            except (json.JSONDecodeError, UnicodeDecodeError):
                continue
            if rec.get("type") != "usage.record":
                continue
            if rec.get("usageScope") != "turn":
                continue
            usage = rec.get("usage") or {}
            t = rec.get("time")
            if not isinstance(t, (int, float)):
                continue
            records.append([
                int(t),
                rec.get("model") or "(unknown)",
                int(usage.get("inputOther") or 0),
                int(usage.get("output") or 0),
                int(usage.get("inputCacheRead") or 0),
                int(usage.get("inputCacheCreation") or 0),
            ])
    return records


def load_cache():
    try:
        with open(CACHE_FILE, "r", encoding="utf-8") as f:
            data = json.load(f)
        if isinstance(data, dict) and data.get("version") == 1 and isinstance(data.get("files"), dict):
            return data["files"]
    except (OSError, json.JSONDecodeError):
        pass
    return {}


def save_cache(files):
    tmp = CACHE_FILE.with_suffix(".tmp")
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump({"version": 1, "files": files}, f)
    os.replace(tmp, CACHE_FILE)


def collect_records(days, sessions_root):
    """返回 [(session_id, record), ...]，record 为 parse_wire_file 的行格式。"""
    wire_files = find_wire_files(sessions_root)
    cache = load_cache()
    new_cache = {}
    parsed = 0
    skipped = 0
    all_rows = []  # (session_id, record)
    cutoff = time.time() - days * 86400

    for path in wire_files:
        try:
            st = os.stat(path)
        except OSError:
            continue
        key = os.path.normcase(os.path.abspath(path))
        entry = cache.get(key)
        if entry and entry.get("mtime") == st.st_mtime and entry.get("size") == st.st_size:
            records = entry["records"]
            skipped += 1
        else:
            records = parse_wire_file(path)
            parsed += 1
        new_cache[key] = {"mtime": st.st_mtime, "size": st.st_size, "records": records}
        sid = session_id_from_path(path)
        for r in records:
            if r[0] >= cutoff * 1000:
                all_rows.append((sid, r))

    save_cache(new_cache)
    print(f"wire.jsonl 共 {len(wire_files)} 个：命中缓存 {skipped}，重新解析 {parsed}")
    return all_rows


def aggregate(rows, days, session_index):
    today = datetime.now().date()
    day_list = [(today - timedelta(days=i)) for i in range(days - 1, -1, -1)]
    day_strs = [d.isoformat() for d in day_list]
    day_set = set(day_strs)

    daily = {d: {"input": 0, "output": 0, "cacheRead": 0, "cacheCreation": 0, "requests": 0}
             for d in day_strs}
    daily_model = defaultdict(lambda: defaultdict(int))   # date -> model -> total
    model_total = defaultdict(int)
    project_total = defaultdict(int)                       # (basename, fullpath) -> total
    heatmap = [[0] * 24 for _ in range(7)]                 # weekday(周一=0) -> hour -> total
    sessions = {}

    for sid, (t_ms, model, inp, out, cr, cc) in rows:
        dt = datetime.fromtimestamp(t_ms / 1000)
        d = dt.date().isoformat()
        if d not in day_set:
            continue
        total = inp + out + cr + cc
        dd = daily[d]
        dd["input"] += inp
        dd["output"] += out
        dd["cacheRead"] += cr
        dd["cacheCreation"] += cc
        dd["requests"] += 1
        daily_model[d][model] += total
        model_total[model] += total
        wd = session_index.get(sid, "(unknown)")
        if wd == "(unknown)":
            proj = "(unknown)"
        else:
            proj = os.path.basename(wd.rstrip("/\\")) or wd
        project_total[(proj, wd)] += total
        heatmap[dt.weekday()][dt.hour] += total

        s = sessions.setdefault(sid, {
            "sessionId": sid, "project": proj, "workDir": wd, "models": set(),
            "input": 0, "output": 0, "cacheRead": 0, "cacheCreation": 0,
            "requests": 0, "first": t_ms, "last": t_ms, "total": 0,
        })
        s["models"].add(model)
        s["input"] += inp
        s["output"] += out
        s["cacheRead"] += cr
        s["cacheCreation"] += cc
        s["requests"] += 1
        s["first"] = min(s["first"], t_ms)
        s["last"] = max(s["last"], t_ms)
        s["total"] += total

    # 每日汇总
    daily_out = []
    for d in day_strs:
        dd = daily[d]
        denom = dd["input"] + dd["cacheRead"] + dd["cacheCreation"]
        hit = dd["cacheRead"] / denom if denom else 0
        daily_out.append({
            "date": d,
            "input": dd["input"], "output": dd["output"],
            "cacheRead": dd["cacheRead"], "cacheCreation": dd["cacheCreation"],
            "total": dd["input"] + dd["output"] + dd["cacheRead"] + dd["cacheCreation"],
            "requests": dd["requests"],
            "cacheHitRate": round(hit, 4),
        })

    # 模型列表（按总量降序）
    models = sorted(model_total, key=model_total.get, reverse=True)
    daily_model_out = {d: [daily_model[d].get(m, 0) for m in models] for d in day_strs}

    model_rank = [{"model": m, "total": model_total[m]} for m in models]

    project_rank = [
        {"name": k[0], "path": k[1], "total": v}
        for k, v in sorted(project_total.items(), key=lambda kv: kv[1], reverse=True)
    ]

    session_rows = sorted(sessions.values(), key=lambda s: s["total"], reverse=True)
    session_out = [{
        "sessionId": s["sessionId"],
        "project": s["project"],
        "workDir": s["workDir"],
        "models": sorted(s["models"]),
        "input": s["input"], "output": s["output"],
        "cacheRead": s["cacheRead"], "cacheCreation": s["cacheCreation"],
        "requests": s["requests"],
        "first": s["first"], "last": s["last"],
        "total": s["total"],
    } for s in session_rows]

    # KPI
    week_total = sum(d["total"] for d in daily_out[-7:])
    prev_week_total = sum(d["total"] for d in daily_out[-14:-7]) if days >= 14 else 0
    today_total = daily_out[-1]["total"]
    sum_input = sum(d["input"] for d in daily_out)
    sum_cr = sum(d["cacheRead"] for d in daily_out)
    sum_cc = sum(d["cacheCreation"] for d in daily_out)
    denom = sum_input + sum_cr + sum_cc
    overall_hit = sum_cr / denom if denom else 0
    wow = ((week_total - prev_week_total) / prev_week_total) if prev_week_total else None

    kpi = {
        "weekTotal": week_total,
        "prevWeekTotal": prev_week_total,
        "weekOverWeek": round(wow, 4) if wow is not None else None,
        "todayTotal": today_total,
        "cacheHitRate": round(overall_hit, 4),
        "activeSessions": len(sessions),
    }

    return {
        "generatedAt": datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
        "days": days,
        "dateRange": f"{day_strs[0]} ~ {day_strs[-1]}",
        "dayList": day_strs,
        "daily": daily_out,
        "models": models,
        "dailyModel": daily_model_out,
        "modelRank": model_rank,
        "projectRank": project_rank,
        "heatmap": heatmap,
        "sessions": session_out,
        "kpi": kpi,
    }


HTML_TEMPLATE = r"""<!DOCTYPE html>
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
  .kpi-row { display: flex; gap: 16px; flex-wrap: wrap; margin-bottom: 24px; }
  .kpi-card {
    flex: 1 1 160px; background: #161a22; border: 1px solid #232836;
    border-radius: 10px; padding: 16px 18px;
  }
  .kpi-card .label { font-size: 12px; color: #7a8194; margin-bottom: 8px; }
  .kpi-card .value { font-size: 24px; font-weight: 600; color: #f0f2f5; font-variant-numeric: tabular-nums; }
  .kpi-card .sub { font-size: 12px; margin-top: 6px; color: #7a8194; }
  .kpi-card .sub.up { color: #4cc38a; }
  .kpi-card .sub.down { color: #e5484d; }
  .grid { display: grid; grid-template-columns: 1fr 1fr; gap: 20px; }
  .card {
    background: #161a22; border: 1px solid #232836; border-radius: 10px;
    padding: 18px; margin-bottom: 20px;
  }
  .card h2 { font-size: 15px; font-weight: 600; color: #c9cedb; margin-bottom: 12px; }
  .chart { width: 100%; height: 320px; }
  .chart.tall { height: 380px; }
  .full { grid-column: 1 / -1; }
  table { width: 100%; border-collapse: collapse; font-size: 12px; font-variant-numeric: tabular-nums; }
  th, td { padding: 7px 10px; text-align: right; border-bottom: 1px solid #232836; white-space: nowrap; }
  th { color: #7a8194; font-weight: 500; position: sticky; top: 0; background: #161a22; }
  td.l, th.l { text-align: left; }
  tbody tr:hover { background: #1c2130; }
  .table-wrap { max-height: 560px; overflow-y: auto; }
  .mono { font-family: Consolas, monospace; font-size: 11px; color: #8a91a5; }
  @media (max-width: 1100px) { .grid { grid-template-columns: 1fr; } }
</style>
</head>
<body>
<header>
  <h1>Kimi Code 用量 Dashboard</h1>
  <div class="meta" id="meta"></div>
</header>

<div class="kpi-row" id="kpiRow"></div>

<div class="grid">
  <div class="card full"><h2>每日 Token 趋势</h2><div id="chartDaily" class="chart tall"></div></div>
  <div class="card"><h2>模型占比</h2><div id="chartModelPie" class="chart"></div></div>
  <div class="card"><h2>每日 × 模型</h2><div id="chartModelDaily" class="chart"></div></div>
  <div class="card"><h2>缓存命中率（按日）</h2><div id="chartHitRate" class="chart"></div></div>
  <div class="card"><h2>项目排行（Top 15）</h2><div id="chartProjects" class="chart"></div></div>
  <div class="card full"><h2>星期 × 小时 热力图</h2><div id="chartHeatmap" class="chart"></div></div>
  <div class="card full"><h2>会话明细（按 total 降序，最多 200 行）</h2>
    <div class="table-wrap"><table id="sessionTable"></table></div>
  </div>
</div>

<script>
const DATA = __DATA__;

const fmt = n => (n == null ? "-" : Math.round(n).toLocaleString("en-US"));
const fmtPct = x => (x == null ? "-" : (x * 100).toFixed(1) + "%");
const abbrev = v => {
  if (v >= 1e9) return (v / 1e9).toFixed(1) + "B";
  if (v >= 1e6) return (v / 1e6).toFixed(1) + "M";
  if (v >= 1e3) return (v / 1e3).toFixed(0) + "K";
  return v;
};
const fmtTime = ms => {
  const d = new Date(ms);
  const p = n => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth()+1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
};

document.getElementById("meta").textContent =
  `数据范围：${DATA.dateRange}（最近 ${DATA.days} 天） · 生成时间：${DATA.generatedAt} · 数据源：~/.kimi-code/sessions`;

// KPI 卡片
(function () {
  const k = DATA.kpi;
  let wowHtml = "-", wowCls = "";
  if (k.weekOverWeek != null) {
    const pct = (k.weekOverWeek * 100).toFixed(1);
    wowCls = k.weekOverWeek >= 0 ? "up" : "down";
    wowHtml = `${k.weekOverWeek >= 0 ? "+" : ""}${pct}% vs 上周`;
  }
  const cards = [
    ["本周 Tokens（7 天）", fmt(k.weekTotal), ""],
    ["今日 Tokens", fmt(k.todayTotal), ""],
    ["总缓存命中率", fmtPct(k.cacheHitRate), ""],
    ["活跃会话数", fmt(k.activeSessions), ""],
    ["上周同期", fmt(k.prevWeekTotal), `<span class="${wowCls}">${wowHtml}</span>`],
  ];
  document.getElementById("kpiRow").innerHTML = cards.map(([label, value, sub]) =>
    `<div class="kpi-card"><div class="label">${label}</div><div class="value">${value}</div><div class="sub">${sub}</div></div>`
  ).join("");
})();

const baseAxis = {
  axisLabel: { color: "#8a91a5" },
  axisLine: { lineStyle: { color: "#2a3040" } },
  splitLine: { lineStyle: { color: "#1e2330" } },
};
const baseTooltip = { backgroundColor: "#1c2130", borderColor: "#2a3040", textStyle: { color: "#d6d9e0" } };
const charts = [];
function make(id, option) {
  const c = echarts.init(document.getElementById(id), null, { renderer: "canvas" });
  c.setOption(option);
  charts.push(c);
}
window.addEventListener("resize", () => charts.forEach(c => c.resize()));

const days = DATA.dayList;
const shortDays = days.map(d => d.slice(5));

// 1. 每日 token 趋势（堆叠柱）
make("chartDaily", {
  tooltip: { ...baseTooltip, trigger: "axis",
    formatter: ps => {
      const i = ps[0].dataIndex, d = DATA.daily[i];
      let html = `<b>${d.date}</b><br>`;
      ps.forEach(p => { html += `${p.marker}${p.seriesName}: ${fmt(p.value)}<br>`; });
      html += `合计: ${fmt(d.total)}<br>请求数: ${fmt(d.requests)}<br>缓存命中率: ${fmtPct(d.cacheHitRate)}`;
      return html;
    } },
  legend: { textStyle: { color: "#8a91a5" } },
  grid: { left: 60, right: 20, top: 40, bottom: 30 },
  xAxis: { type: "category", data: shortDays, ...baseAxis },
  yAxis: { type: "value", axisLabel: { ...baseAxis.axisLabel, formatter: abbrev }, splitLine: baseAxis.splitLine },
  series: [
    { name: "input", type: "bar", stack: "t", data: DATA.daily.map(d => d.input), itemStyle: { color: "#5b8def" } },
    { name: "output", type: "bar", stack: "t", data: DATA.daily.map(d => d.output), itemStyle: { color: "#4cc38a" } },
    { name: "cacheRead", type: "bar", stack: "t", data: DATA.daily.map(d => d.cacheRead), itemStyle: { color: "#9b7ede" } },
    { name: "cacheCreation", type: "bar", stack: "t", data: DATA.daily.map(d => d.cacheCreation), itemStyle: { color: "#e5a545" } },
  ],
});

// 2. 模型占比饼图
const topModels = DATA.modelRank.slice(0, 8);
const otherTotal = DATA.modelRank.slice(8).reduce((s, m) => s + m.total, 0);
const pieData = topModels.map(m => ({ name: m.model, value: m.total }));
if (otherTotal > 0) pieData.push({ name: "其他", value: otherTotal });
make("chartModelPie", {
  tooltip: { ...baseTooltip, formatter: p => `${p.name}<br>${fmt(p.value)} (${p.percent}%)` },
  legend: { type: "scroll", bottom: 0, textStyle: { color: "#8a91a5", fontSize: 11 } },
  series: [{
    type: "pie", radius: ["38%", "65%"], center: ["50%", "45%"],
    label: { color: "#8a91a5", fontSize: 11, formatter: "{b}" },
    data: pieData,
  }],
});

// 3. 每日 × 模型 堆叠柱
const piePalette = ["#5b8def", "#4cc38a", "#9b7ede", "#e5a545", "#e5484d", "#3bc9db", "#f47ab8", "#94a3b8"];
make("chartModelDaily", {
  tooltip: { ...baseTooltip, trigger: "axis",
    formatter: ps => {
      let html = `<b>${days[ps[0].dataIndex]}</b><br>`;
      ps.forEach(p => { if (p.value) html += `${p.marker}${p.seriesName}: ${fmt(p.value)}<br>`; });
      return html;
    } },
  legend: { type: "scroll", top: 0, textStyle: { color: "#8a91a5", fontSize: 11 } },
  grid: { left: 60, right: 20, top: 40, bottom: 30 },
  xAxis: { type: "category", data: shortDays, ...baseAxis },
  yAxis: { type: "value", axisLabel: { ...baseAxis.axisLabel, formatter: abbrev }, splitLine: baseAxis.splitLine },
  series: DATA.models.map((m, i) => ({
    name: m, type: "bar", stack: "m",
    data: days.map(d => DATA.dailyModel[d][i]),
    itemStyle: { color: piePalette[i % piePalette.length] },
  })),
});

// 4. 缓存命中率折线
make("chartHitRate", {
  tooltip: { ...baseTooltip, trigger: "axis",
    formatter: ps => `${days[ps[0].dataIndex]}<br>命中率: ${(ps[0].value * 100).toFixed(1)}%` },
  grid: { left: 50, right: 20, top: 30, bottom: 30 },
  xAxis: { type: "category", data: shortDays, ...baseAxis },
  yAxis: { type: "value", min: 0, max: 1, axisLabel: { ...baseAxis.axisLabel, formatter: v => (v * 100).toFixed(0) + "%" }, splitLine: baseAxis.splitLine },
  series: [{
    type: "line", smooth: true, data: DATA.daily.map(d => d.cacheHitRate),
    lineStyle: { color: "#4cc38a", width: 2 }, itemStyle: { color: "#4cc38a" },
    areaStyle: { color: "rgba(76,195,138,0.12)" },
  }],
});

// 5. 项目排行横向条形图
(function () {
  const top = DATA.projectRank.slice(0, 15).reverse();
  make("chartProjects", {
    tooltip: { ...baseTooltip, formatter: p => `${top[p.dataIndex].path}<br>${fmt(p.value)}` },
    grid: { left: 10, right: 60, top: 10, bottom: 10, containLabel: true },
    xAxis: { type: "value", axisLabel: { ...baseAxis.axisLabel, formatter: abbrev }, splitLine: baseAxis.splitLine },
    yAxis: { type: "category", data: top.map(p => p.name), ...baseAxis, axisLabel: { ...baseAxis.axisLabel, width: 140, overflow: "truncate" } },
    series: [{
      type: "bar", data: top.map(p => p.total), itemStyle: { color: "#5b8def", borderRadius: [0, 3, 3, 0] },
      label: { show: true, position: "right", color: "#8a91a5", formatter: p => abbrev(p.value) },
    }],
  });
})();

// 6. 星期 × 小时 热力图
(function () {
  const weekNames = ["周一", "周二", "周三", "周四", "周五", "周六", "周日"];
  const hours = Array.from({ length: 24 }, (_, i) => i + "时");
  const data = [];
  let max = 0;
  DATA.heatmap.forEach((row, wd) => row.forEach((v, h) => {
    data.push([h, wd, v]);
    if (v > max) max = v;
  }));
  make("chartHeatmap", {
    tooltip: { ...baseTooltip, formatter: p => `${weekNames[p.value[1]]} ${p.value[0]}时<br>${fmt(p.value[2])} tokens` },
    grid: { left: 60, right: 20, top: 10, bottom: 60 },
    xAxis: { type: "category", data: hours, ...baseAxis, splitArea: { show: false } },
    yAxis: { type: "category", data: weekNames, ...baseAxis },
    visualMap: {
      min: 0, max: max || 1, calculable: true, orient: "horizontal",
      left: "center", bottom: 0, textStyle: { color: "#8a91a5" },
      inRange: { color: ["#161a22", "#1f3a5f", "#2f6bc4", "#5b8def", "#9db9f5"] },
      formatter: v => abbrev(v),
    },
    series: [{ type: "heatmap", data, label: { show: false }, itemStyle: { borderColor: "#0f1115", borderWidth: 1 } }],
  });
})();

// 7. 会话明细表
(function () {
  const rows = DATA.sessions.slice(0, 200);
  const head = `<thead><tr>
    <th class="l">Session</th><th class="l">项目</th><th class="l">模型</th>
    <th>Input</th><th>Output</th><th>CacheRead</th><th>CacheCreation</th>
    <th>请求数</th><th class="l">开始</th><th class="l">结束</th><th>Total</th></tr></thead>`;
  const body = rows.map(s => `<tr>
    <td class="l mono" title="${s.sessionId}">${s.sessionId.replace("session_", "").slice(0, 8)}…</td>
    <td class="l" title="${s.workDir}">${s.project}</td>
    <td class="l mono" title="${s.models.join(", ")}">${s.models.length > 1 ? s.models.length + " 个模型" : s.models[0]}</td>
    <td>${fmt(s.input)}</td><td>${fmt(s.output)}</td><td>${fmt(s.cacheRead)}</td><td>${fmt(s.cacheCreation)}</td>
    <td>${fmt(s.requests)}</td>
    <td class="l mono">${fmtTime(s.first)}</td><td class="l mono">${fmtTime(s.last)}</td>
    <td><b>${fmt(s.total)}</b></td></tr>`).join("");
  document.getElementById("sessionTable").innerHTML = head + `<tbody>${body}</tbody>`;
})();
</script>
</body>
</html>
"""


def main():
    ap = argparse.ArgumentParser(description="Kimi Code 本地用量 Dashboard 生成器")
    ap.add_argument("--days", type=int, default=30, help="统计最近 N 天（默认 30）")
    ap.add_argument("--home", help="Kimi Code 数据根目录（默认 $KIMI_CODE_HOME 或 ~/.kimi-code）")
    ap.add_argument("--open", action="store_true", help="生成后用默认浏览器打开")
    ap.add_argument("--out", default=str(SCRIPT_DIR / "dashboard.html"), help="输出 HTML 路径")
    args = ap.parse_args()

    t0 = time.time()
    home = resolve_home(args.home)
    if not home.is_dir():
        print(f"错误：数据目录不存在: {home}", file=sys.stderr)
        return 1
    session_index = load_session_index(home / "session_index.jsonl")
    print(f"数据目录: {home}")
    print(f"session_index: {len(session_index)} 条")

    rows = collect_records(args.days, home / "sessions")
    print(f"最近 {args.days} 天 turn 级记录: {len(rows)} 条")

    data = aggregate(rows, args.days, session_index)

    html = HTML_TEMPLATE.replace("__DATA__", json.dumps(data, ensure_ascii=False))
    out_path = Path(args.out)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    with open(out_path, "w", encoding="utf-8") as f:
        f.write(html)

    elapsed = time.time() - t0
    k = data["kpi"]
    print(f"\n=== 汇总（最近 {args.days} 天，{data['dateRange']}） ===")
    print(f"本周(7天) total : {k['weekTotal']:,}")
    print(f"上周同期 total  : {k['prevWeekTotal']:,}  (环比 {('%+.1f%%' % (k['weekOverWeek']*100)) if k['weekOverWeek'] is not None else '-'})")
    print(f"今日 total      : {k['todayTotal']:,}")
    print(f"总缓存命中率    : {k['cacheHitRate']*100:.1f}%")
    print(f"活跃会话数      : {k['activeSessions']:,}")
    print(f"模型数          : {len(data['models'])}")
    print(f"\n输出: {out_path}  ({elapsed:.1f}s)")

    if args.open:
        import webbrowser
        webbrowser.open(out_path.as_uri())


if __name__ == "__main__":
    sys.exit(main())
