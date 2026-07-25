# 可配置工作目录 + 多工作空间切换 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将硬编码的 `~/localFragNote` 数据存储位置改为基于 Tauri `app_config_dir()` 的引导目录 + 用户自选工作空间目录的双层结构，支持多工作空间切换（切换时重启应用）。

**Architecture:** 引导目录（`%APPDATA%\LocalFragNote\`）持有共享配置 SQLite（`app_config.db`）、embedding 模型、LAN 私钥、`workspaces.json` 索引。工作空间目录（用户自选路径）持有独立的 `memos.db` + `attachments/`。`Store` 拆为 `Store`（笔记）+ `ConfigStore`（共享配置）。启动时根据 `workspaces.json` 的 `active_workspace_id` 加载对应工作空间的 `memos.db`；无 active workspace 时用 in-memory placeholder 并路由到 WorkspacePicker。

**Tech Stack:** Rust + Tauri 2 + rusqlite + refinery + serde_json + React + React Query + Tailwind + shadcn/ui

**Spec:** [2026-07-25-configurable-workspace-design.md](file:///d:/3-ai-project/LocalFragNote/docs/superpowers/specs/2026-07-25-configurable-workspace-design.md)

---

## File Structure

### 新增文件

- `core/src/config_store.rs` — 共享配置 Store（app_setting + instance_setting + tool 表）
- `core/src/config_migration.rs` — app_config.db 的 refinery 迁移入口
- `core/migrations/config/V1__initial_config_schema.sql` — app_config.db 建表 SQL
- `core/migrations/V11__drop_shared_config_tables.sql` — memos.db 删表 SQL
- `src-tauri/src/workspace.rs` — WorkspaceRegistry（load/save/add/remove/rename/validate）
- `src-tauri/src/commands/workspace.rs` — 工作空间 IPC 命令
- `src/components/WorkspacePicker/WorkspacePicker.tsx` — 工作空间选择页
- `src/components/WorkspacePicker/index.ts`
- `src/components/Navigation/WorkspaceSwitcher.tsx` — 侧边栏切换器
- `src/components/Settings/WorkspaceSection.tsx` — 设置页工作空间区域
- `src/hooks/useWorkspaceQueries.ts` — React Query hooks
- `src/types/workspace.ts` — 前端类型

### 修改文件

- `core/src/store.rs` — 移除 setting 字段
- `core/src/lib.rs` — 导出 config_store、config_migration
- `core/src/tool.rs` — 函数签名从 `&Store` 改为 `&ConfigStore`
- `src-tauri/src/main.rs` — 启动流程改造（计算 config_dir、打开 app_config.db、加载 registry、打开 active workspace）
- `src-tauri/src/state.rs` — AppState 新增 config_store、workspace_registry、config_dir
- `src-tauri/src/lib.rs` — 导出 workspace 模块
- `src-tauri/src/embedding.rs` — model_dir 接收 config_dir 参数
- `src-tauri/src/lan/endpoint.rs` — init_lan_state 接收 config_dir；lan 配置走 config_store
- `src-tauri/src/commands/setting.rs` — storage_config 走 config_store；路径解析相对 workspace.path
- `src-tauri/src/commands/attachment.rs` — attachments_dir 来自 workspace.path
- `src-tauri/src/commands/tool.rs` — tool 操作走 config_store
- `src-tauri/src/file_storage.rs` — 路径基准改为 workspace.path/attachments
- `src-tauri/src/ai/provider.rs` — provider 操作走 config_store
- `src-tauri/src/llm_runner/config.rs` — llm_runner_config 走 config_store
- `src-tauri/src/mcp/config.rs` — mcp_config 走 config_store
- `src-tauri/src/ai/tools.rs` — execute_user_tool 走 config_store
- `src/components/Navigation.tsx` — 添加 WorkspaceSwitcher
- `src/components/Settings/index.tsx` — 添加 WorkspaceSection
- `src/router.tsx` — 添加 /workspace-picker 路由
- `src/locales/zh-Hans.json` — 新增 workspace 键
- `src/locales/en.json` — 新增 workspace 键

---

## Phase 1: 数据库拆分基础

### Task 1: 创建 app_config.db 迁移 SQL

**Files:**
- Create: `core/migrations/config/V1__initial_config_schema.sql`

- [ ] **Step 1: 创建迁移目录与文件**

创建 `core/migrations/config/V1__initial_config_schema.sql`：

```sql
-- app_config.db 初始 schema：从原 memos.db 拆分出来的共享配置表
-- 这些表跨工作空间共享，与具体笔记数据无关

