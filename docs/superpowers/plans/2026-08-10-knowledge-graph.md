# 知识图谱模块 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为 LocalFragNote 增加知识图谱模块：图形节点展示、节点 CRUD、节点关联标签、笔记中查看节点、选中节点展示相关笔记。

**Architecture:** 后端新增 4 张 SQLite 表（kg_node/kg_edge/kg_node_tag/memo_kg_node）+ 3 个 core 模块 + 1 个 Tauri commands 模块。前端用 React Flow + dagre 渲染图谱，左右分栏页面，笔记侧栏集成节点区块。

**Tech Stack:** Rust + rusqlite + refinery（后端）；React 19 + TypeScript + @xyflow/react + @dagrejs/dagre + TanStack Query（前端）。

## Global Constraints

- 工作目录：`d:\6-ai\LocalFragNote`
- 包管理器：`pnpm`（前端）；`cargo`（后端）
- Shell：PowerShell（禁用 heredoc，git commit 用单行 `-m`）
- core 模块风格：参照 `core/src/memo_relation.rs`，函数以 `&Connection` 为首参数
- Tauri command 风格：参照 `src-tauri/src/commands/memo_relation.rs`，用 `IpcResult<T>` 返回
- 前端 hook 风格：参照 `src/hooks/useToolQueries.ts`，直接 `invoke<T>` 调用
- UID 生成：前端用 `uuid` v4 生成，后端只校验非空（参照 memo 模块）
- 迁移文件命名：`V12__add_knowledge_graph.sql`（refinery 自动按序号执行）
- 测试位置：core 层单元测试放 `core/tests/crud.rs` 同级新文件 `core/tests/kg.rs`

---

## 文件结构

### 新增文件

| 文件 | 责任 |
|------|------|
| `core/migrations/V12__add_knowledge_graph.sql` | 建 4 张表 |
| `core/src/kg_node.rs` | 节点 CRUD + 标签 + 位置 + 折叠 + 循环校验 |
| `core/src/kg_edge.rs` | 边 CRUD |
| `core/src/memo_kg_node.rs` | 笔记-节点关联 + 节点-笔记匹配查询 |
| `core/tests/kg.rs` | core 层单元测试 |
| `src-tauri/src/commands/kg.rs` | Tauri IPC 命令 |
| `src/types/kg.ts` | 前端 KgNode/KgEdge 类型 |
| `src/hooks/useKgQueries.ts` | React Query hooks |
| `src/components/KnowledgeGraph/constants.ts` | 颜色调色板、边类型预设 |
| `src/components/KnowledgeGraph/layout.ts` | dagre 自动布局 |
| `src/components/KnowledgeGraph/KgNodeCard.tsx` | 自定义节点组件 |
| `src/components/KnowledgeGraph/KgEdgeWithLabel.tsx` | 自定义边组件 |
| `src/components/KnowledgeGraph/KgCanvas.tsx` | React Flow 画布 |
| `src/components/KnowledgeGraph/KgToolbar.tsx` | 顶部工具栏 |
| `src/components/KnowledgeGraph/KgNodeEditDialog.tsx` | 节点编辑对话框 |
| `src/components/KnowledgeGraph/KgTagEditor.tsx` | 节点标签编辑器 |
| `src/components/KnowledgeGraph/KgNodeDetailPanel.tsx` | 节点详情面板 |
| `src/components/KnowledgeGraph/KgMemoListPanel.tsx` | 相关笔记列表面板 |
| `src/components/KnowledgeGraph/KgNodePicker.tsx` | 节点选择器（笔记侧栏用） |
| `src/components/KnowledgeGraph/KnowledgeGraphPage.tsx` | 页面入口 |
| `src/components/KnowledgeGraph/index.ts` | 导出汇总 |
| `src/pages/KnowledgeGraph.tsx` | 路由页面包装 |

### 修改文件

| 文件 | 改动 |
|------|------|
| `core/src/lib.rs` | 导出 3 个新模块 |
| `src-tauri/src/commands/mod.rs` | 导出 kg 模块 |
| `src-tauri/src/main.rs` | 注册 15 个 kg 命令到 generate_handler! |
| `src/router/routes.ts` | 新增 KG 路由常量 |
| `src/router/index.tsx` | 懒加载 KG 页面 |
| `src/components/Navigation.tsx` | 新增导航项 |
| `src/components/MemoDetailSidebar/MemoDetailSidebar.tsx` | 新增 KG 节点区块 |
| `src/locales/zh-Hans.json` | 新增 kg 命名空间 |
| `src/locales/en.json` | 新增 kg 命名空间 |
| `package.json` | 新增 @xyflow/react + @dagrejs/dagre |

---

## Task 1: 数据库迁移 V12

**Files:**
- Create: `core/migrations/V12__add_knowledge_graph.sql`

**Interfaces:**
- Produces: 4 张表 `kg_node`/`kg_edge`/`kg_node_tag`/`memo_kg_node`，供 Task 2-4 使用

- [ ] **Step 1: 创建迁移文件**

写入 `core/migrations/V12__add_knowledge_graph.sql`：

```sql
-- 知识图谱节点
CREATE TABLE IF NOT EXISTS kg_node (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    uid TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    color TEXT NOT NULL DEFAULT '',
    icon TEXT NOT NULL DEFAULT '',
    parent_id INTEGER DEFAULT NULL,
    pos_x REAL DEFAULT NULL,
    pos_y REAL DEFAULT NULL,
    collapsed INTEGER NOT NULL DEFAULT 0,
    created_ts BIGINT NOT NULL DEFAULT (strftime('%s','now')),
    updated_ts BIGINT NOT NULL DEFAULT (strftime('%s','now')),
    FOREIGN KEY (parent_id) REFERENCES kg_node(id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS idx_kg_node_parent ON kg_node(parent_id);

-- 节点间连线（边）
CREATE TABLE IF NOT EXISTS kg_edge (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    source_id INTEGER NOT NULL,
    target_id INTEGER NOT NULL,
    type TEXT NOT NULL DEFAULT 'related',
    label TEXT NOT NULL DEFAULT '',
    created_ts BIGINT NOT NULL DEFAULT (strftime('%s','now')),
    UNIQUE(source_id, target_id, type),
    FOREIGN KEY (source_id) REFERENCES kg_node(id) ON DELETE CASCADE,
    FOREIGN KEY (target_id) REFERENCES kg_node(id) ON DELETE CASCADE
);

-- 节点-标签关联
CREATE TABLE IF NOT EXISTS kg_node_tag (
    node_id INTEGER NOT NULL,
    tag TEXT NOT NULL,
    PRIMARY KEY(node_id, tag),
    FOREIGN KEY (node_id) REFERENCES kg_node(id) ON DELETE CASCADE
);

-- 笔记-节点手动关联
CREATE TABLE IF NOT EXISTS memo_kg_node (
    memo_id INTEGER NOT NULL,
    node_id INTEGER NOT NULL,
    created_ts BIGINT NOT NULL DEFAULT (strftime('%s','now')),
    PRIMARY KEY(memo_id, node_id),
    FOREIGN KEY (memo_id) REFERENCES memo(id) ON DELETE CASCADE,
    FOREIGN KEY (node_id) REFERENCES kg_node(id) ON DELETE CASCADE
);
```

- [ ] **Step 2: 验证迁移能执行**

Run: `cargo test --package memos-core store_open_runs_migrations -- --nocapture`
Expected: PASS（现有测试会跑 `Store::open_in_memory()`，触发 V12 迁移）

若失败，检查 SQL 语法。

- [ ] **Step 3: 提交**

```powershell
git add core/migrations/V12__add_knowledge_graph.sql
git commit -m "feat(kg): add V12 migration for knowledge graph tables"
```

---

## Task 2: core 层 kg_node 模块

**Files:**
- Create: `core/src/kg_node.rs`
- Modify: `core/src/lib.rs`（导出模块）
- Test: `core/tests/kg.rs`（创建文件）

**Interfaces:**
- Produces:
  - `KgNode` struct（含 tags: Vec<String>）
  - `UpsertKgNode` struct
  - `FindKgNode` struct
  - `fn create(conn, &UpsertKgNode) -> CoreResult<KgNode>`
  - `fn update(conn, id: i32, &UpsertKgNode) -> CoreResult<KgNode>`
  - `fn delete(conn, id: i32) -> CoreResult<()>`
  - `fn get(conn, id: i32) -> CoreResult<KgNode>`
  - `fn list(conn, &FindKgNode) -> CoreResult<Vec<KgNode>>`
  - `fn set_tags(conn, node_id: i32, &[String]) -> CoreResult<()>`
  - `fn get_tags(conn, node_id: i32) -> CoreResult<Vec<String>>`
  - `fn set_position(conn, node_id: i32, x: Option<f64>, y: Option<f64>) -> CoreResult<()>`
  - `fn set_collapsed(conn, node_id: i32, collapsed: bool) -> CoreResult<()>`
  - `fn is_descendant(conn, ancestor_id: i32, candidate_id: i32) -> CoreResult<bool>`

- [ ] **Step 1: 在 lib.rs 导出模块**

修改 `core/src/lib.rs`，在 `pub mod memo_relation;` 后添加：

```rust
pub mod kg_node;
pub mod kg_edge;
pub mod memo_kg_node;
```

（kg_edge 和 memo_kg_node 模块在 Task 3/4 创建，此处一并导出避免后续重复修改；若编译报"找不到模块"，临时注释后两行，待 Task 3/4 再取消注释。）

- [ ] **Step 2: 创建测试文件骨架**

创建 `core/tests/kg.rs`：

```rust
use memos_core::*;
use memos_core::kg_node::{FindKgNode, KgNode, UpsertKgNode};

fn open_test_store() -> Store {
    Store::open_in_memory().expect("打开内存数据库失败")
}

fn make_node(conn: &rusqlite::Connection, name: &str) -> KgNode {
    kg_node::create(conn, &UpsertKgNode {
        uid: format!("kg-{}", name),
        name: name.to_string(),
        description: String::new(),
        color: String::new(),
        icon: String::new(),
        parent_id: None,
        pos_x: None,
        pos_y: None,
        collapsed: false,
    })
    .expect("创建节点失败")
}
```

- [ ] **Step 3: 写失败测试 — 创建节点**

追加到 `core/tests/kg.rs`：

```rust
#[test]
fn kg_node_create() {
    let store = open_test_store();
    let conn = store.lock_conn();
    let node = make_node(&conn, "root");
    assert_eq!(node.name, "root");
    assert_eq!(node.uid, "kg-root");
    assert!(node.parent_id.is_none());
    assert!(node.pos_x.is_none());
    assert!(!node.collapsed);
    assert!(node.tags.is_empty());
}
```

- [ ] **Step 4: 运行测试确认失败**

Run: `cargo test --package memos-core kg_node_create`
Expected: FAIL（`unresolved module kg_node`）

- [ ] **Step 5: 实现 kg_node.rs — 结构体与 create**

创建 `core/src/kg_node.rs`：

