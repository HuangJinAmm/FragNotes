# AI Chat Skills 加载功能 — 设计

- **日期**: 2026-07-23
- **状态**: 设计已确认，待实现
- **作者**: 助手 + 用户协同设计

## 1. 背景与目标

LocalFragNote 的 AI 聊天 agent（[ai_chat.rs](file:///d:/3-ai-project/LocalFragNote/src-tauri/src/commands/ai_chat.rs)）目前使用硬编码的 `SYSTEM_PROMPT`（[ai_chat.rs:74-78](file:///d:/3-ai-project/LocalFragNote/src-tauri/src/commands/ai_chat.rs#L74-L78)）和 9 个静态注册的工具（[tools.rs:12-157](file:///d:/3-ai-project/LocalFragNote/src-tauri/src/ai/tools.rs#L12-L157)）。项目内另有 3 处独立硬编码的系统提示词（review 卡片生成、tag 建议、文档摘要）。

本设计引入 **Skills** 概念（参考 Claude 的 Agent Skills 规范）：skill 是一份 Markdown 指南文档，在 AI 计划调用工具时按需加载到上下文，指导工具的正确使用。Skills 不新增工具，仅提供参考资料。

**核心目标**：
- 让 LLM 在调用工具前能获取该工具的详细使用指南（参数格式、注意事项、最佳实践）
- 解决首轮工具调用无指导的问题（如未来 office CLI 工具的复杂参数）
- 内置开箱即用示例 + 用户自定义扩展

## 2. 需求与约束

### 2.1 功能需求

| ID | 需求 |
|----|------|
| R1 | Skill = Markdown 文档（YAML frontmatter + 正文），frontmatter 含 id/name/description/tools/enabled |
| R2 | 内置 skill（只读，可禁用）+ 用户自定义 skill（可增删改）双来源 |
| R3 | 所有已启用 skill 的元数据（id + description + 关联工具）始终注入系统提示，作为紧凑列表 |
| R4 | 新增 `load_skill(skill_id)` 工具；LLM 判断相关性后调用，返回 skill 全文。完整决策流程：看到元数据 → 判断相关 → 调用 `load_skill` → 拿到全文 → 据此调用业务工具 |
| R5 | `load_skill` 作为普通工具走现有 agent loop，不新增特殊分支 |
| R6 | skill 与工具的关联由 frontmatter `tools` 字段声明（用户后续配置关联信息） |
| R7 | 设置面板管理 skill（启用/禁用/新建/编辑/删除），位于主设置页 |
| R8 | 聊天面板对 `load_skill` 工具消息做 Markdown 渲染优化 |
| R9 | `MAX_AGENT_ROUNDS` 调整为 200 |

### 2.2 非功能需求

- **N1**: 内置 skill 通过 `include_str!` 编译期嵌入，无需运行时文件 IO，兼容打包后的二进制
- **N2**: 用户 skill 存数据库（新表 `skill`），沿用 V<n>__<name>.sql 迁移模式
- **N3**: 复用现有 `app_setting` 表存内置 skill 的禁用状态（key `"ai_skill_disabled_builtin"`）
- **N4**: 不修改现有 9 个工具的语义，仅新增第 10 个工具 `load_skill`
- **N5**: 不引入 MCP 工具合并（MCP 是对外 server，与 chat agent 工具集独立）
- **N6**: skill 启用状态全局生效（不区分会话）
- **N7**: i18n 覆盖 zh-Hans / en

### 2.3 范围外（Out of Scope）

- 会话级 skill 启用快照（未来可在 `chat_session` 加 `disabled_skills` 列，V1 不做）
- skill 版本管理 / 导入导出
- skill 共享市场
- `load_skill` 调用去重（同会话同 id 只加载一次）—— V1 靠 LLM 自律 + 200 轮预算，实测后再优化
- 前端单元测试（视项目测试基础设施决定，V1 至少 TypeScript 类型检查）

## 3. Skill 文档格式

```markdown
---
id: b-office-cli-guide          # 稳定 id；内置以 b- 前缀，用户以 u- 前缀
name: Office CLI 指南           # 显示名
description: >                  # 单行摘要，注入 LLM 元数据列表
  指导如何使用 office CLI 工具生成 Word/Excel/PPT 文档，
  包括子命令、参数格式、常见模板。
tools: [office_cli]             # 关联工具名列表；[] 表示通用指南
enabled: true                   # 用户开关（内置默认 true）
---

# Office CLI 使用指南

## 子命令
- `word --template report --out {{path}}` 生成 Word
...
```

**Frontmatter 字段**：

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `id` | string | 是 | 全局唯一；内置 `b-<slug>`，用户 `u-<slug>` |
| `name` | string | 是 | UI 显示名 |
| `description` | string | 是 | 单行摘要，作为元数据注入 LLM |
| `tools` | string[] | 是 | 关联工具名；`[]` 表示通用指南 |
| `enabled` | bool | 否 | 用户开关，默认 `true` |

**正文**：自由 Markdown，纯咨询文本，LLM 读取后据此调整工具调用。

## 4. 存储与数据模型

### 4.1 内置 skill（文件系统，只读）

- 位置：`src-tauri/skills/*.md`
- 编译期通过 `include_str!` 嵌入，启动时解析到 `AppState.builtin_skills: Vec<Skill>` 缓存
- V1 内置 3 个示例：
  1. `b-review-card-best-practices`（关联 `create_review_cards`）
  2. `b-semantic-search-tips`（关联 `search_semantic`）
  3. `b-office-cli-guide`（关联 `office_cli`，工具占位——V1 中该工具不存在，skill 元数据可见但工具不可调用，无害前向占位）

### 4.2 用户 skill（数据库，可编辑）

新迁移 `core/migrations/V9__add_skill.sql`：

```sql
CREATE TABLE skill (
    id TEXT PRIMARY KEY,           -- "u-<slug>"
    name TEXT NOT NULL,
    description TEXT NOT NULL,
    tools TEXT NOT NULL,           -- JSON 数组，如 ["office_cli"]
    body TEXT NOT NULL,            -- Markdown 正文（不含 frontmatter）
    enabled INTEGER NOT NULL DEFAULT 1,
    created_ts INTEGER NOT NULL,
    updated_ts INTEGER NOT NULL
);
CREATE INDEX idx_skill_enabled ON skill(enabled);
```

选 dedicated table 而非 `app_setting` JSON blob 的理由：skill 是独立可编辑的多字段文档，需单独查询/更新/删除，且数量可能增长——表结构比单一 JSON blob 更易扩展。

### 4.3 内置 skill 禁用状态

内置 skill 本体只读（文件），但 `enabled` 状态需用户可改。方案：

- 单独存 `app_setting` 表，key = `"ai_skill_disabled_builtin"`，value = JSON 数组（被禁用的内置 skill id 列表）
- `list_enabled()` 合并逻辑：内置 skill 默认 enabled=true，若 id 出现在禁用列表中则 enabled=false

### 4.4 Rust 实体与 store（`core/src/skill.rs`）

```rust
pub enum SkillSource { BuiltIn, User }

pub struct Skill {
    pub id: String,
    pub name: String,
    pub description: String,
    pub tools: Vec<String>,
    pub body: String,
    pub enabled: bool,
    pub source: SkillSource,
    pub created_ts: i64,
    pub updated_ts: i64,
}

// 传入 builtin 列表 + DB 连接，合并返回
pub fn list(builtin: &[Skill], conn) -> CoreResult<Vec<Skill>>
pub fn list_enabled(builtin: &[Skill], conn) -> CoreResult<Vec<Skill>>
pub fn get(builtin: &[Skill], conn, id) -> CoreResult<Option<Skill>>
pub fn create(conn, skill) -> CoreResult<Skill>          // 仅 user
pub fn update(conn, skill) -> CoreResult<Skill>           // 仅 user
pub fn delete(conn, id) -> CoreResult<()>                 // 仅 user
pub fn set_enabled(conn, id, enabled) -> CoreResult<()>   // user 改 DB；builtin 改 app_setting 禁用列表
```

内置 skill 的 `update`/`delete` 返回 `CoreError::Other("built-in skill is read-only")`。

### 4.5 Tauri 命令（`src-tauri/src/commands/skill.rs`）

镜像 provider 命令模式：
- `skill_list() -> Vec<SkillDto>`
- `skill_create(skill) -> SkillDto`
- `skill_update(skill) -> SkillDto`
- `skill_delete(id) -> ()`
- `skill_set_enabled(id, enabled) -> ()`

`SkillDto` 含 `source: "builtin" | "user"` 字段，前端据此区分可编辑性。

## 5. Agent Loop 整合（核心机制）

### 5.1 新增 `load_skill` 工具

`tool_definitions()`（[tools.rs](file:///d:/3-ai-project/LocalFragNote/src-tauri/src/ai/tools.rs)）追加：

```json
{
  "type": "function",
  "function": {
    "name": "load_skill",
    "description": "加载一个 skill 的完整指南文档到上下文。在调用任何业务工具前，若系统提示中列出的 skill 元数据与当前任务相关，请先调用本工具加载该 skill 的完整内容。一次只加载一个 skill；多个相关 skill 可分别调用。",
    "parameters": {
      "type": "object",
      "properties": {
        "skill_id": { "type": "string", "description": "要加载的 skill id" }
      },
      "required": ["skill_id"]
    }
  }
}
```

`execute_tool` dispatcher 追加 `"load_skill" => execute_load_skill(args, store)` 分支。

`execute_load_skill`：
- 读 `skill_id` 参数
- 通过 `skill::get(builtin, conn, id)` 查找
- 找到且 enabled → 返回 `{ "id", "name", "body" }`（body 即 Markdown 正文，成为 LLM 的 skill 内容）
- 未找到 / 已禁用 → 返回 `{ "error": "skill not found or disabled" }`
- body > 50KB（UTF-8 字节）→ 截断到 50KB 并追加 `…[已截断]`

### 5.2 系统提示词增强

`SYSTEM_PROMPT` 在每次 `ai_chat` 调用启动时拼接 skill 元数据段：

```rust
fn build_skill_metadata_section(enabled_skills: &[Skill]) -> String {
    if enabled_skills.is_empty() { return String::new(); }
    let lines: Vec<String> = enabled_skills.iter()
        .map(|s| format!("- id: {} | {} | 关联工具: [{}]",
            s.id, s.description, s.tools.join(", ")))
        .collect();
    format!(
        "\n\n## 可用 Skills\n以下 skill 提供工具使用指南。在调用关联工具前，\
         若不确定参数或流程，请先用 load_skill(skill_id) 加载完整指南：\n{}",
        lines.join("\n")
    )
}
```

最终系统消息 = `SYSTEM_PROMPT + skill_metadata_section`，在 run 启动时计算一次（运行中 skill 变更不感知，下次调用生效）。

### 5.3 Agent loop 流程（结构不变，新工具自然流转）

现有 loop（[ai_chat.rs:137-262](file:///d:/3-ai-project/LocalFragNote/src-tauri/src/commands/ai_chat.rs#L137-L262)）已泛化处理工具调用，无需特殊分支：

```
Round 1: LLM 看到 系统提示(含 skill 元数据列表) + 用户消息
         → LLM 判断："要生成 Word，但看到 office-cli-guide skill 存在"
         → LLM 调用: load_skill("b-office-cli-guide")
         → execute_load_skill 返回完整 Markdown body
         → tool result 追加到 msgs

Round 2: LLM 看到 系统提示 + 用户消息 + load_skill 结果(完整指南)
         → LLM 据指南调用: office_cli(word, --template report, ...)
         → 工具正确执行

Round 3: LLM 看到结果，回复用户
```

`load_skill` 是普通工具，元数据始终在系统提示中——LLM 可**主动**（业务工具调用前）或**被动**（工具报错后查指南）加载。

### 5.4 轮次预算

`MAX_AGENT_ROUNDS`（[ai_chat.rs:80](file:///d:/3-ai-project/LocalFragNote/src-tauri/src/commands/ai_chat.rs#L80)）从 `5` → **`200`**，容纳多 skill 加载 + 多工具序列 + 多步推理。

[tools.rs:572-588](file:///d:/3-ai-project/LocalFragNote/src-tauri/src/ai/tools.rs#L572-L588) 的 `test_tool_definitions_count` 断言从 9 → 10。

### 5.5 前端事件处理

`ai:tool` 事件对每个工具调用触发（[hooks.ts:75](file:///d:/3-ai-project/LocalFragNote/src/components/AiChat/hooks.ts#L75)）。`load_skill` 结果按普通 tool 消息渲染。

`invalidateQueriesForTool`（[hooks.ts:34-62](file:///d:/3-ai-project/LocalFragNote/src/components/AiChat/hooks.ts#L34-L62)）的 switch 加 `"load_skill"` no-op 分支（不触发 memo 缓存失效）。

## 6. 前端 UI

### 6.1 Skills 设置面板

新增主设置区段 `skills`，注册到 [settingSections.ts](file:///d:/3-ai-project/LocalFragNote/src/components/Settings/settingSections.ts)，与 `mcp` / `local-llm` 并列。使用 `SettingSection` + `SettingGroup` 原语（参考 [McpSection.tsx](file:///d:/3-ai-project/LocalFragNote/src/components/Settings/McpSection.tsx)）。

布局：
```
┌─ Skills 设置 ─────────────────────────────────┐
│  [内置 Skills]                                 │
│  ┌──────────────────────────────────────────┐  │
│  │ ◯ Office CLI 指南      [office_cli]      │  │
│  │   指导如何使用 office CLI…    [启用] ✓   │  │
│  ├──────────────────────────────────────────┤  │
│  │ ◯ 复习卡片最佳实践    [create_review…]  │  │
│  │   卡片类型选择与 front/back… [启用] ✓   │  │
│  └──────────────────────────────────────────┘  │
│  （只读，可禁用，不可编辑/删除）                │
│                                                │
│  [自定义 Skills]                               │
│  ┌──────────────────────────────────────────┐  │
│  │ ✎ 我的写作助手          [create_memo]    │  │
│  │   自定义写作风格… [启用] ✓ [编辑][删除]  │  │
│  └──────────────────────────────────────────┘  │
│  [+ 新建 Skill]                                │
└────────────────────────────────────────────────┘
```

每行：名称、关联工具 chip、启用开关、（仅自定义）编辑/删除按钮。

### 6.2 Skill 编辑器（Dialog）

新建/编辑自定义 skill 时弹出。字段：

| 字段 | 控件 | 说明 |
|---|---|---|
| id | Input | 创建时必填，保存后不可改；用户输入 slug（如 `my-skill`），系统自动加 `u-` 前缀存为 `u-my-skill` |
| name | Input | 显示名 |
| description | Textarea (单行) | LLM 元数据中展示的摘要 |
| tools | Multi-select (chips) | 从已知工具名选择，可多选 |
| body | Textarea (等宽字体) | Markdown 正文，提供"预览"切换 |

校验：id 唯一（不与内置/其他自定义冲突）；name/description/body 非空。

### 6.3 聊天面板可见性

聊天面板**不新增 skill 选择器**（skill 按工具自动加载，无需用户手动选 active）。两处轻量增强：

1. **工具消息渲染优化**：`AiChatMessages` 检测 `tool.name === "load_skill"`，渲染为可折叠"📖 加载 Skill: {name}"卡片，正文用 `ReactMarkdown` 渲染 body。其他工具消息维持现状。
2. **会话级 skill 启用快照**：不在 V1 范围。

### 6.4 国际化

`en.json` / `zh-Hans.json` 新增 `settings.skills.*` 和 `aiChat.skill.*` 键。

## 7. 文件结构

### 7.1 Rust 新增

```
core/
├── migrations/
│   └── V9__add_skill.sql
├── src/
│   └── skill.rs
src-tauri/
├── skills/
│   ├── office_cli_guide.md
│   ├── review_card_best_practices.md
│   └── semantic_search_tips.md
├── src/
│   ├── commands/
│   │   └── skill.rs
│   └── ai/
│       └── builtin_skills.rs
```

### 7.2 Rust 修改

| 文件 | 修改 |
|---|---|
| `core/src/lib.rs` | `pub mod skill;` |
| `src-tauri/src/commands/mod.rs` | `pub mod skill;` |
| `src-tauri/src/main.rs` | 注册 5 个 skill_* 命令到 `invoke_handler` |
| `src-tauri/src/state.rs` | `AppState` 加 `builtin_skills: Vec<Skill>`，setup 回调填充 |
| `src-tauri/src/ai/tools.rs` | `tool_definitions()` 加 `load_skill`；`execute_tool` 加分支；测试断言 10 |
| `src-tauri/src/commands/ai_chat.rs` | `MAX_AGENT_ROUNDS` = 200；系统提示运行时拼接 skill 元数据；`agent_loop` 入口加载 enabled skills |

### 7.3 前端新增

```
src/
├── components/
│   └── Settings/
│       ├── SkillsSection.tsx
│       └── SkillEditor.tsx
├── hooks/
│   └── useSkillQueries.ts
└── types/
    └── skill.ts
```

### 7.4 前端修改

| 文件 | 修改 |
|---|---|
| `src/components/Settings/settingSections.ts` | `SettingSectionKey` 加 `"skills"`；`SETTINGS_SECTIONS` 加条目 |
| `src/components/AiChat/AiChatMessages.tsx` | `load_skill` 消息 Markdown 渲染 |
| `src/components/AiChat/hooks.ts` | `invalidateQueriesForTool` 加 `"load_skill"` no-op |
| `src/locales/en.json` / `zh-Hans.json` | 新增 i18n 键 |

## 8. 错误处理与边界情况

| 场景 | 处理 |
|---|---|
| `load_skill` 调用不存在 id | 返回 `{ "error": "skill not found" }`；LLM 可恢复 |
| `load_skill` 调用已禁用 skill | 同上 |
| skill body > 50KB | 截断 + 追加 `…[已截断]` |
| 内置 skill 文件解析失败 | `tracing::error!` + 跳过该 skill，不阻塞启动 |
| 用户 skill `tools` 引用不存在工具名 | 允许保存（前向兼容）；元数据照常展示 |
| 无任何 enabled skill | 元数据段为空字符串，系统提示不出现 Skills 段；`load_skill` 仍注册但 LLM 无从得知 id |
| V9 迁移失败 | 沿用现有迁移失败处理（启动中断） |
| 跨会话 skill 状态 | 全局生效，切换会话立即同步 |
| 运行中修改 skill | 当前 run 不感知（元数据 run 启动时快照），下次 `ai_chat` 生效 |
| `load_skill` 重复调用 | V1 不去重，靠 LLM 自律 + 200 轮预算；实测后优化 |

## 9. 测试策略

### Rust 单元测试

**`core/src/skill.rs`**:
- `test_create_and_get_skill` — 创建用户 skill 并读回
- `test_list_merges_builtin_and_user` — 内置 + 用户合并
- `test_update_builtin_rejected` — 内置 skill 更新返回错误
- `test_delete_builtin_rejected` — 内置 skill 删除返回错误
- `test_set_enabled_builtin_ok` — 内置 skill 可禁用（状态存 app_setting）
- `test_load_skill_not_found` — `execute_load_skill` 返回 error

**`src-tauri/src/ai/tools.rs`**:
- 更新 `test_tool_definitions_count` 断言为 10
- `test_load_skill_tool_definition` — 验证 `load_skill` 在定义列表中
- `test_execute_load_skill_returns_body` — 加载已存在 skill 返回 body

**`src-tauri/src/ai/builtin_skills.rs`**:
- `test_builtin_skills_loaded` — 启动后 builtin 缓存非空
- `test_builtin_skill_ids_prefixed` — 所有内置 id 以 `b-` 开头

### 前端

V1 靠 TypeScript 类型检查 + 手动测试保障（视项目测试基础设施决定是否补充）。

## 10. 模块依赖关系

```
main.rs
  ├─ state.rs (AppState.builtin_skills)
  ├─ ai/builtin_skills.rs ──include_str!──▶ skills/*.md
  └─ commands/skill.rs ──▶ core/skill.rs ──▶ migrations/V9

ai_chat.rs
  ├─ ai/tools.rs (load_skill 工具定义 + 分发)
  ├─ ai/builtin_skills.rs (读 builtin 缓存)
  └─ core/skill.rs (list_enabled 合并 builtin+user)

hooks.ts (AiChat)
  └─ invalidateQueriesForTool: load_skill → no-op

Settings/SkillsSection.tsx
  └─ hooks/useSkillQueries.ts ──▶ commands/skill.rs (IPC)
```

## 11. 实现顺序建议

1. `core/migrations/V9__add_skill.sql` + `core/src/skill.rs` + 单元测试
2. `src-tauri/src/ai/builtin_skills.rs` + 3 个内置 skill `.md` 文件
3. `src-tauri/src/commands/skill.rs` + `main.rs` 注册 + `state.rs` 集成
4. `src-tauri/src/ai/tools.rs` 加 `load_skill` 定义与分发 + 测试更新
5. `src-tauri/src/commands/ai_chat.rs` 系统提示拼接 + `MAX_AGENT_ROUNDS` = 200
6. 前端 `types/skill.ts` + `hooks/useSkillQueries.ts`
7. 前端 `Settings/SkillsSection.tsx` + `SkillEditor.tsx` + `settingSections.ts` 注册
8. 前端 `AiChatMessages.tsx` 渲染优化 + `hooks.ts` no-op
9. i18n 键
10. 端到端手动测试（创建 skill → 聊天中触发 load_skill → 验证 LLM 据指南调用工具）
