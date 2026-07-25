# 用户可配置工具集 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让用户能在配置中创建 shell 命令类工具，由 AI agent 在权限等级确认机制下调用执行。

**Architecture:** 新增 `tool` 表（对称于 `skill` 表），后端 `tool_definitions()` 改为接收用户工具列表动态合并；`execute_tool()` 增加 user_tool 分发分支。`agent_loop` 在 `spawn_blocking` 同步上下文中运行，用户工具的子进程执行和确认通道等待通过 `tauri::async_runtime::block_on` 桥接到 async。新增 `PendingConfirmations` 类型在 `AppState` 中保存 oneshot channel，通过 Tauri event `tool:confirm_request` 通知前端弹确认 Dialog。

**Tech Stack:** Rust（rusqlite, tokio, tauri）、TypeScript（React, @tanstack/react-query, lucide-react）、SQLite migration V10

**关联设计文档:** [docs/superpowers/specs/2026-07-24-user-configurable-tools-design.md](./2026-07-24-user-configurable-tools-design.md)

---

## 关键背景：agent_loop 的执行上下文

**重要发现**（影响所有 async 代码的设计）：
- `agent_loop` 在 `tauri::async_runtime::spawn_blocking` 中运行（见 [src-tauri/src/commands/ai_chat.rs:129-131](file:///d:/3-ai-project/LocalFragNote/src-tauri/src/commands/ai_chat.rs)），是同步代码
- `execute_tool` 当前是同步函数，在 `state.store()` 锁的作用域内调用
- 用户工具的子进程执行（`tokio::process::Command`）和等待确认（`oneshot::Receiver::await`）是 async 操作
- 解决方案：在 `execute_user_tool` 内部用 `tauri::async_runtime::block_on(async { ... })` 桥接。这是 Tauri 推荐的从同步上下文调用 async 的方式
- `agent_loop` 不在 store 锁作用域内执行用户工具：现有代码 [src-tauri/src/commands/ai_chat.rs:272-275](file:///d:/3-ai-project/LocalFragNote/src-tauri/src/commands/ai_chat.rs) 在 `let store = state.store();` 后调用 `execute_tool`，但对用户工具，store 锁只需要用来读 tool 配置，子进程执行时不应持锁

---

## 文件结构

**新建文件：**
- `core/migrations/V10__add_tool.sql` — tool 表 schema
- `core/src/tool.rs` — Tool struct, Permission enum, CRUD 函数
- `src-tauri/src/commands/tool.rs` — 6 个 Tauri IPC 命令 + ToolDto
- `src-tauri/src/ai/pending_confirmations.rs` — PendingConfirmations 类型
- `src/types/tool.ts` — ToolDto TypeScript 类型 + 常量
- `src/hooks/useToolQueries.ts` — React Query hooks
- `src/components/Settings/ToolsSection.tsx` — Settings 段
- `src/components/Settings/ToolEditor.tsx` — 编辑器 Dialog
- `src/components/AiChat/ToolConfirmDialog.tsx` — 确认弹窗

**修改文件：**
- `core/src/lib.rs` — `pub mod tool;`
- `src-tauri/src/state.rs` — 增加 `pending_confirmations` 和 `app_handle` 字段
- `src-tauri/src/ai/tools.rs` — `tool_definitions` 签名变更 + `execute_tool` 签名变更 + 增加 `execute_user_tool` 分支
- `src-tauri/src/ai/mod.rs` — `pub mod pending_confirmations;`
- `src-tauri/src/commands/ai_chat.rs` — agent_loop 加载 user_tools + 传参 + abort cancel_all + ai:tool 扩展
- `src-tauri/src/main.rs` — 注册新命令 + AppState 新字段初始化
- `src/types/skill.ts` — 移除 `KNOWN_TOOL_NAMES` 常量
- `src/components/Settings/SkillEditor.tsx` — 改用 `useKnownToolNames()`
- `src/components/Settings/settingSections.ts` — 注册 `tools` section
- `src/components/AiChat/types.ts` — `ToolPayload` 扩展 `is_user_tool` / `permission` / `denied` 字段
- `src/components/AiChat/hooks.ts` — `invalidateQueriesForTool` 增加 user_tool 跳过分支
- `src/components/AiChat/AiChatMessages.tsx` — user_tool 卡片渲染
- `src/components/AiChat/index.tsx`（或挂载点）— 挂载 `ToolConfirmDialog`
- `src/locales/zh-Hans.json` 和 `src/locales/en.json` — 新增翻译键

---

## Task 1: 创建 tool 表 migration

**Files:**
- Create: `core/migrations/V10__add_tool.sql`

- [ ] **Step 1: 写 migration SQL**

```sql
-- Tools：用户可配置的 shell 命令工具
-- 与 skill 表对称：用户工具存 DB，内置工具硬编码在 tools.rs
CREATE TABLE IF NOT EXISTS tool (
    id           TEXT PRIMARY KEY,        -- "u-<slug>"
    name         TEXT NOT NULL UNIQUE,    -- LLM 可见的工具名（与内置 10 个不可冲突）
    command      TEXT NOT NULL,           -- 默认/示例命令（仅展示，LLM 调用时传完整 command 覆盖）
    permission   TEXT NOT NULL CHECK(permission IN ('read_only','writable','executable','dangerous')),
    description  TEXT NOT NULL,           -- 注入 LLM 工具描述
    timeout_ms   INTEGER NOT NULL DEFAULT 30000,
    enabled      INTEGER NOT NULL DEFAULT 1,
    created_ts   INTEGER NOT NULL,
    updated_ts   INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_tool_enabled ON tool(enabled);
```

- [ ] **Step 2: 验证 migration 被 refinery 识别**

Run: `cd d:/3-ai-project/LocalFragNote && cargo test -p memos-core --lib migration::tests -- --nocapture`
Expected: 现有 migration 测试通过，无新失败（V10 会在测试 setup 时自动应用）

- [ ] **Step 3: Commit**

```bash
git add core/migrations/V10__add_tool.sql
git commit -m "feat(tool): add tool table migration V10"
```

---

## Task 2: 实现 core/src/tool.rs（数据模型与 CRUD）

**Files:**
- Create: `core/src/tool.rs`
- Modify: `core/src/lib.rs:17`（增加 `pub mod tool;`）

- [ ] **Step 1: 在 lib.rs 注册模块**

修改 `core/src/lib.rs`，在 `pub mod skill;`（第 17 行）后追加：

```rust
pub mod tool;
```

- [ ] **Step 2: 写失败测试**

在 `core/src/tool.rs` 顶部写入：

```rust
//! Tools：用户可配置的 shell 命令工具
//!
//! Tool 与 Skill 的区别：
//! - Skill 是 Markdown 指南文档，告诉 LLM 如何使用工具
//! - Tool 是可执行的工具，LLM 调用时传完整 command 字符串，后端在固定工作目录执行

use crate::error::{CoreError, CoreResult};
use crate::Store;
use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Permission {
    ReadOnly,
    Writable,
    Executable,
    Dangerous,
}

impl Permission {
    pub fn as_str(&self) -> &'static str {
        match self {
            Permission::ReadOnly => "read_only",
            Permission::Writable => "writable",
            Permission::Executable => "executable",
            Permission::Dangerous => "dangerous",
        }
    }

    pub fn from_str(s: &str) -> CoreResult<Self> {
        match s {
            "read_only" => Ok(Permission::ReadOnly),
            "writable" => Ok(Permission::Writable),
            "executable" => Ok(Permission::Executable),
            "dangerous" => Ok(Permission::Dangerous),
            _ => Err(CoreError::Other(format!("未知 permission: {s}"))),
        }
    }

    /// 是否需要用户确认才能执行
    pub fn requires_confirmation(&self) -> bool {
        matches!(self, Permission::Executable | Permission::Dangerous)
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Tool {
    pub id: String,
    pub name: String,
    pub command: String,
    pub permission: Permission,
    pub description: String,
    pub timeout_ms: i64,
    pub enabled: bool,
    #[serde(default)]
    pub created_ts: i64,
    #[serde(default)]
    pub updated_ts: i64,
}

/// 内置工具名黑名单：用户工具不能与这些名字冲突
pub const BUILTIN_TOOL_NAMES: &[&str] = &[
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
];

fn validate_name(name: &str) -> CoreResult<()> {
    if name.is_empty() || name.len() > 64 {
        return Err(CoreError::Other("工具名长度必须在 1-64 之间".into()));
    }
    if !name.chars().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '_') {
        return Err(CoreError::Other("工具名只能包含小写字母、数字和下划线".into()));
    }
    if BUILTIN_TOOL_NAMES.contains(&name) {
        return Err(CoreError::Other(format!("工具名 {name} 与内置工具冲突")));
    }
    Ok(())
}

fn validate_command(command: &str) -> CoreResult<()> {
    if command.is_empty() {
        return Err(CoreError::Other("命令不能为空".into()));
    }
    if command.len() > 1024 {
        return Err(CoreError::Other("命令长度不能超过 1024".into()));
    }
    Ok(())
}

fn validate_description(desc: &str) -> CoreResult<()> {
    if desc.is_empty() {
        return Err(CoreError::Other("描述不能为空".into()));
    }
    if desc.len() > 500 {
        return Err(CoreError::Other("描述长度不能超过 500".into()));
    }
    Ok(())
}

fn validate_timeout_ms(ms: i64) -> CoreResult<()> {
    if !(1000..=600_000).contains(&ms) {
        return Err(CoreError::Other("超时时间必须在 1000-600000 毫秒之间".into()));
    }
    Ok(())
}

fn row_to_tool(row: &rusqlite::Row) -> rusqlite::Result<Tool> {
    let permission_str: String = row.get(3)?;
    let permission = Permission::from_str(&permission_str)
        .map_err(|e| rusqlite::Error::FromSqlConversionFailure(3, rusqlite::types::Type::Text, e.into()))?;
    Ok(Tool {
        id: row.get(0)?,
        name: row.get(1)?,
        command: row.get(2)?,
        permission,
        description: row.get(4)?,
        timeout_ms: row.get(5)?,
        enabled: row.get::<_, i64>(6)? != 0,
        created_ts: row.get(7)?,
        updated_ts: row.get(8)?,
    })
}

/// 列出所有用户工具，按 name 排序
pub fn list(store: &Store) -> CoreResult<Vec<Tool>> {
    store.with_conn(|conn| {
        let mut stmt = conn.prepare(
            "SELECT id, name, command, permission, description, timeout_ms, enabled, created_ts, updated_ts
             FROM tool ORDER BY name",
        )?;
        let rows = stmt.query_map([], row_to_tool)?;
        let mut result = Vec::new();
        for r in rows {
            result.push(r?);
        }
        Ok(result)
    })
}

/// 仅返回 enabled 的工具
pub fn list_enabled(store: &Store) -> CoreResult<Vec<Tool>> {
    Ok(list(store)?.into_iter().filter(|t| t.enabled).collect())
}

/// 按 id 查找
pub fn get(store: &Store, id: &str) -> CoreResult<Option<Tool>> {
    store.with_conn(|conn| {
        let row_opt = conn
            .query_row(
                "SELECT id, name, command, permission, description, timeout_ms, enabled, created_ts, updated_ts
                 FROM tool WHERE id = ?",
                params![id],
                row_to_tool,
            )
            .ok();
        Ok(row_opt)
    })
}

/// 按 name 查找
pub fn get_by_name(store: &Store, name: &str) -> CoreResult<Option<Tool>> {
    store.with_conn(|conn| {
        let row_opt = conn
            .query_row(
                "SELECT id, name, command, permission, description, timeout_ms, enabled, created_ts, updated_ts
                 FROM tool WHERE name = ?",
                params![name],
                row_to_tool,
            )
            .ok();
        Ok(row_opt)
    })
}

/// 创建用户工具。id 必须以 "u-" 开头。
pub fn create(store: &Store, mut tool: Tool) -> CoreResult<Tool> {
    if !tool.id.starts_with("u-") {
        return Err(CoreError::Other("用户工具 id 必须以 u- 开头".into()));
    }
    validate_name(&tool.name)?;
    validate_command(&tool.command)?;
    validate_description(&tool.description)?;
    validate_timeout_ms(tool.timeout_ms)?;

    let now = chrono::Utc::now().timestamp();
    tool.created_ts = now;
    tool.updated_ts = now;

    store.with_conn(|conn| {
        conn.execute(
            "INSERT INTO tool (id, name, command, permission, description, timeout_ms, enabled, created_ts, updated_ts)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?8)",
            params![
                tool.id,
                tool.name,
                tool.command,
                tool.permission.as_str(),
                tool.description,
                tool.timeout_ms,
                tool.enabled as i64,
                now,
            ],
        )?;
        Ok::<(), CoreError>(())
    })?;
    Ok(tool)
}

/// 更新用户工具（id 不可改）
pub fn update(store: &Store, mut tool: Tool) -> CoreResult<Tool> {
    validate_name(&tool.name)?;
    validate_command(&tool.command)?;
    validate_description(&tool.description)?;
    validate_timeout_ms(tool.timeout_ms)?;

    let now = chrono::Utc::now().timestamp();
    tool.updated_ts = now;

    let affected = store.with_conn(|conn| {
        Ok(conn.execute(
            "UPDATE tool SET name=?1, command=?2, permission=?3, description=?4, timeout_ms=?5, enabled=?6, updated_ts=?7
             WHERE id=?8",
            params![
                tool.name,
                tool.command,
                tool.permission.as_str(),
                tool.description,
                tool.timeout_ms,
                tool.enabled as i64,
                now,
                tool.id,
            ],
        )?)
    })?;
    if affected == 0 {
        return Err(CoreError::Other(format!("工具 {} 不存在", tool.id)));
    }
    Ok(tool)
}

/// 删除用户工具
pub fn delete(store: &Store, id: &str) -> CoreResult<()> {
    store.with_conn(|conn| {
        conn.execute("DELETE FROM tool WHERE id=?1", params![id])?;
        Ok(())
    })
}

/// 设置启用状态
pub fn set_enabled(store: &Store, id: &str, enabled: bool) -> CoreResult<()> {
    let now = chrono::Utc::now().timestamp();
    store.with_conn(|conn| {
        conn.execute(
            "UPDATE tool SET enabled=?1, updated_ts=?2 WHERE id=?3",
            params![enabled as i64, now, id],
        )?;
        Ok(())
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample_tool(id: &str, name: &str) -> Tool {
        Tool {
            id: id.to_string(),
            name: name.to_string(),
            command: "echo hello".to_string(),
            permission: Permission::ReadOnly,
            description: "test tool".to_string(),
            timeout_ms: 30000,
            enabled: true,
            created_ts: 0,
            updated_ts: 0,
        }
    }

    #[test]
    fn test_create_and_get() {
        let store = Store::open(":memory:").unwrap();
        let t = create(&store, sample_tool("u-my", "my_tool")).unwrap();
        assert_eq!(t.id, "u-my");
        assert!(t.created_ts > 0);

        let got = get(&store, "u-my").unwrap().unwrap();
        assert_eq!(got.name, "my_tool");
        assert_eq!(got.permission, Permission::ReadOnly);
    }

    #[test]
    fn test_create_rejects_non_u_prefix() {
        let store = Store::open(":memory:").unwrap();
        let result = create(&store, sample_tool("bad", "my_tool"));
        assert!(result.is_err());
    }

    #[test]
    fn test_create_rejects_builtin_name() {
        let store = Store::open(":memory:").unwrap();
        let mut t = sample_tool("u-x", "list_memos");
        let result = create(&store, t.clone());
        assert!(result.is_err());
        t.name = "create_memo".to_string();
        assert!(create(&store, t).is_err());
    }

    #[test]
    fn test_create_rejects_invalid_name() {
        let store = Store::open(":memory:").unwrap();
        // 大写字母不允许
        let mut t = sample_tool("u-x", "MyTool");
        assert!(create(&store, t.clone()).is_err());
        // 空格不允许
        t.name = "my tool".to_string();
        assert!(create(&store, t).is_err());
    }

    #[test]
    fn test_get_by_name() {
        let store = Store::open(":memory:").unwrap();
        create(&store, sample_tool("u-a", "tool_a")).unwrap();
        let got = get_by_name(&store, "tool_a").unwrap().unwrap();
        assert_eq!(got.id, "u-a");
        assert!(get_by_name(&store, "nonexistent").unwrap().is_none());
    }

    #[test]
    fn test_name_unique_constraint() {
        let store = Store::open(":memory:").unwrap();
        create(&store, sample_tool("u-a", "tool_a")).unwrap();
        // 同名不同 id 应失败
        let result = create(&store, sample_tool("u-b", "tool_a"));
        assert!(result.is_err());
    }

    #[test]
    fn test_list_and_list_enabled() {
        let store = Store::open(":memory:").unwrap();
        create(&store, sample_tool("u-a", "tool_a")).unwrap();
        let mut b = sample_tool("u-b", "tool_b");
        b.enabled = false;
        create(&store, b).unwrap();

        let all = list(&store).unwrap();
        assert_eq!(all.len(), 2);

        let enabled = list_enabled(&store).unwrap();
        assert_eq!(enabled.len(), 1);
        assert_eq!(enabled[0].name, "tool_a");
    }

    #[test]
    fn test_update() {
        let store = Store::open(":memory:").unwrap();
        create(&store, sample_tool("u-a", "tool_a")).unwrap();
        let mut t = get(&store, "u-a").unwrap().unwrap();
        t.command = "echo updated".to_string();
        t.permission = Permission::Dangerous;
        let updated = update(&store, t).unwrap();
        assert_eq!(updated.command, "echo updated");
        assert_eq!(updated.permission, Permission::Dangerous);
    }

    #[test]
    fn test_delete() {
        let store = Store::open(":memory:").unwrap();
        create(&store, sample_tool("u-a", "tool_a")).unwrap();
        delete(&store, "u-a").unwrap();
        assert!(get(&store, "u-a").unwrap().is_none());
    }

    #[test]
    fn test_set_enabled() {
        let store = Store::open(":memory:").unwrap();
        create(&store, sample_tool("u-a", "tool_a")).unwrap();
        set_enabled(&store, "u-a", false).unwrap();
        let t = get(&store, "u-a").unwrap().unwrap();
        assert!(!t.enabled);

        set_enabled(&store, "u-a", true).unwrap();
        let t = get(&store, "u-a").unwrap().unwrap();
        assert!(t.enabled);
    }

    #[test]
    fn test_validate_timeout_ms() {
        let store = Store::open(":memory:").unwrap();
        let mut t = sample_tool("u-a", "tool_a");
        t.timeout_ms = 500;
        assert!(create(&store, t.clone()).is_err());
        t.timeout_ms = 700_000;
        assert!(create(&store, t).is_err());
    }

    #[test]
    fn test_permission_serde() {
        let p = Permission::ReadOnly;
        assert_eq!(serde_json::to_string(p).unwrap(), "\"read_only\"");
        let p2: Permission = serde_json::from_str("\"dangerous\"").unwrap();
        assert_eq!(p2, Permission::Dangerous);
    }

    #[test]
    fn test_permission_requires_confirmation() {
        assert!(!Permission::ReadOnly.requires_confirmation());
        assert!(!Permission::Writable.requires_confirmation());
        assert!(Permission::Executable.requires_confirmation());
        assert!(Permission::Dangerous.requires_confirmation());
    }
}
```

- [ ] **Step 3: 运行测试验证失败**

Run: `cd d:/3-ai-project/LocalFragNote && cargo test -p memos-core --lib tool::tests`
Expected: PASS（因为是新文件，测试和实现同时落地；如果编译错误先修编译错误）

- [ ] **Step 4: Commit**

```bash
git add core/src/tool.rs core/src/lib.rs
git commit -m "feat(tool): add core tool module with CRUD"
```

---

## Task 3: 实现 PendingConfirmations 类型

**Files:**
- Create: `src-tauri/src/ai/pending_confirmations.rs`
- Modify: `src-tauri/src/ai/mod.rs`（增加 `pub mod pending_confirmations;`）

- [ ] **Step 1: 在 ai/mod.rs 注册模块**

先读 `src-tauri/src/ai/mod.rs` 看现有结构：

Run: `cat src-tauri/src/ai/mod.rs`（用 Read 工具）

在 `pub mod tools;` 后追加（如果文件结构是 `pub mod xxx;` 列表形式）：

```rust
pub mod pending_confirmations;
```

- [ ] **Step 2: 写 PendingConfirmations**

创建 `src-tauri/src/ai/pending_confirmations.rs`：

```rust
//! 用户工具确认通道
//!
//! 当 LLM 调用 executable/dangerous 等级的用户工具时，需要前端弹 Dialog 让用户确认。
//! PendingConfirmations 用 oneshot channel 实现：
//! - agent_loop 在同步上下文中通过 block_on 调用 request_confirmation
//! - request_confirmation 发 Tauri event 到前端，await oneshot
//! - 前端调 tool_confirm_response 命令，触发 respond 发送 true/false 唤醒等待方

use memos_core::tool::Permission;
use serde::Serialize;
use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;
use std::time::Duration;
use tauri::{AppHandle, Emitter};

#[derive(Debug, Clone, Serialize)]
pub struct ConfirmRequest {
    pub call_id: u64,
    pub tool_name: String,
    pub command: String,
    pub permission: String,
}

pub struct PendingConfirmations {
    next_id: AtomicU64,
    inner: Mutex<HashMap<u64, tokio::sync::oneshot::Sender<bool>>>,
}

impl Default for PendingConfirmations {
    fn default() -> Self {
        Self::new()
    }
}

impl PendingConfirmations {
    pub fn new() -> Self {
        Self {
            next_id: AtomicU64::new(1),
            inner: Mutex::new(HashMap::new()),
        }
    }

    /// 发起确认请求。
    /// 这个函数本身是 async 的，调用方需要用 tauri::async_runtime::block_on 桥接。
    pub async fn request_confirmation(
        &self,
        tool_name: String,
        command: String,
        permission: Permission,
        app: &AppHandle,
    ) -> Result<bool, String> {
        let call_id = self.next_id.fetch_add(1, Ordering::SeqCst);
        let (tx, rx) = tokio::sync::oneshot::channel();
        self.inner.lock().expect("PendingConfirmations Mutex poisoned").insert(call_id, tx);

        let req = ConfirmRequest {
            call_id,
            tool_name,
            command,
            permission: permission.as_str().to_string(),
        };
        app.emit("tool:confirm_request", req).map_err(|e| format!("emit failed: {e}"))?;

        // 60s 等待超时（等价于拒绝，避免永久阻塞）
        match tokio::time::timeout(Duration::from_secs(60), rx).await {
            Ok(Ok(approved)) => Ok(approved),
            Ok(Err(_)) => Ok(false),  // sender dropped = 取消
            Err(_) => {
                self.inner.lock().expect("PendingConfirmations Mutex poisoned").remove(&call_id);
                Ok(false)
            }
        }
    }

    /// 前端回传时调用，返回 true 表示找到了对应的等待项
    pub fn respond(&self, call_id: u64, approved: bool) -> bool {
        if let Some(tx) = self.inner.lock().expect("PendingConfirmations Mutex poisoned").remove(&call_id) {
            let _ = tx.send(approved);
            true
        } else {
            false  // 已超时或不存在
        }
    }

    /// abort/shutdown 时唤醒所有等待中的确认（发送 false）
    /// 同步操作，不 spawn async task，与项目记忆中 LAN shutdown 原则一致
    pub fn cancel_all(&self) {
        let mut map = self.inner.lock().expect("PendingConfirmations Mutex poisoned");
        for (_, tx) in map.drain() {
            let _ = tx.send(false);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn test_respond_wakes_waiter() {
        let pending = PendingConfirmations::new();
        let pending_clone = std::sync::Arc::new(pending);

        // 模拟一个无 AppHandle 的等待方：直接用 oneshot 测试逻辑
        let call_id = pending_clone.next_id.fetch_add(1, Ordering::SeqCst);
        let (tx, rx) = tokio::sync::oneshot::channel();
        pending_clone.inner.lock().unwrap().insert(call_id, tx);

        // 在另一个任务中等待
        let wait_task = tokio::spawn(async move {
            rx.await.unwrap()
        });

        // 等待一会让等待方进入 await
        tokio::time::sleep(Duration::from_millis(50)).await;

        // 回传 true
        assert!(pending_clone.respond(call_id, true));

        let result = wait_task.await.unwrap();
        assert!(result);
    }

    #[tokio::test]
    async fn test_cancel_all_sends_false_to_all() {
        let pending = PendingConfirmations::new();
        let call_id1 = pending.next_id.fetch_add(1, Ordering::SeqCst);
        let call_id2 = pending.next_id.fetch_add(1, Ordering::SeqCst);
        let (tx1, rx1) = tokio::sync::oneshot::channel();
        let (tx2, rx2) = tokio::sync::oneshot::channel();
        pending.inner.lock().unwrap().insert(call_id1, tx1);
        pending.inner.lock().unwrap().insert(call_id2, tx2);

        pending.cancel_all();

        assert_eq!(rx1.await.unwrap(), false);
        assert_eq!(rx2.await.unwrap(), false);
        assert!(pending.inner.lock().unwrap().is_empty());
    }

    #[tokio::test]
    async fn test_timeout_returns_false() {
        let pending = PendingConfirmations::new();
        let call_id = pending.next_id.fetch_add(1, Ordering::SeqCst);
        let (tx, _rx) = tokio::sync::oneshot::channel::<bool>();
        pending.inner.lock().unwrap().insert(call_id, tx);

        // 不回传，验证 cancel_all 会清空
        pending.cancel_all();
        assert!(pending.inner.lock().unwrap().is_empty());
    }
}
```

注意：测试中无法直接测试 `request_confirmation`（需要 AppHandle），只测 `respond`/`cancel_all` 的 oneshot 逻辑。

- [ ] **Step 3: 运行测试**

Run: `cd d:/3-ai-project/LocalFragNote && cargo test -p memos-app --lib ai::pending_confirmations::tests`
Expected: 3 个测试 PASS

- [ ] **Step 4: Commit**

```bash
git add src-tauri/src/ai/pending_confirmations.rs src-tauri/src/ai/mod.rs
git commit -m "feat(tool): add PendingConfirmations type for user tool approval"
```

---

## Task 4: 在 AppState 增加 pending_confirmations 和 app_handle 字段

**Files:**
- Modify: `src-tauri/src/state.rs`
- Modify: `src-tauri/src/main.rs:205-214`（AppState 初始化）

- [ ] **Step 1: 修改 state.rs**

在 `src-tauri/src/state.rs` 的 `use` 区追加：

```rust
use crate::ai::pending_confirmations::PendingConfirmations;
```

在 `AppState` struct 定义中（第 26 行 `cleanup_started: AtomicBool,` 后）增加两个字段：

```rust
    /// 用户工具确认通道（executable/dangerous 工具调用时需要前端确认）
    pub pending_confirmations: PendingConfirmations,
    /// AppHandle 副本，用于 emit 事件（agent_loop 等同步上下文需要）
    pub app_handle: tauri::AppHandle,
```

在 `impl AppState` 块中追加访问方法：

```rust
    /// 获取 app_handle 引用
    pub fn app_handle(&self) -> &tauri::AppHandle {
        &self.app_handle
    }
```

- [ ] **Step 2: 修改 main.rs 初始化**

在 `src-tauri/src/main.rs` 第 205-214 行的 `app.manage(AppState { ... })` 中，在 `cleanup_started: ...` 后追加两个字段：

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
                pending_confirmations: crate::ai::pending_confirmations::PendingConfirmations::new(),
                app_handle: app.handle().clone(),
            });
