# tieba-toolbox (eztb)

<p align="center">
  <img src="https://h-r2.kairi.cc/github/eztb.png" alt="eztb icon" width="128" />
</p>

<p align="center">
  开源的百度贴吧工具箱，聚焦查询、分析、导出三类核心能力。
</p>


## 特殊的新增功能

### 1. 按日期范围抓取用户历史回复

支持抓取指定用户在一段时间内发表的楼层回复和楼中楼回复，并排除可明确识别的主题帖。

主要特性：

- 默认查询最近一个月，也可自定义开始和结束时间。
- 使用指数跳页和二分查找快速定位目标日期范围。
- 单页独立请求，某一页失败不会中断整个任务。
- 对 HTTP 500、429、网络超时等错误执行有限次数的指数退避重试。
- 持续失败的页面会被记录并暂时跳过，同时探测相邻可访问页面。
- 支持低并发抓取、暂停、恢复和失败页面补抓。
- 使用 IndexedDB 保存查询参数、任务进度、成功页面和失败页码，重新打开页面后可断点续抓。
- 自动去除重复发言。
- 只有整个日期范围都成功检查后才显示“抓取完成”；存在遗漏时显示“部分完成”和缺失页数。
- 对无法可靠判断是否属于回复的记录进行明确提示，不会简单地把所有 `UserPost` 当作回复。

### 2. 用户近期发言查询

工具页新增独立的用户发言查询功能，可按照贴吧用户名、用户 ID 或 UID 查询公开发言记录。

主要特性：

- 支持用户名、用户 ID 和 UID 查询。
- 支持分页浏览用户近期发言。
- 可选贴吧名称，只查看用户在指定贴吧中的发言。
- 展示贴吧名称、帖子标题、回复内容、发布时间和原帖链接。
- 兼容贴吧新旧用户发言协议；新版接口无结果时可回退到旧版协议。
- 自动过滤可明确识别的主题帖，主要保留楼层回复和楼中楼。
- 兼容隐藏部分发言的用户，并显示接口提供的隐藏状态。
- 空的贴吧筛选参数会被视为未指定，不会导致查询失败。

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
