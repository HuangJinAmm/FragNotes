# 破碎星球（LocalFragNote）

> 一款参考Memos项目，本地优先（local-first）的 Markdown 笔记应用，基于 Tauri 2 + React 19 + Rust 构建，所有数据均存放在用户本机目录，支持全文 / 语义搜索、附件管理、FSRS 复习、AI 聊天与局域网发现分享。


---

## 目录

- [核心特性](#核心特性)
- [技术栈](#技术栈)
- [项目结构](#项目结构)
- [快速开始](#快速开始)
- [数据存储说明](#数据存储说明)
- [功能模块详解](#功能模块详解)
- [数据库 Schema 概览](#数据库-schema-概览)
- [构建与打包](#构建与打包)
- [开发约定与注意事项](#开发约定与注意事项)
- [许可证](#许可证)

---

## 核心特性

- **本地优先**：所有笔记、附件、模型、配置均存放在用户目录 `~/localFragNote/`，无需账号、无需联网即可使用。
- **Markdown 编辑**：基于 CodeMirror 6 构建的所见即所得编辑器，支持标题、列表、任务、引用、代码块、表格、Mermaid、KaTeX 数学公式、Mention、Tag 等扩展。
- **多模态搜索**：
  - FTS5 trigram 全文搜索，原生支持中文子串匹配，无需分词库。
  - 基于 `all-MiniLM-L6-v2` 的本地语义搜索（KNN 向量召回）。
  - 支持 `tag`、`visibility`、`pinned`、`has_link`、`has_task_list`、`has_code`、时间范围等组合过滤。
- **附件管理**：图片、视频、音频、Motion Photo 一站式管理，含缩略图、附件库浏览、文档摘要（markitdown）。
- **标签与树**：标签内联于 `#tag` 文本，元数据表作为缓存索引；前端支持标签树、预设、自动补全。
- **笔记关系**：支持 `REFERENCE`（引用）与 `COMMENT`（评论）两种关系；评论通过 `parent_id` 挂载到父笔记，且不进入 FTS / embedding 索引。
- **FSRS 复习模块**：基于 `rs-fsrs` 的间隔重复算法，从已有笔记自动生成卡片（问答 / 完形 / 多角度），含热力图、牌组统计、复习记录。
- **AI 聊天面板**：多 Provider 配置（OpenAI 兼容），SSE 流式输出，支持工具调用、附件图片输入、上下文管理、会话持久化（V8 迁移）。
- **AI Skills 机制**：内置 + 用户自定义 Skill（Markdown 指南文档），元数据始终注入系统提示，LLM 通过 `load_skill` 工具按需加载全文；内置 office-cli 系列 Skill（docx/pptx/xlsx/财务模型/学术论文等）。
- **用户可配置工具**：用户可在设置中创建 shell 命令工具，由 AI agent 在权限等级确认机制（again/hard/good/easy）下调用执行。
- **本地 LLM 启动器**：通过 `llama.cpp` 的 `llama-server` 或 LM Studio 的 `lms` CLI 拉起 OpenAI 兼容的本地端点，支持前台 / 守护两种模式与开机自启。
- **LAN 发现与分享**：基于 `iroh`（QUIC）+ mDNS，自动发现局域网内其他实例，可预览 / 复制远端笔记与附件，按需无状态查询，不做主动同步。
- **MCP 服务器**：内置 Streamable HTTP MCP 服务端，向同机 Claude Desktop / Cline / Continue 等客户端暴露 memo CRUD 工具、`memo://{uid}` 资源与预设提示模板（`summarize_recent` / `gather_by_tag` / `review_due`）。
- **多工作空间**：数据目录由 `app_config_dir()` 引导，用户可创建 / 切换 / 重命名 / 删除多个工作空间，每个工作空间独立的 `memos.db` + 附件目录。
- **多语言与主题**：内置 40+ 语言（i18next），5 套主题（默认浅 / 默认深 / 纸面 / 豆绿 / 科幻），支持系统跟随。
- **导入导出**：JSON 格式批量导入导出，便于备份与迁移。

---

## 技术栈

### 前端

| 领域 | 选型 |
| --- | --- |
| 框架 | React 19 + TypeScript 5 |
| 构建 | Vite 8 |
| 样式 | Tailwind CSS 4 + tw-animate-css |
| 桌面壳 | Tauri 2（`@tauri-apps/api` / `@tauri-apps/cli`） |
| 路由 | react-router-dom 7 |
| 数据请求 | @tanstack/react-query 5 + @connectrpc/connect（gRPC-Web 兼容协议层，由 `connect.ts` 适配到 Tauri IPC） |
| 编辑器 | CodeMirror 6（`@codemirror/*`、`@lezer/*`） |
| Markdown | react-markdown + remark/rehype 插件链（GFM、math、breaks、sanitize、自定义 tag/mention 等） |
| 可视化 | Mermaid、KaTeX、highlight.js、html-to-image |
| 地图 | Leaflet + react-leaflet + markercluster |
| 组件库 | Radix UI + shadcn/ui 风格组件（`src/components/ui`） |
| 国际化 | i18next + react-i18next |
| 其他 | dayjs、fuse.js、lodash-es、uuid、copy-to-clipboard |

### 后端（Rust）

| 领域 | 选型 |
| --- | --- |
| 语言 / Edition | Rust 2024 |
| 桌面运行时 | tauri 2 |
| 数据库 | rusqlite 0.32（bundled SQLite）+ refinery 0.8（迁移） |
| 全文搜索 | SQLite FTS5（trigram 分词器） |
| 向量搜索 | sqlite-vec 0.1（vec0 虚拟表，384 维） |
| 嵌入模型 | ort 2.0.0-rc.12（ONNX Runtime 1.24.x，`load-dynamic`）+ tokenizers 0.21 |
| 复习算法 | rs-fsrs 1.2 |
| Markdown 渲染 | comrak 0.24 |
| LAN 网络 | iroh 1 + iroh-mdns-address-lookup 0.4（QUIC + mDNS） |
| 文档解析 | markitdown 0.1（附件摘要） |
| 图像处理 | image 0.25（缩略图） |
| 异步运行时 | tokio（full） |
| 日志 | tracing + tracing-subscriber |
| 错误处理 | thiserror 2 + anyhow |

### Workspace 组织

```
[workspace]
members = ["core", "src-tauri"]
[patch.crates-io]
wmi = { path = "vendor/wmi" }   # Windows 本地 patched 版本
```

- `core`：纯业务逻辑库 `memos-core`，提供 memo / attachment / reaction / memo_relation / setting / review / tag 的 CRUD 与缓存。
- `src-tauri`：桌面应用 `memos-app`，承载 Tauri 命令、LAN、LLM 启动器、AI、embedding 等运行时能力。

---

## 项目结构

```
LocalFragNote/
├── core/                       # memos-core 业务逻辑库
│   ├── config_migrations/      # app_config.db 迁移（V1）
│   ├── migrations/             # memos.db 迁移（V1 ~ V11）
│   └── src/
│       ├── attachment.rs       # 附件 CRUD
│       ├── cache.rs            # moka 缓存
│       ├── chat_session.rs     # AI 聊天会话持久化（V8 迁移）
│       ├── config_migration.rs # app_config.db 迁移入口
│       ├── config_store.rs     # 共享配置 Store（app_config.db）
│       ├── markdown.rs         # comrak 渲染 / 提取
│       ├── memo.rs             # 笔记 CRUD + FTS / 向量同步
│       ├── memo_relation.rs    # 笔记关系
│       ├── migration.rs        # refinery 迁移入口
│       ├── reaction.rs         # 反应
│       ├── review.rs           # FSRS 复习
│       ├── setting.rs          # 设置
│       ├── skill.rs            # AI Skill 实体（V9 迁移）
│       ├── store.rs            # Store 入口（memos.db 连接池 + 扩展注册）
│       ├── tag.rs              # 标签元数据
│       ├── tool.rs             # 用户可配置工具（V10 迁移）
│       └── types.rs            # 公共类型
├── docs/                       # 设计文档与计划
│   ├── plans/
│   └── specs/
│   └── superpowers/{plans,specs}/
├── public/                     # 静态资源（logo2.png）
├── src/                        # 前端 React 应用
│   ├── components/             # 组件（按域划分）
│   │   ├── ActivityCalendar/   # 活动日历
│   │   ├── AiChat/             # AI 聊天面板
│   │   ├── AttachmentLibrary/  # 附件库
│   │   ├── LanDiscovery/       # LAN 发现与远程预览
│   │   ├── MemoActionMenu/     # 笔记菜单 + 分享图
│   │   ├── MemoContent/        # Markdown 渲染（含 Mermaid / KaTeX / Table）
│   │   ├── MemoDetailSidebar/  # 详情侧栏（大纲 / 关系 / 附件 / 分享）
│   │   ├── MemoEditor/         # CodeMirror 编辑器（Toolbar / hooks / services）
│   │   ├── MemoExplorer/       # 抽屉式导航（标签 / 预设 / 快捷方式）
│   │   ├── MemoMetadata/       # 附件 / 位置 / 关系元数据
│   │   ├── MemoView/           # 笔记视图（含评论列表）
│   │   ├── Review/             # FSRS 复习（牌组 / 卡片 / 热力图）
│   │   ├── Settings/           # 设置中心（多分区）
│   │   ├── StatisticsView/     # 统计视图
│   │   ├── map/                # Leaflet 地图与反向地理编码
│   │   └── ui/                 # 基础组件（shadcn 风格）
│   ├── contexts/               # Auth / Instance / Filter / NewMemo / View
│   ├── hooks/                  # 通用 hooks
│   ├── layouts/                # MainLayout / RootLayout
│   ├── locales/                # 40+ 语言资源
│   ├── pages/                  # Home / Archived / Attachments / Discover / Review / Setting / About
│   ├── router/                 # 路由表
│   ├── themes/                 # 默认浅 / 默认深 / 纸面 + COLOR_GUIDE
│   ├── types/proto/            # 生成的 protobuf 类型（gRPC-Web 协议）
│   └── utils/                  # remark / rehype 插件与工具
├── src-tauri/                  # Rust + Tauri 桌面壳
│   ├── capabilities/           # Tauri 权限配置
│   ├── icons/                  # 应用图标（已由 logo2.png 重新生成）
│   ├── skills/                 # 内置 Skill 文档（office-cli 系列 + review/semantic_search 指南）
│   ├── src/
│   │   ├── ai/                 # AI provider / SSE / 工具调用 / agent_loop / 内置 Skills / 工具确认
│   │   │   ├── agent_loop.rs   # AI agent 循环 + RUNNING_COUNT 全局计数
│   │   │   ├── builtin_skills.rs # 内置 Skill 解析器（include_str! + YAML front-matter）
│   │   │   ├── llm_call.rs     # 共享 LLM 调用 helper（call_provider / call_first_provider）
│   │   │   ├── pending_confirmations.rs # 用户工具权限确认（60s 超时 + 事件推送）
│   │   │   ├── provider.rs     # 多 Provider 配置持久化
│   │   │   ├── sse.rs          # SSE 流式解析
│   │   │   └── tools.rs        # 内置 + 用户工具定义与分发
│   │   ├── commands/           # Tauri IPC 命令（按域拆分）
│   │   │   ├── ai_chat.rs      # AI 聊天流式命令 + agent loop 集成
│   │   │   ├── attachment.rs   # 附件 CRUD
│   │   │   ├── chat_session.rs # 聊天会话持久化命令
│   │   │   ├── document_summary.rs # markitdown 文档摘要
│   │   │   ├── import_export.rs # JSON 导入导出
│   │   │   ├── lan.rs          # LAN 发现与远程预览
│   │   │   ├── llm_runner.rs   # 本地 LLM 启动器控制
│   │   │   ├── mcp.rs          # MCP 服务器启停
│   │   │   ├── memo.rs         # 笔记 CRUD + AI 标签建议
│   │   │   ├── memo_relation.rs # 笔记关系
│   │   │   ├── reaction.rs     # 反应
│   │   │   ├── review.rs       # FSRS 复习
│   │   │   ├── setting.rs      # 设置（走 ConfigStore）
│   │   │   ├── skill.rs        # AI Skill CRUD
│   │   │   ├── tool.rs         # 用户工具 CRUD + 确认响应
│   │   │   └── workspace.rs    # 工作空间切换 / 创建 / 重命名 / 删除
│   │   ├── lan/                # iroh + mDNS 发现与协议
│   │   ├── llm_runner/         # 本地 LLM 启动器（config / runner）
│   │   ├── mcp/                # MCP 服务器（config / protocol / server / tools）
│   │   ├── embedding.rs        # ort + tokenizers 本地推理
│   │   ├── file_storage.rs     # 附件落盘
│   │   ├── officecli_watch.rs  # officecli watch 子进程管理器
│   │   ├── protocol.rs         # attachment:// URI scheme 处理
│   │   ├── state.rs            # AppState（Store / ConfigStore / WorkspaceRegistry / LAN / LLM / MCP / shutdown）
│   │   ├── thumbnail.rs        # 缩略图
│   │   ├── workspace.rs        # WorkspaceRegistry（多工作空间注册表）
│   │   ├── main.rs             # 入口（setup / 命令注册 / 退出清理）
│   │   └── lib.rs              # 库暴露口（供集成测试）
│   ├── tests/                  # 集成测试（LAN auth / protocol / 集成 / review 核心）
│   ├── build.rs                # 构建脚本（下载 ONNX Runtime DLL）
│   └── tauri.conf.json         # Tauri 配置
├── vendor/wmi/                 # 本地 patched wmi crate
├── package.json
├── Cargo.toml                  # workspace 根
├── vite.config.mts
└── tsconfig.json
```

---

## 快速开始

### 环境要求

- **Node.js** ≥ 20（推荐 22+）
- **pnpm / npm / yarn**（以下示例使用 npm）
- **Rust toolchain**（stable，edition 2024 支持 ≥ 1.85）
  - Windows：MSVC 工具链（`x86_64-pc-windows-msvc`）
  - macOS：`aarch64-apple-darwin` 或 `x86_64-apple-darwin`
  - Linux：系统 WebView 运行时依赖（WebKitGTK）
- **Tauri 2 系统依赖**：参考 [Tauri 官方 prerequiresites](https://tauri.app/start/prerequisites/)

### 安装依赖

```bash
# 前端依赖
npm install

# Rust 依赖（首次会拉取 ort / iroh / rusqlite 等，耗时较长）
cargo fetch
```

### 开发模式

```bash
# 同时启动 Vite 前端（:1420）与 Tauri 窗口
npm run tauri dev
```

首次启动时：

1. `src-tauri/build.rs` 检测到 `lib/onnxruntime.dll` 缺失，会通过 PowerShell 自动从 GitHub 下载 `onnxruntime-win-x64-1.24.1.zip` 并解压。
2. 首次使用语义搜索时，`embedding.rs` 会从 ModelScope 下载 `all-MiniLM-L6-v2`（约 90MB）到 `~/localFragNote/models/`。

### 类型检查与前端构建

```bash
# 仅类型检查
npx tsc --noEmit

# 前端产物构建（输出到 dist/）
npm run build

# 仅启动 Vite（浏览器调试，无 Tauri 外壳，IPC 调用不可用）
npm run dev
```

---

## 数据存储说明

应用采用**双层目录结构**：引导配置目录（`app_config_dir()`）+ 用户自选工作空间目录。

```
<app_config_dir>/                # 引导目录（由 Tauri app_config_dir() 决定）
│                                # Windows: %APPDATA%/LocalFragNote
│                                # macOS:   ~/Library/Application Support/LocalFragNote
│                                # Linux:   ~/.config/LocalFragNote
├── app_config.db                # 共享配置库（app_setting / instance_setting / tool 表）
├── workspaces.json              # 工作空间注册表（路径列表 + active workspace）
└── lan_identity.key             # LAN 节点身份密钥（iroh NodeId）

<workspace.path>/                # 用户自选的工作空间目录（可创建多个）
├── memos.db                     # SQLite 数据库（含 FTS5 / vec0 虚拟表）
└── attachments/                 # 附件根目录（可通过设置修改）
    └── ...                      # 按 filepath_template 组织

~/localFragNote/models/          # 嵌入模型缓存（仍基于 home_dir，待迁移）
└── all-MiniLM-L6-v2/
    ├── model.onnx
    └── tokenizer.json
```

- 引导目录由 `src-tauri/src/main.rs` 中的 `app.path().app_config_dir()` 决定。
- 工作空间目录由用户在 `WorkspacePicker` 中选择，可创建多个并通过 `WorkspaceSwitcher` 切换。
- 附件目录可由「设置 → 存储」配置，支持相对路径（基于工作空间目录）或绝对路径。
- **从旧版本（`~/localFragNote`）升级**：旧 `memos.db` 与 `attachments/` 不会自动迁移到新工作空间，需在首次启动后通过 `WorkspacePicker` 选择旧目录作为工作空间路径；`app_setting` / `instance_setting` / `tool` 表则由 `config_migration` 模块从旧 `memos.db` 抽取并写入 `app_config.db`。

---

## 功能模块详解

### 1. 笔记与编辑器

- 编辑器基于 CodeMirror 6 实现（`src/components/MemoEditor/`），包含：
  - `Editor/`：核心控制器、扩展、格式化、列表缩进、标签自动补全、装饰、主题。
  - `Toolbar/`：格式化工具栏、插入菜单、可见性选择器。
  - `components/`：录音面板、聚焦模式、时间戳气泡、波形图、标签建议。
  - `hooks/`：自动保存、拖拽上传、Blob URL、文件上传、聚焦模式。
  - `services/`：缓存、文档摘要、错误处理、转写、上传、校验。
- 评论通过 `memo.parent_id` 挂载到父笔记，**不进入 FTS 与 embedding 索引**。

### 2. 搜索

`connect.ts` 中的 `parseFilter` 解析 CEL 风格的过滤表达式，支持：

| 表达式 | 含义 |
| --- | --- |
| `fts.match("xxx")` | FTS5 全文匹配（短词 < 3 字符时 fallback 到 LIKE） |
| `semantic.search("xxx")` | 语义搜索（先 `embed_text` 再 KNN） |
| `content.contains("xxx")` | LIKE 子串匹配 |
| `tag in ["a","b"]` | 标签过滤 |
| `created_ts >= timestamp(N)` | 起始时间 |
| `created_ts < timestamp(N)` | 截止时间 |
| `visibility in [...]` | 可见性过滤 |
| `pinned` / `has_link` / `has_task_list` / `has_code` | 属性过滤 |

语义搜索为固定 top_k 候选集，**不支持 offset 分页**，前端按需切片。

### 3. 附件

- 落盘由 `src-tauri/src/file_storage.rs` 管理，URI 通过 `attachment://` 自定义协议暴露给 WebView（见 `main.rs` 的 `register_uri_scheme_protocol`）。
- 缩略图由 `thumbnail.rs` 生成。
- 文档摘要由 `commands/document_summary.rs` + `markitdown` 实现。
- 前端附件库见 `components/AttachmentLibrary/`。

### 4. 标签

- 单一真相源为正文中的 `#tag` 文本，由 `extract_tags` 解析。
- `tag` 元数据表（V6 迁移）作为缓存与排序索引，触发器自动维护计数。
- AI 辅助打标签见 `docs/specs/2026-07-10-auto-tag-on-save.md`：保存笔记时由 `suggest_tags` IPC 调用 AI provider 推荐标签，前端弹窗让用户挑选后追加到笔记首行；开关持久化在 `localStorage` 的 `memos-editor-auto-tag` 键。
- 标签元数据漂移时可通过「设置 → 标签 → 重建标签索引」从所有 NORMAL 笔记重新聚合 #tag 计数。

### 5. FSRS 复习

- 数据表：`review_deck` / `review_card` / `review_record`（V5 迁移）。
- 算法：`rs-fsrs`（`core/src/review.rs`）。
- 前端：`components/Review/`，包含牌组列表、卡片表、复习卡、热力图、统计。
- 支持 AI 自动从已有笔记生成卡片（问答 / 完形 / 多角度）。

### 6. AI 聊天

- 后端：`src-tauri/src/ai/`（provider 配置、SSE 解析、工具调用、llm_call）。
- 命令：`commands/ai_chat.rs` 中的 `ai_chat`（流式）、`ai_abort`、`list_providers`、`save_providers_cmd`。
- 前端：`components/AiChat/`，多 Provider 配置，支持图片附件输入。
- Provider 配置持久化在 `app_setting` 表中。

### 7. 本地 LLM 启动器

- 模块：`src-tauri/src/llm_runner/`，包含 `config.rs`（持久化）与 `runner.rs`（进程管理）。
- 支持两种后端：
  - **llama.cpp** 的 `llama-server`（前台模式，退出时 kill 子进程）。
  - **LM Studio** 的 `lms` CLI（守护模式，退出时调用 `lms server stop`）。
- 配置存储在 `app_setting` 表的 `llm_runner_config` key，支持 `auto_start` 开机自启。
- 退出时由 `main.rs::stop_llm_runner` 在 2 秒清理窗口内停止服务。

### 8. LAN 发现与分享

- 模块：`src-tauri/src/lan/`（auth / client / endpoint / protocol / server）。
- 基于 `iroh` QUIC Endpoint + `iroh-mdns-address-lookup` 实现：
  - 被动公开本机笔记（按需查询，不做主动同步）。
  - mDNS 自动发现局域网内其他实例。
  - 远端笔记预览、复制到本地、附件传输。
- ALPN：`memos/lan-share/1`；单帧上限 16MB；连接超时 5s；RPC 10s；附件 60s。
- 启停由 `app_setting` 中的 `lan.enabled` 持久化，应用启动时按需拉起。
- 身份密钥：`~/localFragNote/lan_identity.key`。

### 9. 多语言与主题

- 语言资源位于 `src/locales/`，覆盖 40+ 语言。
- 主题位于 `src/themes/`：`default.css`（浅）、`default-dark.css`（深）、`paper.css`（纸面）、`green.css`（豆绿）、`sci-fi.css`（科幻），配色指南见 `COLOR_GUIDE.md`。

### 10. 导入导出

- 命令：`commands/import_export.rs` 的 `export_memos_json` 与 `import_memos_json`。
- 格式：JSON，便于跨实例迁移与备份。

---

## 数据库 Schema 概览

迁移文件位于 `core/migrations/`（`memos.db` 业务库）与 `core/config_migrations/`（`app_config.db` 共享配置库），按版本演进：

### memos.db（业务库）

| 版本 | 文件 | 主要变更 |
| --- | --- | --- |


### app_config.db（共享配置库）

| 版本 | 文件 | 主要变更 |
| --- | --- | --- |


关键约束：

- `vec0` 虚拟表 384 维，对应 `all-MiniLM-L6-v2` 输出。
- FTS5 trigram 要求 token ≥ 3 字符；短词在 `connect.ts` 中 fallback 到 LIKE。
- `sqlite-vec` 扩展需在连接时通过 `sqlite3_auto_extension` 注册（见 `core/src/store.rs`）。
- V11 之后，`app_setting` / `instance_setting` / `tool` 表从 `memos.db` 移到 `app_config.db`，由 `core/src/config_migration.rs` 负责首次启动时从旧库抽取迁移。

---

## 构建与打包

### 生产构建

```bash
# 完整流程：tsc --noEmit → vite build → cargo build --release → tauri bundle
npm run tauri build
```

产物位于 `src-tauri/target/release/bundle/`，目标平台默认包含 `.msi` / `.exe`（Windows）、`.dmg` / `.app`（macOS）、`.deb` / `.AppImage`（Linux）。

### 应用图标

```bash
# 源图位于 public/logo2.png，重新生成各尺寸图标：
npm run tauri icon ./public/logo2.png
```

输出覆盖 `src-tauri/icons/`，含 Windows（`.ico`）、macOS（`.icns`）、Linux PNG、Android / iOS 资源等。已安装版本的图标缓存问题可能需要重启系统或清理图标缓存。

### ONNX Runtime DLL

- `build.rs` 仅在 Windows 上自动下载 `onnxruntime.dll`（v1.24.1）到 `src-tauri/lib/`。
- **版本约束**：`ort` crate 2.0.0-rc.12 必须匹配 ONNX Runtime 1.24.x，否则 `SessionBuilder::new()` 会返回无效 API 结构，导致模型加载阶段无限挂起。
- 若自动下载失败，手动下载并放置 DLL 到 `src-tauri/lib/onnxruntime.dll`。
- `build.rs` 通过 `cargo:rustc-env=ORT_DYLIB_PATH=...` 注入路径，`main.rs::setup_ort_dylib_path` 在启动最早期设置 `ORT_DYLIB_PATH` 环境变量供 `ort load-dynamic` 读取。

---

## 开发约定与注意事项

### Rust 端

- **ONNX Runtime 版本严格匹配**：`ort 2.0.0-rc.12` ↔ ONNX Runtime 1.24.x。升级时需同步更新 `Cargo.toml` 与 `build.rs` 中的下载 URL。
- **数据目录**：引导目录基于 `app.path().app_config_dir()`，工作空间目录由用户选择（见「数据存储说明」）。`embedding.rs` 仍基于 `dirs::home_dir().join("localFragNote")`，待后续迁移到 `config_dir`。
- **ConfigStore vs Store**：共享配置（`app_setting` / `instance_setting` / `tool`）存于 `app_config.db`（`ConfigStore`）；业务数据存于 `memos.db`（`Store`）。新增配置类命令应走 `state.config_store()`，业务类走 `state.store()`。
- **多工作空间切换需重启**：`workspace_switch` 通过 `app_handle.request_restart()` 实现，切换前需 `agent_loop::is_any_running()` 检查无 AI 任务在跑。
- **退出流程**：`main.rs` 实现 2 秒清理窗口 + 5 秒强制退出看门狗（`EXIT_CLEANUP_TIMEOUT_SECS` / `EXIT_FORCE_TIMEOUT_SECS`），避免后台任务卡住退出。
- **shutdown 协作**：`AppState.shutdown` / `cleanup_started` 为全局原子标志，LAN / LLM 后台任务需在循环中检查并提前终止。
- **错误处理**：IPC 错误统一为 `IpcError`；核心层为 `CoreError`；LAN 层为 `LanError`。

### 前端

- **协议适配**：前端使用 `@connectrpc/connect-web` 风格的 client，由 `src/connect.ts` 适配到 Tauri `invoke`。新增 IPC 命令时需同步在 `connect.ts` 中接入。
- **proto 类型**：`src/types/proto/` 为生成的 TypeScript 类型，修改 `.proto` 后需重新生成。
- **CEL 过滤**：`parseFilter` / `parseOrderBy` 是 listMemos 的核心解析逻辑，新增过滤字段需同时改 Rust 端 `list_memos` 命令。
- **评论与父笔记**：`parent_id IS NOT NULL` 的 memo 不进 FTS / embedding / 标签提取，仅作为评论展示。

### 通用

- **wmi patched**：`vendor/wmi` 为本地补丁版本，通过 `[patch.crates-io]` 覆盖。
- **测试**：`core/tests/crud.rs` 为核心层 CRUD 测试；`src-tauri/tests/` 覆盖 LAN auth / protocol / 集成 与 review 核心。
- **迁移版本**：`memos.db` 当前至 V11（V8 chat_session / V9 skill / V10 tool / V11 drop_shared_config_tables）；`app_config.db` 至 V1。

---

## 许可证

MIT License。详见 workspace `Cargo.toml` 中的 `license = "MIT"`。
