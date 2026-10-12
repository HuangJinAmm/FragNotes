# AI 跨会话长期记忆 — 设计文档

> 日期：2026-10-12
> 范围：AI 聊天助手的跨会话长期记忆（用户偏好 / 稳定事实 / 会话要点）
> 状态：M1 + M2 + M3 + M4 + M5 已实现

***

## 背景与目标

当前 AI 聊天具备会话持久化（`chat_session`，V8）与单轮上下文压缩（`ai/context.rs`），但：

- `chat_session` 只是**对话记录**，不跨会话，也不会被后面的对话读取；
- `context.rs` 的摘要在 token 超阈值时生成，**只写回本轮内存 `msgs`**，会话结束即丢失；
- `skill` 是**人工编写**的指令型文档，不会自动积累；
- `knowledge_graph` 是用户**显式**组织的笔记结构。

因此助手无法记住「用户偏好简洁回答」「用户主力语言是 Rust」「上次我们在讨论 X 方案」这类信息，每次对话都从零开始。

**目标**：新增一个轻量、本地优先、用户可见可编辑的「AI 记忆」层，跨会话积累并在后续对话中按相关性注入。

**非目标（明确不做）**：

- 不做笔记正文的第二套检索 —— 已有 FTS5 + `sqlite-vec` 语义搜索，记忆只存「关于用户的元信息」；
- 不与 `knowledge_graph` 合并 —— 图谱是笔记间结构，记忆是用户画像；
- 不做 `review`（FSRS 学习记忆）的任何改动 —— 二者命名与语义严格区分。

***

## 三层记忆模型

| 层 | 职责 | 归属 |
|---|------|------|
| 工作记忆 | 当前会话上下文窗口 | 已有 `ai/context.rs`，不改 |
| 情节记忆 | 跨会话要点（`kind=episode`） | 本模块 |
| 语义记忆 | 用户稳定事实与偏好（`kind=fact` / `preference`） | 本模块 |

***

## 数据模型

迁移 `core/migrations/V14__add_ai_memory.sql`（`memos.db`，按工作空间隔离）：

```sql
CREATE TABLE IF NOT EXISTS ai_memory (
    id                INTEGER PRIMARY KEY AUTOINCREMENT,
    kind              TEXT NOT NULL DEFAULT 'fact',  -- fact | preference | episode
    content           TEXT NOT NULL,
    content_key       TEXT NOT NULL UNIQUE,          -- 归一化去重键
    source            TEXT NOT NULL DEFAULT 'manual',-- manual | ai
    source_session_id INTEGER,
    importance        INTEGER NOT NULL DEFAULT 3,    -- 1..5，越高越优先注入
    confidence        REAL NOT NULL DEFAULT 1.0,
    hits              INTEGER NOT NULL DEFAULT 0,
    last_hit_ts       INTEGER,
    enabled           INTEGER NOT NULL DEFAULT 1,
    created_ts        INTEGER NOT NULL,
    updated_ts        INTEGER NOT NULL
);
```

- **去重**：`content_key = normalize(content)`（trim + 空白折叠 + 小写）。写入走 `INSERT ... ON CONFLICT(content_key) DO UPDATE`，重复内容只更新重要度与时间戳，避免同类记忆堆积。
- `hits` / `last_hit_ts` 参与召回排序（命中加成与衰减）；`confidence` 仍为预留字段。
- `source_session_id` 记录记忆来源会话（AI 抽取/沉淀/`remember` 工具写入），设置页据此提供「跳到来源对话」入口。
- 记忆存 `memos.db`（业务库）而非 `app_config.db`：记忆与工作空间的笔记/会话强相关，切换工作空间应各自独立。

### 向量索引（V15，可选能力）

`core/migrations/V15__add_ai_memory_vector.sql`：

```sql
CREATE VIRTUAL TABLE IF NOT EXISTS ai_memory_vec USING vec0(
    embedding float[384]
);
```

- `rowid` 与 `ai_memory.id` 一一对应；vec0 无外键，删除/清空/内容变更时由 `core/src/memory.rs` 手动清理（内容变更后旧向量失效，删除以触发按需重建）。
- 向量由 `src-tauri` 侧注入（core 不依赖 ONNX）：召回前惰性补齐，每次最多补 5 条。
- **不变量**：向量是可选增强，缺失时记忆仍可通过关键词召回，且**任何交互路径都不会触发 90MB 模型下载**（仅在模型文件已存在时才走语义检索；显式「重建语义索引」按钮要求模型就绪，缺失时提示用户先执行一次语义搜索）。

## 配置

存 `app_config.db` 的 `app_setting`（跨工作空间共享，走 `ConfigStore`）：