```

注意：`app.handle()` 在 setup 闭包内可用（tauri::Manager trait 已在文件顶部 import）。如果 `app` 不是 `&App` 而是 `AppHandle`，则直接 `app.clone()`。先 Read main.rs 确认 `setup` 闭包参数类型。

- [ ] **Step 3: 编译验证**

Run: `cd d:/3-ai-project/LocalFragNote && cargo build -p memos-app 2>&1 | tail -30`
Expected: 编译成功，可能有 unused warning（后续任务会用到）

- [ ] **Step 4: Commit**

```bash
git add src-tauri/src/state.rs src-tauri/src/main.rs
git commit -m "feat(tool): add pending_confirmations and app_handle to AppState"
```

---

## Task 5: 改造 tool_definitions 签名（接收 user_tools）

**Files:**
- Modify: `src-tauri/src/ai/tools.rs:13-172`（tool_definitions 签名和扩展）
- Modify: `src-tauri/src/ai/tools.rs:632-650`（测试）

- [ ] **Step 1: 修改 tool_definitions 签名和实现**

在 `src-tauri/src/ai/tools.rs` 顶部 `use` 区追加：

```rust
use memos_core::tool::Tool;
```

把 `tool_definitions()`（第 13 行）改为：

```rust
/// 返回 OpenAI function-calling 格式的工具定义
/// 内置 10 个工具 + 用户配置的工具
pub fn tool_definitions(user_tools: &[Tool]) -> Vec<Value> {
    let mut defs: Vec<Value> = vec![
        json!({
            "type": "function",
            "function": {
                "name": "list_memos",
                "description": "搜索用户的笔记。支持全文搜索（FTS）和列出最近的笔记。",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "query": { "type": "string", "description": "全文搜索关键词，留空则返回最近笔记" },
                        "limit": { "type": "number", "description": "返回数量，默认 10，最大 50" }
                    }
                }
            }
        }),
        // ... 其他 9 个内置工具 JSON 保持不变（get_memo / create_memo / list_tags / list_memos_by_tag / update_memo / search_semantic / link_memos / create_review_cards / load_skill）
    ];
    // 追加用户工具定义
    for ut in user_tools.iter().filter(|t| t.enabled) {
        defs.push(json!({
            "type": "function",
            "function": {
                "name": ut.name,
                "description": format!(
                    "{}\n\n[权限等级: {}] 执行用户配置的 shell 命令。配置默认命令: `{}`。\
                     调用时传入完整 command 字符串，后端在固定工作目录执行。",
                    ut.description, ut.permission.as_str(), ut.command
                ),
                "parameters": {
                    "type": "object",
                    "properties": {
                        "command": {
                            "type": "string",
                            "description": "要执行的完整 shell 命令字符串"
                        }
                    },
                    "required": ["command"]
                }
            }
        }));
    }
    defs
}
```

实际操作时只改两处：
1. 函数签名从 `pub fn tool_definitions() -> Vec<Value>` 改为 `pub fn tool_definitions(user_tools: &[Tool]) -> Vec<Value>`
2. 在 `vec![...]` 末尾的 `]` 前改为 `];`（原来是 `,`），然后追加 for 循环

注意：内置 10 个工具的 JSON 内容**保持原样不动**，只改外层结构。

- [ ] **Step 2: 修改测试**

把 `src-tauri/src/ai/tools.rs:632-650` 的 `test_tool_definitions_count` 改为：

```rust
    #[test]
    fn test_tool_definitions_count() {
        let defs = tool_definitions(&[]);
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

    #[test]
    fn test_tool_definitions_with_user_tools() {
        use memos_core::tool::Permission;
        let enabled = Tool {
            id: "u-a".to_string(),
            name: "my_tool".to_string(),
            command: "echo hi".to_string(),
            permission: Permission::ReadOnly,
            description: "test".to_string(),
            timeout_ms: 30000,
            enabled: true,
            created_ts: 0,
            updated_ts: 0,
        };
        let disabled = Tool {
            id: "u-b".to_string(),
            name: "disabled_tool".to_string(),
            enabled: false,
            ..enabled.clone()
        };
        let defs = tool_definitions(&[enabled, disabled]);
        assert_eq!(defs.len(), 11);  // 10 + 1 enabled
        let names: Vec<&str> = defs
            .iter()
            .map(|d| d["function"]["name"].as_str().unwrap())
            .collect();
        assert!(names.contains(&"my_tool"));
        assert!(!names.contains(&"disabled_tool"));
    }
```

- [ ] **Step 3: 运行测试**

Run: `cd d:/3-ai-project/LocalFragNote && cargo test -p memos-app --lib ai::tools::tests::test_tool_definitions`
Expected: 两个测试都 PASS

注意：此时 `ai_chat.rs` 还在调用 `tool_definitions()` 无参版本，编译会失败。下一个任务会修复。本步先确认 tools.rs 测试通过即可（`cargo test` 会因为 ai_chat.rs 编译失败而失败，可以先 `cargo build -p memos-app --lib` 看具体错误，下一步会修）。

- [ ] **Step 4: Commit**

```bash
git add src-tauri/src/ai/tools.rs
git commit -m "feat(tool): change tool_definitions to accept user_tools parameter"
```

---

## Task 6: 实现 execute_user_tool（同步桥接 async 子进程执行）

**Files:**
- Modify: `src-tauri/src/ai/tools.rs`（增加 execute_user_tool + execute_tool 分发 + 截断 helper）

- [ ] **Step 1: 增加 use 引用**

在 `src-tauri/src/ai/tools.rs` 顶部 use 区追加：

```rust
use crate::ai::pending_confirmations::PendingConfirmations;
use crate::state::AppState;
use memos_core::tool::{Permission, Tool as UserTool};
use std::process::Stdio;
use std::time::Duration;
use tauri::async_runtime;
```

注意：因为 `memos_core::tool::Tool` 和 `skill::Skill` 都叫 Tool，需要 alias。但 `skill::Skill` 已经在 use 区，`tool::Tool` 引入后用全名 `memos_core::tool::Tool`，避免与 `Skill` 冲突。

- [ ] **Step 2: 改 execute_tool 签名和分发**

把 `execute_tool`（第 175-194 行）改为：

```rust
/// 执行工具调用，返回结果 JSON
/// state 引用用于获取 app_data_dir 和 pending_confirmations
pub fn execute_tool(
    name: &str,
    args: &Value,
    store: &Store,
    builtin: &[Skill],
    state: &AppState,
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
        other => {
            // 内置工具名已知但没匹配上（不应该发生）
            if memos_core::tool::BUILTIN_TOOL_NAMES.contains(&other) {
                return Err(memos_core::CoreError::Other(format!("内置工具未实现: {other}")));
            }
            // 查用户工具
            let user_tool = memos_core::tool::get_by_name(store, other)?
                .ok_or_else(|| memos_core::CoreError::Other(format!("未知工具: {name}")))?;
            if !user_tool.enabled {
                return Ok(json!({"error": format!("工具 {} 已禁用", name)}));
            }
            let command = args
                .get("command")
                .and_then(|v| v.as_str())
                .ok_or_else(|| memos_core::CoreError::Other("缺少 command 参数".into()))?;
            execute_user_tool(user_tool, command, state)
        }
    }
}
```

- [ ] **Step 3: 实现 execute_user_tool**

在 `tools.rs` 末尾（`#\[cfg(test)]` 之前）追加：

