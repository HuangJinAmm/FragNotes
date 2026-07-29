# AI Chat Skills 加载功能 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为 AI chat agent 增加 Skills 机制——skill 是 Markdown 指南文档，元数据始终注入系统提示，LLM 通过调用 `load_skill` 工具按需加载全文，据此正确调用业务工具。

**Architecture:** 内置 skill（`include_str!` 编译期嵌入）+ 用户 skill（DB `skill` 表）。`agent_loop` 启动时读 enabled skills 元数据，拼接进系统提示；新增 `load_skill` 工具走现有 tool-call 分发，返回 skill 全文。设置面板管理 skill 增删改查。

**Tech Stack:** Rust（rusqlite 0.32, refinery 迁移, serde, Tauri 2）/ React + TypeScript / TanStack Query / Tailwind / i18n (zh-Hans, en)

---

## 文件结构

### Rust 新增
- `core/migrations/V9__add_skill.sql` — skill 表迁移
- `core/src/skill.rs` — Skill 实体 + CRUD store 函数
- `src-tauri/skills/review_card_best_practices.md` — 内置 skill 1
- `src-tauri/skills/semantic_search_tips.md` — 内置 skill 2
- `src-tauri/skills/office_cli_guide.md` — 内置 skill 3（占位）
- `src-tauri/src/ai/builtin_skills.rs` — `include_str!` + 解析 frontmatter + 缓存
- `src-tauri/src/commands/skill.rs` — 5 个 Tauri 命令

### Rust 修改
- `core/src/lib.rs` — 注册 `skill` 模块
- `src-tauri/src/commands/mod.rs` — 注册 `skill` 模块
- `src-tauri/src/main.rs` — 注册 5 个 skill_* 命令到 invoke_handler
- `src-tauri/src/state.rs` — AppState 加 `builtin_skills` 字段
- `src-tauri/src/ai/tools.rs` — 加 `load_skill` 定义 + 分发 + execute 函数；测试断言 10
- `src-tauri/src/commands/ai_chat.rs` — `MAX_AGENT_ROUNDS`=200；系统提示拼接 skill 元数据

### 前端新增
- `src/types/skill.ts` — SkillDto 等类型
- `src/hooks/useSkillQueries.ts` — React Query 封装
- `src/components/Settings/SkillsSection.tsx` — 设置区段
- `src/components/Settings/SkillEditor.tsx` — 新建/编辑 Dialog

### 前端修改
- `src/components/Settings/settingSections.ts` — 注册 skills 区段
- `src/components/AiChat/AiChatMessages.tsx` — load_skill 消息 Markdown 渲染
- `src/components/AiChat/hooks.ts` — invalidateQueriesForTool 加 load_skill no-op
- `src/locales/en.json` / `zh-Hans.json` — i18n 键

---

## Task 1: V9 迁移 + core/skill.rs 实体与 store

**Files:**
- Create: `core/migrations/V9__add_skill.sql`
- Create: `core/src/skill.rs`
- Modify: `core/src/lib.rs`

- [x] **Step 1: 创建 V9 迁移文件**

Create `core/migrations/V9__add_skill.sql`:

```sql
-- Skills：AI agent 工具使用指南
-- skill: 用户自定义 skill（内置 skill 通过 include_str! 编译期嵌入，不入库）

CREATE TABLE IF NOT EXISTS skill (
    id           TEXT PRIMARY KEY,        -- "u-<slug>"
    name         TEXT NOT NULL,
    description  TEXT NOT NULL,           -- 注入 LLM 元数据的单行摘要
    tools        TEXT NOT NULL,           -- JSON 数组，如 ["office_cli"]
    body         TEXT NOT NULL,           -- Markdown 正文（不含 frontmatter）
    enabled      INTEGER NOT NULL DEFAULT 1,
    created_ts   INTEGER NOT NULL,
    updated_ts   INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_skill_enabled ON skill(enabled);
```

- [x] **Step 2: 在 core/src/lib.rs 注册 skill 模块**

Modify `core/src/lib.rs` — 在 `pub mod setting;` 之后加一行：

```rust
pub mod skill;
```

- [x] **Step 3: 创建 core/src/skill.rs 实体 + list/get 函数**

Create `core/src/skill.rs`. 关键设计点：`AppSettingStore` 是 `Store` 的字段（`store.setting.app`），不能从裸 `Connection` 取到，所以 list/get/create/update/delete/set_enabled 函数签名接收 `&Store`，内部用 `store.with_conn(|conn| ...)` 获取连接，并在闭包内通过 `store.setting.app.get(conn, key)` 访问 app_setting。

```rust
//! Skills：AI agent 工具使用指南的存储
//!
//! Skill 来源：
//! - BuiltIn（内置）：通过 include_str! 编译期嵌入，本体只读，禁用状态存 app_setting
//! - User（用户）：存 skill 表，可增删改

use crate::error::{CoreError, CoreResult};
use crate::Store;
use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum SkillSource {
    BuiltIn,
    User,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Skill {
    pub id: String,
    pub name: String,
    pub description: String,
    pub tools: Vec<String>,
    pub body: String,
    pub enabled: bool,
    pub source: SkillSource,
    #[serde(default)]
    pub created_ts: i64,
    #[serde(default)]
    pub updated_ts: i64,
}

pub const DISABLED_BUILTIN_KEY: &str = "ai_skill_disabled_builtin";

fn load_disabled_builtin(conn: &Connection, store: &Store) -> Vec<String> {
    store
        .setting
        .app
        .get(conn, DISABLED_BUILTIN_KEY)
        .ok()
        .flatten()
        .and_then(|s| serde_json::from_str::<Vec<String>>(&s).ok())
        .unwrap_or_default()
}

fn save_disabled_builtin(conn: &Connection, store: &Store, ids: &[String]) -> CoreResult<()> {
    let json = serde_json::to_string(ids)
        .map_err(|e| CoreError::Other(format!("序列化禁用列表失败: {e}")))?;
    store.setting.app.upsert(conn, DISABLED_BUILTIN_KEY, &json)
}

/// 列出所有 skill（合并内置 + 用户），按 name 排序
pub fn list(builtin: &[Skill], store: &Store) -> CoreResult<Vec<Skill>> {
    store.with_conn(|conn| {
        let disabled = load_disabled_builtin(conn, store);
        let mut result: Vec<Skill> = builtin
            .iter()
            .map(|s| Skill {
                enabled: !disabled.contains(&s.id),
                ..s.clone()
            })
            .collect();

        let mut stmt = conn.prepare(
            "SELECT id, name, description, tools, body, enabled, created_ts, updated_ts
             FROM skill ORDER BY name",
        )?;
        let user_rows = stmt.query_map([], |row| {
            let tools_json: String = row.get(3)?;
            let tools: Vec<String> = serde_json::from_str(&tools_json).unwrap_or_default();
            Ok(Skill {
                id: row.get(0)?,
                name: row.get(1)?,
                description: row.get(2)?,
                tools,
                body: row.get(4)?,
                enabled: row.get::<_, i64>(5)? != 0,
                source: SkillSource::User,
                created_ts: row.get(6)?,
                updated_ts: row.get(7)?,
            })
        })?;
        for r in user_rows {
            result.push(r?);
        }
        result.sort_by(|a, b| a.name.cmp(&b.name));
        Ok(result)
    })
}

/// 仅返回 enabled 的 skill
pub fn list_enabled(builtin: &[Skill], store: &Store) -> CoreResult<Vec<Skill>> {
    Ok(list(builtin, store)?
        .into_iter()
        .filter(|s| s.enabled)
        .collect())
}

/// 按 id 查找（合并内置 + 用户）
pub fn get(builtin: &[Skill], store: &Store, id: &str) -> CoreResult<Option<Skill>> {
    store.with_conn(|conn| {
        // 先查内置
        if let Some(b) = builtin.iter().find(|s| s.id == id) {
            let disabled = load_disabled_builtin(conn, store);
            return Ok(Some(Skill {
                enabled: !disabled.contains(&b.id),
                ..b.clone()
            }));
        }
        // 再查 DB
        let row_opt: Option<Skill> = conn
            .query_row(
                "SELECT id, name, description, tools, body, enabled, created_ts, updated_ts
                 FROM skill WHERE id = ?",
                params![id],
                |row| {
                    let tools_json: String = row.get(3)?;
                    let tools: Vec<String> =
                        serde_json::from_str(&tools_json).unwrap_or_default();
                    Ok(Skill {
                        id: row.get(0)?,
                        name: row.get(1)?,
                        description: row.get(2)?,
                        tools,
                        body: row.get(4)?,
                        enabled: row.get::<_, i64>(5)? != 0,
                        source: SkillSource::User,
                        created_ts: row.get(6)?,
                        updated_ts: row.get(7)?,
                    })
                },
            )
            .ok();
        Ok(row_opt)
    })
}
```

