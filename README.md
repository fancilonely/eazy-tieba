# tieba-toolbox (eztb)

<p align="center">
  <img src="https://h-r2.kairi.cc/github/eztb.png" alt="eztb icon" width="128" />
</p>

<p align="center">
  开源的百度贴吧工具箱，聚焦查询、分析、导出三类核心能力。
</p>


# 百度贴吧用户历史发言与回复查询工具

一个专注于百度贴吧用户历史回复抓取与近期公开发言查询的实用工具。支持按指定时间范围精准定位、高容错断点续传、智能过滤主题帖以及多维度用户发言检索。

---
*
*
*
## ==魔改版核心功能==

### 1. 按日期范围抓取用户历史回复
支持抓取指定用户在特定时间段内发表的**楼层回复**和**楼中楼回复**，并自动排除可明确识别的主题帖。

* **灵活的时间范围**：默认查询最近一个月，支持自由设定开始与结束日期。
* **高效定位算法**：采用**指数跳页（Exponential Search）**结合**二分查找（Binary Search）**，快速锁定目标日期所在的分页区间，大幅减少无效请求。
* **高可用与容错机制**：
  * **单页独立请求**：单页抓取异常不会中断整体任务进度。
  * **智能指数退避重试**：针对 `HTTP 500`、`HTTP 429`（请求过多）及网络超时等瞬时错误，自动执行有限次数的指数退避重试。
  * **坏页跳过与邻近探测**：对持续失败的页面进行记录并暂时跳过，同时主动探测相邻可访问页面以保障数据完整性。
* **完备的任务控制与持久化**：
  * 支持低并发稳定抓取，随时**暂停、恢复**任务，并支持对遗漏的**失败页面进行一键补抓**。
  * 基于浏览器 **IndexedDB** 持久化存储查询参数、任务进度、已成功页码及失败页码，刷新或重新打开页面后可无缝**断点续抓**。
* **严谨的数据清洗与状态反馈**：
  * 自动对抓取结果进行去重处理。
  * 严格校验完成度：仅当整个日期范围内的所有页面均成功检查后才标记为「抓取完成」；若存在遗漏，则明确提示「部分完成」及具体缺失页数。
  * 准确区分帖子类型：对无法可靠判断是否属于回复的记录给出明确标注，绝不粗暴地将所有 `UserPost` 均视为回复。

---