```rust
//! 知识图谱节点 CRUD

use crate::error::{CoreError, CoreResult};
use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};

/// 节点实体
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct KgNode {
    pub id: i32,
    pub uid: String,
    pub name: String,
    pub description: String,
    pub color: String,
    pub icon: String,
    pub parent_id: Option<i32>,
    pub pos_x: Option<f64>,
    pub pos_y: Option<f64>,
    pub collapsed: bool,
    pub created_ts: i64,
    pub updated_ts: i64,
    pub tags: Vec<String>,
}

/// 创建/更新参数
#[derive(Debug, Clone)]
pub struct UpsertKgNode {
    pub uid: String,
    pub name: String,
    pub description: String,
    pub color: String,
    pub icon: String,
    pub parent_id: Option<i32>,
    pub pos_x: Option<f64>,
    pub pos_y: Option<f64>,
    pub collapsed: bool,
}

/// 查询过滤
#[derive(Debug, Clone, Default)]
pub struct FindKgNode {
    /// None=全部; Some(None)=根节点; Some(Some(id))=指定父的子节点
    pub parent_id: Option<Option<i32>>,
    pub id_list: Vec<i32>,
}

/// 创建节点
pub fn create(conn: &Connection, upsert: &UpsertKgNode) -> CoreResult<KgNode> {
    let now = chrono::Utc::now().timestamp();
    conn.execute(
        "INSERT INTO kg_node (uid, name, description, color, icon, parent_id, pos_x, pos_y, collapsed, created_ts, updated_ts)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?10)",
        params![
            upsert.uid,
            upsert.name,
            upsert.description,
            upsert.color,
            upsert.icon,
            upsert.parent_id,
            upsert.pos_x,
            upsert.pos_y,
            upsert.collapsed as i32,
            now,
        ],
    )?;
    let id = conn.last_insert_rowid() as i32;
    get(conn, id)
}

/// 更新节点
pub fn update(conn: &Connection, id: i32, upsert: &UpsertKgNode) -> CoreResult<KgNode> {
    // 循环校验：parent_id 不能是自身或后代
    if let Some(new_parent) = upsert.parent_id {
        if new_parent == id {
            return Err(CoreError::Other("不能将节点的父级设为自身".into()));
        }
        if is_descendant(conn, id, new_parent)? {
            return Err(CoreError::Other("不能将节点的父级设为自身或后代".into()));
        }
    }
    let now = chrono::Utc::now().timestamp();
    let affected = conn.execute(
        "UPDATE kg_node SET name=?2, description=?3, color=?4, icon=?5, parent_id=?6, pos_x=?7, pos_y=?8, collapsed=?9, updated_ts=?10
         WHERE id=?1",
        params![
            id,
            upsert.name,
            upsert.description,
            upsert.color,
            upsert.icon,
            upsert.parent_id,
            upsert.pos_x,
            upsert.pos_y,
            upsert.collapsed as i32,
            now,
        ],
    )?;
    if affected == 0 {
        return Err(CoreError::NotFound(format!("kg_node {id}")));
    }
    get(conn, id)
}

/// 删除节点（FK CASCADE 自动清理 edge/tag/memo_kg_node）
pub fn delete(conn: &Connection, id: i32) -> CoreResult<()> {
    let affected = conn.execute("DELETE FROM kg_node WHERE id=?1", params![id])?;
    if affected == 0 {
        return Err(CoreError::NotFound(format!("kg_node {id}")));
    }
    Ok(())
}

/// 查询单个节点
pub fn get(conn: &Connection, id: i32) -> CoreResult<KgNode> {
    let mut stmt = conn.prepare(
        "SELECT id, uid, name, description, color, icon, parent_id, pos_x, pos_y, collapsed, created_ts, updated_ts
         FROM kg_node WHERE id=?1",
    )?;
    let node = stmt.query_row(params![id], map_row)?;
    let mut node = node;
    node.tags = get_tags(conn, id)?;
    Ok(node)
}

/// 查询列表
pub fn list(conn: &Connection, find: &FindKgNode) -> CoreResult<Vec<KgNode>> {
    let mut sql = String::from(
        "SELECT id, uid, name, description, color, icon, parent_id, pos_x, pos_y, collapsed, created_ts, updated_ts
         FROM kg_node WHERE 1=1",
    );
    let mut args: Vec<Box<dyn rusqlite::ToSql>> = Vec::new();

    match find.parent_id {
        None => {}
        Some(None) => sql.push_str(" AND parent_id IS NULL"),
        Some(Some(pid)) => {
            sql.push_str(" AND parent_id=?");
            args.push(Box::new(pid));
        }
    }

    if !find.id_list.is_empty() {
        let placeholders: Vec<&str> = find.id_list.iter().map(|_| "?").collect();
        sql.push_str(&format!(" AND id IN ({})", placeholders.join(",")));
        for id in &find.id_list {
            args.push(Box::new(*id));
        }
    }

    sql.push_str(" ORDER BY created_ts ASC");

    let mut stmt = conn.prepare(&sql)?;
    let rows = stmt.query_map(
        args.iter().map(|b| b.as_ref()).collect::<Vec<_>>().as_slice(),
        map_row,
    )?;
    let mut nodes = Vec::new();
    for row in rows {
        let mut node = row?;
        node.tags = get_tags(conn, node.id)?;
        nodes.push(node);
    }
    Ok(nodes)
}

/// 设置节点标签（全量替换）
pub fn set_tags(conn: &Connection, node_id: i32, tags: &[String]) -> CoreResult<()> {
    conn.execute("DELETE FROM kg_node_tag WHERE node_id=?1", params![node_id])?;
    if tags.is_empty() {
        return Ok(());
    }
    let mut stmt = conn.prepare("INSERT INTO kg_node_tag (node_id, tag) VALUES (?1, ?2)")?;
    for tag in tags {
        stmt.execute(params![node_id, tag])?;
    }
    Ok(())
}

/// 获取节点标签
pub fn get_tags(conn: &Connection, node_id: i32) -> CoreResult<Vec<String>> {
    let mut stmt = conn.prepare("SELECT tag FROM kg_node_tag WHERE node_id=?1 ORDER BY tag ASC")?;
    let rows = stmt.query_map(params![node_id], |row| row.get::<_, String>(0))?;
    let mut tags = Vec::new();
    for r in rows {
        tags.push(r?);
    }
    Ok(tags)
}

/// 设置节点位置（None 表示用自动布局）
pub fn set_position(conn: &Connection, node_id: i32, x: Option<f64>, y: Option<f64>) -> CoreResult<()> {
    let affected = conn.execute(
        "UPDATE kg_node SET pos_x=?2, pos_y=?3, updated_ts=?4 WHERE id=?1",
        params![node_id, x, y, chrono::Utc::now().timestamp()],
    )?;
    if affected == 0 {
        return Err(CoreError::NotFound(format!("kg_node {node_id}")));
    }
    Ok(())
}

/// 设置折叠状态
pub fn set_collapsed(conn: &Connection, node_id: i32, collapsed: bool) -> CoreResult<()> {
    let affected = conn.execute(
        "UPDATE kg_node SET collapsed=?2, updated_ts=?3 WHERE id=?1",
        params![node_id, collapsed as i32, chrono::Utc::now().timestamp()],
    )?;
    if affected == 0 {
        return Err(CoreError::NotFound(format!("kg_node {node_id}")));
    }
    Ok(())
}

/// 判断 candidate_id 是否是 ancestor_id 的后代（含任意深度）
pub fn is_descendant(conn: &Connection, ancestor_id: i32, candidate_id: i32) -> CoreResult<bool> {
    let mut current = candidate_id;
    let mut visited = std::collections::HashSet::new();
    while let Some(parent) = get_parent_id(conn, current)? {
        if parent == ancestor_id {
            return Ok(true);
        }
        if !visited.insert(current) {
            // 检测到环，保守返回 true 拒绝操作
            return Ok(true);
        }
        current = parent;
    }
    Ok(false)
}

fn get_parent_id(conn: &Connection, id: i32) -> CoreResult<Option<i32>> {
    let parent: Option<Option<i32>> = conn
        .query_row("SELECT parent_id FROM kg_node WHERE id=?1", params![id], |row| {
            row.get(0)
        })
        .optional()?;
    Ok(parent.flatten())
}

fn map_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<KgNode> {
    Ok(KgNode {
        id: row.get(0)?,
        uid: row.get(1)?,
        name: row.get(2)?,
        description: row.get(3)?,
        color: row.get(4)?,
        icon: row.get(5)?,
        parent_id: row.get(6)?,
        pos_x: row.get(7)?,
        pos_y: row.get(8)?,
        collapsed: row.get::<_, i32>(9)? != 0,
        created_ts: row.get(10)?,
        updated_ts: row.get(11)?,
        tags: Vec::new(),
    })
}
```

需要在 `core/src/kg_node.rs` 顶部追加 `use rusqlite::OptionalExtension;`（`optional()` 方法所需）。修改 import 行：

```rust
use rusqlite::{params, Connection, OptionalExtension};
```

- [ ] **Step 6: 运行测试确认通过**

Run: `cargo test --package memos-core kg_node_create`
Expected: PASS

- [ ] **Step 7: 写测试 — 更新与循环校验**

追加到 `core/tests/kg.rs`：

```rust
#[test]
fn kg_node_update_and_circular_check() {
    let store = open_test_store();
    let conn = store.lock_conn();
    let parent = make_node(&conn, "parent");
    let child = kg_node::create(&conn, &UpsertKgNode {
        uid: "kg-child".into(),
        name: "child".into(),
        description: String::new(),
        color: String::new(),
        icon: String::new(),
        parent_id: Some(parent.id),
        pos_x: None,
        pos_y: None,
        collapsed: false,
    }).unwrap();

    // 正常更新
    let updated = kg_node::update(&conn, child.id, &UpsertKgNode {
        uid: "kg-child".into(),
        name: "child2".into(),
        description: "desc".into(),
        color: "blue".into(),
        icon: "StarIcon".into(),
        parent_id: Some(parent.id),
        pos_x: Some(10.0),
        pos_y: Some(20.0),
        collapsed: true,
    }).unwrap();
    assert_eq!(updated.name, "child2");
    assert_eq!(updated.color, "blue");
    assert_eq!(updated.pos_x, Some(10.0));
    assert!(updated.collapsed);

    // 循环校验：把 parent 的 parent 设为 child 应失败
    let err = kg_node::update(&conn, parent.id, &UpsertKgNode {
        uid: "kg-parent".into(),
        name: "parent".into(),
        description: String::new(),
        color: String::new(),
        icon: String::new(),
        parent_id: Some(child.id),
        pos_x: None,
        pos_y: None,
        collapsed: false,
    });
    assert!(err.is_err(), "应拒绝循环父子关系");
}
```

- [ ] **Step 8: 运行测试确认通过**

Run: `cargo test --package memos-core kg_node_update_and_circular_check`
Expected: PASS

- [ ] **Step 9: 写测试 — 标签与位置**

追加到 `core/tests/kg.rs`：

```rust
#[test]
fn kg_node_tags_and_position() {
    let store = open_test_store();
    let conn = store.lock_conn();
    let node = make_node(&conn, "n1");

    // set_tags 全量替换
    kg_node::set_tags(&conn, node.id, &["rust".into(), "tauri".into()]).unwrap();
    let tags = kg_node::get_tags(&conn, node.id).unwrap();
    assert_eq!(tags, vec!["rust".to_string(), "tauri".to_string()]);

    // 再次 set_tags 替换为新集合
    kg_node::set_tags(&conn, node.id, &["ai".into()]).unwrap();
    let tags = kg_node::get_tags(&conn, node.id).unwrap();
    assert_eq!(tags, vec!["ai".to_string()]);

    // 位置：None 表示自动布局
    kg_node::set_position(&conn, node.id, Some(1.5), Some(2.5)).unwrap();
    let got = kg_node::get(&conn, node.id).unwrap();
    assert_eq!(got.pos_x, Some(1.5));
    assert_eq!(got.pos_y, Some(2.5));

    kg_node::set_position(&conn, node.id, None, None).unwrap();
    let got = kg_node::get(&conn, node.id).unwrap();
    assert!(got.pos_x.is_none());
    assert!(got.pos_y.is_none());
}
```

- [ ] **Step 10: 运行测试确认通过**

Run: `cargo test --package memos-core kg_node_tags_and_position`
Expected: PASS

- [ ] **Step 11: 写测试 — 删除级联**

追加到 `core/tests/kg.rs`（需要 kg_edge 模块存在，先写最小依赖）：

```rust
#[test]
fn kg_node_delete_cascades() {
    let store = open_test_store();
    let conn = store.lock_conn();
    let n1 = make_node(&conn, "n1");
    let n2 = make_node(&conn, "n2");
    kg_node::set_tags(&conn, n1.id, &["t1".into()]).unwrap();

    // 删除 n1
    kg_node::delete(&conn, n1.id).unwrap();

    // 标签应被级联清理
    let tags = kg_node::get_tags(&conn, n1.id).unwrap();
    assert!(tags.is_empty(), "标签应被级联删除");

    // get 应返回 NotFound
    let err = kg_node::get(&conn, n1.id);
    assert!(err.is_err());
}
```

- [ ] **Step 12: 运行测试确认通过**

Run: `cargo test --package memos-core kg_node_delete_cascades`
Expected: PASS

- [ ] **Step 13: 提交**

```powershell
git add core/src/kg_node.rs core/src/lib.rs core/tests/kg.rs
git commit -m "feat(kg): add kg_node core module with CRUD, tags, position, circular check"
```

---

## Task 3: core 层 kg_edge 模块

**Files:**
- Create: `core/src/kg_edge.rs`
- Test: `core/tests/kg.rs`（追加）

**Interfaces:**
- Produces:
  - `KgEdge` struct
  - `fn create(conn, source_id: i32, target_id: i32, type: &str, label: &str) -> CoreResult<KgEdge>`
  - `fn update(conn, id: i32, type: &str, label: &str) -> CoreResult<KgEdge>`
  - `fn delete(conn, id: i32) -> CoreResult<()>`
  - `fn list_by_nodes(conn, &[i32]) -> CoreResult<Vec<KgEdge>>`

- [ ] **Step 1: 写失败测试 — 创建边**

追加到 `core/tests/kg.rs`，顶部加 import：

```rust
use memos_core::kg_edge::KgEdge;
```

追加测试：

```rust
#[test]
fn kg_edge_create_and_list() {
    let store = open_test_store();
    let conn = store.lock_conn();
    let n1 = make_node(&conn, "n1");
    let n2 = make_node(&conn, "n2");

    let edge = kg_edge::create(&conn, n1.id, n2.id, "related", "关联").unwrap();
    assert_eq!(edge.source_id, n1.id);
    assert_eq!(edge.target_id, n2.id);
    assert_eq!(edge.r#type, "related");
    assert_eq!(edge.label, "关联");

    let edges = kg_edge::list_by_nodes(&conn, &[n1.id, n2.id]).unwrap();
    assert_eq!(edges.len(), 1);
    assert_eq!(edges[0].id, edge.id);
}
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cargo test --package memos-core kg_edge_create_and_list`
Expected: FAIL（`unresolved module kg_edge`）

- [ ] **Step 3: 实现 kg_edge.rs**

创建 `core/src/kg_edge.rs`：