- [x] **Step 4: 在 core/src/skill.rs 添加 create/update/delete/set_enabled**

Append to `core/src/skill.rs`:

```rust
/// 创建用户 skill。id 必须以 "u-" 开头且不与内置冲突。
pub fn create(store: &Store, mut skill: Skill) -> CoreResult<Skill> {
    if !skill.id.starts_with("u-") {
        return Err(CoreError::Other("用户 skill id 必须以 u- 开头".into()));
    }
    let now = chrono::Utc::now().timestamp();
    skill.source = SkillSource::User;
    skill.created_ts = now;
    skill.updated_ts = now;
    let tools_json = serde_json::to_string(&skill.tools)
        .map_err(|e| CoreError::Other(format!("序列化 tools 失败: {e}")))?;
    store.with_conn(|conn| {
        conn.execute(
            "INSERT INTO skill (id, name, description, tools, body, enabled, created_ts, updated_ts)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?7)",
            params![
                skill.id,
                skill.name,
                skill.description,
                tools_json,
                skill.body,
                skill.enabled as i64,
                now,
            ],
        )?;
        Ok::<(), CoreError>(())
    })?;
    Ok(skill)
}

/// 更新用户 skill（内置 skill 不可改，返回错误）
pub fn update(store: &Store, skill: Skill) -> CoreResult<Skill> {
    if skill.source == SkillSource::BuiltIn {
        return Err(CoreError::Other("built-in skill is read-only".into()));
    }
    let now = chrono::Utc::now().timestamp();
    let tools_json = serde_json::to_string(&skill.tools)
        .map_err(|e| CoreError::Other(format!("序列化 tools 失败: {e}")))?;
    let affected = store.with_conn(|conn| {
        conn.execute(
            "UPDATE skill SET name=?1, description=?2, tools=?3, body=?4, enabled=?5, updated_ts=?6
             WHERE id=?7",
            params![
                skill.name,
                skill.description,
                tools_json,
                skill.body,
                skill.enabled as i64,
                now,
                skill.id,
            ],
        )
    })?;
    if affected == 0 {
        return Err(CoreError::Other(format!("skill {} 不存在", skill.id)));
    }
    Ok(Skill {
        updated_ts: now,
        ..skill
    })
}

/// 删除用户 skill（内置 skill 不可删）
pub fn delete(store: &Store, id: &str) -> CoreResult<()> {
    // 检查是否内置（通过约定：内置 id 以 b- 开头）
    if id.starts_with("b-") {
        return Err(CoreError::Other("built-in skill is read-only".into()));
    }
    store.with_conn(|conn| {
        conn.execute("DELETE FROM skill WHERE id=?1", params![id])?;
        Ok(())
    })
}

/// 设置启用状态。user skill 改 DB；builtin skill 改 app_setting 禁用列表。
pub fn set_enabled(store: &Store, id: &str, enabled: bool) -> CoreResult<()> {
    if id.starts_with("b-") {
        // 内置 skill：操作禁用列表
        store.with_conn(|conn| {
            let mut disabled = load_disabled_builtin(conn, store);
            if enabled {
                disabled.retain(|x| x != id);
            } else if !disabled.contains(&id.to_string()) {
                disabled.push(id.to_string());
            }
            save_disabled_builtin(conn, store, &disabled)
        })
    } else {
        store.with_conn(|conn| {
            conn.execute(
                "UPDATE skill SET enabled=?1 WHERE id=?2",
                params![enabled as i64, id],
            )?;
            Ok(())
        })
    }
}
```

- [x] **Step 5: 在 core/src/skill.rs 添加单元测试**

Append to `core/src/skill.rs`:

```rust
#[cfg(test)]
mod tests {
    use super::*;

    fn sample_builtin() -> Vec<Skill> {
        vec![Skill {
            id: "b-test".to_string(),
            name: "Test Builtin".to_string(),
            description: "builtin desc".to_string(),
            tools: vec!["list_memos".to_string()],
            body: "# Builtin\n...".to_string(),
            enabled: true,
            source: SkillSource::BuiltIn,
            created_ts: 0,
            updated_ts: 0,
        }]
    }

    #[test]
    fn test_create_and_get_user_skill() {
        let store = Store::open(":memory:").unwrap();
        let s = Skill {
            id: "u-my".to_string(),
            name: "My".to_string(),
            description: "desc".to_string(),
            tools: vec!["create_memo".to_string()],
            body: "# body".to_string(),
            enabled: true,
            source: SkillSource::User,
            created_ts: 0,
            updated_ts: 0,
        };
        let created = create(&store, s.clone()).unwrap();
        assert_eq!(created.id, "u-my");
        assert!(created.created_ts > 0);

        let got = get(&[], &store, "u-my").unwrap().unwrap();
        assert_eq!(got.name, "My");
        assert_eq!(got.tools, vec!["create_memo".to_string()]);
    }

    #[test]
    fn test_create_rejects_non_u_prefix() {
        let store = Store::open(":memory:").unwrap();
        let s = Skill {
            id: "bad".to_string(),
            name: "n".to_string(),
            description: "d".to_string(),
            tools: vec![],
            body: "b".to_string(),
            enabled: true,
            source: SkillSource::User,
            created_ts: 0,
            updated_ts: 0,
        };
        assert!(create(&store, s).is_err());
    }

    #[test]
    fn test_list_merges_builtin_and_user() {
        let store = Store::open(":memory:").unwrap();
        let builtin = sample_builtin();
        create(
            &store,
            Skill {
                id: "u-alpha".to_string(),
                name: "Alpha".to_string(),
                description: "d".to_string(),
                tools: vec![],
                body: "b".to_string(),
                enabled: true,
                source: SkillSource::User,
                created_ts: 0,
                updated_ts: 0,
            },
        )
        .unwrap();
        let all = list(&builtin, &store).unwrap();
        assert_eq!(all.len(), 2);
        // 排序后 Alpha 在前
        assert_eq!(all[0].name, "Alpha");
        assert_eq!(all[1].name, "Test Builtin");
    }

    #[test]
    fn test_update_builtin_rejected() {
        let store = Store::open(":memory:").unwrap();
        let s = Skill {
            id: "b-test".to_string(),
            name: "n".to_string(),
            description: "d".to_string(),
            tools: vec![],
            body: "b".to_string(),
            enabled: true,
            source: SkillSource::BuiltIn,
            created_ts: 0,
            updated_ts: 0,
        };
        assert!(update(&store, s).is_err());
    }

    #[test]
    fn test_delete_builtin_rejected() {
        let store = Store::open(":memory:").unwrap();
        assert!(delete(&store, "b-test").is_err());
    }

    #[test]
    fn test_set_enabled_builtin_ok() {
        let store = Store::open(":memory:").unwrap();
        // 禁用内置
        set_enabled(&store, "b-test", false).unwrap();
        let builtin = sample_builtin();
        let all = list(&builtin, &store).unwrap();
        let b = all.iter().find(|s| s.id == "b-test").unwrap();
        assert!(!b.enabled);

        // 重新启用
        set_enabled(&store, "b-test", true).unwrap();
        let all = list(&builtin, &store).unwrap();
        let b = all.iter().find(|s| s.id == "b-test").unwrap();
        assert!(b.enabled);
    }

    #[test]
    fn test_get_not_found() {
        let store = Store::open(":memory:").unwrap();
        assert!(get(&[], &store, "nonexistent").unwrap().is_none());
    }
}
```