CREATE TABLE IF NOT EXISTS app_setting (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS instance_setting (
    name TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    description TEXT
);

CREATE TABLE IF NOT EXISTS tool (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL UNIQUE,
    command TEXT NOT NULL,
    permission TEXT NOT NULL,
    description TEXT NOT NULL,
    timeout_ms INTEGER NOT NULL,
    enabled INTEGER NOT NULL DEFAULT 1,
    created_ts INTEGER NOT NULL,
    updated_ts INTEGER NOT NULL
);
```

- [ ] **Step 2: 验证 SQL 语法**

Run:
```bash
cd d:/3-ai-project/LocalFragNote
sqlite3 ":memory:" ".read core/migrations/config/V1__initial_config_schema.sql" ".tables"
```
Expected: 输出 `app_setting  instance_setting  tool` 三张表

- [ ] **Step 3: Commit**

```bash
cd d:/3-ai-project/LocalFragNote
git add core/migrations/config/V1__initial_config_schema.sql
git commit -m "feat: add app_config.db initial schema migration"
```

---

### Task 2: 创建 memos.db V11 迁移（删表）

**Files:**
- Create: `core/migrations/V11__drop_shared_config_tables.sql`

- [ ] **Step 1: 创建迁移文件**

创建 `core/migrations/V11__drop_shared_config_tables.sql`：

```sql
-- 删除从 memos.db 拆分到 app_config.db 的共享配置表
-- 这些表现在由 app_config.db 管理，跨工作空间共享

DROP TABLE IF EXISTS app_setting;
DROP TABLE IF EXISTS instance_setting;
DROP TABLE IF EXISTS tool;
```

- [ ] **Step 2: Commit**

```bash
cd d:/3-ai-project/LocalFragNote
git add core/migrations/V11__drop_shared_config_tables.sql
git commit -m "feat: add V11 migration to drop shared config tables from memos.db"
```

---

### Task 3: 创建 config_migration 模块

**Files:**
- Create: `core/src/config_migration.rs`
- Modify: `core/src/lib.rs`

- [ ] **Step 1: 创建 config_migration.rs**

创建 `core/src/config_migration.rs`：

```rust
//! app_config.db 的迁移入口
//!
//! 与 memos.db 的迁移独立，连接到不同的 db 文件，使用独立的迁移目录

use crate::error::CoreResult;
use refinery::embed_migrations;

embed_migrations!("migrations/config");

/// 执行 app_config.db 迁移
pub fn run(conn: &mut rusqlite::Connection) -> CoreResult<()> {
    let report = migrations::runner().run(conn)?;
    tracing::info!(
        "app_config.db 迁移完成，应用 {} 个迁移",
        report.applied_migrations().len()
    );
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_run_on_fresh_db() {
        let mut conn = rusqlite::Connection::open_in_memory().unwrap();
        assert!(run(&mut conn).is_ok());
        // 验证三张表都已创建
        let count: i64 = conn
            .query_row(
                "SELECT count(*) FROM sqlite_master WHERE type='table' AND name IN ('app_setting', 'instance_setting', 'tool')",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(count, 3);
    }

    #[test]
    fn test_run_idempotent() {
        let mut conn = rusqlite::Connection::open_in_memory().unwrap();
        run(&mut conn).unwrap();
        // 第二次运行应该不报错（refinery 跳过已应用的迁移）
        assert!(run(&mut conn).is_ok());
    }
}
```

- [ ] **Step 2: 在 lib.rs 中导出**

修改 `core/src/lib.rs`，在 `pub mod migration;` 后添加：

```rust
pub mod config_migration;
pub mod config_store;
```

（`config_store` 模块在 Task 4 创建）

- [ ] **Step 3: 运行测试验证**

Run:
```bash
cd d:/3-ai-project/LocalFragNote/core
cargo test --lib config_migration::tests
```
Expected: 2 tests passed

- [ ] **Step 4: Commit**

```bash
cd d:/3-ai-project/LocalFragNote
git add core/src/config_migration.rs core/src/lib.rs
git commit -m "feat: add config_migration module for app_config.db"
```

---

### Task 4: 创建 ConfigStore

**Files:**
- Create: `core/src/config_store.rs`

- [ ] **Step 1: 创建 config_store.rs**

创建 `core/src/config_store.rs`：

```rust
//! 共享配置 Store：管理 app_config.db 连接
//!
//! 持有 app_setting、instance_setting、tool 三张表的访问器
//! 与 Store（memos.db）独立，跨工作空间共享

use crate::cache::{new_string_cache, CacheConfig};
use crate::error::CoreResult;
use crate::setting::SettingStore;
use rusqlite::Connection;
use std::path::Path;
use std::sync::Mutex;

/// 共享配置 Store：对应 app_config.db
pub struct ConfigStore {
    conn: Mutex<Connection>,
    pub setting: SettingStore,
}

impl ConfigStore {
    /// 打开/创建 app_config.db 并执行迁移
    pub fn open<P: AsRef<Path>>(db_path: P) -> CoreResult<Self> {
        let conn = Connection::open(db_path)?;
        conn.execute("PRAGMA foreign_keys = ON", [])?;
        let mut conn_mut = conn;
        crate::config_migration::run(&mut conn_mut)?;
        let conn = conn_mut;

        let cfg = CacheConfig::default();
        let app_cache = new_string_cache(&cfg);
        let instance_cache = new_string_cache(&cfg);
        let setting = SettingStore::new(app_cache, instance_cache);

        Ok(Self {
            conn: Mutex::new(conn),
            setting,
        })
    }

    /// 内存数据库（用于测试）
    pub fn open_in_memory() -> CoreResult<Self> {
        let conn = Connection::open_in_memory()?;
        let mut conn_mut = conn;
        crate::config_migration::run(&mut conn_mut)?;
        let conn = conn_mut;

        let cfg = CacheConfig::default();
        let app_cache = new_string_cache(&cfg);
        let instance_cache = new_string_cache(&cfg);
        let setting = SettingStore::new(app_cache, instance_cache);

        Ok(Self {
            conn: Mutex::new(conn),
            setting,
        })
    }

    /// 获取连接（锁住内部 Mutex）
    pub fn with_conn<F, T>(&self, f: F) -> CoreResult<T>
    where
        F: FnOnce(&Connection) -> CoreResult<T>,
    {
        let conn = self.conn.lock().expect("ConfigStore Mutex poisoned");
        f(&conn)
    }

    /// 获取可变连接（用于事务）
    pub fn with_conn_mut<F, T>(&self, f: F) -> CoreResult<T>
    where
        F: FnOnce(&mut Connection) -> CoreResult<T>,
    {
        let mut conn = self.conn.lock().expect("ConfigStore Mutex poisoned");
        f(&mut conn)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_open_in_memory_creates_tables() {
        let store = ConfigStore::open_in_memory().unwrap();
        store
            .with_conn(|c| {
                let count: i64 = c.query_row(
                    "SELECT count(*) FROM sqlite_master WHERE type='table' AND name IN ('app_setting', 'instance_setting', 'tool')",
                    [],
                    |row| row.get(0),
                )?;
                assert_eq!(count, 3);
                Ok(())
            })
            .unwrap();
    }

    #[test]
    fn test_app_setting_crud() {
        let store = ConfigStore::open_in_memory().unwrap();
        store
            .with_conn(|c| store.setting.app.upsert(c, "test_key", "test_value"))
            .unwrap();

        let v = store
            .with_conn(|c| store.setting.app.get(c, "test_key"))
            .unwrap();
        assert_eq!(v, Some("test_value".to_string()));

        store
            .with_conn(|c| store.setting.app.delete(c, "test_key"))
            .unwrap();
        let v = store
            .with_conn(|c| store.setting.app.get(c, "test_key"))
            .unwrap();
        assert_eq!(v, None);
    }

    #[test]
    fn test_instance_setting_crud() {
        let store = ConfigStore::open_in_memory().unwrap();
        store
            .with_conn(|c| {
                store
                    .setting
                    .instance
                    .upsert(c, "name1", "value1", "desc1")
            })
            .unwrap();

        let v = store
            .with_conn(|c| store.setting.instance.get(c, "name1"))
            .unwrap();
        assert_eq!(v, Some("value1".to_string()));
    }
}
```

- [ ] **Step 2: 运行测试验证**

Run:
```bash
cd d:/3-ai-project/LocalFragNote/core
cargo test --lib config_store::tests
```
Expected: 3 tests passed

- [ ] **Step 3: Commit**

```bash
cd d:/3-ai-project/LocalFragNote
git add core/src/config_store.rs
git commit -m "feat: add ConfigStore for shared app_config.db"
```

---

### Task 5: 修改 Store 移除 setting 字段

**Files:**
- Modify: `core/src/store.rs`

- [ ] **Step 1: 修改 store.rs 移除 setting 字段**

替换 `core/src/store.rs` 的 `Store` 结构体和 impl 块：

```rust
//! Store facade：统一管理 memos.db 连接

use crate::error::CoreResult;
use crate::migration;
use rusqlite::Connection;
use std::path::Path;
use std::sync::{Mutex, Once};

/// 确保 sqlite-vec 扩展已注册（全局只需一次）
/// 必须在打开任何 Connection 之前调用，之后所有连接自动加载 vec0 虚拟表
static VEC_EXT_INIT: Once = Once::new();

fn ensure_vec_extension_loaded() {
    VEC_EXT_INIT.call_once(|| {
        use rusqlite::ffi::sqlite3_auto_extension;
        use sqlite_vec::sqlite3_vec_init;
        unsafe {
            sqlite3_auto_extension(Some(std::mem::transmute(sqlite3_vec_init as *const ())));
        }
    });
}

/// Store 是应用的数据层入口（对应 memos.db，工作空间隔离）
///
/// 注意：setting 和 tool 表已移到 ConfigStore（app_config.db，跨工作空间共享）
pub struct Store {
    conn: Mutex<Connection>,
}

impl Store {
    /// 打开/创建数据库并执行迁移
    pub fn open<P: AsRef<Path>>(db_path: P) -> CoreResult<Self> {
        ensure_vec_extension_loaded();
        let conn = Connection::open(db_path)?;
        conn.execute("PRAGMA foreign_keys = ON", [])?;
        let mut conn_mut = conn;
        migration::run(&mut conn_mut)?;
        let conn = conn_mut;

        Ok(Self {
            conn: Mutex::new(conn),
        })
    }

    /// 内存数据库（用于测试与 placeholder 状态）
    pub fn open_in_memory() -> CoreResult<Self> {
        ensure_vec_extension_loaded();
        let conn = Connection::open_in_memory()?;
        let mut conn_mut = conn;
        migration::run(&mut conn_mut)?;
        let conn = conn_mut;

        Ok(Self {
            conn: Mutex::new(conn),
        })
    }

    /// 获取连接（锁住内部 Mutex）
    pub fn with_conn<F, T>(&self, f: F) -> CoreResult<T>
    where
        F: FnOnce(&Connection) -> CoreResult<T>,
    {
        let conn = self.conn.lock().expect("Mutex poisoned");
        f(&conn)
    }

    /// 获取可变连接（用于事务）
    pub fn with_conn_mut<F, T>(&self, f: F) -> CoreResult<T>
    where
        F: FnOnce(&mut Connection) -> CoreResult<T>,
    {
        let mut conn = self.conn.lock().expect("Mutex poisoned");
        f(&mut conn)
    }
}

/// 公开的连接锁方法（测试用）
impl Store {
    pub fn lock_conn(&self) -> std::sync::MutexGuard<'_, Connection> {
        self.conn.lock().expect("Mutex poisoned")
    }
}
```

- [ ] **Step 2: 暂时禁用所有引用 `store.setting` 的编译错误**

此步骤会触发大量编译错误（所有使用 `store.setting` 的代码）。此时不修复，留待 Phase 3 完成。运行 `cargo check` 确认错误数量：

Run:
```bash
cd d:/3-ai-project/LocalFragNote/src-tauri
cargo check 2>&1 | findstr /C:"error[" | find /C /V ""
```
Expected: 大量错误，记录错误数量用于后续追踪

- [ ] **Step 3: Commit（标记为 WIP）**

```bash
cd d:/3-ai-project/LocalFragNote
git add core/src/store.rs
git commit -m "refactor: remove setting field from Store (WIP, breaks compilation)"
```

---

### Task 6: 修改 tool.rs 函数签名

**Files:**
- Modify: `core/src/tool.rs`

- [ ] **Step 1: 修改 tool.rs 的函数签名**

将 `core/src/tool.rs` 中所有 `&Store` 参数改为 `&ConfigStore`，并将 `use crate::Store;` 改为 `use crate::ConfigStore;`。

具体替换（在每个函数签名中）：
- `pub fn list(store: &Store)` → `pub fn list(store: &ConfigStore)`
- `pub fn list_enabled(store: &Store)` → `pub fn list_enabled(store: &ConfigStore)`
- `pub fn get(store: &Store, id: &str)` → `pub fn get(store: &ConfigStore, id: &str)`
- `pub fn get_by_name(store: &Store, name: &str)` → `pub fn get_by_name(store: &ConfigStore, name: &str)`
- `pub fn create(store: &Store, mut tool: Tool)` → `pub fn create(store: &ConfigStore, mut tool: Tool)`
- `pub fn update(store: &Store, mut tool: Tool)` → `pub fn update(store: &ConfigStore, mut tool: Tool)`
- `pub fn delete(store: &Store, id: &str)` → `pub fn delete(store: &ConfigStore, id: &str)`
- `pub fn set_enabled(store: &Store, id: &str, enabled: bool)` → `pub fn set_enabled(store: &ConfigStore, id: &str, enabled: bool)`

同时修改文件顶部的 `use crate::Store;` 为 `use crate::ConfigStore;`

测试代码中的 `Store::open(":memory:")` 改为 `ConfigStore::open_in_memory()`，例如：
```rust
let store = ConfigStore::open_in_memory().unwrap();
```

- [ ] **Step 2: 运行 tool 模块测试**

Run:
```bash
cd d:/3-ai-project/LocalFragNote/core
cargo test --lib tool::tests
```
Expected: 所有 tool 测试通过（13 个）

- [ ] **Step 3: Commit**

```bash
cd d:/3-ai-project/LocalFragNote
git add core/src/tool.rs
git commit -m "refactor: change tool functions to use ConfigStore"
```

---

## Phase 2: WorkspaceRegistry 模块

### Task 7: 创建 WorkspaceRegistry

**Files:**
- Create: `src-tauri/src/workspace.rs`

- [ ] **Step 1: 创建 workspace.rs**

创建 `src-tauri/src/workspace.rs`：

```rust
//! 工作空间注册表：管理 workspaces.json 索引文件
//!
//! workspaces.json 存于引导目录（Tauri app_config_dir），
//! 记录所有工作空间列表和当前 active workspace。
//! 工作空间目录本身由用户选择，包含 memos.db 和 attachments/。

use crate::error::{IpcError, IpcResult};
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use uuid::Uuid;

/// 单个工作空间记录
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Workspace {
    /// `ws-` 前缀 + UUID v4
    pub id: String,
    /// 显示名（用户可改）
    pub name: String,
    /// 工作空间文件夹绝对路径
    pub path: PathBuf,
    /// 创建时间戳（Unix 秒）
    pub created_ts: i64,
}

/// workspaces.json 根结构
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WorkspaceRegistry {
    /// schema 版本号
    pub version: u32,
    /// 当前活动工作空间 ID（启动时加载该工作空间的 memos.db）
    pub active_workspace_id: Option<String>,
    /// 所有已注册工作空间
    pub workspaces: Vec<Workspace>,
}

impl Default for WorkspaceRegistry {
    fn default() -> Self {
        Self {
            version: 1,
            active_workspace_id: None,
            workspaces: Vec::new(),
        }
    }
}

/// 工作空间校验结果
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum WorkspaceStatus {
    Valid,
    /// 路径不存在
    PathNotFound,
    /// 路径不是目录
    PathNotDir,
    /// 路径不可写
    NotWritable,
}

impl WorkspaceRegistry {
    /// 从引导目录加载 workspaces.json
    ///
    /// 文件不存在或解析失败时返回空 registry（不报错，让用户从 WorkspacePicker 开始）
    pub fn load(config_dir: &Path) -> Self {
        let path = config_dir.join("workspaces.json");
        match std::fs::read_to_string(&path) {
            Ok(content) => match serde_json::from_str::<WorkspaceRegistry>(&content) {
                Ok(reg) => reg,
                Err(e) => {
                    tracing::warn!(
                        "workspaces.json 解析失败: {}，备份后重建空 registry",
                        e
                    );
                    // 备份损坏的文件
                    let backup = config_dir.join(format!(
                        "workspaces.json.corrupt.{}",
                        std::time::SystemTime::now()
                            .duration_since(std::time::UNIX_EPOCH)
                            .unwrap_or_default()
                            .as_secs()
                    ));
                    let _ = std::fs::rename(&path, &backup);
                    WorkspaceRegistry::default()
                }
            },
            Err(_) => {
                tracing::info!("workspaces.json 不存在，初始化空 registry");
                WorkspaceRegistry::default()
            }
        }
    }

    /// 原子保存到引导目录（.tmp + rename）
    pub fn save(&self, config_dir: &Path) -> IpcResult<()> {
        let path = config_dir.join("workspaces.json");
        let tmp_path = config_dir.join("workspaces.json.tmp");
        let content = serde_json::to_string_pretty(self)
            .map_err(|e| IpcError::Internal(format!("序列化 workspaces.json 失败: {e}")))?;
        std::fs::write(&tmp_path, content)
            .map_err(|e| IpcError::Internal(format!("写入 workspaces.json.tmp 失败: {e}")))?;
        std::fs::rename(&tmp_path, &path)
            .map_err(|e| IpcError::Internal(format!("rename workspaces.json 失败: {e}")))?;
        Ok(())
    }

    /// 添加新工作空间
    ///
    /// 自动设为 active（如果是第一个工作空间）
    pub fn add(&mut self, name: &str, path: PathBuf) -> &Workspace {
        let ws = Workspace {
            id: format!("ws-{}", Uuid::new_v4()),
            name: name.to_string(),
            path,
            created_ts: std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap_or_default()
                .as_secs() as i64,
        };
        if self.active_workspace_id.is_none() {
            self.active_workspace_id = Some(ws.id.clone());
        }
        self.workspaces.push(ws);
        self.workspaces.last().unwrap()
    }

    /// 删除工作空间（仅从注册表移除，不删除磁盘文件）
    pub fn remove(&mut self, id: &str) -> IpcResult<()> {
        let before = self.workspaces.len();
        self.workspaces.retain(|w| w.id != id);
        if self.workspaces.len() == before {
            return Err(IpcError::NotFound(format!("workspace {id}")));
        }
        // 若删除的是 active，重新选一个或清空
        if self.active_workspace_id.as_deref() == Some(id) {
            self.active_workspace_id = self.workspaces.first().map(|w| w.id.clone());
        }
        Ok(())
    }

    /// 重命名工作空间
    pub fn rename(&mut self, id: &str, new_name: &str) -> IpcResult<()> {
        let ws = self
            .workspaces
            .iter_mut()
            .find(|w| w.id == id)
            .ok_or_else(|| IpcError::NotFound(format!("workspace {id}")))?;
        ws.name = new_name.to_string();
        Ok(())
    }

    /// 设置 active workspace
    pub fn set_active(&mut self, id: &str) -> IpcResult<()> {
        if !self.workspaces.iter().any(|w| w.id == id) {
            return Err(IpcError::NotFound(format!("workspace {id}")));
        }
        self.active_workspace_id = Some(id.to_string());
        Ok(())
    }

    /// 获取 active workspace 引用
    pub fn get_active(&self) -> Option<&Workspace> {
        self.active_workspace_id
            .as_ref()
            .and_then(|id| self.workspaces.iter().find(|w| &w.id == id))
    }

    /// 按 id 查找工作空间
    pub fn get(&self, id: &str) -> Option<&Workspace> {
        self.workspaces.iter().find(|w| w.id == id)
    }

    /// 校验工作空间路径状态
    pub fn validate(path: &Path) -> WorkspaceStatus {
        if !path.exists() {
            return WorkspaceStatus::PathNotFound;
        }
        if !path.is_dir() {
            return WorkspaceStatus::PathNotDir;
        }
        // 测试可写：尝试创建一个临时文件
        let test_file = path.join(".workspace_write_test");
        match std::fs::File::create(&test_file) {
            Ok(_) => {
                let _ = std::fs::remove_file(&test_file);
                WorkspaceStatus::Valid
            }
            Err(_) => WorkspaceStatus::NotWritable,
        }
    }
}

/// AppState 中持有的 workspace registry 类型
pub type SharedWorkspaceRegistry = Mutex<WorkspaceRegistry>;

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    #[test]
    fn test_load_missing_file_returns_empty() {
        let tmp = TempDir::new().unwrap();
        let reg = WorkspaceRegistry::load(tmp.path());
        assert_eq!(reg.version, 1);
        assert!(reg.active_workspace_id.is_none());
        assert!(reg.workspaces.is_empty());
    }

    #[test]
    fn test_save_load_roundtrip() {
        let tmp = TempDir::new().unwrap();
        let mut reg = WorkspaceRegistry::default();
        reg.add("Test Workspace", tmp.path().join("ws1"));
        reg.save(tmp.path()).unwrap();

        let loaded = WorkspaceRegistry::load(tmp.path());
        assert_eq!(loaded.workspaces.len(), 1);
        assert_eq!(loaded.workspaces[0].name, "Test Workspace");
        assert_eq!(loaded.workspaces[0].path, tmp.path().join("ws1"));
        assert_eq!(
            loaded.active_workspace_id,
            Some(loaded.workspaces[0].id.clone())
        );
    }

    #[test]
    fn test_add_first_sets_active() {
        let mut reg = WorkspaceRegistry::default();
        let ws = reg.add("First", PathBuf::from("/tmp/ws1"));
        assert_eq!(reg.active_workspace_id, Some(ws.id.clone()));
    }

    #[test]
    fn test_add_second_does_not_change_active() {
        let mut reg = WorkspaceRegistry::default();
        let first = reg.add("First", PathBuf::from("/tmp/ws1")).clone();
        reg.add("Second", PathBuf::from("/tmp/ws2"));
        assert_eq!(reg.active_workspace_id, Some(first.id));
    }

    #[test]
    fn test_remove_active_selects_another() {
        let mut reg = WorkspaceRegistry::default();
        let first = reg.add("First", PathBuf::from("/tmp/ws1")).clone();
        reg.add("Second", PathBuf::from("/tmp/ws2"));
        reg.remove(&first.id).unwrap();
        assert!(reg.active_workspace_id.is_some());
        assert_ne!(reg.active_workspace_id, Some(first.id));
    }

    #[test]
    fn test_remove_last_clears_active() {
        let mut reg = WorkspaceRegistry::default();
        let ws = reg.add("Only", PathBuf::from("/tmp/ws1")).clone();
        reg.remove(&ws.id).unwrap();
        assert!(reg.active_workspace_id.is_none());
    }

    #[test]
    fn test_remove_nonexistent_returns_error() {
        let mut reg = WorkspaceRegistry::default();
        assert!(reg.remove("ws-nonexistent").is_err());
    }

    #[test]
    fn test_rename() {
        let mut reg = WorkspaceRegistry::default();
        let ws = reg.add("Old", PathBuf::from("/tmp/ws1")).clone();
        reg.rename(&ws.id, "New Name").unwrap();
        assert_eq!(reg.get(&ws.id).unwrap().name, "New Name");
    }

    #[test]
    fn test_set_active() {
        let mut reg = WorkspaceRegistry::default();
        let first = reg.add("First", PathBuf::from("/tmp/ws1")).clone();
        let second = reg.add("Second", PathBuf::from("/tmp/ws2")).clone();
        reg.set_active(&second.id).unwrap();
        assert_eq!(reg.active_workspace_id, Some(second.id));
        reg.set_active(&first.id).unwrap();
        assert_eq!(reg.active_workspace_id, Some(first.id));
    }

    #[test]
    fn test_set_active_nonexistent_returns_error() {
        let mut reg = WorkspaceRegistry::default();
        assert!(reg.set_active("ws-nonexistent").is_err());
    }

    #[test]
    fn test_validate_path_not_found() {
        let status = WorkspaceRegistry::validate(Path::new("/nonexistent/path/that/does/not/exist"));
        assert_eq!(status, WorkspaceStatus::PathNotFound);
    }

    #[test]
    fn test_validate_path_not_dir() {
        let tmp = TempDir::new().unwrap();
        let file_path = tmp.path().join("not_a_dir.txt");
        std::fs::write(&file_path, "hello").unwrap();
        let status = WorkspaceRegistry::validate(&file_path);
        assert_eq!(status, WorkspaceStatus::PathNotDir);
    }

    #[test]
    fn test_validate_valid_dir() {
        let tmp = TempDir::new().unwrap();
        let status = WorkspaceRegistry::validate(tmp.path());
        assert_eq!(status, WorkspaceStatus::Valid);
    }

    #[test]
    fn test_load_corrupt_json_backs_up_and_returns_empty() {
        let tmp = TempDir::new().unwrap();
        let path = tmp.path().join("workspaces.json");
        std::fs::write(&path, "{ invalid json").unwrap();
        let reg = WorkspaceRegistry::load(tmp.path());
        assert!(reg.workspaces.is_empty());
        // 备份文件应存在
        let entries = std::fs::read_dir(tmp.path()).unwrap();
        let has_backup = entries.filter_map(|e| e.ok()).any(|e| {
            e.file_name()
                .to_string_lossy()
                .starts_with("workspaces.json.corrupt.")
        });
        assert!(has_backup);
    }
}
```

- [ ] **Step 2: 添加 uuid 依赖（如尚未添加）**

检查 `src-tauri/Cargo.toml` 是否已有 uuid。若无，添加：

```toml
[dependencies]
uuid = { version = "1", features = ["v4"] }
```

检查 tempfile dev-dependency：

```toml
[dev-dependencies]
tempfile = "3"
```

- [ ] **Step 3: 在 lib.rs 中导出 workspace 模块**

修改 `src-tauri/src/lib.rs`，在 `pub mod ai;` 后添加：

```rust
pub mod workspace;
```

- [ ] **Step 4: 运行测试**

Run:
```bash
cd d:/3-ai-project/LocalFragNote/src-tauri
cargo test --lib workspace::tests
```
Expected: 13 tests passed

- [ ] **Step 5: Commit**

```bash
cd d:/3-ai-project/LocalFragNote
git add src-tauri/src/workspace.rs src-tauri/src/lib.rs src-tauri/Cargo.toml
git commit -m "feat: add WorkspaceRegistry module with json persistence"
```

---

## Phase 3: AppState 改造与启动流程

### Task 8: 修改 AppState 添加新字段

**Files:**
- Modify: `src-tauri/src/state.rs`

- [ ] **Step 1: 修改 state.rs**

替换 `src-tauri/src/state.rs` 的 AppState 结构体和 impl：

```rust
//! 应用状态：持有 Store（memos.db）、ConfigStore（app_config.db）、工作空间注册表

use crate::ai::pending_confirmations::PendingConfirmations;
use crate::lan::LanState;
use crate::llm_runner::LlmRunnerState;
use crate::mcp::McpState;
use crate::workspace::WorkspaceRegistry;
use memos_core::skill::Skill;
use memos_core::{ConfigStore, Store};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, RwLock};