| key | 默认值 | 含义 |
|-----|--------|------|
| `ai_memory_enabled` | `false` | 总开关，关闭时既不注入也不自动抽取 |
| `ai_memory_auto_extract` | `false` | 对话结束后自动抽取记忆 |
| `ai_memory_max_items` | `20` | 单次注入的最大条数 |
| `ai_memory_max_chars` | `800` | 注入到 system prompt 的字符预算上限 |

默认全部关闭 —— 记忆涉及用户画像，必须由用户显式开启。

***

## 后端实现

### `core/src/memory.rs`

实体 `AiMemory` + `MemoryKind` / `MemorySource` 枚举，CRUD：

| 函数 | 说明 |
|------|------|
| `list(store, query, include_disabled)` | 管理页列表，支持 `query` 子串过滤，启用优先排序 |
| `list_enabled(store)` | 供召回使用 |
| `create(store, kind, content, source, importance, session_id)` | 归一化 + upsert，重复内容返回已存在条目 |
| `update(store, id, content, kind, importance, enabled)` | 用户编辑 |
| `delete(store, id)` / `clear(store)` | 删除 / 清空 |
| `set_enabled(store, id, enabled)` | 单条启用开关 |
| `load_config` / `save_config` | `MemoryConfig` 读写 `app_setting` |
| `bump_hits(store, ids)` | 命中计数（注入后调用，驱动命中加成/衰减） |
| `embedded_ids` / `list_without_embedding` | 向量覆盖率与待补条目 |
| `set_embedding` / `delete_embedding` / `knn` | 向量写入与 KNN 检索 |

### `src-tauri/src/ai/memory.rs`

| 函数 | 说明 |
|------|------|
| `build_memory_section(store, config_store, query)` | 召回 + 渲染注入段；未启用返回空串 |
| `extract_and_save(provider, store, config_store, msgs)` | 对话结束后 LLM 抽取记忆并落库，返回新增/修正条数 |
| `sediment_summary(provider, store, config_store, summary)` | 上下文压缩时把离场摘要沉淀为长期记忆 |
| `backfill_embeddings(store)` | 惰性补齐缺失向量（模型缺失时直接跳过） |
| `semantic_scores(store, query, top_k)` | 语义相似度打分，任一步失败返回空 map |
| `conflict_candidates(store, text)` | 挑选与当前对话最相关的已有记忆，供冲突消解 |

**召回打分**（`score`，各信号加权求和）：

| 信号 | 权重 | 说明 |
|------|------|------|
| 关键词命中 | **+10 起**（命中词数 +1，上限 +3） | 主导项，保证「当前话题相关」优先于「高分但无关」 |
| 语义相似度 | 0..10 | 仅在有向量且模型可用时参与；`vec0` L2 距离换算 `cos = 1 - d²/2` |
| `importance` | 1..5 | 基础分 |
| 近 30 天更新 | +1 | |
| 命中频率 | +1 / +2（≥5 次） | 反复被用到的记忆更可能是长期偏好 |
| 命中衰减 | -1（≥30 天未命中）/ -3（≥90 天） | 基准为 `last_hit_ts`，无命中记录时用 `updated_ts` |

排序在 Rust 内完成（`rank` → 按分数、重要度、更新时间三级降序）；取 `max_items` 条并按 `max_chars` 截断后注入，同时 `bump_hits` 记录命中。

检索词构造：拉丁/数字取整词（长度 ≥ 2），CJK 串切成 bigram（中文无空格，整串匹配几乎不可能命中）。
冲突消解场景下会先 `strip_speaker_labels` 去掉「用户: / 助手: 」前缀 —— 「用户」这类词几乎命中每条记忆，会把打分退化成按重要度排序。

**注入格式**（分段标题与 Skill 元数据区分，避免 LLM 混淆「被告知的」与「观察到的」）：

```
## 用户记忆（跨会话）
以下是你在以往对话中记录下的关于用户的事实与偏好，请自然地遵守，不要逐条复述：
- [偏好] 用户偏好简洁、直接的答案
- [事实] 用户主力技术栈是 Rust 2024
```

**自动抽取与冲突消解**：取最近若干条 user/assistant 消息（截断到 12000 字符），附上与之最相关的已有记忆（`conflict_candidates`，最多 40 条，格式 `id | 类型 | 内容`），要求返回 JSON 数组：

```json
[{"action":"add","kind":"fact|preference|episode","content":"...","importance":3}]
[{"action":"update","id":12,"kind":"fact","content":"...","importance":3}]
```

- `add` → 新增；`update` → 修正同一件事的已有记忆（`content_key` 冲突时回退为 upsert）。
- **不允许 `delete`** —— LLM 不删除记忆，删除只能由用户在设置页或 `forget` 工具显式执行。
- `update` 时重要度**只升不降**（`max(新值, 已有值)`），避免 LLM 把用户手动调高的记忆降权。
- 解析时容忍 Markdown 代码围栏与前后多余文本；`importance` 钳制到 1..5。