- [x] **Step 6: 运行测试验证**

Run: `cargo test -p memos-core --lib skill::`
Expected: 所有 7 个测试 PASS

- [x] **Step 7: 提交**

```bash
git add core/migrations/V9__add_skill.sql core/src/skill.rs core/src/lib.rs
git commit -m "feat(core): add skill table migration and Skill store CRUD"
```

---

## Task 2: 内置 skill 文件 + builtin_skills.rs 解析器 ⚠️（占位 office_cli_guide.md 被 8 个真实 office-cli skill 替换，属升级）

**Files:**
- Create: `src-tauri/skills/review_card_best_practices.md`
- Create: `src-tauri/skills/semantic_search_tips.md`
- Create: `src-tauri/skills/office_cli_guide.md`
- Create: `src-tauri/src/ai/builtin_skills.rs`

- [x] **Step 1: 创建内置 skill 文件 1 — review_card_best_practices.md**

Create `src-tauri/skills/review_card_best_practices.md`:

```markdown
---
id: b-review-card-best-practices
name: 复习卡片最佳实践
description: 指导 create_review_cards 工具的卡片类型选择与 front/back 编写规范
tools: [create_review_cards]
---

# 复习卡片生成指南

## 卡片类型选择决策树

1. **basic** — 单向问答（"X 是什么？"）。默认选择，适合定义、事实。
2. **reversed** — 双向问答（"X ↔ 定义"）。适合术语 ↔ 概念的双向映射。
3. **cloze** — 填空（"___ 是 X"）。适合完整背诵定义、公式。必须提供 `cloze_answer`。
4. **concept** — 概念解释（"解释 X"）。适合需要展开论述的概念。
5. **compare** — 对比（"对比 A 与 B"）。适合易混淆概念。

## front/back 编写规范

- front：问题，简短明确，一句话。避免多问。
- back：答案，Markdown。包含"是什么 + 关键点 + （可选）例子"。
- 每张卡只考一个知识点。若笔记涉及多个，拆成多张卡。
- `angle` 字段：`定义` | `应用` | `对比` | `列举` | `原理`，反映考核角度。

## 示例

笔记内容："Rust 所有权规则：每个值有唯一所有者，作用域结束自动释放。"

生成卡片：
- card_type: `cloze`
- front: "`___` 规则：每个值有唯一所有者，作用域结束自动释放。"
- cloze_answer: "所有权"
- back: "**所有权**：Rust 内存安全核心机制。每个值有唯一所有者，所有者离开作用域时值自动 drop。"
- angle: `定义`
```

- [x] **Step 2: 创建内置 skill 文件 2 — semantic_search_tips.md**

Create `src-tauri/skills/semantic_search_tips.md`:

```markdown
---
id: b-semantic-search-tips
name: 语义搜索使用提示
description: 指导 search_semantic 工具的查询表达优化与首次模型下载提示
tools: [search_semantic]
---

# 语义搜索使用指南

## 何时用语义搜索 vs list_memos

- **list_memos(query=...)** — 全文搜索（FTS），适合精确关键词匹配。
- **search_semantic(query=...)** — 语义搜索，按含义相似度查找。适合"关于某主题的想法"这类模糊查询。

## 查询表达优化

- 用**自然语言短语**，不要堆关键词。"如何管理时间" 优于 "时间 管理"。
- 描述**意图/主题**，而非复制笔记标题。"关于 Rust 内存安全的思考" 优于 "Rust"。
- 一次只查一个主题。多主题分多次调用。

## 首次调用延迟

首次调用会下载嵌入模型（约 90MB），可能耗时数十秒。后续调用快。若用户等待，提示此情况。

## 返回结果

返回 `memos` 数组，每项含 `uid` + `content` + `score`（0~1，越高越相似）。用 `get_memo(uid)` 取完整内容。
```

- [x] **Step 3: 创建内置 skill 文件 3 — office_cli_guide.md（占位）**

Create `src-tauri/skills/office_cli_guide.md`:

```markdown
---
id: b-office-cli-guide
name: Office CLI 指南
description: 指导 office_cli 工具生成 Word/Excel/PPT 文档的子命令与参数格式（工具待实现，占位）
tools: [office_cli]
---

# Office CLI 使用指南

> 注意：`office_cli` 工具当前尚未实现。本 skill 为前向占位，待工具落地后填充实际内容。

## 预期子命令（草案）

- `word --template report --out {{path}}` 生成 Word
- `excel --sheets {{n}} --out {{path}}` 生成 Excel
- `ppt --slides {{n}} --out {{path}}` 生成 PPT

## 注意事项（待定）

- 路径必须为绝对路径
- 模板名见 templates 目录
- 此 skill 仅供参考，实际调用以工具实现为准
```

- [x] **Step 4: 创建 src-tauri/src/ai/builtin_skills.rs**

Create `src-tauri/src/ai/builtin_skills.rs`:

```rust
//! 内置 skill：通过 include_str! 编译期嵌入，启动时解析 frontmatter 缓存到 AppState
//!
//! frontmatter 格式（YAML）：
//!   ---
//!   id: b-xxx
//!   name: xxx
//!   description: xxx
//!   tools: [tool1, tool2]
//!   ---
//!   # Markdown body...

use memos_core::skill::{Skill, SkillSource};

/// 嵌入内置 skill 文件
const RAW_FILES: &[(&str, &str)] = &[
    (
        "review_card_best_practices",
        include_str!("../../skills/review_card_best_practices.md"),
    ),
    (
        "semantic_search_tips",
        include_str!("../../skills/semantic_search_tips.md"),
    ),
    (
        "office_cli_guide",
        include_str!("../../skills/office_cli_guide.md"),
    ),
];

/// 解析单个 skill 文件的 frontmatter + body
fn parse(raw: &str) -> Result<Skill, String> {
    let raw = raw.trim_start();
    if !raw.starts_with("---") {
        return Err("missing frontmatter start delimiter".into());
    }
    let after_start = &raw[3..];
    let end = after_start
        .find("\n---")
        .ok_or_else(|| "missing frontmatter end delimiter".to_string())?;
    let frontmatter = &after_start[..end];
    let body = after_start[end + 4..].trim_start_matches('\n');

    let mut id = None;
    let mut name = None;
    let mut description = None;
    let mut tools: Vec<String> = Vec::new();

    for line in frontmatter.lines() {
        let line = line.trim();
        if let Some(v) = line.strip_prefix("id:") {
            id = Some(v.trim().to_string());
        } else if let Some(v) = line.strip_prefix("name:") {
            name = Some(v.trim().to_string());
        } else if let Some(v) = line.strip_prefix("description:") {
            description = Some(v.trim().to_string());
        } else if let Some(v) = line.strip_prefix("tools:") {
            // 格式: [a, b, c]
            let v = v.trim().trim_start_matches('[').trim_end_matches(']');
            tools = v
                .split(',')
                .map(|s| s.trim().to_string())
                .filter(|s| !s.is_empty())
                .collect();
        }
    }

    Ok(Skill {
        id: id.ok_or("missing id")?,
        name: name.ok_or("missing name")?,
        description: description.ok_or("missing description")?,
        tools,
        body: body.to_string(),
        enabled: true,
        source: SkillSource::BuiltIn,
        created_ts: 0,
        updated_ts: 0,
    })
}

/// 启动时调用一次，解析所有内置 skill。解析失败的跳过并记录日志。
pub fn load_builtin_skills() -> Vec<Skill> {
    let mut result = Vec::new();
    for (name, raw) in RAW_FILES {
        match parse(raw) {
            Ok(s) => {
                if !s.id.starts_with("b-") {
                    tracing::error!("内置 skill {} 的 id 不以 b- 开头: {}", name, s.id);
                    continue;
                }
                result.push(s);
            }
            Err(e) => {
                tracing::error!("解析内置 skill {} 失败: {}", name, e);
            }
        }
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_builtin_skills_loaded() {
        let skills = load_builtin_skills();
        assert!(!skills.is_empty(), "至少应加载一个内置 skill");
    }

    #[test]
    fn test_builtin_skill_ids_prefixed() {
        let skills = load_builtin_skills();
        for s in &skills {
            assert!(
                s.id.starts_with("b-"),
                "内置 skill id 必须以 b- 开头: {}",
                s.id
            );
        }
    }

    #[test]
    fn test_parse_valid() {
        let raw = "---\nid: b-test\nname: Test\ndescription: a test\ntools: [a, b]\n---\n# Body\ncontent";
        let s = parse(raw).unwrap();
        assert_eq!(s.id, "b-test");
        assert_eq!(s.name, "Test");
        assert_eq!(s.description, "a test");
        assert_eq!(s.tools, vec!["a".to_string(), "b".to_string()]);
        assert_eq!(s.body, "# Body\ncontent");
    }

    #[test]
    fn test_parse_missing_frontmatter() {
        let raw = "no frontmatter here";
        assert!(parse(raw).is_err());
    }
}
```