pub struct AppState {
    /// memos.db（工作空间隔离）
    pub store: Mutex<Store>,
    /// app_config.db（共享配置）
    pub config_store: Mutex<ConfigStore>,
    /// 当前工作空间的附件目录（workspace.path/attachments）
    pub attachments_dir: PathBuf,
    /// 工作空间注册表（workspaces.json）
    pub workspace_registry: Mutex<WorkspaceRegistry>,
    /// 引导目录（Tauri app_config_dir），供 embedding/lan 等模块使用
    pub config_dir: PathBuf,
    /// LAN 模块运行时状态，支持在设置页里手动启停
    pub lan: RwLock<Option<Arc<LanState>>>,
    /// 本地 LLM 启动器运行时状态，支持在设置页里手动启停
    pub llm: RwLock<Option<Arc<LlmRunnerState>>>,
    /// 本地 MCP 服务器运行时状态，支持在设置页里手动启停
    pub mcp: RwLock<Option<Arc<McpState>>>,
    /// 内置 skill 缓存（启动时从 include_str! 解析，只读）
    pub builtin_skills: Vec<Skill>,
    /// 全局 shutdown 标志：app 退出时设为 true，后台任务据此提前终止
    pub shutdown: AtomicBool,
    /// 保证退出清理只执行一次，避免重复触发退出流程
    pub cleanup_started: AtomicBool,
    /// 用户工具确认通道（executable/dangerous 工具调用时需要前端确认）
    pub pending_confirmations: PendingConfirmations,
    /// AppHandle 副本，用于 emit 事件（agent_loop 等同步上下文需要）
    pub app_handle: tauri::AppHandle,
}