**压缩联动**：`ai/context.rs::maybe_compact_context` 由返回 `bool` 改为返回 `Option<String>`（`Some(summary)` 表示已压缩），`agent_loop` 拿到摘要后调用 `sediment_summary` 把「即将被丢弃的历史」沉淀为记忆，避免「压缩即遗忘」。沉淀走独立的系统提示（默认 `kind=episode`），且只有 `ai:memory_saved` 有新增时才推送事件。

### 记忆溯源（M4）

`ai_chat` 命令新增可选参数 `session_id`，沿 `agent_loop → extract_and_save / sediment_summary → apply_extracted → memory::create` 与
`execute_tool → execute_remember` 两条链路写入 `source_session_id`：

- 前端 `send()` 把当前会话 id（`sid`）随 `ai_chat` 传入；
- 复习卡生成（`commands/review.rs`）无聊天会话上下文，传 `None`；
- 设置页用 `useSourceSessionTitles`（`chat_list_sessions` → `Map<id, title>`，`staleTime` 60s）把 id 还原为会话标题，
  点击经 `aiChatController.openAiChatSession(sessionId)` 打开 AI 面板并 `switchToSession`；
- 会话已被删除时展示兜底文案「来源对话」，点击仍可打开面板（历史为空）。

`openAiChatSession` 与既有的 `openAiChatWithPrompt` 共用同一套模块级控制器注册机制
（`AiChatPanel` 挂载时注册 `open/send/switchSession` 三个回调）。

### 导入 / 导出（M5）

记忆是用户画像，**故意不并入** `export_memos_json` 的工作空间备份，需用户显式导出：

```json
{
  "kind": "fragnote-ai-memory",
  "version": 1,
  "exportedTs": 1760000000,
  "memories": [
    {
      "content": "用户偏好简洁回答",
      "kind": "preference",
      "importance": 4,
      "confidence": 1.0,
      "hits": 3,
      "enabled": true,
      "createdTs": 1759000000,
      "updatedTs": 1759500000
    }
  ]
}
```

| 规则 | 说明 |
|------|------|
| 不含本地字段 | `id` / `sourceSessionId` 换工作空间或设备后无意义，不写入文件；导入条目标记为 `MemorySource::Imported`（UI 显示「导入」） |
| 幂等 | 以 `content_key` 判重：已存在的条目**只提升重要度**，不覆盖本地启用状态、命中统计与创建时间 |
| 容错 | 字段全部可选（`Option`）并对越界值钳制（`importance` 1..5、`confidence` 0..1、`hits` ≥ 0）；空内容与超长内容计入 `skipped` |
| 两种输入形式 | 接受带封装的对象，也接受裸的记忆数组（便于手工整理） |
| 版本校验 | `kind` 必须匹配，`version` 高于当前支持值时拒绝导入并提示 |
| 返回统计 | `ImportReport { imported, merged, skipped }`，前端据此提示 |
| 向量 | 导入的条目没有向量，由召回路径惰性补齐（或用户点「重建语义索引」） |

### 工具

新增两个内置工具（`ai/tools.rs` 的 `tool_definitions` + `execute_tool`，并同步 `core/src/tool.rs::BUILTIN_TOOL_NAMES` 与 `src/types/tool.ts`）：

| 工具 | 参数 | 行为 |
|------|------|------|
| `remember` | `content`(必填)、`kind`、`importance` | 主动写入一条记忆 |
| `forget` | `id` 或 `content` | 按 id 或内容删除记忆 |

两个工具**仅在记忆已启用时加入工具定义**（`tool_definitions(user_tools, memory_enabled)`）——
关闭状态下不占用 prompt token，也避免助手写入无人使用的记忆；执行侧 `ensure_memory_enabled`
再做一次兜底校验，未启用时直接返回错误。

### `commands/ai_chat.rs` 接入点

1. **读取**：`agent_loop` 开头（原 L243-245）拼接 `SYSTEM_PROMPT + skill_metadata + memory_section`，query 取最后一条 `role=user` 消息的文本；
2. **写入**：`tool_calls.is_empty()` 的终止分支，**先 emit `ai:done`**，再执行 `extract_and_save`，避免抽取的 HTTP 调用拖慢对话结束；
3. **沉淀**：每轮检测到上下文压缩（`Ok(Some(summary))`）时调用 `sediment_summary`，把离场摘要变成长期记忆；
4. 抽取/沉淀有新增时 emit `ai:memory_saved { run_id, saved }`，前端据此失效记忆列表缓存。

### IPC 命令 `commands/memory.rs`