- [x] **Step 5: 运行测试验证**

Run: `cargo test -p app --lib ai::builtin_skills`
Expected: 4 个测试 PASS

- [x] **Step 6: 提交**

```bash
git add src-tauri/skills/ src-tauri/src/ai/builtin_skills.rs
git commit -m "feat(ai): add builtin skill markdown files and parser"
```

---

## Task 3: AppState 集成 + Tauri 命令层

**Files:**
- Modify: `src-tauri/src/state.rs`
- Create: `src-tauri/src/commands/skill.rs`
- Modify: `src-tauri/src/commands/mod.rs`
- Modify: `src-tauri/src/main.rs`

- [x] **Step 1: 在 state.rs 的 AppState 加 builtin_skills 字段**

Modify `src-tauri/src/state.rs` — 在 `use` 块加导入，并在 `AppState` struct 加字段：

在文件顶部 `use` 块加：
```rust
use crate::ai::builtin_skills::load_builtin_skills;
use memos_core::skill::Skill;
```

在 `AppState` struct 的 `pub shutdown: AtomicBool,` 之前加：
```rust
    /// 内置 skill 缓存（启动时从 include_str! 解析，只读）
    pub builtin_skills: Vec<Skill>,
```

- [x] **Step 2: 在 main.rs 的 AppState 构造处填充 builtin_skills**

Modify `src-tauri/src/main.rs` — AppState 在第 206-214 行构造。在 struct 字面量中 `shutdown` 字段之前加 `builtin_skills` 字段：

```rust
            app.manage(AppState {
                store: std::sync::Mutex::new(store),
                attachments_dir,
                lan: std::sync::RwLock::new(None),
                llm: std::sync::RwLock::new(None),
                mcp: std::sync::RwLock::new(None),
                builtin_skills: crate::ai::builtin_skills::load_builtin_skills(),
                shutdown: std::sync::atomic::AtomicBool::new(false),
                cleanup_started: std::sync::atomic::AtomicBool::new(false),
            });
```

- [x] **Step 3: 创建 src-tauri/src/commands/skill.rs**

Create `src-tauri/src/commands/skill.rs`:

```rust
//! Skill 管理 IPC 命令

use crate::error::IpcResult;
use crate::state::AppState;
use memos_core::skill::{Skill, SkillSource};
use tauri::State;

#[derive(Debug, Clone, serde::Serialize)]
pub struct SkillDto {
    pub id: String,
    pub name: String,
    pub description: String,
    pub tools: Vec<String>,
    pub body: String,
    pub enabled: bool,
    pub source: String, // "builtin" | "user"
    pub created_ts: i64,
    pub updated_ts: i64,
}

impl From<Skill> for SkillDto {
    fn from(s: Skill) -> Self {
        Self {
            source: match s.source {
                SkillSource::BuiltIn => "builtin".to_string(),
                SkillSource::User => "user".to_string(),
            },
            id: s.id,
            name: s.name,
            description: s.description,
            tools: s.tools,
            body: s.body,
            enabled: s.enabled,
            created_ts: s.created_ts,
            updated_ts: s.updated_ts,
        }
    }
}

#[tauri::command]
pub fn skill_list(state: State<'_, AppState>) -> IpcResult<Vec<SkillDto>> {
    let store = state.store();
    let builtin = state.builtin_skills.clone();
    let skills = memos_core::skill::list(&builtin, &store)
        .map_err(|e| crate::error::IpcError::Internal(e.to_string()))?;
    Ok(skills.into_iter().map(SkillDto::from).collect())
}

#[tauri::command]
pub fn skill_create(
    state: State<'_, AppState>,
    skill: Skill,
) -> IpcResult<SkillDto> {
    let store = state.store();
    let created = memos_core::skill::create(&store, skill)
        .map_err(|e| crate::error::IpcError::Internal(e.to_string()))?;
    Ok(SkillDto::from(created))
}

#[tauri::command]
pub fn skill_update(
    state: State<'_, AppState>,
    skill: Skill,
) -> IpcResult<SkillDto> {
    let store = state.store();
    let updated = memos_core::skill::update(&store, skill)
        .map_err(|e| crate::error::IpcError::Internal(e.to_string()))?;
    Ok(SkillDto::from(updated))
}

#[tauri::command]
pub fn skill_delete(state: State<'_, AppState>, id: String) -> IpcResult<()> {
    let store = state.store();
    memos_core::skill::delete(&store, &id)
        .map_err(|e| crate::error::IpcError::Internal(e.to_string()))?;
    Ok(())
}

#[tauri::command]
pub fn skill_set_enabled(
    state: State<'_, AppState>,
    id: String,
    enabled: bool,
) -> IpcResult<()> {
    let store = state.store();
    memos_core::skill::set_enabled(&store, &id, enabled)
        .map_err(|e| crate::error::IpcError::Internal(e.to_string()))?;
    Ok(())
}
```

- [x] **Step 4: 在 commands/mod.rs 注册 skill 模块**

Modify `src-tauri/src/commands/mod.rs` — 在 `pub mod setting;` 之后加：

```rust
pub mod skill;
```

- [x] **Step 5: 在 main.rs 注册 5 个 skill_* 命令到 invoke_handler**

Modify `src-tauri/src/main.rs` — 在 `// review` 段落之前（或 `// setting` 段落之后）加：

```rust
            // skills
            commands::skill::skill_list,
            commands::skill::skill_create,
            commands::skill::skill_update,
            commands::skill::skill_delete,
            commands::skill::skill_set_enabled,
```

- [x] **Step 6: 在 ai/mod.rs 注册 builtin_skills 子模块**

Modify `src-tauri/src/ai/mod.rs` — 加 `pub mod builtin_skills;`（参考现有 `pub mod tools;` 等声明位置）。