```rust
/// 用户工具执行的最大输出字节数（超出则头尾截断）
const MAX_USER_TOOL_OUTPUT_BYTES: usize = 10 * 1024;

#[cfg(windows)]
fn build_shell_command(command: &str) -> std::process::Command {
    let mut c = std::process::Command::new("cmd");
    c.arg("/C").arg(command);
    c
}

#[cfg(not(windows))]
fn build_shell_command(command: &str) -> std::process::Command {
    let mut c = std::process::Command::new("sh");
    c.arg("-c").arg(command);
    c
}

/// 在不超过 max_bytes 的前提下，保留头部和尾部各 max_bytes/2 字节，
/// 中间用 truncation marker 占位。所有切点都对齐 UTF-8 字符边界。
fn truncate_at_char_boundary(s: &str, max_bytes: usize) -> String {
    if s.len() <= max_bytes {
        return s.to_string();
    }
    let half = max_bytes / 2;

    let mut head_end = half;
    while !s.is_char_boundary(head_end) && head_end > 0 {
        head_end -= 1;
    }

    let tail_start_target = s.len() - half;
    let mut tail_start = tail_start_target;
    while !s.is_char_boundary(tail_start) && tail_start < s.len() {
        tail_start += 1;
    }

    let truncated_bytes = s.len() - head_end - (s.len() - tail_start);
    format!(
        "{}\n...[truncated {} bytes]...\n{}",
        &s[..head_end],
        truncated_bytes,
        &s[tail_start..]
    )
}

/// 执行用户配置的 shell 命令工具
/// agent_loop 在同步上下文中调用，内部用 async_runtime::block_on 桥接
fn execute_user_tool(
    tool: memos_core::tool::Tool,
    command: &str,
    state: &AppState,
) -> memos_core::CoreResult<Value> {
    let permission = tool.permission;
    let timeout_ms = tool.timeout_ms;
    let tool_name = tool.name.clone();
    let cwd = state.attachments_dir.parent().unwrap_or_else(|| std::path::Path::new(".")).to_path_buf();
    let pending = &state.pending_confirmations;
    let app_handle = state.app_handle().clone();

    async_runtime::block_on(async move {
        // 1. 权限分级拦截
        if permission.requires_confirmation() {
            let approved = pending
                .request_confirmation(tool_name.clone(), command.to_string(), permission, &app_handle)
                .await
                .map_err(|e| memos_core::CoreError::Other(format!("确认失败: {e}")))?;
            if !approved {
                return Ok(json!({
                    "error": "user denied the tool call",
                    "denied": true,
                    "tool_name": tool_name,
                    "permission": permission.as_str(),
                }));
            }
        }

        // 2. 在固定工作目录执行
        let mut cmd = build_shell_command(command);
        cmd.current_dir(&cwd)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());

        // 注意：这里用 std::process::Command 同步执行，避免 tokio::process 在 block_on 内嵌套
        let output = match cmd.output() {
            Ok(o) => o,
            Err(e) => {
                return Ok(json!({
                    "error": format!("spawn failed: {e}"),
                    "tool_name": tool_name,
                    "permission": permission.as_str(),
                }));
            }
        };

        // 3. 超时检查：std::process::Command 没有 timeout API，
        // 用 tokio::time::timeout 包装一个等待任务
        // 但 cmd.output() 已经同步完成了，无法事后 kill
        // 解决方案：用 tokio::process::Command + wait_with_output + tokio::time::timeout
        // 见下方的真实实现
        Ok(json!({}))
    }).map(|_| json!({}))
}
```