impl AppState {
    pub fn store(&self) -> std::sync::MutexGuard<'_, Store> {
        self.store.lock().expect("Store Mutex poisoned")
    }

    pub fn config_store(&self) -> std::sync::MutexGuard<'_, ConfigStore> {
        self.config_store.lock().expect("ConfigStore Mutex poisoned")
    }

    /// 获取 LanState，若未初始化则返回错误
    pub fn lan(&self) -> Result<Arc<LanState>, crate::error::IpcError> {
        self.lan
            .read()
            .expect("LAN RwLock poisoned")
            .clone()
            .ok_or_else(|| crate::error::IpcError::Lan("LAN module not initialized".into()))
    }

    /// 覆盖当前 LAN 运行时状态。
    pub fn set_lan(&self, lan: Option<Arc<LanState>>) {
        *self.lan.write().expect("LAN RwLock poisoned") = lan;
    }

    /// 取出当前 LAN 运行时状态并清空。
    pub fn take_lan(&self) -> Option<Arc<LanState>> {
        self.lan.write().expect("LAN RwLock poisoned").take()
    }

    /// 标记应用已进入退出清理阶段，返回 true 表示当前调用者负责执行清理。
    pub fn begin_shutdown(&self) -> bool {
        self.cleanup_started
            .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
            .is_ok()
    }

    /// 获取 app_handle 引用
    pub fn app_handle(&self) -> &tauri::AppHandle {
        &self.app_handle
    }

    /// 获取当前 active workspace 路径（用于附件路径解析）
    pub fn active_workspace_path(&self) -> Option<PathBuf> {
        let reg = self.workspace_registry.lock().expect("WorkspaceRegistry Mutex poisoned");
        reg.get_active().map(|ws| ws.path.clone())
    }
}
```

- [ ] **Step 2: 暂时不验证编译（等 main.rs 改造完再一起验证）**

- [ ] **Step 3: Commit（WIP）**

```bash
cd d:/3-ai-project/LocalFragNote
git add src-tauri/src/state.rs
git commit -m "refactor: add config_store, workspace_registry, config_dir to AppState (WIP)"
```

---

### Task 9: 修改 main.rs 启动流程

**Files:**
- Modify: `src-tauri/src/main.rs`

- [ ] **Step 1: 替换 setup 闭包**

修改 `src-tauri/src/main.rs` 的 `setup` 闭包。找到当前的 setup 闭包（从 `.setup(|app| {` 到对应的 `Ok(())` + `})`），替换为：

```rust
        .setup(|app| {
            tracing::info!(pid = current_pid(), "setup: begin");

            // 1. 计算引导目录（Tauri app_config_dir）
            use tauri::Manager;
            let config_dir = app
                .path()
                .app_config_dir()
                .expect("无法获取 app_config_dir");
            std::fs::create_dir_all(&config_dir).expect("无法创建引导目录");
            tracing::info!("引导目录: {}", config_dir.display());

            // 2. 打开 app_config.db（共享配置）
            let config_db_path = config_dir.join("app_config.db");
            tracing::info!("app_config.db 路径: {}", config_db_path.display());
            let config_store =
                memos_core::ConfigStore::open(&config_db_path).expect("无法打开 ConfigStore");

            // 3. 加载 WorkspaceRegistry
            let registry = crate::workspace::WorkspaceRegistry::load(&config_dir);
            let has_active = registry.get_active().is_some();
            let active_ws_path = registry.get_active().map(|ws| ws.path.clone());

            // 4. 根据 active workspace 状态决定如何初始化 AppState
            let (store, attachments_dir) = if has_active {
                let ws_path = active_ws_path.unwrap();
                let status = crate::workspace::WorkspaceRegistry::validate(&ws_path);
                if status != crate::workspace::WorkspaceStatus::Valid {
                    tracing::warn!("active workspace 路径无效: {:?}, status: {:?}", ws_path, status);
                    // placeholder
                    (memos_core::Store::open_in_memory().expect("无法创建 in-memory Store"), PathBuf::new())
                } else {
                    let db_path = ws_path.join("memos.db");
                    tracing::info!("工作空间 memos.db: {}", db_path.display());
                    let store = memos_core::Store::open(&db_path).expect("无法打开 Store");

                    // 从共享配置读取 storage_config，解析 attachments_dir
                    let storage_config =
                        crate::commands::setting::load_storage_config(&config_store);
                    let attachments_dir = if std::path::Path::new(&storage_config.local_storage_path).is_absolute() {
                        std::path::PathBuf::from(&storage_config.local_storage_path)
                    } else {
                        ws_path.join(&storage_config.local_storage_path)
                    };
                    std::fs::create_dir_all(&attachments_dir).expect("无法创建附件目录");
                    (store, attachments_dir)
                }
            } else {
                tracing::info!("无 active workspace，使用 placeholder AppState");
                (memos_core::Store::open_in_memory().expect("无法创建 in-memory Store"), std::path::PathBuf::new())
            };

            // 5. 注册 AppState
            app.manage(crate::state::AppState {
                store: std::sync::Mutex::new(store),
                config_store: std::sync::Mutex::new(config_store),
                attachments_dir,
                workspace_registry: std::sync::Mutex::new(registry),
                config_dir: config_dir.clone(),
                lan: std::sync::RwLock::new(None),
                llm: std::sync::RwLock::new(None),
                mcp: std::sync::RwLock::new(None),
                builtin_skills: crate::ai::builtin_skills::load_builtin_skills(),
                shutdown: std::sync::atomic::AtomicBool::new(false),
                cleanup_started: std::sync::atomic::AtomicBool::new(false),
                pending_confirmations: crate::ai::pending_confirmations::PendingConfirmations::new(),
                app_handle: app.handle().clone(),
            });

            // 6. 若无 active workspace，通知前端显示 WorkspacePicker
            if !has_active {
                tracing::info!("setup: 通知前端显示 WorkspacePicker");
                let app_handle = app.handle().clone();
                tauri::async_runtime::spawn(async move {
                    let _ = app_handle.emit("show_workspace_picker", ());
                });
            } else {
                // 7. 根据持久化设置决定是否启动 LAN/LLM/MCP（仅在有 active workspace 时）
                let lan_enabled = {
                    let state = app.state::<crate::state::AppState>();
                    let config_store = state.config_store();
                    lan::endpoint::load_enabled(&config_store)
                };
                if lan_enabled {
                    let app_handle = app.handle().clone();
                    tracing::info!("setup: 检测到 LAN 已启用，开始启动 LAN 模块");
                    let result = tauri::async_runtime::block_on(async {
                        lan::endpoint::start_lan_module(&app_handle).await
                    });
                    match result {
                        Ok(_) => tracing::info!("LAN 模块启动成功"),
                        Err(e) => tracing::warn!("LAN 模块启动失败（应用其他功能不受影响）: {}", e),
                    }
                }

                let llm_auto_start = {
                    let state = app.state::<crate::state::AppState>();
                    let config_store = state.config_store();
                    llm_runner::load_config(&config_store).auto_start
                };
                if llm_auto_start {
                    let app_handle = app.handle().clone();
                    tracing::info!("setup: 检测到 LLM 启动器配置 auto_start=true");
                    tauri::async_runtime::spawn(async move {
                        let runner = match commands::llm_runner::llm_start(app_handle.clone()).await {
                            Ok(r) => r,
                            Err(e) => {
                                tracing::warn!("LLM 服务启动失败: {}", e);
                                return;
                            }
                        };
                        tracing::info!(pid = current_pid(), running = runner.running, "LLM 服务启动完成");
                    });
                }

                let mcp_auto_start = {
                    let state = app.state::<crate::state::AppState>();
                    let config_store = state.config_store();
                    mcp::load_config(&config_store).auto_start
                };
                if mcp_auto_start {
                    let app_handle = app.handle().clone();
                    tracing::info!("setup: 检测到 MCP 配置 auto_start=true");
                    tauri::async_runtime::spawn(async move {
                        match commands::mcp::mcp_start(app_handle.clone()).await {
                            Ok(status) => {
                                tracing::info!(pid = current_pid(), running = status.running, "MCP 启动完成");
                            }
                            Err(e) => {
                                tracing::warn!("MCP 服务器启动失败: {}", e);
                            }
                        }
                    });
                }
            }

            tracing::info!(pid = current_pid(), "setup: end");
            Ok(())
        })
```

注意：需要添加 `use std::path::PathBuf;` 到 main.rs 顶部（若尚未导入）。

- [ ] **Step 2: 添加 tauri Event emit trait**

确保 main.rs 顶部有 `use tauri::Manager;` 和 `use tauri::Emitter;`（Emitter 用于 emit 事件）：

```rust
use tauri::{Manager, Emitter};
```

- [ ] **Step 3: 此时不验证编译（等其他模块改完再验证）**

- [ ] **Step 4: Commit（WIP）**

```bash
cd d:/3-ai-project/LocalFragNote
git add src-tauri/src/main.rs
git commit -m "refactor: rewrite main.rs setup to use config_dir and workspace registry (WIP)"
```

---

## Phase 4: 配置访问路径迁移

### Task 10: 修改 commands/setting.rs 走 config_store

**Files:**
- Modify: `src-tauri/src/commands/setting.rs`

- [ ] **Step 1: 修改 setting.rs**

替换 `src-tauri/src/commands/setting.rs` 的所有函数，将 `state.store()` 改为 `state.config_store()`。

关键改动：
1. `load_storage_config` 函数签名从 `store: &memos_core::Store` 改为 `config_store: &memos_core::ConfigStore`：

```rust
/// 从 app_config.db 读取存储配置
pub fn load_storage_config(config_store: &memos_core::ConfigStore) -> StorageConfig {
    let json: Option<String> = config_store
        .with_conn(|c| config_store.setting.app.get(c, STORAGE_CONFIG_KEY))
        .unwrap_or(None);
    json.as_deref()
        .and_then(|s| serde_json::from_str(s).ok())
        .unwrap_or_default()
}
```

2. 所有 `#[tauri::command]` 函数中 `let store = state.store();` 改为 `let store = state.config_store();`，其余不变（store.setting.app.upsert 等保持不变，因为 ConfigStore 也有 setting 字段）。

具体涉及的函数：
- `get_storage_config`
- `update_storage_config`
- `get_app_setting`
- `upsert_app_setting`
- `delete_app_setting`
- `get_instance_setting`
- `upsert_instance_setting`
- `delete_instance_setting`

`get_instance_stats` 函数中 `dir_size(&state.attachments_dir)` 保持不变（attachments_dir 仍来自 AppState）。

- [ ] **Step 2: Commit（WIP）**

```bash
cd d:/3-ai-project/LocalFragNote
git add src-tauri/src/commands/setting.rs
git commit -m "refactor: change setting commands to use config_store"
```

---

### Task 11: 修改 commands/tool.rs 走 config_store

**Files:**
- Modify: `src-tauri/src/commands/tool.rs`

- [ ] **Step 1: 修改 tool.rs**

打开 `src-tauri/src/commands/tool.rs`，将所有 `state.store()` 改为 `state.config_store()`，将 `memos_core::tool::*` 调用保持不变（因为 tool.rs 的函数签名已经改为接收 `&ConfigStore`）。

具体涉及的命令函数：
- `tool_list`
- `tool_create`
- `tool_update`
- `tool_delete`
- `tool_set_enabled`
- `tool_confirm_response`（不涉及 tool 表，无需改）

示例改动（以 `tool_list` 为例）：
```rust
#[tauri::command]
pub fn tool_list(state: tauri::State<'_, AppState>) -> IpcResult<Vec<Tool>> {
    let config_store = state.config_store();
    Ok(memos_core::tool::list(&config_store)?)
}
```

对其他函数做同样改动。

- [ ] **Step 2: Commit（WIP）**

```bash
cd d:/3-ai-project/LocalFragNote
git add src-tauri/src/commands/tool.rs
git commit -m "refactor: change tool commands to use config_store"
```

---

### Task 12: 修改 ai/provider.rs 走 config_store

**Files:**
- Modify: `src-tauri/src/ai/provider.rs`

- [ ] **Step 1: 读取并修改 provider.rs**

打开 `src-tauri/src/ai/provider.rs`，将所有 `state.store()` 改为 `state.config_store()`。

具体改动：所有 `load_providers`、`save_providers` 等函数中：
- `let store = state.store();` → `let store = state.config_store();`
- 调用 `memos_core::tool::*` 的地方保持不变（因为已改为接收 ConfigStore）

- [ ] **Step 2: Commit（WIP）**