- [x] **Step 7: 编译验证**

Run: `cargo check -p app`
Expected: 编译通过（可能有 unused warning，无 error）

- [x] **Step 8: 提交**

```bash
git add src-tauri/src/state.rs src-tauri/src/commands/skill.rs src-tauri/src/commands/mod.rs src-tauri/src/main.rs src-tauri/src/ai/mod.rs src-tauri/src/ai.rs
git commit -m "feat(ipc): add skill management commands and AppState builtin_skills cache"
```

---

## Task 4: load_skill 工具定义与分发

**Files:**
- Modify: `src-tauri/src/ai/tools.rs`

- [x] **Step 1: 在 tool_definitions() 末尾加 load_skill 定义**

Modify `src-tauri/src/ai/tools.rs` — 在 `tool_definitions()` 的 `vec![` 末尾、`create_review_cards` 定义之后、`]` 之前加：

```rust
        json!({
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
        }),
```

- [x] **Step 2: 修改 execute_tool 签名与分发**

`execute_skill` 需要访问 builtin skills 列表。修改 `execute_tool` 签名加 `builtin: &[Skill]` 参数。

Modify `src-tauri/src/ai/tools.rs` — 将 `execute_tool` 函数改为：

```rust
use memos_core::skill::{Skill, SkillSource};

/// 执行工具调用，返回结果 JSON
pub fn execute_tool(
    name: &str,
    args: &Value,
    store: &Store,
    builtin: &[Skill],
) -> memos_core::CoreResult<Value> {
    match name {
        "list_memos" => execute_list_memos(args, store),
        "get_memo" => execute_get_memo(args, store),
        "create_memo" => execute_create_memo(args, store),
        "list_tags" => execute_list_tags(store),
        "list_memos_by_tag" => execute_list_memos_by_tag(args, store),
        "update_memo" => execute_update_memo(args, store),
        "search_semantic" => execute_search_semantic(args, store),
        "link_memos" => execute_link_memos(args, store),
        "create_review_cards" => execute_create_review_cards(args, store),
        "load_skill" => execute_load_skill(args, store, builtin),
        _ => Ok(json!({"error": format!("unknown tool: {name}")})),
    }
}
```

- [x] **Step 3: 实现 execute_load_skill 函数**

Append to `src-tauri/src/ai/tools.rs`（在 execute_create_review_cards 之后）：

```rust
const MAX_SKILL_BODY_BYTES: usize = 50 * 1024;

fn execute_load_skill(
    args: &Value,
    store: &Store,
    builtin: &[Skill],
) -> memos_core::CoreResult<Value> {
    let skill_id = args
        .get("skill_id")
        .and_then(|v| v.as_str())
        .ok_or_else(|| {
            memos_core::CoreError::Other("load_skill 缺少 skill_id 参数".into())
        })?;

    match memos_core::skill::get(builtin, store, skill_id)? {
        Some(s) if s.enabled => {
            let body = if s.body.len() > MAX_SKILL_BODY_BYTES {
                let mut truncated = s.body[..MAX_SKILL_BODY_BYTES].to_string();
                truncated.push_str("\n\n…[已截断]");
                truncated
            } else {
                s.body
            };
            Ok(json!({
                "id": s.id,
                "name": s.name,
                "body": body,
            }))
        }
        _ => Ok(json!({
            "error": "skill not found or disabled"
        })),
    }
}
```

- [x] **Step 4: 更新 test_tool_definitions_count 断言**

Modify `src-tauri/src/ai/tools.rs` 测试 — 将 `assert_eq!(defs.len(), 9);` 改为 `assert_eq!(defs.len(), 10);`，并在 names 断言加 `assert!(names.contains(&"load_skill"));`：

```rust
    #[test]
    fn test_tool_definitions_count() {
        let defs = tool_definitions();
        assert_eq!(defs.len(), 10);
        let names: Vec<&str> = defs
            .iter()
            .map(|d| d["function"]["name"].as_str().unwrap())
            .collect();
        assert!(names.contains(&"list_memos"));
        assert!(names.contains(&"get_memo"));
        assert!(names.contains(&"create_memo"));
        assert!(names.contains(&"list_tags"));
        assert!(names.contains(&"list_memos_by_tag"));
        assert!(names.contains(&"update_memo"));
        assert!(names.contains(&"search_semantic"));
        assert!(names.contains(&"link_memos"));
        assert!(names.contains(&"create_review_cards"));
        assert!(names.contains(&"load_skill"));
    }
```

- [x] **Step 5: 修复现有测试中 execute_tool 的调用**

现有测试可能直接调用 `execute_*` 函数（不经 `execute_tool` 分发），需检查是否有调用 `execute_tool` 的测试。

Run: `grep -n "execute_tool" src-tauri/src/ai/tools.rs src-tauri/src/commands/ai_chat.rs`

若有调用 `execute_tool(name, args, store)` 的地方（如 ai_chat.rs 的 agent_loop），需改为 `execute_tool(name, args, store, builtin)`，builtin 从 `state.builtin_skills` 取。这会在 Task 5 处理 ai_chat.rs 时统一改。

- [x] **Step 6: 运行测试验证**

Run: `cargo test -p app --lib ai::tools`
Expected: 测试 PASS（注意：若现有测试调用了 execute_tool，需先改参数。若只调用 execute_* 私有函数，则不受影响）

- [x] **Step 7: 提交**

```bash
git add src-tauri/src/ai/tools.rs
git commit -m "feat(ai): add load_skill tool definition and dispatcher"
```

---

## Task 5: ai_chat.rs 集成 — 系统提示拼接 + MAX_AGENT_ROUNDS

**Files:**
- Modify: `src-tauri/src/commands/ai_chat.rs`

- [x] **Step 1: 修改 MAX_AGENT_ROUNDS 为 200**

Modify `src-tauri/src/commands/ai_chat.rs` 第 80 行：

```rust
const MAX_AGENT_ROUNDS: u32 = 200;
```

- [x] **Step 2: 添加 build_skill_metadata_section 函数**

在 `ai_chat.rs` 的 `MAX_AGENT_ROUNDS` 定义之后加：

```rust
use memos_core::skill::Skill;

/// 构建注入系统提示的 skill 元数据段
fn build_skill_metadata_section(enabled_skills: &[Skill]) -> String {
    if enabled_skills.is_empty() {
        return String::new();
    }
    let lines: Vec<String> = enabled_skills
        .iter()
        .map(|s| {
            format!(
                "- id: {} | {} | 关联工具: [{}]",
                s.id,
                s.description,
                s.tools.join(", ")
            )
        })
        .collect();
    format!(
        "\n\n## 可用 Skills\n以下 skill 提供工具使用指南。在调用关联工具前，\
         若不确定参数或流程，请先用 load_skill(skill_id) 加载完整指南：\n{}",
        lines.join("\n")
    )
}
```

- [x] **Step 3: 在 agent_loop 中加载 enabled skills 并拼接系统提示**

Modify `src-tauri/src/commands/ai_chat.rs` 的 `agent_loop` 函数 — 在 `let mut msgs: Vec<Value> = ...` 之后、`let system_msg = ...` 之前插入：

```rust
    // 加载 enabled skills 元数据，拼接进系统提示
    let builtin = state.builtin_skills.clone();
    let enabled_skills = {
        let store = state.store();
        memos_core::skill::list_enabled(&builtin, &store).unwrap_or_default()
    };
    let skill_section = build_skill_metadata_section(&enabled_skills);
    let system_content = format!("{}{}", SYSTEM_PROMPT, skill_section);
    let system_msg = json!({"role": "system", "content": system_content});
```

并删除原来的 `let system_msg = json!({"role": "system", "content": SYSTEM_PROMPT});` 行。