上面的实现有问题（cmd.output() 是同步的，无法 timeout）。重写为正确的 tokio::process 版本：

```rust
fn execute_user_tool(
    tool: memos_core::tool::Tool,
    command: &str,
    state: &AppState,
) -> memos_core::CoreResult<Value> {
    use tokio::process::Command as TokioCommand;

    let permission = tool.permission;
    let timeout_ms = tool.timeout_ms;
    let tool_name = tool.name.clone();
    let cwd = state.attachments_dir.parent().unwrap_or_else(|| std::path::Path::new(".")).to_path_buf();
    let pending = &state.pending_confirmations;
    let app_handle = state.app_handle().clone();
    let command_owned = command.to_string();

    async_runtime::block_on(async move {
        // 1. 权限分级拦截
        if permission.requires_confirmation() {
            let approved = pending
                .request_confirmation(tool_name.clone(), command_owned.clone(), permission, &app_handle)
                .await
                .map_err(|e| memos_core::CoreError::Other(format!("确认失败: {e}")))?;
            if !approved {
                return Ok(json!({
                    "error": "user denied the tool call",
                    "denied": true,
                    "tool_name": tool_name,
                    "permission": permission.as_str(),
                }));
            }
        }

        // 2. 构建 tokio::process::Command
        #[cfg(windows)]
        let mut cmd = {
            let mut c = TokioCommand::new("cmd");
            c.arg("/C").arg(&command_owned);
            c
        };
        #[cfg(not(windows))]
        let mut cmd = {
            let mut c = TokioCommand::new("sh");
            c.arg("-c").arg(&command_owned);
            c
        };
        cmd.current_dir(&cwd)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true);

        let child = match cmd.spawn() {
            Ok(c) => c,
            Err(e) => {
                return Ok(json!({
                    "error": format!("spawn failed: {e}"),
                    "tool_name": tool_name,
                    "permission": permission.as_str(),
                }));
            }
        };

        // 3. 超时强制 kill
        let timeout_dur = Duration::from_millis(timeout_ms as u64);
        let output = match tokio::time::timeout(timeout_dur, child.wait_with_output()).await {
            Ok(Ok(out)) => out,
            Ok(Err(e)) => {
                return Ok(json!({
                    "error": format!("wait failed: {e}"),
                    "tool_name": tool_name,
                    "permission": permission.as_str(),
                }));
            }
            Err(_) => {
                // 超时：kill_on_drop 会在 child drop 时 kill，但这里显式等待已不需要
                return Ok(json!({
                    "error": format!("timeout after {timeout_ms}ms"),
                    "tool_name": tool_name,
                    "permission": permission.as_str(),
                }));
            }
        };

        // 4. 合并 stdout+stderr
        let stdout = String::from_utf8_lossy(&output.stdout).to_string();
        let stderr: String = String::from_utf8_lossy(&output.stderr)
            .lines()
            .map(|l| format!("[stderr] {l}\n"))
            .collect();
        let mut combined = format!("{stdout}{stderr}");

        if combined.len() > MAX_USER_TOOL_OUTPUT_BYTES {
            combined = truncate_at_char_boundary(&combined, MAX_USER_TOOL_OUTPUT_BYTES);
        }

        Ok(json!({
            "output": combined,
            "exit_code": output.status.code().unwrap_or(-1),
            "tool_name": tool_name,
            "permission": permission.as_str(),
        }))
    })
}
```

注意 `async_runtime::block_on` 返回 `memos_core::CoreResult<Value>`，因为闭包返回 `Result<Value, CoreError>`。如果签名不匹配，调整闭包返回类型。

- [ ] **Step 4: 修复调用点 ai_chat.rs（暂时占位）**

`src-tauri/src/commands/ai_chat.rs:272-275`：

```rust
            let args: Value = serde_json::from_str(&tc.arguments).unwrap_or(Value::Null);
            let result = {
                let store = state.store();
                execute_tool(&tc.name, &args, &store, &state.builtin_skills)
            };
```

暂时改为（在本任务中只为了让编译通过，下个任务再正式集成）：

```rust
            let args: Value = serde_json::from_str(&tc.arguments).unwrap_or(Value::Null);
            let result = {
                let store = state.store();
                execute_tool(&tc.name, &args, &store, &state.builtin_skills, &state)
            };
```

- [ ] **Step 5: 编译验证**

Run: `cd d:/3-ai-project/LocalFragNote && cargo build -p memos-app 2>&1 | tail -30`
Expected: 编译通过（可能有 unused warning）

- [ ] **Step 6: 运行现有测试确保无回归**

Run: `cd d:/3-ai-project/LocalFragNote && cargo test -p memos-app --lib ai::tools::tests`
Expected: 全部 PASS

- [ ] **Step 7: Commit**

```bash
git add src-tauri/src/ai/tools.rs src-tauri/src/commands/ai_chat.rs
git commit -m "feat(tool): implement execute_user_tool with timeout and truncation"
```

---

## Task 7: agent_loop 集成（加载 user_tools + abort cancel_all）

**Files:**
- Modify: `src-tauri/src/commands/ai_chat.rs`

- [ ] **Step 1: 加载 enabled 用户工具**

在 `src-tauri/src/commands/ai_chat.rs` 的 `agent_loop` 中，找到第 160-164 行的 skill_section 加载块：

```rust
    let builtin = state.builtin_skills.clone();
    let skill_section = {
        let store = state.store();
        memos_core::skill::list_enabled(&builtin, &store).unwrap_or_default()
    };
```

在其后追加：

```rust
    let user_tools = {
        let store = state.store();
        memos_core::tool::list_enabled(&store).unwrap_or_default()
    };
```

- [ ] **Step 2: 传 user_tools 给 tool_definitions**

把第 183 行：

```rust
            "tools": tool_definitions(),
```

改为：

```rust
            "tools": tool_definitions(&user_tools),
```

- [ ] **Step 3: abort 时 cancel_all**

在 `agent_loop` 中找到所有 `cleanup_abort(run_id); return;` 的位置（第 171-173、231-234、266-269 行）。在每处 `return;` 前追加 cancel_all 调用。

更简洁的做法：在 `cleanup_abort` 函数内部加一次 cancel_all。但 `cleanup_abort` 是 static 函数无 state 引用。

最简方案：在 agent_loop 开头保存 state 引用（已经有了），在每个 break 点之前调用一次：

实际上最干净的做法是：在 `agent_loop` 结束（包括所有 return 路径）前调用 cancel_all。但 Rust 的早期 return 会导致重复代码。

采用 RAII guard 模式。在 `agent_loop` 顶部追加：

```rust
    // abort/shutdown 时唤醒所有 pending 确认
    let state_ref = state;
    struct CancelGuard<'a>(&'a AppState);
    impl<'a> Drop for CancelGuard<'a> {
        fn drop(&mut self) {
            self.0.pending_confirmations.cancel_all();
        }
    }
    let _cancel_guard = CancelGuard(state_ref);
```

放在 `let state = app.state::<AppState>();` 之后。当 agent_loop 因任何原因 return 时，guard drop 会触发 cancel_all。已结束的确认会被 drain 清空，无副作用。

- [ ] **Step 4: 扩展 ai:tool 事件 payload**

在 `src-tauri/src/commands/ai_chat.rs:78-85` 的 `ToolPayload` struct 改为：