```bash
cd d:/3-ai-project/LocalFragNote
git add src-tauri/src/ai/provider.rs
git commit -m "refactor: change ai provider to use config_store"
```

---

### Task 13: 修改 llm_runner/config.rs 走 config_store

**Files:**
- Modify: `src-tauri/src/llm_runner/config.rs`

- [ ] **Step 1: 修改 config.rs**

打开 `src-tauri/src/llm_runner/config.rs`，将 `load_config` 函数签名从 `store: &memos_core::Store` 改为 `config_store: &memos_core::ConfigStore`：

```rust
pub fn load_config(config_store: &memos_core::ConfigStore) -> LlmRunnerConfig {
    let json: Option<String> = config_store
        .with_conn(|c| config_store.setting.app.get(c, CONFIG_KEY))
        .unwrap_or(None);
    json.as_deref()
        .and_then(|s| serde_json::from_str(s).ok())
        .unwrap_or_default()
}

pub fn save_config(
    config_store: &memos_core::ConfigStore,
    config: &LlmRunnerConfig,
) -> CoreResult<()> {
    let json = serde_json::to_string(config)?;
    config_store.with_conn(|c| config_store.setting.app.upsert(c, CONFIG_KEY, &json))?;
    Ok(())
}
```

同时修改 `src-tauri/src/commands/llm_runner.rs` 中所有调用 `llm_runner::load_config(&store)` 的地方改为 `llm_runner::load_config(&config_store)`：

```rust
let config = {
    let state = ctx.app_handle().state::<AppState>();
    let config_store = state.config_store();
    llm_runner::load_config(&config_store)
};
```

- [ ] **Step 2: Commit（WIP）**

```bash
cd d:/3-ai-project/LocalFragNote
git add src-tauri/src/llm_runner/config.rs src-tauri/src/commands/llm_runner.rs
git commit -m "refactor: change llm_runner config to use config_store"
```

---

### Task 14: 修改 mcp/config.rs 走 config_store

**Files:**
- Modify: `src-tauri/src/mcp/config.rs`
- Modify: `src-tauri/src/commands/mcp.rs`

- [ ] **Step 1: 修改 mcp/config.rs**

将 `load_config` 和 `save_config` 函数签名从 `&memos_core::Store` 改为 `&memos_core::ConfigStore`：

```rust
pub fn load_config(config_store: &memos_core::ConfigStore) -> McpConfig {
    let json: Option<String> = config_store
        .with_conn(|c| config_store.setting.app.get(c, CONFIG_KEY))
        .unwrap_or(None);
    json.as_deref()
        .and_then(|s| serde_json::from_str(s).ok())
        .unwrap_or_default()
}

pub fn save_config(
    config_store: &memos_core::ConfigStore,
    config: &McpConfig,
) -> CoreResult<()> {
    let json = serde_json::to_string(config)?;
    config_store.with_conn(|c| config_store.setting.app.upsert(c, CONFIG_KEY, &json))?;
    Ok(())
}
```

- [ ] **Step 2: 修改 commands/mcp.rs**

将所有 `let store = state.store();` 改为 `let config_store = state.config_store();`，相应调用改为 `mcp::load_config(&config_store)` / `mcp::save_config(&config_store, ...)`。

- [ ] **Step 3: Commit（WIP）**

```bash
cd d:/3-ai-project/LocalFragNote
git add src-tauri/src/mcp/config.rs src-tauri/src/commands/mcp.rs
git commit -m "refactor: change mcp config to use config_store"
```

---

### Task 15: 修改 lan/endpoint.rs 走 config_store + config_dir

**Files:**
- Modify: `src-tauri/src/lan/endpoint.rs`

- [ ] **Step 1: 修改 endpoint.rs 的 load/save 函数**

将 `load_enabled`、`save_enabled`、`load_display_name`、`save_display_name`、`load_acl_rules`、`save_acl_rules` 函数签名从 `&Store` 改为 `&ConfigStore`：

```rust
pub fn load_enabled(config_store: &memos_core::ConfigStore) -> bool {
    config_store
        .with_conn(|c| config_store.setting.app.get(c, ENABLED_KEY))
        .ok()
        .flatten()
        .map(|v| v == "true")
        .unwrap_or(false)
}

pub fn save_enabled(config_store: &memos_core::ConfigStore, enabled: bool) -> CoreResult<()> {
    config_store.with_conn(|c| {
        config_store
            .setting
            .app
            .upsert(c, ENABLED_KEY, if enabled { "true" } else { "false" })
    })?;
    Ok(())
}
```

对其他 load/save 函数做同样改动。

- [ ] **Step 2: 修改 init_lan_state 接收 config_dir**

```rust
pub fn init_lan_state(config_dir: &Path) -> Result<LanState, String> {
    let key_path = config_dir.join("lan_identity.key");
    // ... 其余逻辑不变
}
```

移除 `dirs::home_dir().join("localFragNote")` 硬编码。

- [ ] **Step 3: 修改 start_lan_module 内部**

`start_lan_module` 内部目前重新推导 `data_dir`。改为从 AppState 获取 `config_dir`：

```rust
pub async fn start_lan_module(app_handle: &tauri::AppHandle) -> Result<(), String> {
    let state = app_handle.state::<AppState>();
    let config_dir = state.config_dir.clone();
    let lan_state = init_lan_state(&config_dir)?;
    // ... 其余逻辑不变
}
```

- [ ] **Step 4: 修改 commands/lan.rs**

将所有 `state.store()` 改为 `state.config_store()`：

```rust
let enabled = {
    let state = ctx.app_handle().state::<AppState>();
    let config_store = state.config_store();
    lan::endpoint::load_enabled(&config_store)
};
```

- [ ] **Step 5: Commit（WIP）**

```bash
cd d:/3-ai-project/LocalFragNote
git add src-tauri/src/lan/endpoint.rs src-tauri/src/commands/lan.rs
git commit -m "refactor: change lan endpoint to use config_store and config_dir"
```

---

### Task 16: 修改 embedding.rs 使用 config_dir

**Files:**
- Modify: `src-tauri/src/embedding.rs`

- [ ] **Step 1: 修改 model_dir 函数**

将 `model_dir()` 改为接收 `config_dir` 参数：

```rust
fn model_dir(config_dir: &Path) -> IpcResult<PathBuf> {
    let dir = config_dir.join("models").join("all-MiniLM-L6-v2");
    std::fs::create_dir_all(&dir)?;
    Ok(dir)
}

fn model_paths(config_dir: &Path) -> IpcResult<ModelPaths> {
    let dir = model_dir(config_dir)?;
    Ok(ModelPaths {
        model: dir.join("model.onnx"),
        tokenizer: dir.join("tokenizer.json"),
    })
}
```

移除 `dirs::home_dir().join("localFragNote")` 硬编码。

- [ ] **Step 2: 修改所有调用 model_dir/model_paths 的地方**

所有 IPC 命令中获取 config_dir：
```rust
let config_dir = state.config_dir.clone();
let paths = model_paths(&config_dir)?;
```

- [ ] **Step 3: Commit（WIP）**

```bash
cd d:/3-ai-project/LocalFragNote
git add src-tauri/src/embedding.rs
git commit -m "refactor: change embedding model_dir to use config_dir"
```

---

### Task 17: 修改 ai/tools.rs 中的 execute_user_tool 走 config_store

**Files:**
- Modify: `src-tauri/src/ai/tools.rs`

- [ ] **Step 1: 修改 execute_user_tool 函数**

将 `state.store()` 改为 `state.config_store()`，因为 tool 表现在在 app_config.db：

```rust
fn execute_user_tool(
    args: &serde_json::Value,
    state: &AppState,
) -> Result<String, String> {
    let name = args.get("name").and_then(|v| v.as_str())
        .ok_or("missing name")?;
    let command = args.get("command").and_then(|v| v.as_str())
        .ok_or("missing command")?;

    let config_store = state.config_store();
    let tool = memos_core::tool::get_by_name(&config_store, name)
        .map_err(|e| e.to_string())?
        .ok_or_else(|| format!("tool {name} not found"))?;
    // ... 其余逻辑不变
}
```

同样修改 `tool_definitions` 函数中读取用户工具列表的地方：
```rust
let config_store = state.config_store();
let user_tools = memos_core::tool::list_enabled(&config_store).unwrap_or_default();
```

- [ ] **Step 2: Commit（WIP）**

```bash
cd d:/3-ai-project/LocalFragNote
git add src-tauri/src/ai/tools.rs
git commit -m "refactor: change execute_user_tool to use config_store"
```

---

### Task 18: 修改 commands/skill.rs 走 config_store

**Files:**
- Modify: `src-tauri/src/commands/skill.rs`

- [ ] **Step 1: 修改 skill.rs**

打开 `src-tauri/src/commands/skill.rs`，将所有 `state.store()` 改为 `state.config_store()`。

注意：skill 表（V9__add_skill.sql）原本在 memos.db 中。需要决定是否移到 app_config.db。根据 spec，skill 不在共享列表中（spec 只列了 app_setting/instance_setting/tool），所以 skill **保留在 memos.db**（每工作空间独立）。

因此 skill 命令保持使用 `state.store()`，无需改动。

- [ ] **Step 2: 跳过此任务（skill 保留在 memos.db）**

无需修改，标记完成。

- [ ] **Step 3: Commit**

```bash
cd d:/3-ai-project/LocalFragNote
git commit --allow-empty -m "no-op: skill commands remain on memos.db (per-workspace)"
```

---

### Task 19: 修改 commands/attachment.rs 走 workspace path

**Files:**
- Modify: `src-tauri/src/commands/attachment.rs`

- [ ] **Step 1: 修改 attachment.rs**

`state.attachments_dir` 已经是 workspace.path/attachments（在 main.rs 启动时计算好），所以 attachment 命令基本无需改动。

但 `create_attachment` 中读取 storage_config 的地方需要改为 config_store：

```rust
let storage_config = {
    let config_store = state.config_store();
    crate::commands::setting::load_storage_config(&config_store)
};
```

- [ ] **Step 2: Commit（WIP）**

```bash
cd d:/3-ai-project/LocalFragNote
git add src-tauri/src/commands/attachment.rs
git commit -m "refactor: change attachment to read storage_config from config_store"
```

---

### Task 20: 验证整体编译

**Files:**
- 无修改，仅验证

- [ ] **Step 1: 运行 cargo check**

Run:
```bash
cd d:/3-ai-project/LocalFragNote/src-tauri
cargo check 2>&1 | tee check.log
```

- [ ] **Step 2: 修复剩余编译错误**

根据错误日志逐一修复。常见错误：
- `store.setting` → `config_store.setting`
- `state.store()` 用于 setting/tool → `state.config_store()`
- `Store::open(":memory:")` 在 tool 测试中 → `ConfigStore::open_in_memory()`

- [ ] **Step 3: 运行所有测试**

Run:
```bash
cd d:/3-ai-project/LocalFragNote/core
cargo test --lib
cd ../src-tauri
cargo test --lib
```
Expected: 所有测试通过

- [ ] **Step 4: Commit**

```bash
cd d:/3-ai-project/LocalFragNote
git add -A
git commit -m "fix: resolve all compilation errors after Store/ConfigStore split"
```

---

## Phase 5: 工作空间 IPC 命令

### Task 21: 创建 commands/workspace.rs

**Files:**
- Create: `src-tauri/src/commands/workspace.rs`
- Modify: `src-tauri/src/commands/mod.rs`
- Modify: `src-tauri/src/main.rs`

- [ ] **Step 1: 创建 commands/workspace.rs**