- [x] **Step 4: 修改 execute_tool 调用，传入 builtin**

在 `agent_loop` 中查找 `execute_tool(...)` 调用，改为传入 `&builtin`：

原调用形如 `execute_tool(&name, &args, &store)`，改为 `execute_tool(&name, &args, &store, &builtin)`。

注意 builtin 在 Step 3 已 `clone()` 到本地变量，agent_loop 内可直接用 `&builtin`。

但注意：agent_loop 内 store 的获取方式。查找现有代码中 execute_tool 的调用上下文：

Run: `grep -n "execute_tool\|with_conn\|state.store()" src-tauri/src/commands/ai_chat.rs`

若 agent_loop 内通过 `let store = state.store();` 获取 store guard，则需确保 builtin 的 clone 在 store lock 之前完成（避免死锁）。

- [x] **Step 5: 编译验证**

Run: `cargo check -p app`
Expected: 编译通过

- [x] **Step 6: 提交**

```bash
git add src-tauri/src/commands/ai_chat.rs
git commit -m "feat(ai-chat): inject skill metadata into system prompt, bump MAX_AGENT_ROUNDS to 200"
```

---

## Task 6: 前端类型 + React Query hooks

**Files:**
- Create: `src/types/skill.ts`
- Create: `src/hooks/useSkillQueries.ts`

- [x] **Step 1: 创建 src/types/skill.ts**

Create `src/types/skill.ts`:

```typescript
export type SkillSource = "builtin" | "user";

export interface SkillDto {
  id: string;
  name: string;
  description: string;
  tools: string[];
  body: string;
  enabled: boolean;
  source: SkillSource;
  created_ts: number;
  updated_ts: number;
}

/** 已知的工具名（供 SkillEditor 的 tools 多选） */
export const KNOWN_TOOL_NAMES = [
  "list_memos",
  "get_memo",
  "create_memo",
  "list_tags",
  "list_memos_by_tag",
  "update_memo",
  "search_semantic",
  "link_memos",
  "create_review_cards",
  "load_skill",
] as const;
```

- [x] **Step 2: 创建 src/hooks/useSkillQueries.ts**

Create `src/hooks/useSkillQueries.ts`:

```typescript
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { invoke } from "@tauri-apps/api/core";
import type { SkillDto } from "@/types/skill";

export const skillKeys = {
  all: ["skills"] as const,
  list: () => [...skillKeys.all, "list"] as const,
};

export function useSkillList() {
  return useQuery<SkillDto[]>({
    queryKey: skillKeys.list(),
    queryFn: () => invoke<SkillDto[]>("skill_list"),
  });
}

export function useCreateSkill() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (skill: SkillDto) => invoke<SkillDto>("skill_create", { skill }),
    onSuccess: () => qc.invalidateQueries({ queryKey: skillKeys.all }),
  });
}

export function useUpdateSkill() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (skill: SkillDto) => invoke<SkillDto>("skill_update", { skill }),
    onSuccess: () => qc.invalidateQueries({ queryKey: skillKeys.all }),
  });
}

export function useDeleteSkill() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => invoke<void>("skill_delete", { id }),
    onSuccess: () => qc.invalidateQueries({ queryKey: skillKeys.all }),
  });
}

export function useSetSkillEnabled() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, enabled }: { id: string; enabled: boolean }) =>
      invoke<void>("skill_set_enabled", { id, enabled }),
    onSuccess: () => qc.invalidateQueries({ queryKey: skillKeys.all }),
  });
}
```

- [x] **Step 3: TypeScript 类型检查**

Run: `npx tsc --noEmit`
Expected: 无错误

- [x] **Step 4: 提交**

```bash
git add src/types/skill.ts src/hooks/useSkillQueries.ts
git commit -m "feat(web): add skill types and React Query hooks"
```

---

## Task 7: Settings SkillsSection + SkillEditor

**Files:**
- Create: `src/components/Settings/SkillEditor.tsx`
- Create: `src/components/Settings/SkillsSection.tsx`
- Modify: `src/components/Settings/settingSections.ts`

- [x] **Step 1: 创建 SkillEditor.tsx（Dialog）**

Create `src/components/Settings/SkillEditor.tsx`:

```tsx
import { useEffect, useState } from "react";
import toast from "react-hot-toast";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { useTranslate } from "@/utils/i18n";
import { getErrorMessage } from "@/lib/error";
import { KNOWN_TOOL_NAMES, type SkillDto } from "@/types/skill";

interface SkillEditorProps {
  open: boolean;
  /** 编辑模式时传入原 skill；新建模式为 null */
  skill: SkillDto | null;
  onSave: (skill: SkillDto) => Promise<void>;
  onClose: () => void;
}

const emptySkill = (): SkillDto => ({
  id: "",
  name: "",
  description: "",
  tools: [],
  body: "",
  enabled: true,
  source: "user",
  created_ts: 0,
  updated_ts: 0,
});

const SkillEditor = ({ open, skill, onSave, onClose }: SkillEditorProps) => {
  const t = useTranslate();
  const isEdit = skill !== null;
  const [draft, setDraft] = useState<SkillDto>(emptySkill());
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (open) {
      setDraft(skill ? { ...skill } : emptySkill());
    }
  }, [open, skill]);

  if (!open) return null;

  const toggleTool = (tool: string) => {
    setDraft((d) => ({
      ...d,
      tools: d.tools.includes(tool)
        ? d.tools.filter((x) => x !== tool)
        : [...d.tools, tool],
    }));
  };

  const handleSave = async () => {
    const slug = draft.id.trim().replace(/^u-/, "");
    if (!slug || !draft.name.trim() || !draft.description.trim() || !draft.body.trim()) {
      toast.error(t("settings.skills.editor.validation-required"));
      return;
    }
    const toSave: SkillDto = {
      ...draft,
      id: isEdit ? draft.id : `u-${slug}`,
      source: "user",
    };
    setSaving(true);
    try {
      await onSave(toSave);
      onClose();
    } catch (e) {
      toast.error(getErrorMessage(e, t("settings.skills.editor.save-failed")));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <div className="bg-background w-full max-w-2xl max-h-[90vh] overflow-y-auto rounded-lg border p-6 shadow-lg">
        <h2 className="mb-4 text-lg font-semibold">
          {isEdit ? t("settings.skills.editor.edit") : t("settings.skills.editor.create")}
        </h2>
        <div className="space-y-4">
          <div>
            <Label>{t("settings.skills.editor.id")}</Label>
            <Input
              value={isEdit ? draft.id : draft.id.replace(/^u-/, "")}
              onChange={(e) => setDraft((d) => ({ ...d, id: e.target.value }))}
              disabled={isEdit}
              placeholder="my-skill"
            />
            {!isEdit && (
              <p className="mt-1 text-xs text-muted-foreground">
                {t("settings.skills.editor.id-hint")}
              </p>
            )}
          </div>
          <div>
            <Label>{t("settings.skills.editor.name")}</Label>
            <Input
              value={draft.name}
              onChange={(e) => setDraft((d) => ({ ...d, name: e.target.value }))}
            />
          </div>
          <div>
            <Label>{t("settings.skills.editor.description")}</Label>
            <Input
              value={draft.description}
              onChange={(e) => setDraft((d) => ({ ...d, description: e.target.value }))}
            />
          </div>
          <div>
            <Label>{t("settings.skills.editor.tools")}</Label>
            <div className="mt-2 flex flex-wrap gap-2">
              {KNOWN_TOOL_NAMES.map((tool) => (
                <button
                  key={tool}
                  type="button"
                  onClick={() => toggleTool(tool)}
                  className={`rounded px-2 py-1 text-xs border ${
                    draft.tools.includes(tool)
                      ? "bg-primary text-primary-foreground border-primary"
                      : "bg-background border-border hover:bg-accent"
                  }`}
                >
                  {tool}
                </button>
              ))}
            </div>
          </div>
          <div>
            <Label>{t("settings.skills.editor.body")}</Label>
            <Textarea
              value={draft.body}
              onChange={(e) => setDraft((d) => ({ ...d, body: e.target.value }))}
              className="mt-2 font-mono text-sm"
              rows={12}
            />
          </div>
        </div>
        <div className="mt-6 flex justify-end gap-2">
          <Button variant="outline" onClick={onClose} disabled={saving}>
            {t("common.cancel")}
          </Button>
          <Button onClick={handleSave} disabled={saving}>
            {saving ? t("common.saving") : t("common.save")}
          </Button>
        </div>
      </div>
    </div>
  );
};

export default SkillEditor;
```