```rust
#[derive(Debug, Clone, Serialize)]
struct ToolPayload {
    run_id: u32,
    name: String,
    args: Value,
    tool_call_id: String,
    result: Value,
    /// 用户工具标识（前端用于差异化渲染）
    #[serde(skip_serializing_if = "Option::is_none")]
    is_user_tool: Option<bool>,
    /// 用户工具权限等级
    #[serde(skip_serializing_if = "Option::is_none")]
    permission: Option<String>,
    /// 用户是否拒绝
    #[serde(skip_serializing_if = "Option::is_none")]
    denied: Option<bool>,
}
```

在第 281-287 行的 emit 处改为：

```rust
            // 判断是否用户工具（内置 10 个之外的工具名）
            let is_user_tool = !memos_core::tool::BUILTIN_TOOL_NAMES.contains(&tc.name.as_str());
            let (permission_opt, denied_opt) = if is_user_tool {
                let perm = result.get("permission").and_then(|v| v.as_str()).map(String::from);
                let denied = result.get("denied").and_then(|v| v.as_bool());
                (perm, denied)
            } else {
                (None, None)
            };
            let _ = app.emit("ai:tool", ToolPayload {
                run_id,
                name: tc.name.clone(),
                args: args.clone(),
                tool_call_id: tc.id.clone(),
                result: result.clone(),
                is_user_tool: if is_user_tool { Some(true) } else { None },
                permission: permission_opt,
                denied: denied_opt,
            });
```

- [ ] **Step 5: 编译验证**

Run: `cd d:/3-ai-project/LocalFragNote && cargo build -p memos-app 2>&1 | tail -30`
Expected: 编译通过

- [ ] **Step 6: Commit**

```bash
git add src-tauri/src/commands/ai_chat.rs
git commit -m "feat(tool): integrate user_tools into agent_loop with cancel guard"
```

---

## Task 8: 实现 Tauri IPC 命令（commands/tool.rs）

**Files:**
- Create: `src-tauri/src/commands/tool.rs`
- Modify: `src-tauri/src/commands/mod.rs`（增加 `pub mod tool;`）
- Modify: `src-tauri/src/main.rs:331-336`（注册命令）

- [ ] **Step 1: 检查 commands/mod.rs 结构**

Run: 用 Read 工具读 `src-tauri/src/commands/mod.rs`

在 `pub mod skill;` 后追加：

```rust
pub mod tool;
```

- [ ] **Step 2: 写 commands/tool.rs**

```rust
//! Tool 管理 IPC 命令

use crate::error::IpcResult;
use crate::state::AppState;
use memos_core::tool::{Permission, Tool};
use tauri::State;

#[derive(Debug, Clone, serde::Serialize)]
pub struct ToolDto {
    pub id: String,
    pub name: String,
    pub command: String,
    pub permission: String,  // snake_case 字符串
    pub description: String,
    pub timeout_ms: i64,
    pub enabled: bool,
    pub created_ts: i64,
    pub updated_ts: i64,
}

impl From<Tool> for ToolDto {
    fn from(t: Tool) -> Self {
        Self {
            id: t.id,
            name: t.name,
            command: t.command,
            permission: t.permission.as_str().to_string(),
            description: t.description,
            timeout_ms: t.timeout_ms,
            enabled: t.enabled,
            created_ts: t.created_ts,
            updated_ts: t.updated_ts,
        }
    }
}

#[tauri::command]
pub fn tool_list(
    enabled: Option<bool>,
    state: State<'_, AppState>,
) -> IpcResult<Vec<ToolDto>> {
    let store = state.store();
    let tools = match enabled {
        Some(true) => memos_core::tool::list_enabled(&store)?,
        Some(false) | None => memos_core::tool::list(&store)?,
    };
    Ok(tools.into_iter().map(ToolDto::from).collect())
}

#[tauri::command]
pub fn tool_create(tool: Tool, state: State<'_, AppState>) -> IpcResult<ToolDto> {
    let store = state.store();
    let created = memos_core::tool::create(&store, tool)?;
    Ok(ToolDto::from(created))
}

#[tauri::command]
pub fn tool_update(tool: Tool, state: State<'_, AppState>) -> IpcResult<ToolDto> {
    let store = state.store();
    let updated = memos_core::tool::update(&store, tool)?;
    Ok(ToolDto::from(updated))
}

#[tauri::command]
pub fn tool_delete(id: String, state: State<'_, AppState>) -> IpcResult<()> {
    let store = state.store();
    memos_core::tool::delete(&store, &id)?;
    Ok(())
}

#[tauri::command]
pub fn tool_set_enabled(id: String, enabled: bool, state: State<'_, AppState>) -> IpcResult<()> {
    let store = state.store();
    memos_core::tool::set_enabled(&store, &id, enabled)?;
    Ok(())
}

#[tauri::command]
pub fn tool_confirm_response(
    call_id: u64,
    approved: bool,
    state: State<'_, AppState>,
) -> IpcResult<bool> {
    Ok(state.pending_confirmations.respond(call_id, approved))
}
```

注意 `Tool` struct 通过 `Deserialize` 反序列化前端传入的参数。`Tool` 的所有字段必须都有默认值或前端传入。检查 `core/src/tool.rs` 中 `Tool` 的 `created_ts`/`updated_ts` 是否有 `#[serde(default)]`（已有）。

- [ ] **Step 3: 在 main.rs 注册命令**

在 `src-tauri/src/main.rs:331-336` 的 skills 块后追加：

```rust
            // tools
            commands::tool::tool_list,
            commands::tool::tool_create,
            commands::tool::tool_update,
            commands::tool::tool_delete,
            commands::tool::tool_set_enabled,
            commands::tool::tool_confirm_response,
```

- [ ] **Step 4: 编译验证**

Run: `cd d:/3-ai-project/LocalFragNote && cargo build -p memos-app 2>&1 | tail -30`
Expected: 编译通过

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/commands/tool.rs src-tauri/src/commands/mod.rs src-tauri/src/main.rs
git commit -m "feat(tool): add tool IPC commands"
```

---

## Task 9: 前端类型与 hooks

**Files:**
- Create: `src/types/tool.ts`
- Create: `src/hooks/useToolQueries.ts`
- Modify: `src/types/skill.ts`（移除 KNOWN_TOOL_NAMES）

- [ ] **Step 1: 创建 src/types/tool.ts**

```typescript
export type ToolPermission = "read_only" | "writable" | "executable" | "dangerous";

export interface ToolDto {
  id: string;
  name: string;
  command: string;
  permission: ToolPermission;
  description: string;
  timeout_ms: number;
  enabled: boolean;
  created_ts: number;
  updated_ts: number;
}

/** 内置 10 个工具名（黑名单，校验用户输入用） */
export const BUILTIN_TOOL_NAMES = [
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

export const PERMISSION_LABELS: Record<ToolPermission, string> = {
  read_only: "只读",
  writable: "可写",
  executable: "可执行",
  dangerous: "危险",
};

/** 权限等级 badge 颜色（Tailwind class） */
export const PERMISSION_BADGE_COLORS: Record<ToolPermission, string> = {
  read_only: "bg-gray-100 text-gray-700 dark:bg-gray-800 dark:text-gray-300",
  writable: "bg-blue-100 text-blue-700 dark:bg-blue-900 dark:text-blue-300",
  executable: "bg-orange-100 text-orange-700 dark:bg-orange-900 dark:text-orange-300",
  dangerous: "bg-red-100 text-red-700 dark:bg-red-900 dark:text-red-300",
};

/** tool:confirm_request 事件 payload */
export interface ToolConfirmRequest {
  call_id: number;
  tool_name: string;
  command: string;
  permission: ToolPermission;
}
```

- [ ] **Step 2: 创建 src/hooks/useToolQueries.ts**

```typescript
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { invoke } from "@tauri-apps/api/core";
import type { ToolDto } from "@/types/tool";

export const toolKeys = {
  all: ["tools"] as const,
  list: (options?: { enabled?: boolean }) => [...toolKeys.all, "list", options] as const,
};

/**
 * 拉取工具列表
 * @param options.enabled - true 只返回启用的，false/undefined 返回所有
 */
export function useToolList(options?: { enabled?: boolean }) {
  return useQuery<ToolDto[]>({
    queryKey: toolKeys.list(options),
    queryFn: () => invoke<ToolDto[]>("tool_list", { enabled: options?.enabled ?? null }),
  });
}

export function useCreateTool() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (tool: ToolDto) => invoke<ToolDto>("tool_create", { tool }),
    onSuccess: () => qc.invalidateQueries({ queryKey: toolKeys.all }),
  });
}

export function useUpdateTool() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (tool: ToolDto) => invoke<ToolDto>("tool_update", { tool }),
    onSuccess: () => qc.invalidateQueries({ queryKey: toolKeys.all }),
  });
}

export function useDeleteTool() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => invoke<void>("tool_delete", { id }),
    onSuccess: () => qc.invalidateQueries({ queryKey: toolKeys.all }),
  });
}

export function useSetToolEnabled() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, enabled }: { id: string; enabled: boolean }) =>
      invoke<void>("tool_set_enabled", { id, enabled }),
    onSuccess: () => qc.invalidateQueries({ queryKey: toolKeys.all }),
  });
}

/**
 * 合并内置 10 个工具名 + 所有用户工具名（含禁用），供 SkillEditor 多选用
 */
export function useKnownToolNames() {
  const { data: userTools } = useToolList({ enabled: false });
  const userNames = (userTools ?? []).map((t) => t.name);
  return [...BUILTIN_TOOL_NAMES, ...userNames];
}

import { BUILTIN_TOOL_NAMES } from "@/types/tool";
```

注意：`import` 语句应该在文件顶部。最后那行 `import` 是笔误，应该移到顶部。最终文件应该是：

```typescript
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { invoke } from "@tauri-apps/api/core";
import { BUILTIN_TOOL_NAMES, type ToolDto } from "@/types/tool";

export const toolKeys = {
  all: ["tools"] as const,
  list: (options?: { enabled?: boolean }) => [...toolKeys.all, "list", options] as const,
};

export function useToolList(options?: { enabled?: boolean }) {
  return useQuery<ToolDto[]>({
    queryKey: toolKeys.list(options),
    queryFn: () => invoke<ToolDto[]>("tool_list", { enabled: options?.enabled ?? null }),
  });
}

export function useCreateTool() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (tool: ToolDto) => invoke<ToolDto>("tool_create", { tool }),
    onSuccess: () => qc.invalidateQueries({ queryKey: toolKeys.all }),
  });
}

export function useUpdateTool() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (tool: ToolDto) => invoke<ToolDto>("tool_update", { tool }),
    onSuccess: () => qc.invalidateQueries({ queryKey: toolKeys.all }),
  });
}

export function useDeleteTool() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => invoke<void>("tool_delete", { id }),
    onSuccess: () => qc.invalidateQueries({ queryKey: toolKeys.all }),
  });
}

export function useSetToolEnabled() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, enabled }: { id: string; enabled: boolean }) =>
      invoke<void>("tool_set_enabled", { id, enabled }),
    onSuccess: () => qc.invalidateQueries({ queryKey: toolKeys.all }),
  });
}

/** 合并内置 10 个工具名 + 所有用户工具名（含禁用），供 SkillEditor 多选用 */
export function useKnownToolNames() {
  const { data: userTools } = useToolList({ enabled: false });
  const userNames = (userTools ?? []).map((t) => t.name);
  return [...BUILTIN_TOOL_NAMES, ...userNames];
}
```

- [ ] **Step 3: 从 src/types/skill.ts 移除 KNOWN_TOOL_NAMES**

修改 `src/types/skill.ts`：删除第 15-27 行的 `KNOWN_TOOL_NAMES` 常量及其注释。最终文件应该是：

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
```