```rust
//! 工作空间管理 IPC 命令

use crate::error::{IpcError, IpcResult};
use crate::state::AppState;
use crate::workspace::{Workspace, WorkspaceStatus};
use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use tauri::Emitter;

#[derive(Debug, Serialize)]
pub struct WorkspaceInfo {
    pub id: String,
    pub name: String,
    pub path: String,
    pub created_ts: i64,
    pub is_active: bool,
    pub status: String,
}

fn status_str(status: &WorkspaceStatus) -> &'static str {
    match status {
        WorkspaceStatus::Valid => "valid",
        WorkspaceStatus::PathNotFound => "path_not_found",
        WorkspaceStatus::PathNotDir => "path_not_dir",
        WorkspaceStatus::NotWritable => "not_writable",
    }
}

/// 列出所有工作空间
#[tauri::command]
pub fn workspace_list(state: tauri::State<'_, AppState>) -> IpcResult<Vec<WorkspaceInfo>> {
    let reg = state
        .workspace_registry
        .lock()
        .expect("WorkspaceRegistry Mutex poisoned");
    let active_id = reg.active_workspace_id.clone();
    let result = reg
        .workspaces
        .iter()
        .map(|ws| WorkspaceInfo {
            id: ws.id.clone(),
            name: ws.name.clone(),
            path: ws.path.to_string_lossy().to_string(),
            created_ts: ws.created_ts,
            is_active: Some(ws.id.clone()) == active_id,
            status: status_str(&WorkspaceRegistry::validate(&ws.path)).to_string(),
        })
        .collect();
    Ok(result)
}

#[derive(Debug, Deserialize)]
pub struct CreateWorkspaceRequest {
    pub name: String,
    pub path: String,
}

/// 创建新工作空间
///
/// - 校验路径有效性
/// - 创建工作空间目录（若不存在）
/// - 初始化空 memos.db（跑迁移）
/// - 添加到 registry 并设为 active
/// - 保存 workspaces.json
#[tauri::command]
pub fn workspace_create(
    state: tauri::State<'_, AppState>,
    req: CreateWorkspaceRequest,
) -> IpcResult<WorkspaceInfo> {
    let path = PathBuf::from(&req.path);

    // 校验路径
    if path.exists() && !path.is_dir() {
        return Err(IpcError::BadRequest("路径已存在但不是目录".into()));
    }
    if !path.exists() {
        std::fs::create_dir_all(&path)
            .map_err(|e| IpcError::Internal(format!("创建工作空间目录失败: {e}")))?;
    }
    let status = WorkspaceStatus::validate(&path);
    if status != WorkspaceStatus::Valid {
        return Err(IpcError::BadRequest(format!(
            "工作空间路径无效: {:?}",
            status
        )));
    }

    // 初始化空 memos.db（跑迁移）
    let db_path = path.join("memos.db");
    if !db_path.exists() {
        memos_core::Store::open(&db_path)
            .map_err(|e| IpcError::Internal(format!("初始化 memos.db 失败: {e}")))?;
    }

    // 创建 attachments 目录
    let attachments_dir = path.join("attachments");
    std::fs::create_dir_all(&attachments_dir)
        .map_err(|e| IpcError::Internal(format!("创建 attachments 目录失败: {e}")))?;

    // 添加到 registry
    let config_dir = state.config_dir.clone();
    let mut reg = state
        .workspace_registry
        .lock()
        .expect("WorkspaceRegistry Mutex poisoned");
    let ws = reg.add(&req.name, path.clone());
    let ws_id = ws.id.clone();
    let ws_name = ws.name.clone();
    let ws_path = ws.path.clone();
    let ws_created = ws.created_ts;
    reg.save(&config_dir)?;

    Ok(WorkspaceInfo {
        id: ws_id,
        name: ws_name,
        path: ws_path.to_string_lossy().to_string(),
        created_ts: ws_created,
        is_active: reg.active_workspace_id == Some(reg.workspaces.last().unwrap().id.clone()),
        status: "valid".to_string(),
    })
}

/// 切换工作空间
///
/// 更新 active_workspace_id 并重启应用
#[tauri::command]
pub async fn workspace_switch(
    state: tauri::State<'_, AppState>,
    app_handle: tauri::AppHandle,
    id: String,
) -> IpcResult<()> {
    // 检查是否有运行中的 AI Agent 任务
    if crate::ai::agent_loop::is_any_running() {
        return Err(IpcError::BadRequest(
            "有正在执行的 AI 任务，请等待完成或中止后再切换".into(),
        ));
    }

    let config_dir = state.config_dir.clone();
    let mut reg = state
        .workspace_registry
        .lock()
        .expect("WorkspaceRegistry Mutex poisoned");

    // 校验目标工作空间
    let ws = reg
        .get(&id)
        .ok_or_else(|| IpcError::NotFound(format!("workspace {id}")))?
        .clone();

    let status = WorkspaceStatus::validate(&ws.path);
    if status != WorkspaceStatus::Valid {
        return Err(IpcError::BadRequest(format!(
            "工作空间路径无效: {:?}",
            status
        )));
    }

    reg.set_active(&id)?;
    reg.save(&config_dir)?;

    // 通知前端
    let _ = app_handle.emit("workspace_switching", ());

    // 重启应用
    std::thread::spawn(move || {
        std::thread::sleep(std::time::Duration::from_millis(500));
        app_handle.restart();
    });

    Ok(())
}

/// 重命名工作空间
#[tauri::command]
pub fn workspace_rename(
    state: tauri::State<'_, AppState>,
    id: String,
    new_name: String,
) -> IpcResult<()> {
    let config_dir = state.config_dir.clone();
    let mut reg = state
        .workspace_registry
        .lock()
        .expect("WorkspaceRegistry Mutex poisoned");
    reg.rename(&id, &new_name)?;
    reg.save(&config_dir)?;
    Ok(())
}

/// 删除工作空间（仅从注册表移除）
#[tauri::command]
pub fn workspace_delete(state: tauri::State<'_, AppState>, id: String) -> IpcResult<()> {
    let config_dir = state.config_dir.clone();
    let mut reg = state
        .workspace_registry
        .lock()
        .expect("WorkspaceRegistry Mutex poisoned");
    reg.remove(&id)?;
    reg.save(&config_dir)?;
    Ok(())
}

/// 在文件管理器中打开工作空间目录
#[tauri::command]
pub fn workspace_open_in_explorer(path: String) -> IpcResult<()> {
    #[cfg(target_os = "windows")]
    {
        std::process::Command::new("explorer")
            .arg(&path)
            .spawn()
            .map_err(|e| IpcError::Internal(format!("打开资源管理器失败: {e}")))?;
    }
    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("open")
            .arg(&path)
            .spawn()
            .map_err(|e| IpcError::Internal(format!("打开 Finder 失败: {e}")))?;
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        std::process::Command::new("xdg-open")
            .arg(&path)
            .spawn()
            .map_err(|e| IpcError::Internal(format!("打开文件管理器失败: {e}")))?;
    }
    Ok(())
}

use crate::workspace::WorkspaceRegistry;
```

- [ ] **Step 2: 在 commands/mod.rs 中添加模块**

修改 `src-tauri/src/commands/mod.rs`，添加：

```rust
pub mod workspace;
```

- [ ] **Step 3: 在 main.rs 中注册命令**

修改 `src-tauri/src/main.rs` 的 `invoke_handler`，在末尾添加：

```rust
            // workspace
            commands::workspace::workspace_list,
            commands::workspace::workspace_create,
            commands::workspace::workspace_switch,
            commands::workspace::workspace_rename,
            commands::workspace::workspace_delete,
            commands::workspace::workspace_open_in_explorer,
```

- [ ] **Step 4: 添加 agent_loop::is_any_running 函数**

检查 `src-tauri/src/ai/agent_loop.rs` 是否有 `is_any_running` 函数。若无，添加：

```rust
/// 检查是否有任何 agent_loop 正在运行
pub fn is_any_running() -> bool {
    // 使用静态 AtomicBool 跟踪
    RUNNING_COUNT.load(std::sync::atomic::Ordering::SeqCst) > 0
}
```

并在 agent_loop 模块顶部添加：
```rust
use std::sync::atomic::AtomicUsize;
static RUNNING_COUNT: AtomicUsize = AtomicUsize::new(0);
```

在 agent_loop 开始时 `RUNNING_COUNT.fetch_add(1, ...)`，结束时 `fetch_sub(1, ...)`。

- [ ] **Step 5: Commit**

```bash
cd d:/3-ai-project/LocalFragNote
git add src-tauri/src/commands/workspace.rs src-tauri/src/commands/mod.rs src-tauri/src/main.rs src-tauri/src/ai/agent_loop.rs
git commit -m "feat: add workspace IPC commands (list/create/switch/rename/delete)"
```

---

## Phase 6: 前端 UI

### Task 22: 创建前端类型与 hooks

**Files:**
- Create: `src/types/workspace.ts`
- Create: `src/hooks/useWorkspaceQueries.ts`

- [ ] **Step 1: 创建 workspace 类型**

创建 `src/types/workspace.ts`：

```typescript
export interface WorkspaceInfo {
  id: string;
  name: string;
  path: string;
  created_ts: number;
  is_active: boolean;
  status: "valid" | "path_not_found" | "path_not_dir" | "not_writable";
}

export interface CreateWorkspaceRequest {
  name: string;
  path: string;
}
```

- [ ] **Step 2: 创建 workspace hooks**

创建 `src/hooks/useWorkspaceQueries.ts`：

```typescript
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import type { CreateWorkspaceRequest, WorkspaceInfo } from "@/types/workspace";

const QUERY_KEY = ["workspaces"];

export function useWorkspaceList() {
  return useQuery<WorkspaceInfo[]>({
    queryKey: QUERY_KEY,
    queryFn: () => invoke<WorkspaceInfo[]>("workspace_list"),
  });
}

export function useCreateWorkspace() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (req: CreateWorkspaceRequest) =>
      invoke<WorkspaceInfo>("workspace_create", { req }),
    onSuccess: () => qc.invalidateQueries({ queryKey: QUERY_KEY }),
  });
}

export function useSwitchWorkspace() {
  return useMutation({
    mutationFn: (id: string) => invoke("workspace_switch", { id }),
  });
}

export function useRenameWorkspace() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, newName }: { id: string; newName: string }) =>
      invoke("workspace_rename", { id, newName }),
    onSuccess: () => qc.invalidateQueries({ queryKey: QUERY_KEY }),
  });
}

export function useDeleteWorkspace() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => invoke("workspace_delete", { id }),
    onSuccess: () => qc.invalidateQueries({ queryKey: QUERY_KEY }),
  });
}

export function useOpenInExplorer() {
  return useMutation({
    mutationFn: (path: string) => invoke("workspace_open_in_explorer", { path }),
  });
}

/// 选择文件夹对话框
export async function pickWorkspaceFolder(): Promise<string | null> {
  const selected = await open({
    directory: true,
    multiple: false,
    title: "选择工作空间目录",
  });
  return typeof selected === "string" ? selected : null;
}
```

- [ ] **Step 3: Commit**

```bash
cd d:/3-ai-project/LocalFragNote
git add src/types/workspace.ts src/hooks/useWorkspaceQueries.ts
git commit -m "feat: add workspace frontend types and hooks"
```

---

### Task 23: 创建 WorkspacePicker 页面

**Files:**
- Create: `src/components/WorkspacePicker/WorkspacePicker.tsx`
- Create: `src/components/WorkspacePicker/index.ts`
- Modify: `src/router.tsx`

- [ ] **Step 1: 创建 WorkspacePicker 组件**

创建 `src/components/WorkspacePicker/WorkspacePicker.tsx`：