- [x] **Step 2: 创建 SkillsSection.tsx**

Create `src/components/Settings/SkillsSection.tsx`:

```tsx
import { useState } from "react";
import toast from "react-hot-toast";
import { SparklesIcon, PlusIcon, PencilIcon, Trash2Icon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { useTranslate } from "@/utils/i18n";
import { getErrorMessage } from "@/lib/error";
import {
  useSkillList,
  useCreateSkill,
  useUpdateSkill,
  useDeleteSkill,
  useSetSkillEnabled,
} from "@/hooks/useSkillQueries";
import type { SkillDto } from "@/types/skill";
import SettingGroup from "./SettingGroup";
import { SettingList, SettingListItem } from "./SettingList";
import SettingSection from "./SettingSection";
import SkillEditor from "./SkillEditor";

const SkillsSection = () => {
  const t = useTranslate();
  const { data: skills = [], isLoading } = useSkillList();
  const createMut = useCreateSkill();
  const updateMut = useUpdateSkill();
  const deleteMut = useDeleteSkill();
  const setEnabledMut = useSetSkillEnabled();

  const [editorOpen, setEditorOpen] = useState(false);
  const [editingSkill, setEditingSkill] = useState<SkillDto | null>(null);

  const builtin = skills.filter((s) => s.source === "builtin");
  const user = skills.filter((s) => s.source === "user");

  const handleToggle = (skill: SkillDto, enabled: boolean) => {
    setEnabledMut.mutate(
      { id: skill.id, enabled },
      {
        onError: (e) =>
          toast.error(getErrorMessage(e, t("settings.skills.toggle-failed"))),
      }
    );
  };

  const handleDelete = async (skill: SkillDto) => {
    if (!confirm(t("settings.skills.confirm-delete", { name: skill.name }))) return;
    deleteMut.mutate(skill.id, {
      onError: (e) =>
        toast.error(getErrorMessage(e, t("settings.skills.delete-failed"))),
    });
  };

  const handleEditorSave = async (skill: SkillDto) => {
    if (editingSkill) {
      await updateMut.mutateAsync(skill);
    } else {
      await createMut.mutateAsync(skill);
    }
  };

  return (
    <SettingSection title={t("settings.skills.title")} description={t("settings.skills.description")}>
      <SettingGroup title={t("settings.skills.builtin")}>
        {isLoading ? (
          <p className="text-sm text-muted-foreground p-4">{t("common.loading")}</p>
        ) : (
          <SettingList>
            {builtin.map((skill) => (
              <SettingListItem
                key={skill.id}
                title={skill.name}
                description={skill.description}
              >
                <div className="flex items-center gap-3">
                  <div className="flex flex-wrap gap-1">
                    {skill.tools.map((tool) => (
                      <span
                        key={tool}
                        className="rounded bg-muted px-1.5 py-0.5 text-xs"
                      >
                        {tool}
                      </span>
                    ))}
                  </div>
                  <Switch
                    checked={skill.enabled}
                    onCheckedChange={(v) => handleToggle(skill, v)}
                  />
                </div>
              </SettingListItem>
            ))}
          </SettingList>
        )}
      </SettingGroup>

      <SettingGroup title={t("settings.skills.custom")}>
        <SettingList>
          {user.map((skill) => (
            <SettingListItem
              key={skill.id}
              title={skill.name}
              description={skill.description}
            >
              <div className="flex items-center gap-3">
                <div className="flex flex-wrap gap-1">
                  {skill.tools.map((tool) => (
                    <span
                      key={tool}
                      className="rounded bg-muted px-1.5 py-0.5 text-xs"
                    >
                      {tool}
                    </span>
                  ))}
                </div>
                <Switch
                  checked={skill.enabled}
                  onCheckedChange={(v) => handleToggle(skill, v)}
                />
                <Button
                  variant="ghost"
                  size="icon"
                  onClick={() => {
                    setEditingSkill(skill);
                    setEditorOpen(true);
                  }}
                >
                  <PencilIcon className="h-4 w-4" />
                </Button>
                <Button
                  variant="ghost"
                  size="icon"
                  onClick={() => handleDelete(skill)}
                >
                  <Trash2Icon className="h-4 w-4" />
                </Button>
              </div>
            </SettingListItem>
          ))}
        </SettingList>
        <div className="p-2">
          <Button
            variant="outline"
            onClick={() => {
              setEditingSkill(null);
              setEditorOpen(true);
            }}
          >
            <PlusIcon className="mr-2 h-4 w-4" />
            {t("settings.skills.create")}
          </Button>
        </div>
      </SettingGroup>

      <SkillEditor
        open={editorOpen}
        skill={editingSkill}
        onSave={handleEditorSave}
        onClose={() => setEditorOpen(false)}
      />
    </SettingSection>
  );
};

export default SkillsSection;
```

- [x] **Step 3: 在 settingSections.ts 注册 skills 区段**

Modify `src/components/Settings/settingSections.ts`:

在 import 块加：
```typescript
import SkillsSection from "@/components/Settings/SkillsSection";
import { SparklesIcon } from "lucide-react";
```

在 `SettingSectionKey` 联合类型加 `"skills"`：
```typescript
export type SettingSectionKey =
  | "my-account"
  | "preference"
  | "memo"
  | "tags"
  | "storage"
  | "resource-stats"
  | "lan-share"
  | "local-llm"
  | "mcp"
  | "review"
  | "skills";
```

在 `SETTINGS_SECTIONS` 数组末尾（review 之后）加：
```typescript
  {
    key: "skills",
    scope: "basic",
    labelKey: "setting.skills.label",
    icon: SparklesIcon,
    component: SkillsSection,
  },
```

- [x] **Step 4: TypeScript 类型检查**

Run: `npx tsc --noEmit`
Expected: 无错误（i18n 键尚未加，t() 调用可能在运行时返回 key 本身，但类型检查不报错）

- [x] **Step 5: 提交**

```bash
git add src/components/Settings/SkillsSection.tsx src/components/Settings/SkillEditor.tsx src/components/Settings/settingSections.ts
git commit -m "feat(web): add Skills settings section and editor dialog"
```

---

## Task 8: AiChatMessages load_skill 渲染 + hooks no-op

**Files:**
- Modify: `src/components/AiChat/types.ts`
- Modify: `src/components/AiChat/AiChatMessages.tsx`
- Modify: `src/components/AiChat/hooks.ts`

- [x] **Step 1: 在 types.ts 的 ChatMessage 加 toolName 字段**