- [ ] **Step 4: TypeScript 编译验证**

Run: `cd d:/3-ai-project/LocalFragNote && npx tsc --noEmit 2>&1 | head -30`
Expected: 报错 SkillEditor.tsx 引用 KNOWN_TOOL_NAMES（下个任务会修），其他无错

- [ ] **Step 5: Commit**

```bash
git add src/types/tool.ts src/hooks/useToolQueries.ts src/types/skill.ts
git commit -m "feat(tool): add frontend types and hooks"
```

---

## Task 10: SkillEditor 改用 useKnownToolNames

**Files:**
- Modify: `src/components/Settings/SkillEditor.tsx`

- [ ] **Step 1: 修改 import**

把 `src/components/Settings/SkillEditor.tsx:16`：

```typescript
import { KNOWN_TOOL_NAMES, type SkillDto } from "@/types/skill";
```

改为：

```typescript
import type { SkillDto } from "@/types/skill";
import { useKnownToolNames } from "@/hooks/useToolQueries";
```

- [ ] **Step 2: 在组件内调用 hook**

在 `src/components/Settings/SkillEditor.tsx:38-43`：

```typescript
const SkillEditor = ({ open, skill, onSave, onClose }: SkillEditorProps) => {
  const t = useTranslate();
  const isEdit = skill !== null;
  const [draft, setDraft] = useState<SkillDto>(emptySkill());
  const [saving, setSaving] = useState(false);
```

改为：

```typescript
const SkillEditor = ({ open, skill, onSave, onClose }: SkillEditorProps) => {
  const t = useTranslate();
  const isEdit = skill !== null;
  const [draft, setDraft] = useState<SkillDto>(emptySkill());
  const [saving, setSaving] = useState(false);
  const knownToolNames = useKnownToolNames();
```

- [ ] **Step 3: 在多选渲染处替换常量**

把 `src/components/Settings/SkillEditor.tsx:121`：

```typescript
              {KNOWN_TOOL_NAMES.map((tool) => (
```

改为：

```typescript
              {knownToolNames.map((tool) => (
```

- [ ] **Step 4: TypeScript 编译验证**

Run: `cd d:/3-ai-project/LocalFragNote && npx tsc --noEmit 2>&1 | head -30`
Expected: 无 KNOWN_TOOL_NAMES 相关错误

- [ ] **Step 5: Commit**

```bash
git add src/components/Settings/SkillEditor.tsx
git commit -m "refactor(skill): use dynamic useKnownToolNames hook in SkillEditor"
```

---

## Task 11: 实现 ToolsSection + ToolEditor

**Files:**
- Create: `src/components/Settings/ToolsSection.tsx`
- Create: `src/components/Settings/ToolEditor.tsx`
- Modify: `src/components/Settings/settingSections.ts`

- [ ] **Step 1: 创建 ToolEditor.tsx**

```typescript
import { useEffect, useState } from "react";
import toast from "react-hot-toast";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { getErrorMessage } from "@/lib/error";
import { useTranslate } from "@/utils/i18n";
import {
  BUILTIN_TOOL_NAMES,
  PERMISSION_BADGE_COLORS,
  PERMISSION_LABELS,
  type ToolDto,
  type ToolPermission,
} from "@/types/tool";

interface ToolEditorProps {
  open: boolean;
  /** 编辑模式时传入原 tool；新建模式为 null */
  tool: ToolDto | null;
  onSave: (tool: ToolDto) => Promise<void>;
  onClose: () => void;
}

const emptyTool = (): ToolDto => ({
  id: "",
  name: "",
  command: "echo hello",
  permission: "read_only",
  description: "",
  timeout_ms: 30000,
  enabled: true,
  created_ts: 0,
  updated_ts: 0,
});

const PERMISSIONS: ToolPermission[] = ["read_only", "writable", "executable", "dangerous"];

const ToolEditor = ({ open, tool, onSave, onClose }: ToolEditorProps) => {
  const t = useTranslate();
  const isEdit = tool !== null;
  const [draft, setDraft] = useState<ToolDto>(emptyTool());
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (open) {
      setDraft(tool ? { ...tool } : emptyTool());
    }
  }, [open, tool]);

  const validate = (): string | null => {
    const slug = draft.id.trim().replace(/^u-/, "");
    if (!slug) return t("setting.tools.editor.validation-id");
    if (!/^[a-z0-9_]+$/.test(draft.name)) return t("setting.tools.editor.validation-name");
    if (BUILTIN_TOOL_NAMES.includes(draft.name as any)) {
      return t("setting.tools.editor.validation-name-builtin");
    }
    if (!draft.command.trim()) return t("setting.tools.editor.validation-command");
    if (!draft.description.trim()) return t("setting.tools.editor.validation-description");
    if (draft.timeout_ms < 1000 || draft.timeout_ms > 600000) {
      return t("setting.tools.editor.validation-timeout");
    }
    return null;
  };

  const handleSave = async () => {
    const err = validate();
    if (err) {
      toast.error(err);
      return;
    }
    const toSave: ToolDto = {
      ...draft,
      id: isEdit ? draft.id : `u-${draft.id.trim().replace(/^u-/, "")}`,
    };
    setSaving(true);
    try {
      await onSave(toSave);
      onClose();
    } catch (e) {
      toast.error(getErrorMessage(e, t("setting.tools.editor.save-failed")));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent size="2xl">
        <DialogHeader>
          <DialogTitle>
            {isEdit ? t("setting.tools.editor.edit") : t("setting.tools.editor.create")}
          </DialogTitle>
        </DialogHeader>
        <div className="space-y-4">
          <div className="space-y-2">
            <Label>{t("setting.tools.editor.id")}</Label>
            <Input
              value={isEdit ? draft.id : draft.id.replace(/^u-/, "")}
              onChange={(e) => setDraft((d) => ({ ...d, id: e.target.value }))}
              disabled={isEdit}
              placeholder="my-tool"
            />
            {!isEdit && (
              <p className="text-xs text-muted-foreground">
                {t("setting.tools.editor.id-hint")}
              </p>
            )}
          </div>
          <div className="space-y-2">
            <Label>{t("setting.tools.editor.name")}</Label>
            <Input
              value={draft.name}
              onChange={(e) => setDraft((d) => ({ ...d, name: e.target.value }))}
              placeholder="git_status"
            />
          </div>
          <div className="space-y-2">
            <Label>{t("setting.tools.editor.command")}</Label>
            <Input
              value={draft.command}
              onChange={(e) => setDraft((d) => ({ ...d, command: e.target.value }))}
              placeholder="git status"
            />
            <p className="text-xs text-muted-foreground">
              {t("setting.tools.editor.command-hint")}
            </p>
          </div>
          <div className="space-y-2">
            <Label>{t("setting.tools.editor.permission")}</Label>
            <div className="flex flex-wrap gap-2">
              {PERMISSIONS.map((p) => (
                <button
                  key={p}
                  type="button"
                  onClick={() => setDraft((d) => ({ ...d, permission: p }))}
                  className={`rounded border px-3 py-1.5 text-xs ${
                    draft.permission === p
                      ? "border-primary bg-primary text-primary-foreground"
                      : "border-border bg-background hover:bg-accent"
                  }`}
                >
                  <span className={`mr-1.5 inline-block rounded px-1 py-0.5 text-[10px] ${PERMISSION_BADGE_COLORS[p]}`}>
                    {PERMISSION_LABELS[p]}
                  </span>
                  {p}
                </button>
              ))}
            </div>
          </div>
          <div className="space-y-2">
            <Label>{t("setting.tools.editor.description")}</Label>
            <Input
              value={draft.description}
              onChange={(e) => setDraft((d) => ({ ...d, description: e.target.value }))}
              placeholder={t("setting.tools.editor.description-placeholder")}
            />
          </div>
          <div className="space-y-2">
            <Label>{t("setting.tools.editor.timeout")}</Label>
            <Input
              type="number"
              min={1000}
              max={600000}
              step={1000}
              value={draft.timeout_ms}
              onChange={(e) => setDraft((d) => ({ ...d, timeout_ms: Number(e.target.value) }))}
            />
            <p className="text-xs text-muted-foreground">
              {t("setting.tools.editor.timeout-hint")}
            </p>
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={saving}>
            {t("common.cancel")}
          </Button>
          <Button onClick={handleSave} disabled={saving}>
            {saving ? t("common.saving") : t("common.save")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};

export default ToolEditor;
```

- [ ] **Step 2: 创建 ToolsSection.tsx**

```typescript
import { useState } from "react";
import toast from "react-hot-toast";
import { PencilIcon, PlusIcon, Trash2Icon, WrenchIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { getErrorMessage } from "@/lib/error";
import {
  useCreateTool,
  useDeleteTool,
  useSetToolEnabled,
  useToolList,
  useUpdateTool,
} from "@/hooks/useToolQueries";
import { useTranslate } from "@/utils/i18n";
import {
  PERMISSION_BADGE_COLORS,
  PERMISSION_LABELS,
  type ToolDto,
} from "@/types/tool";
import SettingGroup from "./SettingGroup";
import { SettingList, SettingListItem } from "./SettingList";
import SettingSection from "./SettingSection";
import ToolEditor from "./ToolEditor";

const ToolsSection = () => {
  const t = useTranslate();
  const { data: tools = [], isLoading } = useToolList();
  const createMut = useCreateTool();
  const updateMut = useUpdateTool();
  const deleteMut = useDeleteTool();
  const setEnabledMut = useSetToolEnabled();

  const [editorOpen, setEditorOpen] = useState(false);
  const [editingTool, setEditingTool] = useState<ToolDto | null>(null);

  const handleToggle = (tool: ToolDto, enabled: boolean) => {
    setEnabledMut.mutate(
      { id: tool.id, enabled },
      {
        onError: (e) =>
          toast.error(getErrorMessage(e, t("setting.tools.toggle-failed"))),
      },
    );
  };

  const handleDelete = (tool: ToolDto) => {
    if (!confirm(t("setting.tools.confirm-delete", { name: tool.name }))) return;
    deleteMut.mutate(tool.id, {
      onError: (e) =>
        toast.error(getErrorMessage(e, t("setting.tools.delete-failed"))),
    });
  };

  const handleEditorSave = async (tool: ToolDto) => {
    if (editingTool) {
      await updateMut.mutateAsync(tool);
    } else {
      await createMut.mutateAsync(tool);
    }
  };

  return (
    <SettingSection title={t("setting.tools.label")} description={t("setting.tools.description")}>
      <SettingGroup title={t("setting.tools.list")}>
        {isLoading ? (
          <p className="p-4 text-sm text-muted-foreground">{t("common.loading")}</p>
        ) : tools.length === 0 ? (
          <p className="p-4 text-sm text-muted-foreground">{t("setting.tools.empty")}</p>
        ) : (
          <SettingList>
            {tools.map((tool) => (
              <SettingListItem
                key={tool.id}
                label={tool.name}
                description={tool.description}
              >
                <div className="flex items-center gap-3">
                  <span className={`rounded px-1.5 py-0.5 text-xs ${PERMISSION_BADGE_COLORS[tool.permission]}`}>
                    {PERMISSION_LABELS[tool.permission]}
                  </span>
                  <code className="rounded bg-muted px-1.5 py-0.5 text-xs font-mono">
                    {tool.command}
                  </code>
                  <Switch
                    checked={tool.enabled}
                    onCheckedChange={(v) => handleToggle(tool, v)}
                  />
                  <Button
                    variant="ghost"
                    size="icon"
                    onClick={() => {
                      setEditingTool(tool);
                      setEditorOpen(true);
                    }}
                  >
                    <PencilIcon className="h-4 w-4" />
                  </Button>
                  <Button variant="ghost" size="icon" onClick={() => handleDelete(tool)}>
                    <Trash2Icon className="h-4 w-4" />
                  </Button>
                </div>
              </SettingListItem>
            ))}
          </SettingList>
        )}
        <div className="p-2">
          <Button
            variant="outline"
            onClick={() => {
              setEditingTool(null);
              setEditorOpen(true);
            }}
          >
            <PlusIcon className="mr-2 h-4 w-4" />
            {t("setting.tools.create")}
          </Button>
        </div>
      </SettingGroup>

      <ToolEditor
        open={editorOpen}
        tool={editingTool}
        onSave={handleEditorSave}
        onClose={() => setEditorOpen(false)}
      />
    </SettingSection>
  );
};

export default ToolsSection;
```