`memory_list` / `memory_create` / `memory_update` / `memory_delete` / `memory_set_enabled` / `memory_clear` / `memory_reindex` / `memory_export_json` / `memory_import_json` / `memory_get_config` / `memory_set_config`，注册于 `main.rs` 的 `generate_handler!`。

`memory_reindex`（重建语义索引）需要嵌入模型已在本地：命令本身不触发下载，模型缺失时返回
`BadRequest` 提示用户先执行一次语义搜索；执行时先在短锁内取出待补条目，再在无锁状态下做推理，最后回写，避免长时间持有 Store 锁。

***

## 前端实现

| 文件 | 变更 |
|------|------|
| `src/types/memory.ts` | `AiMemoryDto`、`MemoryKind`、`MemoryConfigDto` |
| `src/hooks/useMemoryQueries.ts` | `useMemoryList` / `useCreateMemory` / `useUpdateMemory` / `useDeleteMemory` / `useSetMemoryEnabled` / `useClearMemories` / `useReindexMemories` / `useMemoryConfig` / `useSaveMemoryConfig` |
| `src/components/Settings/MemorySection.tsx` | 总开关 + 自动抽取开关 + 条数/字符预算 + 重建语义索引 + 导出/导入备份 + 记忆列表（启用开关、编辑、删除、来源对话跳转）+ 清空 |
| `src/components/AiChat/aiChatController.ts` | 新增 `openAiChatSession(sessionId)`，与 `openAiChatWithPrompt` 共用注册机制 |
| `src/components/AiChat/AiChatPanel.tsx` | 注册 `switchSession` 回调（经 ref 保持最新引用） |
| `src/components/Settings/MemoryEditor.tsx` | 记忆新增/编辑弹窗（kind、content、importance） |
| `src/components/Settings/settingSections.ts` | `SettingSectionKey` 增加 `"memory"`，`SETTINGS_SECTIONS` 插入分区（`BrainIcon`） |
| `src/locales/*.json` | `setting.memory.*` 词条（zh-Hans / en 完整，其余语言回退英文） |
| `src/components/AiChat/hooks.ts` | 监听 `ai:memory_saved` 事件 → 失效 `memoryKeys.all` |

***

## 边界与安全

- **隐私**：记忆属用户画像，**不参与** LAN 分享与 MCP 工具暴露；`export_memos_json` 的工作空间备份亦**不包含**记忆，导出必须由用户在设置页显式触发（`memory_export_json`），避免随手分享备份时泄露用户画像。
- **Prompt 膨胀**：`max_chars` 硬预算 + `max_items` 上限，双重约束，默认 800 字符。
- **错误记忆**：默认关闭 + 管理页可编辑/删除/清空 + 抽取侧只允许 `add` / `update`（LLM 不能删除）+ `update` 重要度只升不降，保证用户对记忆有最终控制权。
- **下载安全**：交互路径（对话召回、自动抽取沉淀）永不触发嵌入模型下载；只有显式「重建语义索引」/语义搜索才会下载，且模型缺失时给出明确提示。
- **写入时机**：抽取/沉淀都在 `spawn_blocking` 线程内、`ai:done` 之后执行，不阻塞流式结束；失败仅打日志，不影响主流程。
- **锁粒度**：向量推理期间不持有 Store 锁（先取待补列表 → 无锁推理 → 回写），避免阻塞笔记读写。
- **命名**：模块统一用 `ai_memory` / UI 文案「AI 记忆」，与「复习（FSRS）」严格区分。

***

## 验证

- `cargo check --workspace`：通过，无新增 warning。
- `cargo test -p memos-core`：102 passed（含归一化去重、upsert、CRUD、配置读写、向量生命周期 / KNN 排序 / 更新失效 / 删除清理、导入导出往返 / 幂等 / 越界钳制 / 残缺 JSON 容错）。
- `cargo test -p frag-note-app --lib`：200 passed（含打分主导性、语义加分、命中加成与衰减、字符预算、命中计数、无模型回退、抽取解析、冲突消解 `add`/`update`、重要度只升不降、来源会话标注）。
- `npx tsc --noEmit`：通过。
- 命令注册、i18n 词条、设置分区已人工核对。

***

## 后续可选增强

- 记忆冲突的**双模型校验**：目前冲突消解依赖单次抽取调用，可加一轮复核降低误合并。
- `confidence` 落地：抽取时让 LLM 输出置信度，低于阈值时先进「待确认」队列由用户裁定（LLM 自评置信度校准较差，需配合二次校验才有意义）。
- 跨工作空间共享的全局记忆层（当前记忆随工作空间隔离）。
- 记忆向量随备份文件迁移（当前仅迁移文本字段，向量由导入侧重建）。