`ChatMessage`（[types.ts:52-68](file:///d:/3-ai-project/LocalFragNote/src/components/AiChat/types.ts#L52-L68)）目前没有工具名字段——tool 消息只有 `toolCallId` 和 `toolResult`。要区分 `load_skill` 渲染，需加 `toolName` 字段。

Modify `src/components/AiChat/types.ts` — 在 `ChatMessage` interface 的 `toolResult?: unknown;` 之后加：

```typescript
  /** tool 消息的工具名（如 "load_skill"），用于差异化渲染 */
  toolName?: string;
```

- [x] **Step 2: 在 hooks.ts 创建 tool 消息时填充 toolName**

`hooks.ts` 的 `ai:tool` 事件监听器（约第 75 行）创建 tool ChatMessage。ToolPayload 有 `name` 字段（[types.ts:91-96](file:///d:/3-ai-project/LocalFragNote/src/components/AiChat/types.ts#L91-L96)）。

查找 `hooks.ts` 中创建 tool 消息的位置（搜索 `role: "tool"` 或 `isToolCall: true`），在创建 ChatMessage 对象时加 `toolName: payload.name`。

具体：找到形如 `{ id: ..., role: "tool", content: ..., toolCallId: ..., toolResult: ... }` 的对象字面量，加 `toolName: payload.name,`。

- [x] **Step 3: 在 hooks.ts 的 invalidateQueriesForTool 加 load_skill no-op**

Modify `src/components/AiChat/hooks.ts` — 在 `invalidateQueriesForTool` 的 switch，`case "link_memos"` 之后加：

```typescript
    case "load_skill":
      // skill 加载不修改 memo 数据，无需失效缓存
      break;
    default:
      break;
```

- [x] **Step 4: 在 AiChatMessages.tsx 添加 load_skill 的 Markdown 渲染**

`AiChatMessages.tsx` 第 60-66 行渲染 tool 消息（当前仅显示 `msg.content` 字符串）。改为检测 `msg.toolName === "load_skill"` 并渲染 Markdown。

Modify `src/components/AiChat/AiChatMessages.tsx` — 将第 60-66 行的 tool 消息渲染块替换为：

```tsx
        if (msg.role === "tool") {
          if (msg.toolName === "load_skill") {
            const result = msg.toolResult as { id?: string; name?: string; body?: string; error?: string } | null;
            return (
              <div key={msg.id} className="my-1 rounded border border-blue-200 bg-blue-50 dark:border-blue-900 dark:bg-blue-950/30 p-2 text-xs">
                <details>
                  <summary className="cursor-pointer font-medium text-blue-700 dark:text-blue-300">
                    📖 {t("aiChat.skill.loaded", { name: result?.name ?? "skill" })}
                  </summary>
                  <div className="mt-2 prose prose-sm dark:prose-invert max-w-none">
                    {result?.error ? (
                      <p className="text-red-600">{result.error}</p>
                    ) : (
                      <ReactMarkdown>{result?.body ?? ""}</ReactMarkdown>
                    )}
                  </div>
                </details>
              </div>
            );
          }
          return (
            <div key={msg.id} className="text-xs text-muted-foreground px-2 py-1 rounded bg-muted/50">
              {typeof msg.content === "string" ? msg.content : JSON.stringify(msg.content)}
            </div>
          );
        }
```

同时在文件顶部 import 区加：
```tsx
import ReactMarkdown from "react-markdown";
import { useTranslate } from "@/utils/i18n";
```

并在组件函数体内获取 `const t = useTranslate();`（若已有则跳过）。

- [x] **Step 5: TypeScript 类型检查**

Run: `npx tsc --noEmit`
Expected: 无错误

- [x] **Step 6: 提交**

```bash
git add src/components/AiChat/types.ts src/components/AiChat/AiChatMessages.tsx src/components/AiChat/hooks.ts
git commit -m "feat(web): render load_skill tool messages as Markdown, add no-op cache invalidation"
```

---

## Task 9: i18n 键

**Files:**
- Modify: `src/locales/zh-Hans.json`
- Modify: `src/locales/en.json`

- [x] **Step 1: 在 zh-Hans.json 添加 skills 相关键**

在 `setting` 对象内（与其他 section label 同级）加 `"skills"` 子对象。同时在 `aiChat` 对象加 `skill` 子对象。

具体键结构（参考现有 JSON 层级）：

```json
{
  "setting": {
    "skills": {
      "label": "Skills"
    }
  },
  "settings": {
    "skills": {
      "title": "Skills 管理",
      "description": "管理 AI agent 的工具使用指南",
      "builtin": "内置 Skills",
      "custom": "自定义 Skills",
      "create": "新建 Skill",
      "confirm-delete": "确定删除 Skill \"{{name}}\" 吗？",
      "toggle-failed": "切换状态失败",
      "delete-failed": "删除失败",
      "editor": {
        "create": "新建 Skill",
        "edit": "编辑 Skill",
        "id": "ID",
        "id-hint": "将自动加 u- 前缀，保存后不可修改",
        "name": "名称",
        "description": "描述（注入 LLM 元数据）",
        "tools": "关联工具",
        "body": "正文（Markdown）",
        "validation-required": "请填写所有必填字段",
        "save-failed": "保存失败"
      }
    }
  },
  "aiChat": {
    "skill": {
      "loaded": "加载 Skill: {{name}}"
    }
  }
}
```

注意：`setting.skills.label`（用于侧栏标签）与 `settings.skills.*`（用于面板内容）是两个不同层级，参考现有 `setting.mcp.label` 与 `settings.mcp.*` 的模式。

- [x] **Step 2: 在 en.json 添加对应英文键**

```json
{
  "setting": {
    "skills": {
      "label": "Skills"
    }
  },
  "settings": {
    "skills": {
      "title": "Skills Management",
      "description": "Manage AI agent tool usage guides",
      "builtin": "Built-in Skills",
      "custom": "Custom Skills",
      "create": "New Skill",
      "confirm-delete": "Delete skill \"{{name}}\"?",
      "toggle-failed": "Failed to toggle",
      "delete-failed": "Delete failed",
      "editor": {
        "create": "New Skill",
        "edit": "Edit Skill",
        "id": "ID",
        "id-hint": "Will be prefixed with u-, cannot be changed after save",
        "name": "Name",
        "description": "Description (injected into LLM metadata)",
        "tools": "Associated tools",
        "body": "Body (Markdown)",
        "validation-required": "Please fill in all required fields",
        "save-failed": "Save failed"
      }
    }
  },
  "aiChat": {
    "skill": {
      "loaded": "Loaded Skill: {{name}}"
    }
  }
}
```

- [x] **Step 3: 提交**

```bash
git add src/locales/zh-Hans.json src/locales/en.json
git commit -m "i18n: add skills section and skill editor translations"
```

---

## Task 10: 端到端验证 ⚠️（代码完整，端到端验证需手动执行）

- [x] **Step 1: 编译 Rust 后端**

Run: `cargo check -p app`
Expected: 编译通过，无 error

- [x] **Step 2: 运行 Rust 测试**

Run: `cargo test -p app --lib ai:: && cargo test -p memos-core --lib skill::`
Expected: 所有测试 PASS

- [x] **Step 3: TypeScript 类型检查**

Run: `npx tsc --noEmit`
Expected: 无错误

- [x] **Step 4: 启动开发模式手动验证**

Run: `npm run tauri dev`

手动测试流程：
1. 打开设置 → 看到 Skills 区段
2. 看到 3 个内置 skill（review-card-best-practices, semantic-search-tips, office-cli-guide）
3. 禁用一个内置 skill，刷新后状态保持
4. 新建一个自定义 skill（id=test, name=测试, tools=[create_memo], body=测试指南）
5. 打开 AI 聊天，发送"帮我创建一条笔记"
6. 观察 LLM 是否调用 load_skill 加载相关 skill（若自定义 skill 关联了 create_memo 且 enabled，LLM 可能加载它）
7. 观察 load_skill 工具消息是否渲染为可折叠 Markdown 卡片

- [x] **Step 5: 最终提交（如有修复）**

```bash
git add -A
git commit -m "test: verify skills feature end-to-end"
```