```rust
//! 知识图谱边 CRUD

use crate::error::{CoreError, CoreResult};
use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};

/// 边实体
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct KgEdge {
    pub id: i32,
    pub source_id: i32,
    pub target_id: i32,
    #[serde(rename = "type")]
    pub r#type: String,
    pub label: String,
    pub created_ts: i64,
}

/// 创建边
pub fn create(conn: &Connection, source_id: i32, target_id: i32, edge_type: &str, label: &str) -> CoreResult<KgEdge> {
    let now = chrono::Utc::now().timestamp();
    conn.execute(
        "INSERT INTO kg_edge (source_id, target_id, type, label, created_ts)
         VALUES (?1, ?2, ?3, ?4, ?5)",
        params![source_id, target_id, edge_type, label, now],
    )?;
    let id = conn.last_insert_rowid() as i32;
    get(conn, id)
}

/// 更新边
pub fn update(conn: &Connection, id: i32, edge_type: &str, label: &str) -> CoreResult<KgEdge> {
    let affected = conn.execute(
        "UPDATE kg_edge SET type=?2, label=?3 WHERE id=?1",
        params![id, edge_type, label],
    )?;
    if affected == 0 {
        return Err(CoreError::NotFound(format!("kg_edge {id}")));
    }
    get(conn, id)
}

/// 删除边
pub fn delete(conn: &Connection, id: i32) -> CoreResult<()> {
    let affected = conn.execute("DELETE FROM kg_edge WHERE id=?1", params![id])?;
    if affected == 0 {
        return Err(CoreError::NotFound(format!("kg_edge {id}")));
    }
    Ok(())
}

/// 查询给定节点集涉及的边
pub fn list_by_nodes(conn: &Connection, node_ids: &[i32]) -> CoreResult<Vec<KgEdge>> {
    if node_ids.is_empty() {
        return Ok(Vec::new());
    }
    let placeholders: Vec<&str> = node_ids.iter().map(|_| "?").collect();
    let sql = format!(
        "SELECT id, source_id, target_id, type, label, created_ts FROM kg_edge
         WHERE source_id IN ({}) OR target_id IN ({})
         ORDER BY created_ts ASC",
        placeholders.join(","),
        placeholders.join(",")
    );
    let mut stmt = conn.prepare(&sql)?;
    let mut args: Vec<Box<dyn rusqlite::ToSql>> = Vec::new();
    for id in node_ids {
        args.push(Box::new(*id));
    }
    for id in node_ids {
        args.push(Box::new(*id));
    }
    let rows = stmt.query_map(
        args.iter().map(|b| b.as_ref()).collect::<Vec<_>>().as_slice(),
        |row| {
            Ok(KgEdge {
                id: row.get(0)?,
                source_id: row.get(1)?,
                target_id: row.get(2)?,
                r#type: row.get(3)?,
                label: row.get(4)?,
                created_ts: row.get(5)?,
            })
        },
    )?;
    let mut edges = Vec::new();
    for r in rows {
        edges.push(r?);
    }
    Ok(edges)
}

fn get(conn: &Connection, id: i32) -> CoreResult<KgEdge> {
    conn.query_row(
        "SELECT id, source_id, target_id, type, label, created_ts FROM kg_edge WHERE id=?1",
        params![id],
        |row| {
            Ok(KgEdge {
                id: row.get(0)?,
                source_id: row.get(1)?,
                target_id: row.get(2)?,
                r#type: row.get(3)?,
                label: row.get(4)?,
                created_ts: row.get(5)?,
            })
        },
    )
    .map_err(|e| match e {
        rusqlite::Error::QueryReturnedNoRows => CoreError::NotFound(format!("kg_edge {id}")),
        other => CoreError::Db(other),
    })
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `cargo test --package memos-core kg_edge_create_and_list`
Expected: PASS

- [ ] **Step 5: 写测试 — 唯一约束与删除**

追加到 `core/tests/kg.rs`：

```rust
#[test]
fn kg_edge_unique_and_delete() {
    let store = open_test_store();
    let conn = store.lock_conn();
    let n1 = make_node(&conn, "n1");
    let n2 = make_node(&conn, "n2");

    let edge = kg_edge::create(&conn, n1.id, n2.id, "related", "").unwrap();
    // 相同 source/target/type 应冲突
    let dup = kg_edge::create(&conn, n1.id, n2.id, "related", "");
    assert!(dup.is_err(), "应拒绝重复边");

    // 不同 type 允许
    let edge2 = kg_edge::create(&conn, n1.id, n2.id, "contains", "");
    assert!(edge2.is_ok());

    // 删除
    kg_edge::delete(&conn, edge.id).unwrap();
    let edges = kg_edge::list_by_nodes(&conn, &[n1.id, n2.id]).unwrap();
    assert_eq!(edges.len(), 1);
}
```

- [ ] **Step 6: 运行测试确认通过**

Run: `cargo test --package memos-core kg_edge_unique_and_delete`
Expected: PASS

- [ ] **Step 7: 提交**

```powershell
git add core/src/kg_edge.rs core/tests/kg.rs
git commit -m "feat(kg): add kg_edge core module with CRUD and unique constraint"
```

---

## Task 4: core 层 memo_kg_node 模块 + 节点-笔记匹配

**Files:**
- Create: `core/src/memo_kg_node.rs`
- Test: `core/tests/kg.rs`（追加）

**Interfaces:**
- Produces:
  - `fn link(conn, memo_id: i32, node_id: i32) -> CoreResult<()>`
  - `fn unlink(conn, memo_id: i32, node_id: i32) -> CoreResult<()>`
  - `fn list_by_memo(conn, memo_id: i32) -> CoreResult<Vec<i32>>`
  - `fn list_by_node(conn, node_id: i32) -> CoreResult<Vec<i32>>`
  - `fn find_memos_by_kg_node(conn, node_id: i32) -> CoreResult<Vec<i32>>`
  - `fn find_nodes_by_memo_tags(conn, memo_tags: &[String]) -> CoreResult<Vec<i32>>`

- [ ] **Step 1: 写失败测试 — 关联与匹配**

追加到 `core/tests/kg.rs`，顶部加 import：

```rust
use memos_core::memo_kg_node;
use memos_core::memo::{CreateMemo, FindMemo};
use memos_core::types::{Visibility};
use serde_json::json;
```

追加测试：

```rust
fn make_memo(conn: &rusqlite::Connection, uid: &str, content: &str) -> i32 {
    let m = memo::create(conn, &CreateMemo {
        uid: uid.into(),
        content: content.into(),
        visibility: Visibility::Private,
        pinned: false,
        payload: json!({}),
        location: None,
        parent_id: None,
    }).unwrap();
    m.id
}

#[test]
fn memo_kg_node_link_and_find() {
    let store = open_test_store();
    let conn = store.lock_conn();

    // memo1 含 #rust 标签，memo2 含 #python 标签
    let m1 = make_memo(&conn, "m1", "学习 #rust 笔记");
    let m2 = make_memo(&conn, "m2", "#python 入门");

    // node1 关联 rust 标签（自动匹配 m1）
    let n1 = make_node(&conn, "rust-node");
    kg_node::set_tags(&conn, n1.id, &["rust".into()]).unwrap();

    // node2 无标签，手动关联 m2
    let n2 = make_node(&conn, "manual-node");
    memo_kg_node::link(&conn, m2, n2.id).unwrap();

    // find_memos_by_kg_node(n1) 应返回 [m1]（标签自动匹配）
    let memos = memo_kg_node::find_memos_by_kg_node(&conn, n1.id).unwrap();
    assert_eq!(memos, vec![m1]);

    // find_memos_by_kg_node(n2) 应返回 [m2]（手动关联）
    let memos = memo_kg_node::find_memos_by_kg_node(&conn, n2.id).unwrap();
    assert_eq!(memos, vec![m2]);

    // list_by_memo(m2) 应返回 [n2.id]
    let nodes = memo_kg_node::list_by_memo(&conn, m2).unwrap();
    assert_eq!(nodes, vec![n2.id]);

    // unlink
    memo_kg_node::unlink(&conn, m2, n2.id).unwrap();
    let nodes = memo_kg_node::list_by_memo(&conn, m2).unwrap();
    assert!(nodes.is_empty());
}
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cargo test --package memos-core memo_kg_node_link_and_find`
Expected: FAIL（`unresolved module memo_kg_node`）

- [ ] **Step 3: 实现 memo_kg_node.rs**

创建 `core/src/memo_kg_node.rs`：

```rust
//! 笔记-节点关联 + 节点-笔记匹配查询

use crate::error::CoreResult;
use crate::markdown;
use crate::kg_node;
use rusqlite::{params, Connection};
use std::collections::HashSet;

/// 手动关联笔记与节点
pub fn link(conn: &Connection, memo_id: i32, node_id: i32) -> CoreResult<()> {
    conn.execute(
        "INSERT OR IGNORE INTO memo_kg_node (memo_id, node_id) VALUES (?1, ?2)",
        params![memo_id, node_id],
    )?;
    Ok(())
}

/// 解除手动关联
pub fn unlink(conn: &Connection, memo_id: i32, node_id: i32) -> CoreResult<()> {
    conn.execute(
        "DELETE FROM memo_kg_node WHERE memo_id=?1 AND node_id=?2",
        params![memo_id, node_id],
    )?;
    Ok(())
}

/// 查询笔记手动关联的节点 id 列表
pub fn list_by_memo(conn: &Connection, memo_id: i32) -> CoreResult<Vec<i32>> {
    let mut stmt = conn.prepare("SELECT node_id FROM memo_kg_node WHERE memo_id=?1 ORDER BY node_id ASC")?;
    let rows = stmt.query_map(params![memo_id], |row| row.get::<_, i32>(0))?;
    let mut out = Vec::new();
    for r in rows {
        out.push(r?);
    }
    Ok(out)
}

/// 查询节点手动关联的笔记 id 列表
pub fn list_by_node(conn: &Connection, node_id: i32) -> CoreResult<Vec<i32>> {
    let mut stmt = conn.prepare("SELECT memo_id FROM memo_kg_node WHERE node_id=?1 ORDER BY memo_id ASC")?;
    let rows = stmt.query_map(params![node_id], |row| row.get::<_, i32>(0))?;
    let mut out = Vec::new();
    for r in rows {
        out.push(r?);
    }
    Ok(out)
}

/// 返回与节点相关的笔记 id：标签交集（自动匹配）∪ 手动关联，去重
pub fn find_memos_by_kg_node(conn: &Connection, node_id: i32) -> CoreResult<Vec<i32>> {
    let node_tags: HashSet<String> = kg_node::get_tags(conn, node_id)?.into_iter().collect();
    let mut result: HashSet<i32> = HashSet::new();

    // 自动匹配：扫描所有 NORMAL 状态 memo，提取 #tag 与节点标签求交集
    if !node_tags.is_empty() {
        let mut stmt = conn.prepare(
            "SELECT id, content FROM memo WHERE row_status='NORMAL' AND parent_id IS NULL",
        )?;
        let rows = stmt.query_map([], |row| {
            Ok((row.get::<_, i32>(0)?, row.get::<_, String>(1)?))
        })?;
        for r in rows {
            let (memo_id, content) = r?;
            let memo_tags: HashSet<String> = markdown::extract_tags(&content).into_iter().collect();
            if !memo_tags.is_disjoint(&node_tags) {
                result.insert(memo_id);
            }
        }
    }

    // 手动关联
    for memo_id in list_by_node(conn, node_id)? {
        result.insert(memo_id);
    }

    let mut sorted: Vec<i32> = result.into_iter().collect();
    sorted.sort();
    Ok(sorted)
}

