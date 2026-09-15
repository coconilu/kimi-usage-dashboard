# kimi-usage-dashboard

[English](#english) · [中文](#中文)

<a id="english"></a>

A zero-dependency local usage analytics dashboard for **Kimi Code CLI** — a single Python file that scans your local `wire.jsonl` session logs and generates a self-contained HTML report. All data stays on your machine.

![screenshot](docs/screenshot.png)

## Features

- 📈 Daily token trend (stacked input / output / cache-read / cache-creation, with request counts and cache hit rate)
- 🥧 Model breakdown — share pie chart plus per-day × per-model stacked bars
- 💾 Daily cache hit-rate line (see how much the prompt cache saves you)
- 🗂️ Project ranking (Top 15, aggregated by `workDir`)
- 🌡️ Weekday × hour heatmap of your coding rhythm
- 📋 Per-session detail table (tokens, models, requests, first/last activity)
- ⚡ Incremental cache — first full scan takes seconds, refreshes are sub-second
- 🐍 Pure Python standard library, zero dependencies; the report is one self-contained HTML file
- 🔒 100% local — nothing is uploaded anywhere

## Quickstart

Requires **Python 3.8+**, works on Windows / macOS / Linux.

```bash
python build_dashboard.py --days 30 --open
```

This writes `dashboard.html` next to the script and opens it in your browser (drop `--open` to skip). Options:

| Flag | Default | Description |
|---|---|---|
| `--days N` | `30` | Only include the last N days |
| `--home PATH` | `$KIMI_CODE_HOME` or `~/.kimi-code` | Kimi Code data root |
| `--out FILE` | `./dashboard.html` | Output HTML path |
| `--open` | off | Open the report in the default browser |

## Data source

Kimi Code CLI stores full session transcripts locally under `~/.kimi-code/sessions/`. Each session has `agents/<agentId>/wire.jsonl` files (sub-agents included) containing `usage.record` entries with per-turn token usage; `~/.kimi-code/session_index.jsonl` maps sessions to their working directory (the "project" dimension). The script streams every `wire.jsonl` line-by-line, keeps only turn-level usage records, and aggregates them. Set the `KIMI_CODE_HOME` environment variable (or pass `--home`) if your data lives elsewhere.

An incremental cache (`.usage-cache.json`, keyed by file mtime+size) makes repeat runs nearly instant; delete it to force a full rescan.

## Why not ccusage?

[ccusage](https://github.com/ryoppippi/ccusage) is an excellent multi-tool CLI usage analyzer. This project deliberately focuses on **Kimi Code only** and goes deeper on visualization: per-model-per-day breakdowns, project and session dimensions, cache hit-rate tracking, and the weekday×hour heatmap. [KimiCodeBar](https://github.com/fashioncj/KimiCodeBar) is a always-on tray quota monitor; this is an on-demand analytical report. They complement each other.

## Known limitations

- **Cost estimates and weekly quota percentages are server-side data.** Local logs contain token counts only — check `/usage` in the CLI or the Kimi Code Console for billing and quota.

## Roadmap

- [ ] Cost estimation (via LiteLLM pricing data)
- [ ] `--watch` mode with auto-refresh
- [ ] More export formats (CSV / JSON)

## License

[MIT](LICENSE) © 2026 coconilu

---

<a id="中文"></a>

# kimi-usage-dashboard（中文说明）

**Kimi Code 专用的零依赖本地用量分析 Dashboard** —— 一个 Python 文件，扫描本地 `wire.jsonl` 会话日志，生成自包含的 HTML 报告。数据不出本机。

## 功能特性

- 📈 每日 token 趋势（input / output / cacheRead / cacheCreation 堆叠，附请求数与缓存命中率）
- 🥧 模型维度：占比饼图 + 每日 × 模型堆叠柱状图
- 💾 缓存命中率折线（按日）
- 🗂️ 项目排行 Top 15（按 workDir 聚合）
- 🌡️ 星期 × 小时热力图（你的编码节奏一目了然）
- 📋 会话明细表（token、模型、请求数、首末时间）
- ⚡ 增量缓存：首次全量秒级完成，之后刷新亚秒级
- 🐍 纯标准库零依赖；产物是单个自包含 HTML 文件
- 🔒 完全本地运行，无任何数据上传

## 快速开始

需要 **Python 3.8+**，支持 Windows / macOS / Linux。

```bash
python build_dashboard.py --days 30 --open
```

生成 `dashboard.html` 并用默认浏览器打开（去掉 `--open` 则不打开）。参数说明：

| 参数 | 默认值 | 说明 |
|---|---|---|
| `--days N` | `30` | 只统计最近 N 天 |
| `--home PATH` | `$KIMI_CODE_HOME` 或 `~/.kimi-code` | Kimi Code 数据根目录 |
| `--out FILE` | `./dashboard.html` | 输出 HTML 路径 |
| `--open` | 关 | 生成后自动打开 |

## 数据源

Kimi Code CLI 把每个会话的完整记录存在本地 `~/.kimi-code/sessions/` 下。每个会话目录的 `agents/<agentId>/wire.jsonl`（含子代理）里有 `usage.record` 用量记录；`~/.kimi-code/session_index.jsonl` 提供 sessionId → workDir 的映射（即「项目」维度）。脚本流式逐行扫描所有 wire.jsonl，只取 turn 级记录做聚合。数据目录不在默认位置时，用 `KIMI_CODE_HOME` 环境变量或 `--home` 参数指定。

同目录的 `.usage-cache.json` 是增量缓存（按文件 mtime+size 判断），让重复运行近乎瞬时；删掉它即可强制全量重扫。

## 为什么不用 ccusage？

[ccusage](https://github.com/ryoppippi/ccusage) 是优秀的多工具 CLI 用量统计器。本项目专注 **Kimi Code**，在可视化上做深：每模型每日细分、项目/会话维度、缓存命中率、星期×小时热力图。[KimiCodeBar](https://github.com/fashioncj/KimiCodeBar) 是托盘常驻的额度监控，本项目是按需生成的分析报表——定位互补。

## 已知限制

- **费用估算和周额度百分比是服务端数据**，本地日志只有 token 计数——请使用 CLI 内 `/usage` 或 Kimi Code Console 查看。

## Roadmap

- [ ] 成本估算（接入 LiteLLM 定价数据）
- [ ] `--watch` 自动刷新模式
- [ ] 更多导出格式（CSV / JSON）

## License

[MIT](LICENSE) © 2026 coconilu