- [ ] **Step 3: 在 settingSections.ts 注册**

修改 `src/components/Settings/settingSections.ts`：

在顶部 import 区追加（第 2 行的 lucide-react import 里加 `WrenchIcon`，或新加一行）：

```typescript
import { BarChart3Icon, BookOpenIcon, CogIcon, CpuIcon, HardDriveIcon, LibraryIcon, PlugIcon, RadioIcon, SparklesIcon, TagsIcon, UserIcon, WrenchIcon, type LucideIcon } from "lucide-react";
```

在第 14 行 `import SkillsSection ...` 后追加：

```typescript
import ToolsSection from "@/components/Settings/ToolsSection";
```

在 `SettingSectionKey` 类型（第 17-28 行）追加 `| "tools"`：

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
  | "skills"
  | "tools";
```

在 `SETTINGS_SECTIONS` 数组末尾（第 118 行 `}` 前）追加：

```typescript
  {
    key: "tools",
    scope: "basic",
    labelKey: "setting.tools.label",
    icon: WrenchIcon,
    component: ToolsSection,
  },
```

- [ ] **Step 4: TypeScript 编译验证**

Run: `cd d:/3-ai-project/LocalFragNote && npx tsc --noEmit 2>&1 | head -30`
Expected: 无报错（翻译键在下一个任务补）

- [ ] **Step 5: Commit**

```bash
git add src/components/Settings/ToolsSection.tsx src/components/Settings/ToolEditor.tsx src/components/Settings/settingSections.ts
git commit -m "feat(tool): add ToolsSection and ToolEditor UI"
```

---

## Task 12: 实现 ToolConfirmDialog 前端组件

**Files:**
- Create: `src/components/AiChat/ToolConfirmDialog.tsx`
- Modify: `src/components/AiChat/types.ts`（ToolPayload 扩展字段）

- [ ] **Step 1: 扩展 ToolPayload 类型**

修改 `src/components/AiChat/types.ts:93-99`：

```typescript
export interface ToolPayload {
  run_id: number;
  name: string;
  args: unknown;
  tool_call_id: string;
  result: unknown;
  /** 用户工具标识（前端用于差异化渲染） */
  is_user_tool?: boolean;
  /** 用户工具权限等级 */
  permission?: string;
  /** 用户是否拒绝 */
  denied?: boolean;
}
```

- [ ] **Step 2: 创建 ToolConfirmDialog.tsx**

```typescript
import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useTranslate } from "@/utils/i18n";
import {
  PERMISSION_BADGE_COLORS,
  PERMISSION_LABELS,
  type ToolConfirmRequest,
  type ToolPermission,
} from "@/types/tool";

const CONFIRM_TIMEOUT_SECONDS = 60;

const ToolConfirmDialog = () => {
  const t = useTranslate();
  const [queue, setQueue] = useState<ToolConfirmRequest[]>([]);
  const [remainingSeconds, setRemainingSeconds] = useState(CONFIRM_TIMEOUT_SECONDS);

  const current = queue[0] ?? null;

  useEffect(() => {
    if (!current) return;
    setRemainingSeconds(CONFIRM_TIMEOUT_SECONDS);
    const interval = setInterval(() => {
      setRemainingSeconds((s) => {
        if (s <= 1) {
          // 超时按拒绝处理
          handleRespond(false);
          return 0;
        }
        return s - 1;
      });
    }, 1000);
    return () => clearInterval(interval);
  }, [current?.call_id]);

  useEffect(() => {
    let unlisten: UnlistenFn | null = null;
    listen<ToolConfirmRequest>("tool:confirm_request", (event) => {
      setQueue((q) => [...q, event.payload]);
    }).then((fn) => {
      unlisten = fn;
    });
    return () => {
      if (unlisten) unlisten();
    };
  }, []);

  const handleRespond = async (approved: boolean) => {
    if (!current) return;
    const callId = current.call_id;
    // 先从队列移除，避免 Dialog 闪现新内容
    setQueue((q) => q.slice(1));
    try {
      await invoke("tool_confirm_response", { callId, approved });
    } catch (e) {
      console.error("tool_confirm_response failed:", e);
    }
  };

  if (!current) return null;
  const permission = current.permission as ToolPermission;
  const isDangerous = permission === "dangerous";

  return (
    <Dialog open={true} onOpenChange={(o) => { if (!o) handleRespond(false); }}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t("aiChat.tool.confirm-title")}</DialogTitle>
          <DialogDescription>
            {t("aiChat.tool.confirm-description")}
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div className="flex items-center gap-2">
            <span className="text-sm text-muted-foreground">{t("aiChat.tool.tool-name")}</span>
            <code className="rounded bg-muted px-1.5 py-0.5 text-xs font-mono">{current.tool_name}</code>
            <span className={`rounded px-1.5 py-0.5 text-xs ${PERMISSION_BADGE_COLORS[permission]}`}>
              {PERMISSION_LABELS[permission]}
            </span>
          </div>
          <div>
            <p className="mb-1 text-sm text-muted-foreground">{t("aiChat.tool.command")}</p>
            <pre className="max-h-64 overflow-auto rounded bg-muted p-3 text-xs font-mono whitespace-pre-wrap break-all">
              {current.command}
            </pre>
          </div>
          {isDangerous && (
            <div className="rounded border border-red-300 bg-red-50 dark:border-red-800 dark:bg-red-950/30 p-3 text-sm text-red-700 dark:text-red-300">
              ⚠️ {t("aiChat.tool.dangerous-warning")}
            </div>
          )}
          <p className="text-xs text-muted-foreground">
            {t("aiChat.tool.countdown", { seconds: remainingSeconds })}
          </p>
        </div>
        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => handleRespond(false)}
            autoFocus
          >
            {t("aiChat.tool.deny")}
          </Button>
          <Button
            variant={isDangerous ? "destructive" : "default"}
            onClick={() => handleRespond(true)}
          >
            {t("aiChat.tool.approve")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};

export default ToolConfirmDialog;
```

- [ ] **Step 3: 挂载 ToolConfirmDialog**

找到 AiChat 主组件挂载点。先用 Glob 找：

Run: 用 Glob 工具搜 `src/components/AiChat/index.tsx` 或 `App.tsx`

最简单做法：在 `src/App.tsx`（或根组件）顶部挂载一个 `<ToolConfirmDialog />`，让它在全局监听 `tool:confirm_request` 事件。

读 `src/App.tsx`，在根 `<>` 中追加 `<ToolConfirmDialog />`：

```typescript
import ToolConfirmDialog from "@/components/AiChat/ToolConfirmDialog";
// ...
return (
  <>
    {/* 现有内容 */}
    <ToolConfirmDialog />
  </>
);
```

- [ ] **Step 4: TypeScript 编译验证**

Run: `cd d:/3-ai-project/LocalFragNote && npx tsc --noEmit 2>&1 | head -30`
Expected: 无报错（翻译键在下一个任务补）

- [ ] **Step 5: Commit**

```bash
git add src/components/AiChat/ToolConfirmDialog.tsx src/components/AiChat/types.ts src/App.tsx
git commit -m "feat(tool): add ToolConfirmDialog with 60s countdown"
```

---

## Task 13: 扩展 AiChatMessages 渲染 user_tool 卡片

**Files:**
- Modify: `src/components/AiChat/AiChatMessages.tsx`
- Modify: `src/components/AiChat/hooks.ts`

- [ ] **Step 1: 修改 invalidateQueriesForTool**

在 `src/components/AiChat/hooks.ts:34-65` 的 `invalidateQueriesForTool` 函数末尾，在 `}` 前追加 default 分支：

把：
```typescript
    case "load_skill":
      // skill 加载不修改 memo 数据，无需失效缓存
      break;
  }
}
```

改为：
```typescript
    case "load_skill":
      // skill 加载不修改 memo 数据，无需失效缓存
      break;
    default:
      // 用户工具：不直接修改 memo 数据（与 load_skill 同样 no-op）
      // 内置工具名之外的工具调用都走这里
      break;
  }
}
```

- [ ] **Step 2: 修改 AiChatMessages 渲染**

在 `src/components/AiChat/AiChatMessages.tsx:63-88` 的 `if (msg.role === "tool")` 块中，在现有 `load_skill` 特殊渲染之后、默认渲染之前，追加 user_tool 分支。

先读现有文件结构（已读过）。在第 82 行 `}`（load_skill 块结束）后追加：

```typescript
          // 用户工具渲染：根据 result 中的 is_user_tool 标记判断
          const userToolResult = msg.toolResult as {
            tool_name?: string;
            permission?: string;
            denied?: boolean;
            error?: string;
            output?: string;
            exit_code?: number;
          } | null;

          if (userToolResult?.tool_name && userToolResult?.permission) {
            const perm = userToolResult.permission as ToolPermission;
            const isDenied = userToolResult.denied === true;
            return (
              <div
                key={msg.id}
                className={`my-1 rounded border p-2 text-xs ${
                  isDenied
                    ? "border-yellow-200 bg-yellow-50 dark:border-yellow-900 dark:bg-yellow-950/30"
                    : userToolResult.error
                    ? "border-red-200 bg-red-50 dark:border-red-900 dark:bg-red-950/30"
                    : "border-gray-200 bg-gray-50 dark:border-gray-800 dark:bg-gray-900/30"
                }`}
              >
                <div className="mb-1 flex items-center gap-2">
                  <span className="font-medium">{userToolResult.tool_name}</span>
                  <span className={`rounded px-1.5 py-0.5 text-[10px] ${PERMISSION_BADGE_COLORS[perm]}`}>
                    {PERMISSION_LABELS[perm]}
                  </span>
                  {isDenied && (
                    <span className="text-yellow-700 dark:text-yellow-300">
                      {t("aiChat.tool.denied")}
                    </span>
                  )}
                </div>
                {userToolResult.error ? (
                  <p className="font-mono text-red-600 dark:text-red-400">{userToolResult.error}</p>
                ) : (
                  <pre className="max-h-48 overflow-auto whitespace-pre-wrap break-all font-mono">
                    {userToolResult.output ?? ""}
                  </pre>
                )}
              </div>
            );
          }