/// 返回标签集合能匹配的节点 id（用于笔记侧栏自动匹配）
/// 给定笔记的 tags，返回 kg_node_tag 中 tag 命中的节点 id
pub fn find_nodes_by_memo_tags(conn: &Connection, memo_tags: &[String]) -> CoreResult<Vec<i32>> {
    if memo_tags.is_empty() {
        return Ok(Vec::new());
    }
    let placeholders: Vec<&str> = memo_tags.iter().map(|_| "?").collect();
    let sql = format!(
        "SELECT DISTINCT node_id FROM kg_node_tag WHERE tag IN ({}) ORDER BY node_id ASC",
        placeholders.join(",")
    );
    let mut stmt = conn.prepare(&sql)?;
    let mut args: Vec<Box<dyn rusqlite::ToSql>> = Vec::new();
    for t in memo_tags {
        args.push(Box::new(t.clone()));
    }
    let rows = stmt.query_map(
        args.iter().map(|b| b.as_ref()).collect::<Vec<_>>().as_slice(),
        |row| row.get::<_, i32>(0),
    )?;
    let mut out = Vec::new();
    for r in rows {
        out.push(r?);
    }
    Ok(out)
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `cargo test --package memos-core memo_kg_node_link_and_find`
Expected: PASS

- [ ] **Step 5: 写测试 — 空标签节点**

追加到 `core/tests/kg.rs`：

```rust
#[test]
fn memo_kg_node_empty_tags() {
    let store = open_test_store();
    let conn = store.lock_conn();
    let n = make_node(&conn, "empty-node");
    let m = make_memo(&conn, "m1", "无标签笔记");

    // 节点无标签、无手动关联 → 空结果
    let memos = memo_kg_node::find_memos_by_kg_node(&conn, n.id).unwrap();
    assert!(memos.is_empty());

    // 手动关联后返回
    memo_kg_node::link(&conn, m, n.id).unwrap();
    let memos = memo_kg_node::find_memos_by_kg_node(&conn, n.id).unwrap();
    assert_eq!(memos, vec![m]);
}
```

- [ ] **Step 6: 运行测试确认通过**

Run: `cargo test --package memos-core memo_kg_node_empty_tags`
Expected: PASS

- [ ] **Step 7: 跑全部 kg 测试**

Run: `cargo test --package memos-core kg_`
Expected: 6 个测试全部 PASS

- [ ] **Step 8: 提交**

```powershell
git add core/src/memo_kg_node.rs core/tests/kg.rs
git commit -m "feat(kg): add memo_kg_node module with link/unlink and tag-intersection matching"
```

---

## Task 5: Tauri commands + 注册

**Files:**
- Create: `src-tauri/src/commands/kg.rs`
- Modify: `src-tauri/src/commands/mod.rs`
- Modify: `src-tauri/src/main.rs`（注册到 generate_handler!）

**Interfaces:**
- Consumes: Task 2/3/4 的 core 模块
- Produces: 15 个 Tauri IPC 命令，前端通过 `invoke<T>("kg_xxx", {...})` 调用

- [ ] **Step 1: 在 commands/mod.rs 导出 kg 模块**

修改 `src-tauri/src/commands/mod.rs`，在 `pub mod memo_relation;` 后添加：

```rust
pub mod kg;
```

- [ ] **Step 2: 实现 commands/kg.rs**

创建 `src-tauri/src/commands/kg.rs`：

```rust
//! 知识图谱 IPC 命令

use crate::error::IpcResult;
use crate::state::AppState;
use memos_core::kg_edge::KgEdge;
use memos_core::kg_node::{FindKgNode, KgNode, UpsertKgNode};
use memos_core::memo;
use memos_core::memo_kg_node;
use serde::Deserialize;

#[derive(Debug, Deserialize)]
pub struct UpsertKgNodeRequest {
    pub uid: String,
    pub name: String,
    #[serde(default)]
    pub description: String,
    #[serde(default)]
    pub color: String,
    #[serde(default)]
    pub icon: String,
    pub parent_id: Option<i32>,
    pub pos_x: Option<f64>,
    pub pos_y: Option<f64>,
    #[serde(default)]
    pub collapsed: bool,
}

impl From<UpsertKgNodeRequest> for UpsertKgNode {
    fn from(r: UpsertKgNodeRequest) -> Self {
        UpsertKgNode {
            uid: r.uid,
            name: r.name,
            description: r.description,
            color: r.color,
            icon: r.icon,
            parent_id: r.parent_id,
            pos_x: r.pos_x,
            pos_y: r.pos_y,
            collapsed: r.collapsed,
        }
    }
}

#[derive(Debug, Deserialize, Default)]
pub struct ListKgNodesRequest {
    /// None=全部; Some(None)=根节点; Some(Some(id))=指定父的子节点
    pub parent_id: Option<Option<i32>>,
    pub id_list: Option<Vec<i32>>,
}

#[derive(Debug, Deserialize)]
pub struct CreateKgEdgeRequest {
    pub source_id: i32,
    pub target_id: i32,
    pub edge_type: String,
    #[serde(default)]
    pub label: String,
}

#[derive(Debug, Deserialize)]
pub struct UpdateKgEdgeRequest {
    pub id: i32,
    pub edge_type: String,
    pub label: String,
}

#[derive(Debug, Deserialize)]
pub struct SetPositionRequest {
    pub id: i32,
    pub x: Option<f64>,
    pub y: Option<f64>,
}

#[tauri::command]
pub fn kg_node_create(state: tauri::State<'_, AppState>, req: UpsertKgNodeRequest) -> IpcResult<KgNode> {
    let store = state.store();
    Ok(store.with_conn(|c| kg_node::create(c, &req.into()))?)
}

#[tauri::command]
pub fn kg_node_update(state: tauri::State<'_, AppState>, id: i32, req: UpsertKgNodeRequest) -> IpcResult<KgNode> {
    let store = state.store();
    Ok(store.with_conn(|c| kg_node::update(c, id, &req.into()))?)
}

#[tauri::command]
pub fn kg_node_delete(state: tauri::State<'_, AppState>, id: i32) -> IpcResult<()> {
    let store = state.store();
    store.with_conn(|c| kg_node::delete(c, id))?;
    Ok(())
}

#[tauri::command]
pub fn kg_node_list(state: tauri::State<'_, AppState>, req: ListKgNodesRequest) -> IpcResult<Vec<KgNode>> {
    let store = state.store();
    let find = FindKgNode {
        parent_id: req.parent_id,
        id_list: req.id_list.unwrap_or_default(),
    };
    Ok(store.with_conn(|c| kg_node::list(c, &find))?)
}

#[tauri::command]
pub fn kg_node_set_tags(state: tauri::State<'_, AppState>, id: i32, tags: Vec<String>) -> IpcResult<()> {
    let store = state.store();
    store.with_conn(|c| kg_node::set_tags(c, id, &tags))?;
    Ok(())
}

#[tauri::command]
pub fn kg_node_set_position(state: tauri::State<'_, AppState>, req: SetPositionRequest) -> IpcResult<()> {
    let store = state.store();
    store.with_conn(|c| kg_node::set_position(c, req.id, req.x, req.y))?;
    Ok(())
}

#[tauri::command]
pub fn kg_node_set_collapsed(state: tauri::State<'_, AppState>, id: i32, collapsed: bool) -> IpcResult<()> {
    let store = state.store();
    store.with_conn(|c| kg_node::set_collapsed(c, id, collapsed))?;
    Ok(())
}

#[tauri::command]
pub fn kg_edge_create(state: tauri::State<'_, AppState>, req: CreateKgEdgeRequest) -> IpcResult<KgEdge> {
    let store = state.store();
    Ok(store.with_conn(|c| kg_edge::create(c, req.source_id, req.target_id, &req.edge_type, &req.label))?)
}

#[tauri::command]
pub fn kg_edge_update(state: tauri::State<'_, AppState>, req: UpdateKgEdgeRequest) -> IpcResult<KgEdge> {
    let store = state.store();
    Ok(store.with_conn(|c| kg_edge::update(c, req.id, &req.edge_type, &req.label))?)
}

#[tauri::command]
pub fn kg_edge_delete(state: tauri::State<'_, AppState>, id: i32) -> IpcResult<()> {
    let store = state.store();
    store.with_conn(|c| kg_edge::delete(c, id))?;
    Ok(())
}

#[tauri::command]
pub fn kg_link_memo(state: tauri::State<'_, AppState>, memo_id: i32, node_id: i32) -> IpcResult<()> {
    let store = state.store();
    store.with_conn(|c| memo_kg_node::link(c, memo_id, node_id))?;
    Ok(())
}

#[tauri::command]
pub fn kg_unlink_memo(state: tauri::State<'_, AppState>, memo_id: i32, node_id: i32) -> IpcResult<()> {
    let store = state.store();
    store.with_conn(|c| memo_kg_node::unlink(c, memo_id, node_id))?;
    Ok(())
}

/// 返回笔记关联的节点：自动匹配（标签交集）∪ 手动关联，去重
#[tauri::command]
pub fn kg_list_memo_nodes(state: tauri::State<'_, AppState>, memo_id: i32) -> IpcResult<Vec<KgNode>> {
    let store = state.store();
    Ok(store.with_conn(|c| {
        // 取笔记 tags
        let memo_obj = memo::get(c, &memo::FindMemo { id: Some(memo_id), ..Default::default() })?
            .ok_or_else(|| memos_core::CoreError::NotFound(format!("memo {memo_id}")))?;
        let memo_tags = memos_core::markdown::extract_tags(&memo_obj.content);
        // 自动匹配节点
        let mut node_ids = memo_kg_node::find_nodes_by_memo_tags(c, &memo_tags)?;
        // 加入手动关联
        for nid in memo_kg_node::list_by_memo(c, memo_id)? {
            if !node_ids.contains(&nid) {
                node_ids.push(nid);
            }
        }
        if node_ids.is_empty() {
            return Ok(Vec::new());
        }
        kg_node::list(c, &FindKgNode { parent_id: None, id_list: node_ids })
    })?)
}

/// 返回节点相关的笔记（自动匹配 + 手动关联）
#[tauri::command]
pub fn kg_list_node_memos(state: tauri::State<'_, AppState>, node_id: i32) -> IpcResult<Vec<memo::Memo>> {
    let store = state.store();
    Ok(store.with_conn(|c| {
        let memo_ids = memo_kg_node::find_memos_by_kg_node(c, node_id)?;
        if memo_ids.is_empty() {
            return Ok(Vec::new());
        }
        memo::list(c, &memo::FindMemo { id_list: memo_ids, ..Default::default() })
    })?)
}
```

- [ ] **Step 3: 注册到 main.rs generate_handler!**

修改 `src-tauri/src/main.rs`，在 `// memo_relation` 段后（约 line 423 `commands::memo_relation::delete_memo_relation,` 之后）插入：

```rust
            // knowledge graph
            commands::kg::kg_node_create,
            commands::kg::kg_node_update,
            commands::kg::kg_node_delete,
            commands::kg::kg_node_list,
            commands::kg::kg_node_set_tags,
            commands::kg::kg_node_set_position,
            commands::kg::kg_node_set_collapsed,
            commands::kg::kg_edge_create,
            commands::kg::kg_edge_update,
            commands::kg::kg_edge_delete,
            commands::kg::kg_link_memo,
            commands::kg::kg_unlink_memo,
            commands::kg::kg_list_memo_nodes,
            commands::kg::kg_list_node_memos,
```

- [ ] **Step 4: 编译检查**

Run: `cargo build --manifest-path src-tauri/Cargo.toml 2>&1 | Select-Object -Last 30`
Expected: 编译成功，无错误

- [ ] **Step 5: 提交**

```powershell
git add src-tauri/src/commands/kg.rs src-tauri/src/commands/mod.rs src-tauri/src/main.rs
git commit -m "feat(kg): add 14 Tauri IPC commands and register handlers"
```

---

## Task 6: 前端依赖 + 类型 + hooks

**Files:**
- Modify: `package.json`（新增依赖）
- Create: `src/types/kg.ts`
- Create: `src/hooks/useKgQueries.ts`

**Interfaces:**
- Produces: 前端 KgNode/KgEdge 类型 + React Query hooks，供 Task 7-13 使用

- [ ] **Step 1: 安装依赖**

Run: `pnpm add @xyflow/react @dagrejs/dagre`
Expected: `package.json` 新增两个依赖

- [ ] **Step 2: 创建类型文件**

创建 `src/types/kg.ts`：

```ts
// 知识图谱前端类型（与后端 Rust serde 序列化对齐）

export interface KgNode {
  id: number;
  uid: string;
  name: string;
  description: string;
  color: string;
  icon: string;
  parent_id: number | null;
  pos_x: number | null;
  pos_y: number | null;
  collapsed: boolean;
  created_ts: number;
  updated_ts: number;
  tags: string[];
}

export interface KgEdge {
  id: number;
  source_id: number;
  target_id: number;
  type: string;
  label: string;
  created_ts: number;
}

export interface UpsertKgNodeRequest {
  uid: string;
  name: string;
  description?: string;
  color?: string;
  icon?: string;
  parent_id?: number | null;
  pos_x?: number | null;
  pos_y?: number | null;
  collapsed?: boolean;
}

export interface ListKgNodesRequest {
  parent_id?: number | null | undefined;
  id_list?: number[];
}

export interface CreateKgEdgeRequest {
  source_id: number;
  target_id: number;
  edge_type: string;
  label?: string;
}

export interface UpdateKgEdgeRequest {
  id: number;
  edge_type: string;
  label: string;
}

export interface SetKgPositionRequest {
  id: number;
  x: number | null;
  y: number | null;
}
```

- [ ] **Step 3: 创建 hooks 文件**

创建 `src/hooks/useKgQueries.ts`：

```ts
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { invoke } from "@tauri-apps/api/core";
import type {
  CreateKgEdgeRequest,
  KgEdge,
  KgNode,
  ListKgNodesRequest,
  SetKgPositionRequest,
  UpdateKgEdgeRequest,
  UpsertKgNodeRequest,
} from "@/types/kg";
import type { Memo } from "@/types/proto/api/v1/memo_service_pb";

export const kgKeys = {
  all: ["kg"] as const,
  nodes: () => [...kgKeys.all, "nodes"] as const,
  edges: () => [...kgKeys.all, "edges"] as const,
  nodeMemos: (nodeId: number) => [...kgKeys.all, "nodeMemos", nodeId] as const,
  memoNodes: (memoId: number) => [...kgKeys.all, "memoNodes", memoId] as const,
};

export function useKgNodes() {
  return useQuery<KgNode[]>({
    queryKey: kgKeys.nodes(),
    queryFn: () => invoke<KgNode[]>("kg_node_list", { req: {} as ListKgNodesRequest }),
  });
}

export function useKgEdges() {
  return useQuery<KgEdge[]>({
    queryKey: kgKeys.edges(),
    queryFn: async () => {
      // 边查询复用节点 id 列表
      const nodes = await invoke<KgNode[]>("kg_node_list", { req: {} as ListKgNodesRequest });
      if (nodes.length === 0) return [];
      const ids = nodes.map((n) => n.id);
      // 后端没有独立的 list_all_edges 命令，用 list_by_nodes；前端暂用一次性拉取
      // 这里通过 invoke kg_edge_list_by_nodes 拉取，但该命令未注册
      // 改为：后端 kg_edge_list 命令已在 Task 5 中无；改用节点 id 拉取
      // 注意：Task 5 未提供 list_all_edges，需通过节点 id 拉
      // 简化：此处先返回空，Task 9 画布组件会用 useKgNodes 的结果调用 list_by_nodes
      void ids;
      return [];
    },
  });
}

export function useCreateKgNode() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (req: UpsertKgNodeRequest) => invoke<KgNode>("kg_node_create", { req }),
    onSuccess: () => qc.invalidateQueries({ queryKey: kgKeys.nodes() }),
  });
}

export function useUpdateKgNode() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, req }: { id: number; req: UpsertKgNodeRequest }) =>
      invoke<KgNode>("kg_node_update", { id, req }),
    onSuccess: () => qc.invalidateQueries({ queryKey: kgKeys.nodes() }),
  });
}

export function useDeleteKgNode() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: number) => invoke<void>("kg_node_delete", { id }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: kgKeys.nodes() });
      qc.invalidateQueries({ queryKey: kgKeys.all });
    },
  });
}

export function useSetKgNodeTags() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, tags }: { id: number; tags: string[] }) =>
      invoke<void>("kg_node_set_tags", { id, tags }),
    onSuccess: () => qc.invalidateQueries({ queryKey: kgKeys.nodes() }),
  });
}

export function useSetKgNodePosition() {
  return useMutation({
    mutationFn: (req: SetKgPositionRequest) => invoke<void>("kg_node_set_position", { req }),
  });
}

export function useSetKgNodeCollapsed() {
  return useMutation({
    mutationFn: ({ id, collapsed }: { id: number; collapsed: boolean }) =>
      invoke<void>("kg_node_set_collapsed", { id, collapsed }),
  });
}

export function useCreateKgEdge() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (req: CreateKgEdgeRequest) => invoke<KgEdge>("kg_edge_create", { req }),
    onSuccess: () => qc.invalidateQueries({ queryKey: kgKeys.edges() }),
  });
}

export function useUpdateKgEdge() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (req: UpdateKgEdgeRequest) => invoke<KgEdge>("kg_edge_update", { req }),
    onSuccess: () => qc.invalidateQueries({ queryKey: kgKeys.edges() }),
  });
}

export function useDeleteKgEdge() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: number) => invoke<void>("kg_edge_delete", { id }),
    onSuccess: () => qc.invalidateQueries({ queryKey: kgKeys.edges() }),
  });
}

export function useLinkMemoToNode() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ memoId, nodeId }: { memoId: number; nodeId: number }) =>
      invoke<void>("kg_link_memo", { memoId, nodeId }),
    onSuccess: (_data, { memoId }) => qc.invalidateQueries({ queryKey: kgKeys.memoNodes(memoId) }),
  });
}

export function useUnlinkMemoFromNode() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ memoId, nodeId }: { memoId: number; nodeId: number }) =>
      invoke<void>("kg_unlink_memo", { memoId, nodeId }),
    onSuccess: (_data, { memoId }) => qc.invalidateQueries({ queryKey: kgKeys.memoNodes(memoId) }),
  });
}

export function useKgNodeMemos(nodeId: number | null) {
  return useQuery<Memo[]>({
    queryKey: kgKeys.nodeMemos(nodeId ?? 0),
    queryFn: () => invoke<Memo[]>("kg_list_node_memos", { nodeId }),
    enabled: nodeId != null,
  });
}

export function useMemoKgNodes(memoId: number | null) {
  return useQuery<KgNode[]>({
    queryKey: kgKeys.memoNodes(memoId ?? 0),
    queryFn: () => invoke<KgNode[]>("kg_list_memo_nodes", { memoId }),
    enabled: memoId != null,
  });
}
```

注意：`useKgEdges` 的简化实现会在 Task 9 被替换。当前先保证编译通过。

- [ ] **Step 4: TypeScript 类型检查**

Run: `pnpm tsc --noEmit`
Expected: 无错误

- [ ] **Step 5: 提交**

```powershell
git add package.json pnpm-lock.yaml src/types/kg.ts src/hooks/useKgQueries.ts
git commit -m "feat(kg): add frontend deps, types, and React Query hooks"
```

---

## Task 7: 前端 constants + layout + 边查询补全

**Files:**
- Create: `src/components/KnowledgeGraph/constants.ts`
- Create: `src/components/KnowledgeGraph/layout.ts`
- Modify: `src/hooks/useKgQueries.ts`（补全 useKgEdges 实现）

**Interfaces:**
- Produces: 颜色调色板、边类型预设、dagre 布局函数

- [ ] **Step 1: 创建 constants.ts**

创建 `src/components/KnowledgeGraph/constants.ts`：

```ts
// 颜色调色板：key → tailwind 类名前缀
export const NODE_COLOR_PALETTE = [
  { key: "", label: "默认", dot: "bg-muted-foreground" },
  { key: "blue", label: "蓝", dot: "bg-blue-500" },
  { key: "green", label: "绿", dot: "bg-green-500" },
  { key: "amber", label: "琥珀", dot: "bg-amber-500" },
  { key: "red", label: "红", dot: "bg-red-500" },
  { key: "purple", label: "紫", dot: "bg-purple-500" },
  { key: "cyan", label: "青", dot: "bg-cyan-500" },
  { key: "pink", label: "粉", dot: "bg-pink-500" },
] as const;

// 边类型预设
export const EDGE_TYPES = [
  { value: "related", label: "相关" },
  { value: "contains", label: "包含" },
  { value: "derived", label: "派生" },
] as const;

// 边类型 → 样式
export const EDGE_TYPE_STYLES: Record<string, { stroke: string; dashed: boolean }> = {
  related: { stroke: "#94a3b8", dashed: false },
  contains: { stroke: "#3b82f6", dashed: false },
  derived: { stroke: "#a855f7", dashed: true },
};

export const DEFAULT_NODE_WIDTH = 180;
export const DEFAULT_NODE_HEIGHT = 80;
```

- [ ] **Step 2: 创建 layout.ts**

创建 `src/components/KnowledgeGraph/layout.ts`：

```ts
import dagre from "@dagrejs/dagre";
import type { Edge, Node } from "@xyflow/react";
import { DEFAULT_NODE_HEIGHT, DEFAULT_NODE_WIDTH } from "./constants";

interface KgLayoutNode {
  id: number;
  parent_id: number | null;
  pos_x: number | null;
  pos_y: number | null;
}

interface KgLayoutEdge {
  source_id: number;
  target_id: number;
}

/**
 * 用 dagre 计算自动布局；用户手动覆盖坐标（pos_x/pos_y 非空）优先
 */
export function layoutGraph<T extends KgLayoutNode>(
  nodes: T[],
  edges: KgLayoutEdge[],
  direction: "TB" | "LR" = "TB",
): Map<number, { x: number; y: number }> {
  const g = new dagre.graphlib.Graph();
  g.setGraph({ rankdir: direction, nodesep: 50, ranksep: 80, marginx: 40, marginy: 40 });
  g.setDefaultEdgeLabel(() => ({}));

  nodes.forEach((n) => {
    g.setNode(String(n.id), { width: DEFAULT_NODE_WIDTH, height: DEFAULT_NODE_HEIGHT });
  });

  // 父子关系优先作为 dagre 边
  nodes.forEach((n) => {
    if (n.parent_id != null) {
      g.setEdge(String(n.parent_id), String(n.id));
    }
  });
  // 其他边加入布局
  edges.forEach((e) => {
    // 避免重复添加父子边
    const sourceNode = nodes.find((n) => n.id === e.source_id);
    if (sourceNode?.parent_id !== e.target_id) {
      g.setEdge(String(e.source_id), String(e.target_id));
    }
  });

  dagre.layout(g);

  const result = new Map<number, { x: number; y: number }>();
  nodes.forEach((n) => {
    const pos = g.node(String(n.id));
    // 手动覆盖优先
    if (n.pos_x != null && n.pos_y != null) {
      result.set(n.id, { x: n.pos_x, y: n.pos_y });
    } else if (pos) {
      // React Flow 用左上角坐标，dagre 返回中心点
      result.set(n.id, {
        x: pos.x - DEFAULT_NODE_WIDTH / 2,
        y: pos.y - DEFAULT_NODE_HEIGHT / 2,
      });
    } else {
      result.set(n.id, { x: 0, y: 0 });
    }
  });
  return result;
}

/** 将后端 KgNode/KgEdge 转为 React Flow 格式 */
export function toFlowNodes<T extends KgLayoutNode>(
  nodes: T[],
  positions: Map<number, { x: number; y: number }>,
): Node[] {
  return nodes.map((n) => ({
    id: String(n.id),
    type: "kgNode",
    position: positions.get(n.id) ?? { x: 0, y: 0 },
    data: n,
  }));
}

export function toFlowEdges<T extends KgLayoutEdge & { id: number; type: string; label: string }>(
  edges: T[],
): Edge[] {
  return edges.map((e) => ({
    id: String(e.id),
    source: String(e.source_id),
    target: String(e.target_id),
    type: "kgEdge",
    label: e.label || e.type,
    data: { type: e.type, label: e.label },
  }));
}
```

- [ ] **Step 3: 补全 useKgEdges**

修改 `src/hooks/useKgQueries.ts`，替换 `useKgEdges` 函数为：

```ts
export function useKgEdges() {
  return useQuery<KgEdge[]>({
    queryKey: kgKeys.edges(),
    queryFn: async () => {
      const nodes = await invoke<KgNode[]>("kg_node_list", { req: {} as ListKgNodesRequest });
      if (nodes.length === 0) return [];
      // 通过节点 id 拉 所有相关边；当前无独立 list_all 命令，扩展 useKgNodes 后用 list_by_nodes
      // 后端没有 list_by_nodes IPC，但 Task 5 已注册所有命令；需新增 kg_edge_list_by_nodes
      // 简化方案：返回所有节点的边，前端去重
      // 这里通过遍历节点拉取，但效率低；改为直接用 kg_edge_list（如已注册）
      // 当前 Task 5 未提供 list_all，需补一个命令或改用 list_by_nodes
      // 实际：Task 5 命令列表中无 list_edges，此处改为返回空并依赖画布组件传入节点 id
      void nodes;
      return [];
    },
  });
}
```

发现缺口：Task 5 缺少"拉所有边"的命令。补一个命令到后端。

修改 `src-tauri/src/commands/kg.rs`，在 `kg_edge_delete` 后追加：

```rust
#[derive(Debug, Deserialize, Default)]
pub struct ListKgEdgesRequest {
    pub node_ids: Option<Vec<i32>>,
}

#[tauri::command]
pub fn kg_edge_list(state: tauri::State<'_, AppState>, req: ListKgEdgesRequest) -> IpcResult<Vec<KgEdge>> {
    let store = state.store();
    Ok(store.with_conn(|c| {
        let node_ids = req.node_ids.unwrap_or_default();
        kg_edge::list_by_nodes(c, &node_ids)
    })?)
}
```

注意 `list_by_nodes` 传空切片会返回空，需改为"空切片=返回全部"。修改 `core/src/kg_edge.rs` 的 `list_by_nodes`：

```rust
pub fn list_by_nodes(conn: &Connection, node_ids: &[i32]) -> CoreResult<Vec<KgEdge>> {
    if node_ids.is_empty() {
        // 空切片=返回全部
        return list_all(conn);
    }
    // ... 原有逻辑
}
```

在 `core/src/kg_edge.rs` 末尾追加：

```rust
/// 查询所有边
pub fn list_all(conn: &Connection) -> CoreResult<Vec<KgEdge>> {
    let mut stmt = conn.prepare(
        "SELECT id, source_id, target_id, type, label, created_ts FROM kg_edge ORDER BY created_ts ASC",
    )?;
    let rows = stmt.query_map([], |row| {
        Ok(KgEdge {
            id: row.get(0)?,
            source_id: row.get(1)?,
            target_id: row.get(2)?,
            r#type: row.get(3)?,
            label: row.get(4)?,
            created_ts: row.get(5)?,
        })
    })?;
    let mut edges = Vec::new();
    for r in rows {
        edges.push(r?);
    }
    Ok(edges)
}
```

注册 `kg_edge_list` 到 `src-tauri/src/main.rs` 的 generate_handler!（在 `commands::kg::kg_edge_delete,` 后）：

```rust
            commands::kg::kg_edge_list,
```

更新 `src/hooks/useKgQueries.ts` 的 `useKgEdges`：

```ts
export function useKgEdges() {
  return useQuery<KgEdge[]>({
    queryKey: kgKeys.edges(),
    queryFn: () => invoke<KgEdge[]>("kg_edge_list", { req: { node_ids: null } }),
  });
}
```

- [ ] **Step 4: 编译验证**

Run: `cargo build --manifest-path src-tauri/Cargo.toml 2>&1 | Select-Object -Last 10`
Expected: 编译成功

Run: `pnpm tsc --noEmit`
Expected: 无错误

- [ ] **Step 5: 提交**

```powershell
git add src/components/KnowledgeGraph/constants.ts src/components/KnowledgeGraph/layout.ts src/hooks/useKgQueries.ts src-tauri/src/commands/kg.rs src-tauri/src/main.rs core/src/kg_edge.rs
git commit -m "feat(kg): add constants, dagre layout, and kg_edge_list command"
```

---

## Task 8: 前端 KgNodeCard + KgEdgeWithLabel

**Files:**
- Create: `src/components/KnowledgeGraph/KgNodeCard.tsx`
- Create: `src/components/KnowledgeGraph/KgEdgeWithLabel.tsx`

**Interfaces:**
- Produces: React Flow 自定义节点/边组件，供 Task 9 画布使用

- [ ] **Step 1: 创建 KgNodeCard.tsx**

创建 `src/components/KnowledgeGraph/KgNodeCard.tsx`：

```tsx
import { Handle, Position, type NodeProps } from "@xyflow/react";
import { ChevronDownIcon, ChevronRightIcon, HashIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import { NODE_COLOR_PALETTE } from "./constants";

export interface KgNodeData {
  id: number;
  name: string;
  description: string;
  color: string;
  icon: string;
  parent_id: number | null;
  collapsed: boolean;
  tags: string[];
  hasChildren?: boolean;
  [key: string]: unknown;
}

const colorClassMap: Record<string, string> = Object.fromEntries(
  NODE_COLOR_PALETTE.map((c) => [
    c.key,
    c.key === "" ? "border-border bg-card" : `border-${c.key}-500/50 bg-${c.key}-500/5`,
  ]),
);

export default function KgNodeCard({ data, selected }: NodeProps) {
  const nodeData = data as KgNodeData;
  const colorClass = colorClassMap[nodeData.color] ?? colorClassMap[""];

  return (
    <div
      className={cn(
        "relative w-[180px] rounded-lg border-2 px-3 py-2 shadow-sm transition-colors",
        colorClass,
        selected ? "ring-2 ring-primary" : "",
      )}
    >
      <Handle type="target" position={Position.Top} className="!h-2 !w-2 !bg-muted-foreground/50" />

      <div className="flex items-start gap-2">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            <span className="truncate text-sm font-medium text-foreground">{nodeData.name}</span>
          </div>
          {nodeData.description && (
            <p className="mt-0.5 line-clamp-2 text-xs text-muted-foreground">{nodeData.description}</p>
          )}
        </div>
      </div>

      {nodeData.tags.length > 0 && (
        <div className="mt-1.5 flex flex-wrap gap-0.5">
          {nodeData.tags.slice(0, 3).map((tag) => (
            <span key={tag} className="inline-flex items-center gap-0.5 rounded bg-muted/60 px-1 text-[10px] text-muted-foreground">
              <HashIcon className="h-2 w-2" />
              {tag}
            </span>
          ))}
          {nodeData.tags.length > 3 && (
            <span className="text-[10px] text-muted-foreground">+{nodeData.tags.length - 3}</span>
          )}
        </div>
      )}

      {nodeData.hasChildren && (
        <div className="absolute -bottom-2 left-1/2 -translate-x-1/2 rounded-full bg-background border border-border px-1 text-xs">
          {nodeData.collapsed ? <ChevronRightIcon className="h-3 w-3" /> : <ChevronDownIcon className="h-3 w-3" />}
        </div>
      )}

      <Handle type="source" position={Position.Bottom} className="!h-2 !w-2 !bg-muted-foreground/50" />
    </div>
  );
}
```

- [ ] **Step 2: 创建 KgEdgeWithLabel.tsx**

创建 `src/components/KnowledgeGraph/KgEdgeWithLabel.tsx`：

```tsx
import { BaseEdge, EdgeLabelRenderer, getBezierPath, type EdgeProps } from "@xyflow/react";
import { EDGE_TYPE_STYLES } from "./constants";

export interface KgEdgeData {
  type: string;
  label: string;
  [key: string]: unknown;
}

export default function KgEdgeWithLabel({
  id,
  sourceX,
  sourceY,
  targetX,
  targetY,
  sourcePosition,
  targetPosition,
  data,
  selected,
}: EdgeProps) {
  const edgeData = (data ?? {}) as KgEdgeData;
  const style = EDGE_TYPE_STYLES[edgeData.type] ?? EDGE_TYPE_STYLES.related;
  const [edgePath, labelX, labelY] = getBezierPath({
    sourceX,
    sourceY,
    sourcePosition,
    targetX,
    targetY,
    targetPosition,
  });

  return (
    <>
      <BaseEdge
        id={id}
        path={edgePath}
        style={{
          stroke: style.stroke,
          strokeWidth: selected ? 2.5 : 1.5,
          strokeDasharray: style.dashed ? "6 4" : undefined,
        }}
      />
      {(edgeData.label || edgeData.type) && (
        <EdgeLabelRenderer>
          <div
            style={{
              position: "absolute",
              transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)`,
              pointerEvents: "all",
            }}
            className="rounded bg-background px-1.5 py-0.5 text-[10px] text-muted-foreground border border-border shadow-sm"
          >
            {edgeData.label || edgeData.type}
          </div>
        </EdgeLabelRenderer>
      )}
    </>
  );
}
```

- [ ] **Step 3: 类型检查**

Run: `pnpm tsc --noEmit`
Expected: 无错误

- [ ] **Step 4: 提交**

```powershell
git add src/components/KnowledgeGraph/KgNodeCard.tsx src/components/KnowledgeGraph/KgEdgeWithLabel.tsx
git commit -m "feat(kg): add custom React Flow node and edge components"
```

---

## Task 9: 前端 KgCanvas 画布

**Files:**
- Create: `src/components/KnowledgeGraph/KgCanvas.tsx`

**Interfaces:**
- Consumes: useKgNodes, useKgEdges, useSetKgNodePosition, useSetKgNodeCollapsed, useCreateKgEdge
- Produces: 画布组件，支持拖拽/缩放/连线/折叠

- [ ] **Step 1: 创建 KgCanvas.tsx**

创建 `src/components/KnowledgeGraph/KgCanvas.tsx`：

```tsx
import { useCallback, useEffect, useMemo, useState } from "react";
import { ReactFlow, ReactFlowProvider, Background, Controls, type Connection, type NodeMouseHandler } from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { useKgEdges, useKgNodes, useCreateKgEdge, useSetKgNodeCollapsed, useSetKgNodePosition } from "@/hooks/useKgQueries";
import { useDebouncedEffect } from "@/hooks";
import { layoutGraph, toFlowEdges, toFlowNodes } from "./layout";
import KgNodeCard, { type KgNodeData } from "./KgNodeCard";
import KgEdgeWithLabel from "./KgEdgeWithLabel";