### 2. 用户近期发言查询
> **技术参考**：本功能的查询机制与协议解析思路借鉴自 [tb.anova.me](https://tb.anova.me/)。

工具页提供独立的即时查询面板，可快速检索贴吧用户的近期公开发言记录。

* **多维度用户检索**：支持通过**贴吧用户名**、**用户 ID（user_id）** 或 **UID** 进行精准查询。
* **精细化筛选与分页**：
  * 支持流畅的分页浏览。
  * 支持按**贴吧名称**过滤，仅查看目标用户在指定贴吧内的发言（若贴吧筛选框留空，系统将自动视为未指定，不会引发参数校验失败）。
* **清晰的信息展示**：完整呈现发言所属贴吧、原帖标题、具体回复内容、发布时间及直达原帖的跳转链接。
* **新旧协议双栈兼容**：内置贴吧新旧两套用户发言接口解析逻辑，当新版接口无返回结果时，自动平滑回退至旧版协议。
* **智能过滤与隐私状态识别**：
  * 自动过滤可明确识别的主题帖，聚焦展示楼层回复与楼中楼互动。
  * 完美兼容开启了「隐藏部分发言」隐私设置的用户账号，并在界面中直观展示接口返回的隐藏状态提示。

---

## ==魔改版技术亮点==

| 模块 | 实现方案 | 解决痛点 |
| :--- | :--- | :--- |
| **日期定位** | 指数跳页 + 二分查找 | 避免从第 1 页顺序翻页导致的请求过多与封禁风险 |
| **本地存储** | IndexedDB | 突破 `localStorage` 容量限制，支持海量发言数据缓存与断点续传 |
| **网络请求** | 低并发队列 + 指数退避重试 | 有效应对贴吧接口限流（429）与偶发服务器波动（500） |
| **数据兼容** | 双协议回退机制 | 解决部分老账号或特殊状态账号在新版接口下无法拉取数据的问题 |

---

## ==魔改版使用指南==

### 1. 历史回复按日抓取
1. 在工具页切换至**「历史回复抓取」**模块。
2. 输入目标用户的贴吧用户名 / ID / UID，并设置起止日期（默认为近 30 天）。
3. 点击**「开始抓取」**，系统将自动定位起始页码并开始低并发拉取。
4. 如遇网络波动导致部分页面失败，可在任务结束后点击**「补抓失败页面」**；若中途关闭浏览器，下次打开时可直接恢复未完成的任务。

### 2. 近期发言快速查询
1. 在工具页进入**「近期发言查询」**模块。
2. 输入用户名、用户 ID 或 UID。
3. *（可选）* 填入特定贴吧名称以缩小检索范围；留空则查询全吧近期公开动态。
4. 点击**「查询」**即可分页浏览结果，点击标题或链接可跳转至贴吧原帖。

---

## ==魔改版免责与使用声明==

* 本工具仅用于获取和整理百度贴吧公开可访问的数据，请勿用于任何违反相关法律法规或侵犯他人合法权益的用途。
* 为维护良好的网络环境并避免触发目标服务器风控，请合理控制查询频率，切勿修改并发参数进行恶意高频请求。
* 感谢 [tb.anova.me](https://tb.anova.me/) 为用户近期发言查询功能提供的底层原理参考。


*
*
*
## 本地运行

项目保留原有 API，同时为用户发言查询提供并行 API：

- `http://localhost:8000`：原有 API。
- `http://localhost:8001`：用户发言查询 API。
- `http://localhost:5173`：前端开发服务器。

启动用户发言查询 API：

```powershell
cd D:\tools\eazy-tieba
$env:BDUSS="你的 BDUSS"
bun run dev:recent-api
```



## 功能展示

![feature showcase](https://h-r2.kairi.cc/github/eztb-feat.png)

## UI 截图

![ui screenshot](https://h-r2.kairi.cc/github/ui-screenshot.png)

## 项目结构

本仓库是一个 monorepo，`apps/api` 和 `packages/sdk` 为 Git Submodule：

```text
tieba-toolbox
├─ apps/
│  ├─ web/        # 前端应用（React + Vite + TanStack）
│  └─ api/        # API 服务（Hono + Effect）[submodule]
├─ packages/
│  └─ sdk/        # tieba.js SDK [submodule]
└─ .github/workflows/
   └─ web-cf-pages.yml  # 网页端部署流水线
```

## 技术栈

- **前端**：React 19、Vite、TanStack Router、TanStack Query
- **UI 组件**：Primer React（GitHub 出品）
- **图标**：Primer Octicons
- **图表**：VChart
- **服务端**：Hono、Effect
- **工程化**：Bun、Turborepo、Biome、TypeScript

## 快速开始

### 1) 克隆仓库（含子模块）

```bash
git clone --recursive https://github.com/Dilettante258/tieba-toolbox.git
cd tieba-toolbox
```

如果你已经克隆过：

```bash
git submodule sync --recursive
git submodule update --init --recursive
```

### 2) 安装依赖

```bash
bun install
```

### 3) 开发模式

启动全部工作区：

```bash
bun run dev
```

分别启动：

```bash
# Web
bun run --cwd apps/web dev

# API
bun run --cwd apps/api dev
```

> `apps/api` 需要 `BDUSS` 等环境变量，详见 `apps/api/README.md`。

## 构建与检查

```bash
bun run build
bun run typecheck
bun run lint
```

## 部署

- 网页端通过 GitHub Actions 工作流 `.github/workflows/web-cf-pages.yml` 自动部署到 Cloudflare Pages。
- 默认在 `v3` 分支推送时触发。

## 相关链接

- 主仓库（Web）：https://github.com/Dilettante258/tieba-toolbox
- API 仓库：https://github.com/Dilettante258/Tieba-API-SCF
- SDK 仓库：https://github.com/Dilettante258/tieba.js
- SDK 文档：http://sdk.eztb.org/