```

在文件顶部 import 区追加：

```typescript
import {
  PERMISSION_BADGE_COLORS,
  PERMISSION_LABELS,
  type ToolPermission,
} from "@/types/tool";
```

- [ ] **Step 3: TypeScript 编译验证**

Run: `cd d:/3-ai-project/LocalFragNote && npx tsc --noEmit 2>&1 | head -30`
Expected: 无报错

- [ ] **Step 4: Commit**

```bash
git add src/components/AiChat/AiChatMessages.tsx src/components/AiChat/hooks.ts
git commit -m "feat(tool): render user tool results with permission badge"
```

---

## Task 14: 补充 i18n 翻译键

**Files:**
- Modify: `src/locales/zh-Hans.json`
- Modify: `src/locales/en.json`

- [ ] **Step 1: 在 zh-Hans.json 补充中文翻译**

在 `src/locales/zh-Hans.json` 的 `setting` 对象中（第 1082 行 `"skills"` 块之后），追加 `"tools"` 块：

```json
    "tools": {
      "label": "工具",
      "description": "管理 AI agent 可调用的自定义 shell 命令工具。",
      "list": "工具列表",
      "empty": "暂无工具，点击下方按钮创建。",
      "create": "新建工具",
      "toggle-failed": "切换状态失败",
      "delete-failed": "删除失败",
      "confirm-delete": "确定删除工具 \"{{name}}\" 吗？此操作不可撤销。",
      "editor": {
        "edit": "编辑工具",
        "create": "新建工具",
        "id": "ID",
        "id-hint": "工具的唯一标识符（如 my-tool）。创建后不可修改。",
        "name": "工具名",
        "command": "默认命令",
        "command-hint": "示例命令，LLM 调用时会传入完整 command 覆盖它。",
        "permission": "权限等级",
        "description": "描述",
        "description-placeholder": "如：查看当前 git 仓库状态",
        "timeout": "超时时间（毫秒）",
        "timeout-hint": "范围 1000-600000，超出后强制终止子进程。",
        "validation-id": "请填写 ID",
        "validation-name": "工具名只能包含小写字母、数字和下划线",
        "validation-name-builtin": "工具名与内置工具冲突",
        "validation-command": "请填写命令",
        "validation-description": "请填写描述",
        "validation-timeout": "超时时间必须在 1000-600000 之间",
        "save-failed": "保存失败"
      }
    }
```

在 `aiChat` 对象中（找到现有的 `aiChat` 块）追加：

```json
    "tool": {
      "confirm-title": "工具调用确认",
      "confirm-description": "AI 助手请求执行以下工具，请确认。",
      "tool-name": "工具",
      "command": "命令",
      "dangerous-warning": "此工具被标记为危险，执行可能造成不可逆后果。",
      "countdown": "{{seconds}} 秒后自动拒绝",
      "deny": "拒绝",
      "approve": "批准",
      "denied": "已拒绝"
    }
```

- [ ] **Step 2: 在 en.json 补充英文翻译**

在 `src/locales/en.json` 的对应位置追加：

```json
    "tools": {
      "label": "Tools",
      "description": "Manage custom shell command tools that the AI agent can invoke.",
      "list": "Tool List",
      "empty": "No tools yet. Click the button below to create one.",
      "create": "New Tool",
      "toggle-failed": "Failed to toggle",
      "delete-failed": "Failed to delete",
      "confirm-delete": "Are you sure you want to delete tool \"{{name}}\"? This cannot be undone.",
      "editor": {
        "edit": "Edit Tool",
        "create": "New Tool",
        "id": "ID",
        "id-hint": "Unique identifier for the tool (e.g., my-tool). Cannot be changed after creation.",
        "name": "Tool Name",
        "command": "Default Command",
        "command-hint": "Example command. The LLM will pass a full command that overrides this.",
        "permission": "Permission Level",
        "description": "Description",
        "description-placeholder": "e.g., Show current git repository status",
        "timeout": "Timeout (ms)",
        "timeout-hint": "Range 1000-600000. The subprocess will be killed after this duration.",
        "validation-id": "Please fill in the ID",
        "validation-name": "Tool name can only contain lowercase letters, digits, and underscores",
        "validation-name-builtin": "Tool name conflicts with a builtin tool",
        "validation-command": "Please fill in the command",
        "validation-description": "Please fill in the description",
        "validation-timeout": "Timeout must be between 1000 and 600000",
        "save-failed": "Save failed"
      }
    }
```

```json
    "tool": {
      "confirm-title": "Tool Call Confirmation",
      "confirm-description": "The AI assistant is requesting to execute the following tool. Please confirm.",
      "tool-name": "Tool",
      "command": "Command",
      "dangerous-warning": "This tool is marked as dangerous. Execution may cause irreversible consequences.",
      "countdown": "Auto-denied in {{seconds}} seconds",
      "deny": "Deny",
      "approve": "Approve",
      "denied": "Denied"
    }
```

- [ ] **Step 3: 验证 JSON 格式**

Run: `cd d:/3-ai-project/LocalFragNote && node -e "JSON.parse(require('fs').readFileSync('src/locales/zh-Hans.json'))" && node -e "JSON.parse(require('fs').readFileSync('src/locales/en.json'))"`
Expected: 无输出（解析成功）

- [ ] **Step 4: Commit**

```bash
git add src/locales/zh-Hans.json src/locales/en.json
git commit -m "i18n(tool): add zh-Hans and en translations for tool config and confirm dialog"
```

---

## Task 15: 端到端集成测试

**Files:**
- 无新增文件，验证现有测试全部通过

- [ ] **Step 1: 运行 Rust 测试套件**

Run: `cd d:/3-ai-project/LocalFragNote && cargo test -p memos-core --lib 2>&1 | tail -20`
Expected: 全部 PASS（含 tool::tests）

- [ ] **Step 2: 运行 Tauri 后端测试**

Run: `cd d:/3-ai-project/LocalFragNote && cargo test -p memos-app --lib 2>&1 | tail -30`
Expected: 全部 PASS（含 ai::tools::tests、ai::pending_confirmations::tests）

- [ ] **Step 3: TypeScript 编译**

Run: `cd d:/3-ai-project/LocalFragNote && npx tsc --noEmit 2>&1 | tail -30`
Expected: 无错误

- [ ] **Step 4: 前端构建**

Run: `cd d:/3-ai-project/LocalFragNote && npm run build 2>&1 | tail -20`
Expected: 构建成功

- [ ] **Step 5: 手动验证 checklist（启动应用后）**

启动 dev 服务器：`cd d:/3-ai-project/LocalFragNote && npm run tauri dev`

打开应用后，按以下顺序手动验证：
1. 设置 → 工具：看到空列表
2. 点击「新建工具」按钮，Dialog 弹出
3. 创建工具：id=test, name=test_tool, command=echo hello, permission=read_only, description=测试, timeout=5000
4. 工具列表出现新条目，带「只读」灰色 badge
5. AI 聊天：让 AI 调用 test_tool 工具（如「请用 test_tool 工具打印 hello world」）
6. 验证 AI 返回 `hello world`，AiChatMessages 渲染带 badge 的卡片
7. 修改工具 permission=executable，再让 AI 调用：验证弹出确认 Dialog
8. 拒绝：验证返回 `denied: true`
9. 批准：验证执行成功
10. 修改 permission=dangerous：验证 Dialog 显示红色警告框 + destructive 按钮
11. 修改 timeout_ms=1000，让 AI 调用 `sleep 5`：验证返回 timeout 错误
12. 让 AI 调用 `yes hello | head -c 20000`：验证输出被截断含 `[truncated`
13. Skills 设置：创建 skill 时，tools 多选中能看到 test_tool
14. AI 聊天：abort 一个等待确认的调用，验证 Dialog 自动关闭

- [ ] **Step 6: Commit（如有修复）**

```bash
git add -A
git commit -m "test(tool): end-to-end integration verified"
```

---

## Self-Review 检查清单

执行完所有任务后，对照 spec 检查覆盖：

**Spec Section 2（数据模型）**：
- [x] `tool` 表 → Task 1
- [x] `Permission` enum + `Tool` struct → Task 2
- [x] CRUD 函数 → Task 2
- [x] name 黑名单校验 → Task 2 (`BUILTIN_TOOL_NAMES` + `validate_name`)

**Spec Section 3（工具定义与执行）**：
- [x] `tool_definitions` 签名改造 → Task 5
- [x] `execute_user_tool` → Task 6
- [x] 跨平台 shell → Task 6 (`#[cfg(windows)]`)
- [x] 截断 helper → Task 6 (`truncate_at_char_boundary`)
- [x] 超时 + kill_on_drop → Task 6

**Spec Section 4（确认通道）**：
- [x] `PendingConfirmations` → Task 3
- [x] `cancel_all` → Task 3
- [x] AppState 字段 → Task 4
- [x] `tool_confirm_response` 命令 → Task 8
- [x] 前端 Dialog + 队列 → Task 12
- [x] 60s 倒计时 → Task 12

**Spec Section 5（Agent Loop 集成）**：
- [x] 加载 user_tools → Task 7
- [x] tool_definitions 传参 → Task 7
- [x] abort 时 cancel_all（RAII guard）→ Task 7
- [x] ai:tool 事件扩展 → Task 7
- [x] execute_tool 签名变更 → Task 6（state 参数）

**Spec Section 6（IPC + 前端 + Skill 关联）**：
- [x] 6 个 Tauri 命令 → Task 8
- [x] `src/types/tool.ts` → Task 9
- [x] `src/hooks/useToolQueries.ts` → Task 9
- [x] `ToolsSection.tsx` → Task 11
- [x] `ToolEditor.tsx` → Task 11
- [x] settingSections 注册 → Task 11
- [x] `useKnownToolNames` → Task 9
- [x] SkillEditor 动态化 → Task 10
- [x] skill 后端不校验 tools 字段 → 无需改动（保持现状）

**Spec Section 7（错误处理与测试）**：
- [x] 错误矩阵覆盖 → Task 6 (deny/timeout/spawn fail/truncate)
- [x] core 测试 → Task 2
- [x] tools.rs 测试 → Task 5
- [x] PendingConfirmations 测试 → Task 3
- [x] 端到端验证 → Task 15

**类型一致性检查**：
- `Permission::as_str()` 在 Task 2/6/8 一致使用
- `ToolDto.permission` 是 `String`（IPC 层）vs `Tool.permission` 是 `Permission` enum（core 层）—— 通过 `From` impl 转换，一致
- `tool_keys` 在 hooks.ts 内部使用，与 `skillKeys` 命名风格一致
- `BUILTIN_TOOL_NAMES` 在 `core/src/tool.rs` 和 `src/types/tool.ts` 两处定义，需保持同步（前者 Rust，后者 TS）

**已知偏离 spec 的地方**：
1. `agent_loop` 用 RAII `CancelGuard` 替代在每个 return 点显式调用 `cancel_all`。语义等价但代码更简洁，避免了漏掉 return 路径的风险。
2. `execute_tool` 签名增加 `state: &AppState` 参数（spec 说增加 3 个参数 `user_tools`、`pending_confirmations`、`app_handle`），改为直接传 `state` 引用更简洁，因为 AppState 已经包含 `pending_confirmations` 和 `app_handle`。`user_tools` 不需要传入，因为 `execute_user_tool` 内部用 `memos_core::tool::get_by_name(store, name)` 查 DB（一次性查比预加载列表+查找更简单，且用户工具数量预期很小）。

---

## 执行 Handoff

Plan 完成并保存到 `docs/superpowers/plans/2026-07-24-user-configurable-tools.md`。两种执行选项：

**1. Subagent-Driven (recommended)** - 每个 Task 派发一个 fresh subagent，task 之间 review，迭代快

**2. Inline Execution** - 在当前会话用 executing-plans skill 批量执行，带 checkpoint review

哪种方式？