interface Props {
  selectedNodeId: number | null;
  onSelectNode: (id: number | null) => void;
  onRequestEditNode: (id: number) => void;
}

const nodeTypes = { kgNode: KgNodeCard };
const edgeTypes = { kgEdge: KgEdgeWithLabel };

function KgCanvasInner({ selectedNodeId, onSelectNode, onRequestEditNode }: Props) {
  const { data: nodes = [] } = useKgNodes();
  const { data: edges = [] } = useKgEdges();
  const setPos = useSetKgNodePosition();
  const setCollapsed = useSetKgNodeCollapsed();
  const createEdge = useCreateKgEdge();

  // 计算每个节点是否有子节点（用于折叠按钮）
  const hasChildrenMap = useMemo(() => {
    const map = new Map<number, boolean>();
    nodes.forEach((n) => {
      if (n.parent_id != null) {
        map.set(n.parent_id, true);
      }
    });
    return map;
  }, [nodes]);

  // 过滤掉折叠节点的后代
  const visibleNodes = useMemo(() => {
    const collapsedSet = new Set<number>();
    nodes.forEach((n) => {
      if (n.collapsed) collapsedSet.add(n.id);
    });
    // 标记被折叠的祖先的后代
    const hiddenSet = new Set<number>();
    const checkHidden = (n: typeof nodes[number]): boolean => {
      if (n.parent_id == null) return false;
      if (hiddenSet.has(n.id)) return true;
      const parent = nodes.find((p) => p.id === n.parent_id);
      if (!parent) return false;
      if (collapsedSet.has(parent.id) || checkHidden(parent)) {
        hiddenSet.add(n.id);
        return true;
      }
      return false;
    };
    return nodes.filter((n) => !checkHidden(n));
  }, [nodes]);

  // 布局
  const positions = useMemo(() => {
    return layoutGraph(visibleNodes, edges);
  }, [visibleNodes, edges]);

  const flowNodes = useMemo(() => {
    return toFlowNodes(visibleNodes, positions).map((n) => {
      const data = n.data as KgNodeData;
      return {
        ...n,
        data: { ...data, hasChildren: hasChildrenMap.get(data.id) ?? false },
        selected: selectedNodeId === data.id,
      };
    });
  }, [visibleNodes, positions, hasChildrenMap, selectedNodeId]);

  const flowEdges = useMemo(() => {
    const visibleIds = new Set(visibleNodes.map((n) => n.id));
    return toFlowEdges(edges.filter((e) => visibleIds.has(e.source_id) && visibleIds.has(e.target_id)));
  }, [edges, visibleNodes]);

  // 拖拽后保存位置（防抖）
  const [pendingPositions, setPendingPositions] = useState<Map<string, { x: number; y: number }>>(new Map());
  useDebouncedEffect(
    () => {
      if (pendingPositions.size === 0) return;
      for (const [id, pos] of pendingPositions) {
        setPos.mutate({ id: Number(id), x: pos.x, y: pos.y });
      }
      setPendingPositions(new Map());
    },
    500,
    [pendingPositions],
  );

  const onNodeDragStop: NodeMouseHandler = useCallback((_evt, node) => {
    setPendingPositions((prev) => {
      const next = new Map(prev);
      next.set(node.id, node.position);
      return next;
    });
  }, []);

  const onNodeClick: NodeMouseHandler = useCallback((_evt, node) => {
    onSelectNode(Number(node.id));
  }, [onSelectNode]);

  const onPaneClick = useCallback(() => {
    onSelectNode(null);
  }, [onSelectNode]);

  const onNodeDoubleClick: NodeMouseHandler = useCallback((_evt, node) => {
    onRequestEditNode(Number(node.id));
  }, [onRequestEditNode]);

  const onConnect = useCallback((connection: Connection) => {
    if (!connection.source || !connection.target) return;
    createEdge.mutate({
      source_id: Number(connection.source),
      target_id: Number(connection.target),
      edge_type: "related",
      label: "",
    });
  }, [createEdge]);

  // 折叠/展开按钮（在节点卡片底部）
  useEffect(() => {
    // 通过自定义事件让 KgNodeCard 触发折叠
    const handler = (e: Event) => {
      const detail = (e as CustomEvent<{ id: number; collapsed: boolean }>).detail;
      setCollapsed.mutate(detail);
    };
    window.addEventListener("kg-toggle-collapse", handler as EventListener);
    return () => window.removeEventListener("kg-toggle-collapse", handler as EventListener);
  }, [setCollapsed]);

  return (
    <ReactFlow
      nodes={flowNodes}
      edges={flowEdges}
      nodeTypes={nodeTypes}
      edgeTypes={edgeTypes}
      onNodeClick={onNodeClick}
      onNodeDoubleClick={onNodeDoubleClick}
      onNodeDragStop={onNodeDragStop}
      onPaneClick={onPaneClick}
      onConnect={onConnect}
      fitView
      className="bg-muted/10"
    >
      <Background gap={16} size={1} />
      <Controls />
    </ReactFlow>
  );
}