```tsx
import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useToast } from "@/components/ui/use-toast";
import { useTranslate } from "@/utils/i18n";
import {
  useCreateWorkspace,
  useWorkspaceList,
  useSwitchWorkspace,
  pickWorkspaceFolder,
} from "@/hooks/useWorkspaceQueries";
import { ChevronRightIcon, FolderPlusIcon, FolderOpenIcon } from "lucide-react";

export function WorkspacePicker() {
  const t = useTranslate();
  const navigate = useNavigate();
  const { toast } = useToast();
  const { data: workspaces, isLoading } = useWorkspaceList();
  const createMutation = useCreateWorkspace();
  const switchMutation = useSwitchWorkspace();

  const [showCreate, setShowCreate] = useState(false);
  const [name, setName] = useState("");
  const [path, setPath] = useState("");

  const handlePickFolder = async () => {
    const picked = await pickWorkspaceFolder();
    if (picked) {
      setPath(picked);
      if (!name) {
        // 默认用文件夹名作为工作空间名
        const parts = picked.replace(/\\/g, "/").split("/").filter(Boolean);
        const folderName = parts[parts.length - 1] || "工作空间";
        setName(folderName);
      }
    }
  };

  const handleCreate = () => {
    if (!name.trim()) {
      toast({ title: t("workspace.picker.name"), variant: "destructive" });
      return;
    }
    if (!path.trim()) {
      toast({ title: t("workspace.picker.path"), variant: "destructive" });
      return;
    }
    createMutation.mutate(
      { name: name.trim(), path: path.trim() },
      {
        onSuccess: () => {
          toast({ title: t("common.success") });
          // 创建后切换到新工作空间（会重启应用）
          // 创建时已自动设为 active
          // 触发切换以重启
          switchMutation.mutate("");
        },
        onError: (e) => {
          toast({ title: String(e), variant: "destructive" });
        },
      }
    );
  };

  const handleSwitch = (id: string) => {
    switchMutation.mutate(id);
  };

  return (
    <div className="flex h-screen flex-col items-center justify-center gap-6 p-8">
      <div className="text-center">
        <h1 className="text-2xl font-semibold">{t("workspace.picker.title")}</h1>
        {workspaces && workspaces.length > 0 && (
          <p className="text-sm text-muted-foreground mt-2">
            {t("workspace.picker.title")}
          </p>
        )}
      </div>

      {workspaces && workspaces.length > 0 && (
        <div className="w-full max-w-md space-y-2">
          {workspaces.map((ws) => (
            <button
              key={ws.id}
              onClick={() => handleSwitch(ws.id)}
              className="w-full flex items-center justify-between p-3 rounded-lg border hover:bg-accent transition-colors"
              disabled={ws.status !== "valid"}
            >
              <div className="text-left">
                <div className="font-medium">{ws.name}</div>
                <div className="text-xs text-muted-foreground">{ws.path}</div>
              </div>
              <ChevronRightIcon className="size-4 opacity-50" />
            </button>
          ))}
        </div>
      )}

      {!showCreate && (
        <Button onClick={() => setShowCreate(true)} variant="outline">
          <FolderPlusIcon className="size-4 mr-2" />
          {t("workspace.picker.new")}
        </Button>
      )}

      {showCreate && (
        <div className="w-full max-w-md space-y-3 p-4 border rounded-lg">
          <h2 className="font-medium">{t("workspace.picker.new")}</h2>
          <div>
            <label className="text-sm text-muted-foreground block mb-1">
              {t("workspace.picker.name")}
            </label>
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={t("workspace.picker.name")}
            />
          </div>
          <div>
            <label className="text-sm text-muted-foreground block mb-1">
              {t("workspace.picker.path")}
            </label>
            <div className="flex gap-2">
              <Input
                value={path}
                onChange={(e) => setPath(e.target.value)}
                placeholder={t("workspace.picker.path")}
                readOnly
              />
              <Button type="button" variant="outline" onClick={handlePickFolder}>
                <FolderOpenIcon className="size-4" />
              </Button>
            </div>
          </div>
          <div className="flex gap-2 justify-end">
            <Button variant="ghost" onClick={() => setShowCreate(false)}>
              {t("common.cancel")}
            </Button>
            <Button
              onClick={handleCreate}
              disabled={createMutation.isPending || !name || !path}
            >
              {t("workspace.picker.create")}
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 2: 创建 index.ts**

```typescript
export { WorkspacePicker } from "./WorkspacePicker";
```

- [ ] **Step 3: 在 router.tsx 添加路由**

修改 `src/router.tsx`，在路由列表中添加：

```tsx
import { WorkspacePicker } from "@/components/WorkspacePicker";

// 在路由配置中添加
<Route path="/workspace-picker" element={<WorkspacePicker />} />
```

- [ ] **Step 4: 添加 show_workspace_picker 事件监听**

在 App 根组件（通常是 `src/App.tsx`）中添加事件监听：

```tsx
import { listen } from "@tauri-apps/api/event";
import { useNavigate } from "react-router-dom";

useEffect(() => {
  const unlisten = listen("show_workspace_picker", () => {
    navigate("/workspace-picker");
  });
  return () => {
    unlisten.then((fn) => fn());
  };
}, [navigate]);
```

- [ ] **Step 5: Commit**

```bash
cd d:/3-ai-project/LocalFragNote
git add src/components/WorkspacePicker/ src/router.tsx src/App.tsx
git commit -m "feat: add WorkspacePicker page with create/switch UI"
```

---

### Task 24: 创建 WorkspaceSwitcher 组件

**Files:**
- Create: `src/components/Navigation/WorkspaceSwitcher.tsx`
- Modify: `src/components/Navigation.tsx`

- [ ] **Step 1: 创建 WorkspaceSwitcher**

创建 `src/components/Navigation/WorkspaceSwitcher.tsx`：

```tsx
import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useToast } from "@/components/ui/use-toast";
import { useTranslate } from "@/utils/i18n";
import {
  useWorkspaceList,
  useSwitchWorkspace,
} from "@/hooks/useWorkspaceQueries";
import { CheckIcon, ChevronDownIcon, FolderIcon, PlusIcon, SettingsIcon } from "lucide-react";

export function WorkspaceSwitcher() {
  const t = useTranslate();
  const navigate = useNavigate();
  const { toast } = useToast();
  const { data: workspaces } = useWorkspaceList();
  const switchMutation = useSwitchWorkspace();
  const [switching, setSwitching] = useState(false);

  const activeWorkspace = workspaces?.find((ws) => ws.is_active);

  const handleSwitch = (id: string, name: string) => {
    setSwitching(true);
    switchMutation.mutate(id, {
      onSuccess: () => {
        toast({ title: t("workspace.switcher.switching") });
      },
      onError: (e) => {
        setSwitching(false);
        toast({ title: String(e), variant: "destructive" });
      },
    });
  };

  if (switching) {
    return (
      <div className="p-2 text-xs text-muted-foreground">
        {t("workspace.switcher.switching")}
      </div>
    );
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          className="w-full justify-between"
          disabled={!activeWorkspace}
        >
          <span className="flex items-center gap-2 truncate">
            <FolderIcon className="size-4 shrink-0" />
            <span className="truncate">
              {activeWorkspace?.name || t("workspace.picker.title")}
            </span>
          </span>
          <ChevronDownIcon className="size-4 opacity-50 shrink-0" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-64">
        {workspaces?.map((ws) => (
          <DropdownMenuItem
            key={ws.id}
            onClick={() => !ws.is_active && handleSwitch(ws.id, ws.name)}
            disabled={ws.status !== "valid"}
          >
            <div className="flex items-center justify-between w-full">
              <div className="flex flex-col">
                <span>{ws.name}</span>
                {ws.status !== "valid" && (
                  <span className="text-xs text-destructive">
                    {t(`workspace.settings.status${ws.status === "valid" ? "Valid" : "Invalid"}`)}
                  </span>
                )}
              </div>
              {ws.is_active && <CheckIcon className="size-4" />}
            </div>
          </DropdownMenuItem>
        ))}
        <DropdownMenuSeparator />
        <DropdownMenuItem onClick={() => navigate("/workspace-picker")}>
          <PlusIcon className="size-4 mr-2" />
          {t("workspace.switcher.new")}
        </DropdownMenuItem>
        <DropdownMenuItem onClick={() => navigate("/settings")}>
          <SettingsIcon className="size-4 mr-2" />
          {t("workspace.switcher.manage")}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
```

- [ ] **Step 2: 在 Navigation.tsx 中添加 WorkspaceSwitcher**

修改 `src/components/Navigation.tsx`，在 logo 下方、导航链接上方添加：

```tsx
import { WorkspaceSwitcher } from "./Navigation/WorkspaceSwitcher";

// 在 Navigation 组件 JSX 中
<div className="...">
  {/* Logo 区域 */}
  ...
  <div className="px-2 py-1">
    <WorkspaceSwitcher />
  </div>
  {/* 导航链接 */}
  ...
</div>
```

- [ ] **Step 3: Commit**

```bash
cd d:/3-ai-project/LocalFragNote
git add src/components/Navigation/WorkspaceSwitcher.tsx src/components/Navigation.tsx
git commit -m "feat: add WorkspaceSwitcher to sidebar"
```

---

### Task 25: 创建 WorkspaceSection 设置页

**Files:**
- Create: `src/components/Settings/WorkspaceSection.tsx`
- Modify: `src/components/Settings/index.tsx`

- [ ] **Step 1: 创建 WorkspaceSection**

创建 `src/components/Settings/WorkspaceSection.tsx`：

```tsx
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { useToast } from "@/components/ui/use-toast";
import { useTranslate } from "@/utils/i18n";
import {
  useWorkspaceList,
  useCreateWorkspace,
  useRenameWorkspace,
  useDeleteWorkspace,
  useSwitchWorkspace,
  useOpenInExplorer,
  pickWorkspaceFolder,
} from "@/hooks/useWorkspaceQueries";
import {
  FolderOpenIcon,
  PlusIcon,
  TrashIcon,
  PencilIcon,
  ExternalLinkIcon,
} from "lucide-react";

export function WorkspaceSection() {
  const t = useTranslate();
  const { toast } = useToast();
  const { data: workspaces } = useWorkspaceList();
  const createMutation = useCreateWorkspace();
  const renameMutation = useRenameWorkspace();
  const deleteMutation = useDeleteWorkspace();
  const switchMutation = useSwitchWorkspace();
  const openInExplorer = useOpenInExplorer();

  const [showCreate, setShowCreate] = useState(false);
  const [newName, setNewName] = useState("");
  const [newPath, setNewPath] = useState("");
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState("");

  const handlePickFolder = async () => {
    const picked = await pickWorkspaceFolder();
    if (picked) {
      setNewPath(picked);
      if (!newName) {
        const parts = picked.replace(/\\/g, "/").split("/").filter(Boolean);
        setNewName(parts[parts.length - 1] || "工作空间");
      }
    }
  };

  const handleCreate = () => {
    if (!newName.trim() || !newPath.trim()) return;
    createMutation.mutate(
      { name: newName.trim(), path: newPath.trim() },
      {
        onSuccess: () => {
          toast({ title: t("common.success") });
          setShowCreate(false);
          setNewName("");
          setNewPath("");
        },
        onError: (e) => toast({ title: String(e), variant: "destructive" }),
      }
    );
  };

  const handleRename = (id: string) => {
    if (!renameValue.trim()) return;
    renameMutation.mutate(
      { id, newName: renameValue.trim() },
      {
        onSuccess: () => {
          setRenamingId(null);
          toast({ title: t("common.success") });
        },
        onError: (e) => toast({ title: String(e), variant: "destructive" }),
      }
    );
  };

  const handleDelete = (id: string, name: string) => {
    if (!window.confirm(t("workspace.settings.deleteConfirm"))) return;
    deleteMutation.mutate(id, {
      onSuccess: () => toast({ title: t("common.success") }),
      onError: (e) => toast({ title: String(e), variant: "destructive" }),
    });
  };

  const handleSwitch = (id: string) => {
    switchMutation.mutate(id);
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-semibold">{t("workspace.settings.title")}</h2>
        <Button onClick={() => setShowCreate(!showCreate)} variant="outline" size="sm">
          <PlusIcon className="size-4 mr-2" />
          {t("workspace.settings.new")}
        </Button>
      </div>

      {showCreate && (
        <Card>
          <CardHeader>
            <CardTitle>{t("workspace.settings.new")}</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <div>
              <label className="text-sm text-muted-foreground block mb-1">
                {t("workspace.settings.name")}
              </label>
              <Input
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
              />
            </div>
            <div>
              <label className="text-sm text-muted-foreground block mb-1">
                {t("workspace.settings.path")}
              </label>
              <div className="flex gap-2">
                <Input value={newPath} onChange={(e) => setNewPath(e.target.value)} readOnly />
                <Button type="button" variant="outline" onClick={handlePickFolder}>
                  <FolderOpenIcon className="size-4" />
                </Button>
              </div>
            </div>
            <div className="flex gap-2 justify-end">
              <Button variant="ghost" onClick={() => setShowCreate(false)}>
                {t("common.cancel")}
              </Button>
              <Button
                onClick={handleCreate}
                disabled={createMutation.isPending || !newName || !newPath}
              >
                {t("common.create")}
              </Button>
            </div>
          </CardContent>
        </Card>
      )}

      <div className="space-y-2">
        {workspaces?.map((ws) => (
          <Card key={ws.id}>
            <CardContent className="p-4">
              <div className="flex items-start justify-between">
                <div className="space-y-1">
                  {renamingId === ws.id ? (
                    <div className="flex gap-2">
                      <Input
                        value={renameValue}
                        onChange={(e) => setRenameValue(e.target.value)}
                        className="w-48"
                      />
                      <Button
                        size="sm"
                        onClick={() => handleRename(ws.id)}
                      >
                        {t("common.save")}
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => setRenamingId(null)}
                      >
                        {t("common.cancel")}
                      </Button>
                    </div>
                  ) : (
                    <div className="font-medium flex items-center gap-2">
                      {ws.name}
                      {ws.is_active && (
                        <span className="text-xs bg-primary/10 text-primary px-2 py-0.5 rounded">
                          Active
                        </span>
                      )}
                    </div>
                  )}
                  <div className="text-xs text-muted-foreground">{ws.path}</div>
                  <div className="text-xs">
                    {t("workspace.settings.status")}:{" "}
                    <span className={ws.status === "valid" ? "text-green-600" : "text-red-600"}>
                      {t(`workspace.settings.status${ws.status === "valid" ? "Valid" : "Invalid"}`)}
                    </span>
                  </div>
                </div>
                <div className="flex gap-1">
                  {!ws.is_active && ws.status === "valid" && (
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => handleSwitch(ws.id)}
                      disabled={switchMutation.isPending}
                    >
                      {t("workspace.switcher.switch")}
                    </Button>
                  )}
                  <Button
                    size="icon"
                    variant="ghost"
                    onClick={() => {
                      setRenamingId(ws.id);
                      setRenameValue(ws.name);
                    }}
                  >
                    <PencilIcon className="size-4" />
                  </Button>
                  <Button
                    size="icon"
                    variant="ghost"
                    onClick={() => openInExplorer.mutate(ws.path)}
                  >
                    <ExternalLinkIcon className="size-4" />
                  </Button>
                  <Button
                    size="icon"
                    variant="ghost"
                    onClick={() => handleDelete(ws.id, ws.name)}
                  >
                    <TrashIcon className="size-4 text-destructive" />
                  </Button>
                </div>
              </div>
            </CardContent>
          </Card>
        ))}
      </div>
    </div>
  );
}
```

- [ ] **Step 2: 在 Settings/index.tsx 中添加 WorkspaceSection**

修改 `src/components/Settings/index.tsx`，在合适位置（通常在顶部或"通用"区域附近）添加：

```tsx
import { WorkspaceSection } from "./WorkspaceSection";