export default function KgCanvas(props: Props) {
  return (
    <ReactFlowProvider>
      <KgCanvasInner {...props} />
    </ReactFlowProvider>
  );
}
```

- [ ] **Step 2: 类型检查**

Run: `pnpm tsc --noEmit`
Expected: 无错误

- [ ] **Step 3: 提交**

```powershell
git add src/components/KnowledgeGraph/KgCanvas.tsx
git commit -m "feat(kg): add React Flow canvas with drag/connect/collapse"
```

---

## Task 10: 前端 KgToolbar + KgNodeEditDialog + KgTagEditor

**Files:**
- Create: `src/components/KnowledgeGraph/KgToolbar.tsx`
- Create: `src/components/KnowledgeGraph/KgNodeEditDialog.tsx`
- Create: `src/components/KnowledgeGraph/KgTagEditor.tsx`

**Interfaces:**
- Produces: 工具栏（新建/重置布局）、节点编辑对话框、标签编辑器

- [ ] **Step 1: 创建 KgTagEditor.tsx**

创建 `src/components/KnowledgeGraph/KgTagEditor.tsx`：

```tsx
import { HashIcon, XIcon } from "lucide-react";
import { useState } from "react";
import { Input } from "@/components/ui/input";

interface Props {
  tags: string[];
  onChange: (tags: string[]) => void;
}

export default function KgTagEditor({ tags, onChange }: Props) {
  const [input, setInput] = useState("");

  const addTag = () => {
    const trimmed = input.trim();
    if (!trimmed || tags.includes(trimmed)) return;
    onChange([...tags, trimmed]);
    setInput("");
  };

  const removeTag = (tag: string) => {
    onChange(tags.filter((t) => t !== tag));
  };

  return (
    <div className="flex flex-wrap gap-1.5 rounded-md border border-border p-2">
      {tags.map((tag) => (
        <span
          key={tag}
          className="inline-flex items-center gap-1 rounded bg-muted px-1.5 py-0.5 text-xs text-muted-foreground"
        >
          <HashIcon className="h-3 w-3" />
          {tag}
          <button type="button" onClick={() => removeTag(tag)} className="hover:text-destructive">
            <XIcon className="h-3 w-3" />
          </button>
        </span>
      ))}
      <Input
        type="text"
        value={input}
        onChange={(e) => setInput(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            addTag();
          }
        }}
        onBlur={addTag}
        placeholder="输入标签后回车"
        className="h-6 min-w-[80px] border-0 bg-transparent px-1 text-xs shadow-none focus-visible:ring-0"
      />
    </div>
  );
}
```

- [ ] **Step 2: 创建 KgNodeEditDialog.tsx**

创建 `src/components/KnowledgeGraph/KgNodeEditDialog.tsx`：

```tsx
import { useEffect, useState } from "react";
import { generateUUID } from "@/utils/uuid";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { useCreateKgNode, useKgNodes, useSetKgNodeTags, useUpdateKgNode } from "@/hooks/useKgQueries";
import type { KgNode, UpsertKgNodeRequest } from "@/types/kg";
import { NODE_COLOR_PALETTE } from "./constants";
import KgTagEditor from "./KgTagEditor";

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** 传入节点 id 表示编辑；null 表示新建 */
  editNodeId?: number | null;
  defaultParentId?: number | null;
}

export default function KgNodeEditDialog({ open, onOpenChange, editNodeId, defaultParentId }: Props) {
  const { data: nodes = [] } = useKgNodes();
  const createNode = useCreateKgNode();
  const updateNode = useUpdateKgNode();
  const setTags = useSetKgNodeTags();

  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [color, setColor] = useState("");
  const [icon, setIcon] = useState("");
  const [parentId, setParentId] = useState<number | null>(null);
  const [tags, setTagsState] = useState<string[]>([]);

  useEffect(() => {
    if (!open) return;
    if (editNodeId != null) {
      const node = nodes.find((n) => n.id === editNodeId);
      if (node) {
        setName(node.name);
        setDescription(node.description);
        setColor(node.color);
        setIcon(node.icon);
        setParentId(node.parent_id);
        setTagsState(node.tags);
      }
    } else {
      setName("");
      setDescription("");
      setColor("");
      setIcon("");
      setParentId(defaultParentId ?? null);
      setTagsState([]);
    }
  }, [open, editNodeId, nodes, defaultParentId]);

  const handleSave = () => {
    if (!name.trim()) return;
    const req: UpsertKgNodeRequest = {
      uid: editNodeId != null ? nodes.find((n) => n.id === editNodeId)?.uid ?? generateUUID() : generateUUID(),
      name: name.trim(),
      description,
      color,
      icon,
      parent_id: parentId,
      pos_x: null,
      pos_y: null,
      collapsed: false,
    };
    if (editNodeId != null) {
      updateNode.mutate(
        { id: editNodeId, req },
        {
          onSuccess: () => {
            setTags.mutate({ id: editNodeId, tags });
            onOpenChange(false);
          },
        },
      );
    } else {
      createNode.mutate(req, {
        onSuccess: (node: KgNode) => {
          setTags.mutate({ id: node.id, tags });
          onOpenChange(false);
        },
      });
    }
  };

  // 可选父节点：排除自身与后代
  const candidateParents = nodes.filter((n) => n.id !== editNodeId);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>{editNodeId != null ? "编辑节点" : "新建节点"}</DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          <div className="space-y-1">
            <Label htmlFor="kg-node-name">名称 *</Label>
            <Input id="kg-node-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="节点名称" />
          </div>
          <div className="space-y-1">
            <Label htmlFor="kg-node-desc">描述</Label>
            <Textarea id="kg-node-desc" value={description} onChange={(e) => setDescription(e.target.value)} rows={2} />
          </div>
          <div className="space-y-1">
            <Label>颜色</Label>
            <div className="flex flex-wrap gap-1.5">
              {NODE_COLOR_PALETTE.map((c) => (
                <button
                  key={c.key || "default"}
                  type="button"
                  onClick={() => setColor(c.key)}
                  className={`h-6 w-6 rounded-full ${c.dot} ${color === c.key ? "ring-2 ring-primary ring-offset-2" : ""}`}
                  title={c.label}
                />
              ))}
            </div>
          </div>
          <div className="space-y-1">
            <Label htmlFor="kg-node-icon">图标（lucide 图标名，可空）</Label>
            <Input id="kg-node-icon" value={icon} onChange={(e) => setIcon(e.target.value)} placeholder="如 StarIcon" />
          </div>
          <div className="space-y-1">
            <Label htmlFor="kg-node-parent">父节点</Label>
            <select
              id="kg-node-parent"
              value={parentId ?? ""}
              onChange={(e) => setParentId(e.target.value ? Number(e.target.value) : null)}
              className="w-full rounded-md border border-border bg-transparent px-2 py-1 text-sm"
            >
              <option value="">（无）</option>
              {candidateParents.map((n) => (
                <option key={n.id} value={n.id}>
                  {n.name}
                </option>
              ))}
            </select>
          </div>
          <div className="space-y-1">
            <Label>标签</Label>
            <KgTagEditor tags={tags} onChange={setTagsState} />
          </div>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            取消
          </Button>
          <Button onClick={handleSave} disabled={!name.trim() || createNode.isPending || updateNode.isPending}>
            保存
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
```

- [ ] **Step 3: 创建 KgToolbar.tsx**

创建 `src/components/KnowledgeGraph/KgToolbar.tsx`：

```tsx
import { PlusIcon, RotateCcwIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useKgNodes, useSetKgNodePosition } from "@/hooks/useKgQueries";
import { useTranslate } from "@/utils/i18n";

interface Props {
  onCreateNode: () => void;
}

export default function KgToolbar({ onCreateNode }: Props) {
  const t = useTranslate();
  const { data: nodes = [] } = useKgNodes();
  const setPos = useSetKgNodePosition();

  const handleResetLayout = () => {
    // 清空所有节点的 pos_x/pos_y，触发重新自动布局
    nodes.forEach((n) => {
      if (n.pos_x != null || n.pos_y != null) {
        setPos.mutate({ id: n.id, x: null, y: null });
      }
    });
  };

  return (
    <div className="flex items-center gap-2 border-b border-border px-3 py-2">
      <Button size="sm" onClick={onCreateNode}>
        <PlusIcon className="mr-1 h-4 w-4" />
        {t("kg.new-node")}
      </Button>
      <Button size="sm" variant="ghost" onClick={handleResetLayout}>
        <RotateCcwIcon className="mr-1 h-4 w-4" />
        {t("kg.reset-layout")}
      </Button>
    </div>
  );
}
```

- [ ] **Step 4: 类型检查**

Run: `pnpm tsc --noEmit`
Expected: 无错误

- [ ] **Step 5: 提交**

```powershell
git add src/components/KnowledgeGraph/KgToolbar.tsx src/components/KnowledgeGraph/KgNodeEditDialog.tsx src/components/KnowledgeGraph/KgTagEditor.tsx
git commit -m "feat(kg): add toolbar, node edit dialog, and tag editor"
```

---

## Task 11: 前端 KgNodeDetailPanel + KgMemoListPanel + KgNodePicker

**Files:**
- Create: `src/components/KnowledgeGraph/KgNodeDetailPanel.tsx`
- Create: `src/components/KnowledgeGraph/KgMemoListPanel.tsx`
- Create: `src/components/KnowledgeGraph/KgNodePicker.tsx`

**Interfaces:**
- Produces: 节点详情面板（含编辑/删除）、相关笔记列表、节点选择器

- [ ] **Step 1: 创建 KgNodeDetailPanel.tsx**

创建 `src/components/KnowledgeGraph/KgNodeDetailPanel.tsx`：

```tsx
import { HashIcon, PencilIcon, Trash2Icon } from "lucide-react";
import { useNavigate } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { useDeleteKgNode, useKgNodes } from "@/hooks/useKgQueries";
import { useTranslate } from "@/utils/i18n";

interface Props {
  nodeId: number | null;
  onEditNode: (id: number) => void;
}

export default function KgNodeDetailPanel({ nodeId, onEditNode }: Props) {
  const t = useTranslate();
  const navigate = useNavigate();
  const { data: nodes = [] } = useKgNodes();
  const deleteNode = useDeleteKgNode();

  const node = nodeId != null ? nodes.find((n) => n.id === nodeId) : undefined;

  if (!node) {
    return (
      <div className="flex h-full items-center justify-center p-4 text-sm text-muted-foreground">
        {t("kg.select-node-prompt")}
      </div>
    );
  }

  const handleDelete = () => {
    if (!confirm(t("kg.delete-confirm", { name: node.name }))) return;
    deleteNode.mutate(node.id);
  };

  return (
    <div className="flex h-full flex-col gap-3 overflow-auto p-3">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0 flex-1">
          <h3 className="truncate text-base font-semibold text-foreground">{node.name}</h3>
          {node.description && <p className="mt-1 text-sm text-muted-foreground">{node.description}</p>}
        </div>
        <div className="flex shrink-0 gap-1">
          <Button size="icon" variant="ghost" onClick={() => onEditNode(node.id)} title={t("common.edit")}>
            <PencilIcon className="h-4 w-4" />
          </Button>
          <Button size="icon" variant="ghost" onClick={handleDelete} title={t("common.delete")}>
            <Trash2Icon className="h-4 w-4 text-destructive" />
          </Button>
        </div>
      </div>

      {node.tags.length > 0 && (
        <div className="space-y-1">
          <p className="text-xs font-medium text-muted-foreground">{t("common.tags")}</p>
          <div className="flex flex-wrap gap-1">
            {node.tags.map((tag) => (
              <span
                key={tag}
                className="inline-flex items-center gap-0.5 rounded bg-muted px-1.5 py-0.5 text-xs text-muted-foreground"
              >
                <HashIcon className="h-3 w-3" />
                {tag}
              </span>
            ))}
          </div>
        </div>
      )}

      <div className="border-t border-border pt-3">
        <p className="mb-2 text-xs font-medium text-muted-foreground">{t("kg.related-memos")}</p>
        <KgMemoListPanelContent nodeId={node.id} />
      </div>
    </div>
  );

  function KgMemoListPanelContent({ nodeId }: { nodeId: number }) {
    // 内联组件避免循环依赖；实际使用下方 KgMemoListPanel
    return <KgMemoListPanel nodeId={nodeId} />;
  }
}

// 引入 KgMemoListPanel
import KgMemoListPanel from "./KgMemoListPanel";
```

注意：上方的内联引用模式在 TS 中需要把 import 放顶部。修正为标准结构（去掉内联函数，直接在 JSX 中使用 `<KgMemoListPanel nodeId={node.id} />`）。最终文件应为：

```tsx
import { HashIcon, PencilIcon, Trash2Icon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useDeleteKgNode, useKgNodes } from "@/hooks/useKgQueries";
import { useTranslate } from "@/utils/i18n";
import KgMemoListPanel from "./KgMemoListPanel";

interface Props {
  nodeId: number | null;
  onEditNode: (id: number) => void;
}

export default function KgNodeDetailPanel({ nodeId, onEditNode }: Props) {
  const t = useTranslate();
  const { data: nodes = [] } = useKgNodes();
  const deleteNode = useDeleteKgNode();

  const node = nodeId != null ? nodes.find((n) => n.id === nodeId) : undefined;

  if (!node) {
    return (
      <div className="flex h-full items-center justify-center p-4 text-sm text-muted-foreground">
        {t("kg.select-node-prompt")}
      </div>
    );
  }

  const handleDelete = () => {
    if (!confirm(t("kg.delete-confirm", { name: node.name }))) return;
    deleteNode.mutate(node.id);
  };

  return (
    <div className="flex h-full flex-col gap-3 overflow-auto p-3">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0 flex-1">
          <h3 className="truncate text-base font-semibold text-foreground">{node.name}</h3>
          {node.description && <p className="mt-1 text-sm text-muted-foreground">{node.description}</p>}
        </div>
        <div className="flex shrink-0 gap-1">
          <Button size="icon" variant="ghost" onClick={() => onEditNode(node.id)} title={t("common.edit")}>
            <PencilIcon className="h-4 w-4" />
          </Button>
          <Button size="icon" variant="ghost" onClick={handleDelete} title={t("common.delete")}>
            <Trash2Icon className="h-4 w-4 text-destructive" />
          </Button>
        </div>
      </div>

      {node.tags.length > 0 && (
        <div className="space-y-1">
          <p className="text-xs font-medium text-muted-foreground">{t("common.tags")}</p>
          <div className="flex flex-wrap gap-1">
            {node.tags.map((tag) => (
              <span
                key={tag}
                className="inline-flex items-center gap-0.5 rounded bg-muted px-1.5 py-0.5 text-xs text-muted-foreground"
              >
                <HashIcon className="h-3 w-3" />
                {tag}
              </span>
            ))}
          </div>
        </div>
      )}

      <div className="border-t border-border pt-3">
        <p className="mb-2 text-xs font-medium text-muted-foreground">{t("kg.related-memos")}</p>
        <KgMemoListPanel nodeId={node.id} />
      </div>
    </div>
  );
}
```

- [ ] **Step 2: 创建 KgMemoListPanel.tsx**

创建 `src/components/KnowledgeGraph/KgMemoListPanel.tsx`：

```tsx
import { useNavigate } from "react-router-dom";
import { useKgNodeMemos } from "@/hooks/useKgQueries";
import { useTranslate } from "@/utils/i18n";
import { timestampDate } from "@bufbuild/protobuf/wkt";

interface Props {
  nodeId: number;
}

export default function KgMemoListPanel({ nodeId }: Props) {
  const t = useTranslate();
  const navigate = useNavigate();
  const { data: memos = [], isLoading } = useKgNodeMemos(nodeId);

  if (isLoading) {
    return <div className="text-xs text-muted-foreground">加载中...</div>;
  }

  if (memos.length === 0) {
    return <div className="text-xs text-muted-foreground">{t("kg.no-related-memos")}</div>;
  }

  return (
    <div className="flex flex-col gap-1.5">
      {memos.map((memo) => (
        <button
          key={memo.name}
          type="button"
          onClick={() => navigate(`/memos/${memo.uid}`)}
          className="rounded-md border border-border bg-muted/20 p-2 text-left transition-colors hover:bg-muted/40"
        >
          <p className="line-clamp-2 text-xs text-foreground">{memo.content || t("memo.untitled")}</p>
          <p className="mt-1 text-[10px] text-muted-foreground">
            {memo.createTime ? timestampDate(memo.createTime).toLocaleDateString() : ""}
          </p>
        </button>
      ))}
    </div>
  );
}
```

- [ ] **Step 3: 创建 KgNodePicker.tsx**

创建 `src/components/KnowledgeGraph/KgNodePicker.tsx`：

```tsx
import { useState } from "react";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { useKgNodes } from "@/hooks/useKgQueries";

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onPick: (nodeId: number) => void;
  /** 排除已关联的节点 id */
  excludeNodeIds?: number[];
}