// 在 Settings 页面 JSX 中
<WorkspaceSection />
```

- [ ] **Step 3: Commit**

```bash
cd d:/3-ai-project/LocalFragNote
git add src/components/Settings/WorkspaceSection.tsx src/components/Settings/index.tsx
git commit -m "feat: add WorkspaceSection to settings page"
```

---

### Task 26: 添加 i18n 键

**Files:**
- Modify: `src/locales/zh-Hans.json`
- Modify: `src/locales/en.json`

- [ ] **Step 1: 在 zh-Hans.json 添加 workspace 键**

在 `src/locales/zh-Hans.json` 顶层添加 `workspace` 对象：

```json
{
  "workspace": {
    "picker": {
      "title": "选择工作空间",
      "empty": "还没有工作空间，请新建一个开始",
      "new": "新建工作空间",
      "open": "打开现有文件夹",
      "name": "工作空间名称",
      "path": "路径",
      "create": "创建",
      "selectFolder": "选择文件夹"
    },
    "switcher": {
      "switching": "正在切换工作空间...",
      "switch": "切换到工作空间",
      "manage": "管理工作空间",
      "new": "新建工作空间"
    },
    "settings": {
      "title": "工作空间",
      "name": "名称",
      "path": "路径",
      "status": "状态",
      "statusValid": "有效",
      "statusInvalid": "无效",
      "rename": "重命名",
      "openInExplorer": "在文件管理器中打开",
      "delete": "删除",
      "deleteConfirm": "删除工作空间将仅从列表中移除，不会删除磁盘文件。确定继续吗？",
      "new": "新建工作空间"
    }
  },
  ...其他现有键
}
```

- [ ] **Step 2: 在 en.json 添加对应英文键**

```json
{
  "workspace": {
    "picker": {
      "title": "Select Workspace",
      "empty": "No workspaces yet. Create one to get started.",
      "new": "New Workspace",
      "open": "Open Existing Folder",
      "name": "Workspace Name",
      "path": "Path",
      "create": "Create",
      "selectFolder": "Select Folder"
    },
    "switcher": {
      "switching": "Switching workspace...",
      "switch": "Switch to workspace",
      "manage": "Manage workspaces",
      "new": "New Workspace"
    },
    "settings": {
      "title": "Workspaces",
      "name": "Name",
      "path": "Path",
      "status": "Status",
      "statusValid": "Valid",
      "statusInvalid": "Invalid",
      "rename": "Rename",
      "openInExplorer": "Open in File Explorer",
      "delete": "Delete",
      "deleteConfirm": "Removing the workspace only removes it from the list. Disk files will not be deleted. Continue?",
      "new": "New Workspace"
    }
  },
  ...other existing keys
}
```

- [ ] **Step 3: Commit**

```bash
cd d:/3-ai-project/LocalFragNote
git add src/locales/zh-Hans.json src/locales/en.json
git commit -m "feat: add workspace i18n keys"
```

---

## Phase 7: 最终验证

### Task 27: 整体编译验证

**Files:**
- 无修改，仅验证

- [ ] **Step 1: 运行 Rust 编译检查**

Run:
```bash
cd d:/3-ai-project/LocalFragNote/src-tauri
cargo check 2>&1 | tee check.log
```
Expected: 0 errors

- [ ] **Step 2: 运行所有 Rust 测试**

Run:
```bash
cd d:/3-ai-project/LocalFragNote/core
cargo test --lib
cd ../src-tauri
cargo test --lib
```
Expected: 所有测试通过

- [ ] **Step 3: 运行前端 TypeScript 检查**

Run:
```bash
cd d:/3-ai-project/LocalFragNote
npx tsc --noEmit
```
Expected: 0 errors

- [ ] **Step 4: 运行前端构建**

Run:
```bash
cd d:/3-ai-project/LocalFragNote
npm run build
```
Expected: 构建成功

- [ ] **Step 5: 手动启动应用验证**

Run:
```bash
cd d:/3-ai-project/LocalFragNote/src-tauri
cargo tauri dev
```

验证清单：
- [ ] 首次启动应显示 WorkspacePicker
- [ ] 创建新工作空间后应用重启
- [ ] 重启后进入主界面
- [ ] 侧边栏顶部显示 WorkspaceSwitcher
- [ ] 设置页显示 WorkspaceSection
- [ ] 创建笔记正常
- [ ] 上传附件正常
- [ ] AI 聊天正常
- [ ] 切换工作空间后重启加载新工作空间数据

- [ ] **Step 6: Commit**

```bash
cd d:/3-ai-project/LocalFragNote
git add -A
git commit -m "test: verify full build and tests pass"
```

---

## Self-Review

### Spec 覆盖检查

| Spec 要求 | 实现任务 |
|---|---|
| 引导目录结构 | Task 9 (main.rs setup) |
| 工作空间目录结构 | Task 21 (workspace_create 初始化 memos.db + attachments) |
| workspaces.json 数据结构 | Task 7 (WorkspaceRegistry) |
| 工作空间校验规则 | Task 7 (validate 函数) |
| 并发与原子写入 | Task 7 (save 使用 .tmp + rename) |
| 数据库拆分（app_config.db） | Task 1, 3, 4 |
| memos.db V11 删表 | Task 2 |
| storage_config 路径解析 | Task 9 (main.rs setup), Task 10 (setting.rs) |
| 旧用户首次启动 | Task 9 (无 active → placeholder + WorkspacePicker) |
| Store 拆分 | Task 5 (移除 setting), Task 6 (tool.rs 签名) |
| AppState 改造 | Task 8 |
| main.rs 启动流程 | Task 9 |
| embedding.rs 改造 | Task 16 |
| lan/endpoint.rs 改造 | Task 15 |
| commands/setting.rs 改造 | Task 10 |
| commands/attachment.rs 改造 | Task 19 |
| commands/tool.rs 改造 | Task 11 |
| ai/provider.rs 改造 | Task 12 |
| llm_runner/config.rs 改造 | Task 13 |
| mcp/config.rs 改造 | Task 14 |
| ai/tools.rs 改造 | Task 17 |
| WorkspaceRegistry 模块 | Task 7 |
| 工作空间切换流程 | Task 21 (workspace_switch) |
| WorkspacePicker 页面 | Task 23 |
| 侧边栏 WorkspaceSwitcher | Task 24 |
| 设置页 WorkspaceSection | Task 25 |
| i18n 键 | Task 26 |
| 错误处理（active 无效） | Task 9 (placeholder + show_workspace_picker) |
| 错误处理（路径被删除） | Task 7 (validate) |
| 错误处理（workspaces.json 损坏） | Task 7 (load 备份并重建) |
| 错误处理（切换时 AI 任务运行中） | Task 21 (is_any_running 检查) |

### Placeholder 扫描

- 无 "TBD"、"TODO" 占位符
- 每个 step 都有完整代码或具体命令

### Type 一致性检查

- `WorkspaceRegistry` 在 Task 7 定义，Task 8/9/21 使用，字段名一致
- `ConfigStore` 在 Task 4 定义，Task 5/6/10-17 使用，方法名一致
- `WorkspaceInfo` 在 Task 21 定义，Task 22-25 使用，字段名一致
- `WorkspaceStatus` 枚举值在 Task 7 定义，Task 21 使用，一致