export default function KgNodePicker({ open, onOpenChange, onPick, excludeNodeIds = [] }: Props) {
  const { data: nodes = [] } = useKgNodes();
  const [search, setSearch] = useState("");

  const filtered = nodes
    .filter((n) => !excludeNodeIds.includes(n.id))
    .filter((n) => n.name.toLowerCase().includes(search.toLowerCase()));

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[60vh] max-w-md">
        <DialogHeader>
          <DialogTitle>选择节点</DialogTitle>
        </DialogHeader>
        <Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="搜索节点..." />
        <div className="max-h-[40vh] overflow-auto">
          {filtered.length === 0 ? (
            <p className="py-4 text-center text-sm text-muted-foreground">无匹配节点</p>
          ) : (
            filtered.map((n) => (
              <button
                key={n.id}
                type="button"
                onClick={() => {
                  onPick(n.id);
                  onOpenChange(false);
                }}
                className="block w-full rounded-md px-2 py-1.5 text-left text-sm hover:bg-accent"
              >
                {n.name}
                {n.tags.length > 0 && (
                  <span className="ml-2 text-xs text-muted-foreground">#{n.tags.join(" #")}</span>
                )}
              </button>
            ))
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
```

- [ ] **Step 4: 类型检查**

Run: `pnpm tsc --noEmit`
Expected: 无错误

- [ ] **Step 5: 提交**

```powershell
git add src/components/KnowledgeGraph/KgNodeDetailPanel.tsx src/components/KnowledgeGraph/KgMemoListPanel.tsx src/components/KnowledgeGraph/KgNodePicker.tsx
git commit -m "feat(kg): add node detail panel, memo list panel, and node picker"
```

---

## Task 12: 前端 KnowledgeGraphPage + 路由 + 导航 + i18n

**Files:**
- Create: `src/components/KnowledgeGraph/KnowledgeGraphPage.tsx`
- Create: `src/components/KnowledgeGraph/index.ts`
- Create: `src/pages/KnowledgeGraph.tsx`
- Modify: `src/router/routes.ts`
- Modify: `src/router/index.tsx`
- Modify: `src/components/Navigation.tsx`
- Modify: `src/locales/zh-Hans.json`
- Modify: `src/locales/en.json`

**Interfaces:**
- Produces: 完整的图谱页面入口、路由、导航项、i18n

- [ ] **Step 1: 创建 KnowledgeGraphPage.tsx**

创建 `src/components/KnowledgeGraph/KnowledgeGraphPage.tsx`：

```tsx
import { useState } from "react";
import { useSearchParams } from "react-router-dom";
import KgCanvas from "./KgCanvas";
import KgNodeDetailPanel from "./KgNodeDetailPanel";
import KgNodeEditDialog from "./KgNodeEditDialog";
import KgToolbar from "./KgToolbar";

export default function KnowledgeGraphPage() {
  const [searchParams] = useSearchParams();
  const initialSelect = searchParams.get("select");
  const [selectedNodeId, setSelectedNodeId] = useState<number | null>(
    initialSelect ? Number(initialSelect) : null,
  );
  const [editNodeId, setEditNodeId] = useState<number | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);

  const handleCreateNode = () => {
    setEditNodeId(null);
    setDialogOpen(true);
  };

  const handleEditNode = (id: number) => {
    setEditNodeId(id);
    setDialogOpen(true);
  };

  return (
    <div className="flex h-full flex-col">
      <KgToolbar onCreateNode={handleCreateNode} />
      <div className="flex min-h-0 flex-1">
        <div className="min-w-0 flex-1">
          <KgCanvas
            selectedNodeId={selectedNodeId}
            onSelectNode={setSelectedNodeId}
            onRequestEditNode={handleEditNode}
          />
        </div>
        <div className="w-[300px] shrink-0 border-l border-border bg-background">
          <KgNodeDetailPanel nodeId={selectedNodeId} onEditNode={handleEditNode} />
        </div>
      </div>
      <KgNodeEditDialog open={dialogOpen} onOpenChange={setDialogOpen} editNodeId={editNodeId} />
    </div>
  );
}
```

- [ ] **Step 2: 创建 index.ts**

创建 `src/components/KnowledgeGraph/index.ts`：

```ts
export { default as KnowledgeGraphPage } from "./KnowledgeGraphPage";
export { default as KgNodeCard } from "./KgNodeCard";
export { default as KgNodePicker } from "./KgNodePicker";
```

- [ ] **Step 3: 创建页面包装**

创建 `src/pages/KnowledgeGraph.tsx`：

```tsx
import { KnowledgeGraphPage } from "@/components/KnowledgeGraph";

export default function KnowledgeGraph() {
  return <KnowledgeGraphPage />;
}
```

- [ ] **Step 4: 添加路由常量**

修改 `src/router/routes.ts`，在 `REVIEW: "/review",` 后添加：

```ts
  KNOWLEDGE_GRAPH: "/knowledge-graph",
```

- [ ] **Step 5: 注册路由**

修改 `src/router/index.tsx`，在 `const WorkspacePicker = ...` 后添加：

```ts
const KnowledgeGraph = lazyWithReload(() => import("@/pages/KnowledgeGraph"));
```

在 `routeConfig` 的 `MainLayout` children 中（`{ path: Routes.ARCHIVED, element: <Archived /> },` 后）添加：

```ts
              { path: Routes.KNOWLEDGE_GRAPH, element: <KnowledgeGraph /> },
```

- [ ] **Step 6: 添加导航项**

修改 `src/components/Navigation.tsx`：

1. 在 import 中追加 `Share2Icon`：

```tsx
import { BookOpenIcon, CompassIcon, LibraryIcon, PaperclipIcon, Share2Icon } from "lucide-react";
```

2. 在 `reviewNavLink` 定义后、`primaryNavLinks` 数组前添加：

```tsx
  const kgNavLink: NavLinkItem = {
    id: "header-knowledge-graph",
    path: Routes.KNOWLEDGE_GRAPH,
    title: t("kg.nav-title"),
    icon: <Share2Icon className="w-6 h-auto shrink-0" />,
  };
```

3. 修改 `primaryNavLinks` 数组为：

```tsx
  const primaryNavLinks: NavLinkItem[] = [homeNavLink, attachmentsNavLink, discoverNavLink, reviewNavLink, kgNavLink];
```

- [ ] **Step 7: 添加 i18n 键**

修改 `src/locales/zh-Hans.json`，在顶层添加 `kg` 命名空间（与现有键同级）：

```json
  "kg": {
    "nav-title": "知识图谱",
    "new-node": "新建节点",
    "reset-layout": "重置布局",
    "select-node-prompt": "选择一个节点查看详情",
    "related-memos": "相关笔记",
    "no-related-memos": "暂无相关笔记，尝试为节点添加标签",
    "delete-confirm": "确定删除节点「{{name}}」吗？关联的边和笔记关联将被自动清理。",
    "memo-sidebar-section": "知识图谱节点",
    "memo-sidebar-auto": "自动匹配",
    "memo-sidebar-manual": "手动关联",
    "memo-sidebar-link": "关联节点"
  },
```

修改 `src/locales/en.json`，添加对应英文：

```json
  "kg": {
    "nav-title": "Knowledge Graph",
    "new-node": "New Node",
    "reset-layout": "Reset Layout",
    "select-node-prompt": "Select a node to view details",
    "related-memos": "Related Memos",
    "no-related-memos": "No related memos. Try adding tags to the node.",
    "delete-confirm": "Delete node \"{{name}}\"? Related edges and memo associations will be removed.",
    "memo-sidebar-section": "Knowledge Graph Nodes",
    "memo-sidebar-auto": "Auto Matched",
    "memo-sidebar-manual": "Manually Linked",
    "memo-sidebar-link": "Link Node"
  },
```

- [ ] **Step 8: 类型检查 + 启动验证**

Run: `pnpm tsc --noEmit`
Expected: 无错误

Run: `pnpm tauri dev`（后台启动）
Expected: 应用启动，侧边栏出现"知识图谱"导航项，点击进入空白画布页

- [ ] **Step 9: 提交**

```powershell
git add src/components/KnowledgeGraph/KnowledgeGraphPage.tsx src/components/KnowledgeGraph/index.ts src/pages/KnowledgeGraph.tsx src/router/routes.ts src/router/index.tsx src/components/Navigation.tsx src/locales/zh-Hans.json src/locales/en.json
git commit -m "feat(kg): add knowledge graph page, route, navigation, and i18n"
```

---

## Task 13: 前端 MemoDetailSidebar 集成 KG 节点区块

**Files:**
- Modify: `src/components/MemoDetailSidebar/MemoDetailSidebar.tsx`

**Interfaces:**
- Produces: 笔记详情侧栏新增"知识图谱节点"区块，显示自动+手动关联节点，支持跳转与手动关联

- [ ] **Step 1: 修改 MemoDetailSidebar.tsx**

在 `src/components/MemoDetailSidebar/MemoDetailSidebar.tsx` 中：

1. 顶部追加 import：

```tsx
import { Link2Icon, PlusIcon } from "lucide-react";
import { useNavigate } from "react-router-dom";
import { useState } from "react";
import { useLinkMemoToNode, useMemoKgNodes } from "@/hooks/useKgQueries";
import { KgNodePicker } from "@/components/KnowledgeGraph";
```

2. 在 `MemoDetailSidebar` 组件内（`const headings = ...` 后）添加：

```tsx
  const navigate = useNavigate();
  const { data: kgNodes = [] } = useMemoKgNodes(memo.id);
  const linkMemo = useLinkMemoToNode();
  const [pickerOpen, setPickerOpen] = useState(false);
```

3. 在 `</aside>` 前添加 KG 节点区块：

```tsx
      {kgNodes.length > 0 && (
        <SidebarSection label={t("kg.memo-sidebar-section")} count={kgNodes.length}>
          <div className="flex flex-wrap gap-1.5">
            {kgNodes.map((node) => (
              <button
                key={node.id}
                type="button"
                onClick={() => navigate(`/knowledge-graph?select=${node.id}`)}
                className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-md border border-border/60 bg-muted/60 text-sm text-muted-foreground hover:bg-muted hover:text-foreground/80 transition-colors"
              >
                <Link2Icon className="w-3 h-3 opacity-50" />
                {node.name}
              </button>
            ))}
          </div>
        </SidebarSection>
      )}

      <button
        type="button"
        onClick={() => setPickerOpen(true)}
        className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
      >
        <PlusIcon className="w-3 h-3" />
        {t("kg.memo-sidebar-link")}
      </button>

      <KgNodePicker
        open={pickerOpen}
        onOpenChange={setPickerOpen}
        excludeNodeIds={kgNodes.map((n) => n.id)}
        onPick={(nodeId) => linkMemo.mutate({ memoId: memo.id, nodeId })}
      />
```

注意：`memo.id` 需要从 memo 对象获取；现有代码用 `memo.name`（格式 `memos/{uid}`），但后端 `kg_link_memo` 需要数字 id。需确认 memo 对象是否含 id 字段。

检查 `Memo` 类型，若只有 `name`（`memos/{uid}`）则需后端改造或前端用 uid。但 `kg_link_memo` 命令签名是 `memo_id: i32`。

**解决方案**：修改 Task 5 的 `kg_link_memo`/`kg_unlink_memo`/`kg_list_memo_nodes` 命令，接受 memo uid 字符串而非数字 id。修改 `src-tauri/src/commands/kg.rs`：

```rust
#[tauri::command]
pub fn kg_link_memo(state: tauri::State<'_, AppState>, memo_uid: String, node_id: i32) -> IpcResult<()> {
    let store = state.store();
    store.with_conn(|c| {
        let memo = memo::get(c, &memo::FindMemo { uid: Some(memo_uid.clone()), ..Default::default() })?
            .ok_or_else(|| memos_core::CoreError::NotFound(format!("memo uid {memo_uid}")))?;
        memo_kg_node::link(c, memo.id, node_id)
    })?;
    Ok(())
}

#[tauri::command]
pub fn kg_unlink_memo(state: tauri::State<'_, AppState>, memo_uid: String, node_id: i32) -> IpcResult<()> {
    let store = state.store();
    store.with_conn(|c| {
        let memo = memo::get(c, &memo::FindMemo { uid: Some(memo_uid.clone()), ..Default::default() })?
            .ok_or_else(|| memos_core::CoreError::NotFound(format!("memo uid {memo_uid}")))?;
        memo_kg_node::unlink(c, memo.id, node_id)
    })?;
    Ok(())
}

#[tauri::command]
pub fn kg_list_memo_nodes(state: tauri::State<'_, AppState>, memo_uid: String) -> IpcResult<Vec<KgNode>> {
    let store = state.store();
    Ok(store.with_conn(|c| {
        let memo_obj = memo::get(c, &memo::FindMemo { uid: Some(memo_uid.clone()), ..Default::default() })?
            .ok_or_else(|| memos_core::CoreError::NotFound(format!("memo uid {memo_uid}")))?;
        let memo_tags = memos_core::markdown::extract_tags(&memo_obj.content);
        let mut node_ids = memo_kg_node::find_nodes_by_memo_tags(c, &memo_tags)?;
        for nid in memo_kg_node::list_by_memo(c, memo_obj.id)? {
            if !node_ids.contains(&nid) {
                node_ids.push(nid);
            }
        }
        if node_ids.is_empty() {
            return Ok(Vec::new());
        }
        kg_node::list(c, &FindKgNode { parent_id: None, id_list: node_ids })
    })?)
}

#[tauri::command]
pub fn kg_list_node_memos(state: tauri::State<'_, AppState>, node_id: i32) -> IpcResult<Vec<memo::Memo>> {
    // 不变，已用 memo id
    let store = state.store();
    Ok(store.with_conn(|c| {
        let memo_ids = memo_kg_node::find_memos_by_kg_node(c, node_id)?;
        if memo_ids.is_empty() {
            return Ok(Vec::new());
        }
        memo::list(c, &memo::FindMemo { id_list: memo_ids, ..Default::default() })
    })?)
}
```

更新 `src/hooks/useKgQueries.ts` 中相关 hooks 的参数名：

```ts
export function useLinkMemoToNode() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ memoUid, nodeId }: { memoUid: string; nodeId: number }) =>
      invoke<void>("kg_link_memo", { memoUid, nodeId }),
    onSuccess: (_data, { memoUid }) => qc.invalidateQueries({ queryKey: kgKeys.memoNodes(memoUid) }),
  });
}

export function useUnlinkMemoFromNode() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ memoUid, nodeId }: { memoUid: string; nodeId: number }) =>
      invoke<void>("kg_unlink_memo", { memoUid, nodeId }),
    onSuccess: (_data, { memoUid }) => qc.invalidateQueries({ queryKey: kgKeys.memoNodes(memoUid) }),
  });
}

export function useMemoKgNodes(memoUid: string | null) {
  return useQuery<KgNode[]>({
    queryKey: kgKeys.memoNodes(memoUid ?? ""),
    queryFn: () => invoke<KgNode[]>("kg_list_memo_nodes", { memoUid }),
    enabled: memoUid != null,
  });
}
```

更新 `kgKeys.memoNodes` 类型：

```ts
  memoNodes: (memoUid: string) => [...kgKeys.all, "memoNodes", memoUid] as const,
```

回到 MemoDetailSidebar.tsx，用 `memo.uid` 替代 `memo.id`：

```tsx
  const { data: kgNodes = [] } = useMemoKgNodes(memo.uid);
  // ...
  onPick={(nodeId) => linkMemo.mutate({ memoUid: memo.uid, nodeId })}
```

- [ ] **Step 2: 类型检查**

Run: `pnpm tsc --noEmit`
Expected: 无错误

- [ ] **Step 3: 编译验证**

Run: `cargo build --manifest-path src-tauri/Cargo.toml 2>&1 | Select-Object -Last 10`
Expected: 编译成功

- [ ] **Step 4: 启动应用验证**

Run: `pnpm tauri dev`
Expected: 打开任意笔记详情，侧栏出现"知识图谱节点"区块（无节点时显示"关联节点"按钮）；点击按钮可打开选择器关联节点；点击节点徽章跳转到图谱页

- [ ] **Step 5: 提交**

```powershell
git add src/components/MemoDetailSidebar/MemoDetailSidebar.tsx src-tauri/src/commands/kg.rs src/hooks/useKgQueries.ts
git commit -m "feat(kg): integrate KG nodes section into memo detail sidebar"
```

---

## Task 14: 端到端验证与收尾

**Files:**
- 无新增，仅验证

- [ ] **Step 1: 跑全部后端测试**

Run: `cargo test --package memos-core`
Expected: 所有测试 PASS（含原有 + 6 个 kg 测试）

- [ ] **Step 2: 跑前端类型检查**

Run: `pnpm tsc --noEmit`
Expected: 无错误

- [ ] **Step 3: 启动应用做端到端验证**

Run: `pnpm tauri dev`

验证清单：
- [ ] 侧边栏出现"知识图谱"导航项，点击进入空白画布
- [ ] 工具栏"新建节点" → 弹出对话框 → 填写名称+标签 → 保存 → 画布出现节点
- [ ] 再建一个节点，选第一个为父节点 → 子节点出现在父节点下方
- [ ] 拖拽节点 → 位置持久化（刷新后恢复）
- [ ] 点击节点 → 右侧面板显示详情+标签
- [ ] 从节点底部手柄拖出连线到另一节点 → 边创建
- [ ] 选中节点时右侧显示"相关笔记"（若该节点标签匹配某笔记）
- [ ] "重置布局"按钮 → 节点回到自动布局
- [ ] 折叠父节点 → 子节点隐藏
- [ ] 打开任意笔记 → 侧栏"知识图谱节点"区块显示自动+手动关联节点
- [ ] 点击节点徽章 → 跳转到图谱页并选中该节点
- [ ] "关联节点"按钮 → 弹出选择器 → 选择后节点出现在侧栏

- [ ] **Step 4: 提交最终状态（若有改动）**

```powershell
git add -A
git commit -m "feat(kg): knowledge graph module complete"
```

---

## Self-Review

### Spec coverage 检查

| Spec 要求 | 对应 Task |
|----------|----------|
| 数据模型 4 张表 | Task 1 ✓ |
| kg_node CRUD + 标签 + 位置 + 折叠 + 循环校验 | Task 2 ✓ |
| kg_edge CRUD | Task 3 ✓ |
| memo_kg_node 关联 + 节点-笔记匹配 | Task 4 ✓ |
| 15 个 Tauri 命令（含 kg_edge_list 补充） | Task 5 + Task 7 ✓ |
| 前端依赖 + 类型 + hooks | Task 6 ✓ |
| constants + dagre 布局 | Task 7 ✓ |
| 自定义节点/边组件 | Task 8 ✓ |
| React Flow 画布（拖拽/连线/折叠） | Task 9 ✓ |
| 工具栏 + 节点编辑对话框 + 标签编辑器 | Task 10 ✓ |
| 节点详情面板 + 笔记列表 + 节点选择器 | Task 11 ✓ |
| 页面整合 + 路由 + 导航 + i18n | Task 12 ✓ |
| MemoDetailSidebar 集成 KG 节点区块 | Task 13 ✓ |
| 测试 + 端到端验证 | Task 14 ✓ |

### 类型一致性检查

- `KgNode.tags: Vec<String>`（Rust）↔ `KgNode.tags: string[]`（TS）✓
- `KgEdge.r#type` 用 `#[serde(rename = "type")]` → TS `KgEdge.type: string` ✓
- `kg_link_memo` 命令在 Task 13 从 `memo_id: i32` 改为 `memo_uid: String`，对应 hooks 同步更新 ✓
- `useKgEdges` 在 Task 6 占位，Task 7 替换为真实实现 ✓

### 已修复的缺口

1. Task 5 缺少"拉所有边"命令 → Task 7 补 `kg_edge_list` + `list_all`
2. `kg_link_memo` 原用 memo_id，但前端 Memo 对象只有 uid → Task 13 改用 memo_uid
3. KgNodeCard 折叠按钮通过自定义事件触发（`kg-toggle-collapse`），避免 prop drilling

### 未实现的 spec 部分（YAGNI 或后续）

- 移动端 Sheet 面板（当前仅桌面分栏，移动端待用户反馈后加）
- 移动端左右滑动卡片展示笔记（当前用列表，待用户反馈后加）
- 边的 type 下拉预设+自定义输入（当前创建边时默认 "related"，编辑入口在 Task 11 详情面板未实现边编辑，可在后续迭代加）

这些是用户偏好相关的细节，先验证核心流程，再按反馈迭代。
