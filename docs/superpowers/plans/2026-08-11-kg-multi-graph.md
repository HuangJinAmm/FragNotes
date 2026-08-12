# 知识图谱多图谱支持 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在现有知识图谱模块基础上，引入 `kg_graph` 顶层实体，支持多个独立知识体系图谱的创建、切换和管理。

**Architecture:** 新增 `kg_graph` 表作为图谱顶层实体，`kg_node` 增加 `graph_id` 外键归属到某个图谱。每个图谱独立一棵节点树，节点/边/笔记关联按 `graph_id` 隔离。前端通过路由参数 `/knowledge-graph/:graphId` 切换图谱，顶部工具栏集成图谱切换器。

**Tech Stack:** Rust + rusqlite + refinery（后端）；React 19 + TypeScript + TanStack Query + react-router-dom（前端）。

## Global Constraints

- 工作目录：`d:\6-ai\LocalFragNote`
- 包管理器：`pnpm`（前端）；`cargo`（后端）
- Shell：PowerShell（禁用 heredoc，git commit 用单行 `-m`）
- core 模块风格：参照 `core/src/kg_node.rs`，函数以 `&Connection` 为首参数
- Tauri command 风格：参照 `src-tauri/src/commands/kg.rs`，用 `IpcResult<T>` 返回
- 前端 hook 风格：参照 `src/hooks/useKgQueries.ts`，直接 `invoke<T>` 调用
- 迁移文件命名：`V13__add_kg_graph.sql`（refinery 自动按序号执行）
- 测试位置：`core/tests/kg.rs`（已有文件，追加测试）
- 节点的 `graph_id` 创建后不可更改（update 时忽略该字段）
- `memo_kg_node` 模块不需要改动（节点已归属图谱，按 node_id 查询天然隔离）
- 现有数据迁移：V13 迁移时自动创建默认图谱"主图谱"（id=1），现有节点归入该图谱

---

## 文件结构

### 新增文件

| 文件 | 责任 |
|------|------|
| `core/migrations/V13__add_kg_graph.sql` | 建 kg_graph 表，kg_node 加 graph_id 列，迁移现有数据 |
| `core/src/kg_graph.rs` | 图谱实体 + CRUD |
| `src/components/KnowledgeGraph/KgGraphSwitcher.tsx` | 顶部图谱切换下拉框 |
| `src/components/KnowledgeGraph/KgGraphEditDialog.tsx` | 图谱新建/编辑对话框 |

### 修改文件

| 文件 | 改动 |
|------|------|
| `core/src/lib.rs` | 注册 `kg_graph` 模块 |
| `core/src/kg_node.rs` | `KgNode`/`UpsertKgNode`/`FindKgNode` 加 `graph_id`，list 按 graph_id 过滤，update 校验父节点同图谱 |
| `core/tests/kg.rs` | 更新 `make_node` helper 接受 graph_id，追加 kg_graph 测试 |
| `src-tauri/src/commands/kg.rs` | 新增 `kg_graph_*` 命令，`UpsertKgNodeRequest`/`ListKgNodesRequest` 加 graph_id |
| `src-tauri/src/main.rs` | 注册 6 个新命令 |
| `src/types/kg.ts` | 新增 `KgGraph`/`UpsertKgGraphRequest` 类型，`KgNode`/`UpsertKgNodeRequest`/`ListKgNodesRequest` 加 graph_id |
| `src/hooks/useKgQueries.ts` | 新增 `useKgGraphs`/`useCreateKgGraph`/`useUpdateKgGraph`/`useDeleteKgGraph` hooks，`useKgNodes` 接受 graphId 参数 |
| `src/components/KnowledgeGraph/KnowledgeGraphPage.tsx` | 从路由参数读取 graphId，传递给子组件 |
| `src/components/KnowledgeGraph/KgToolbar.tsx` | 集成 KgGraphSwitcher |
| `src/components/KnowledgeGraph/KgNodeEditDialog.tsx` | 创建节点时传入当前 graphId |
| `src/router/routes.ts` | 无需改动（已有 KNOWLEDGE_GRAPH 常量） |
| `src/router/index.tsx` | 新增 `/knowledge-graph/:graphId` 路由 |
| `src/locales/zh-Hans.json` | 追加 kg.graph-* i18n 键 |
| `src/locales/en.json` | 追加 kg.graph-* i18n 键 |

---

## Task 1: 后端 - kg_graph 模块（迁移 + 实体 + CRUD + 测试）

**Files:**
- Create: `core/migrations/V13__add_kg_graph.sql`
- Create: `core/src/kg_graph.rs`
- Modify: `core/src/lib.rs`
- Test: `core/tests/kg.rs`

**Interfaces:**
- Produces: `KgGraph` 结构体（id, uid, name, description, color, icon, created_ts, updated_ts）
- Produces: `UpsertKgGraph` 结构体（uid, name, description, color, icon）
- Produces: `kg_graph::create(conn, &UpsertKgGraph) -> CoreResult<KgGraph>`
- Produces: `kg_graph::update(conn, id, &UpsertKgGraph) -> CoreResult<KgGraph>`
- Produces: `kg_graph::delete(conn, id) -> CoreResult<()>`
- Produces: `kg_graph::get(conn, id) -> CoreResult<KgGraph>`
- Produces: `kg_graph::list(conn) -> CoreResult<Vec<KgGraph>>`

- [ ] **Step 1: 创建迁移文件 V13**

Create `core/migrations/V13__add_kg_graph.sql`:

```sql
-- 知识图谱顶层实体：一个图谱包含一棵节点树
CREATE TABLE IF NOT EXISTS kg_graph (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    uid TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    color TEXT NOT NULL DEFAULT '',
    icon TEXT NOT NULL DEFAULT '',
    created_ts BIGINT NOT NULL DEFAULT (strftime('%s','now')),
    updated_ts BIGINT NOT NULL DEFAULT (strftime('%s','now'))
);

-- 插入默认图谱（id=1），用于归属现有节点
INSERT INTO kg_graph (uid, name, description, color, icon)
VALUES ('default-kg-graph', '主图谱', '默认知识图谱', '', '');

-- kg_node 增加 graph_id 列，现有节点归入默认图谱（id=1）
ALTER TABLE kg_node ADD COLUMN graph_id INTEGER NOT NULL DEFAULT 1;

CREATE INDEX IF NOT EXISTS idx_kg_node_graph ON kg_node(graph_id);
```

- [ ] **Step 2: 创建 kg_graph.rs 模块**

Create `core/src/kg_graph.rs`:

```rust
//! 知识图谱（多图谱顶层实体）CRUD

use crate::error::{CoreError, CoreResult};
use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};

/// 图谱实体
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct KgGraph {
    pub id: i32,
    pub uid: String,
    pub name: String,
    pub description: String,
    pub color: String,
    pub icon: String,
    pub created_ts: i64,
    pub updated_ts: i64,
}

/// 创建/更新参数
#[derive(Debug, Clone)]
pub struct UpsertKgGraph {
    pub uid: String,
    pub name: String,
    pub description: String,
    pub color: String,
    pub icon: String,
}

/// 创建图谱
pub fn create(conn: &Connection, upsert: &UpsertKgGraph) -> CoreResult<KgGraph> {
    let now = chrono::Utc::now().timestamp();
    conn.execute(
        "INSERT INTO kg_graph (uid, name, description, color, icon, created_ts, updated_ts)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?6)",
        params![
            upsert.uid,
            upsert.name,
            upsert.description,
            upsert.color,
            upsert.icon,
            now,
        ],
    )?;
    let id = conn.last_insert_rowid() as i32;
    get(conn, id)
}

/// 更新图谱
pub fn update(conn: &Connection, id: i32, upsert: &UpsertKgGraph) -> CoreResult<KgGraph> {
    let now = chrono::Utc::now().timestamp();
    let affected = conn.execute(
        "UPDATE kg_graph SET name=?2, description=?3, color=?4, icon=?5, updated_ts=?6
         WHERE id=?1",
        params![
            id,
            upsert.name,
            upsert.description,
            upsert.color,
            upsert.icon,
            now,
        ],
    )?;
    if affected == 0 {
        return Err(CoreError::NotFound(format!("kg_graph {id}")));
    }
    get(conn, id)
}

/// 删除图谱（kg_node FK CASCADE 自动清理节点及关联）
pub fn delete(conn: &Connection, id: i32) -> CoreResult<()> {
    let affected = conn.execute("DELETE FROM kg_graph WHERE id=?1", params![id])?;
    if affected == 0 {
        return Err(CoreError::NotFound(format!("kg_graph {id}")));
    }
    Ok(())
}

/// 查询单个图谱
pub fn get(conn: &Connection, id: i32) -> CoreResult<KgGraph> {
    conn.query_row(
        "SELECT id, uid, name, description, color, icon, created_ts, updated_ts
         FROM kg_graph WHERE id=?1",
        params![id],
        map_row,
    )
    .map_err(|e| match e {
        rusqlite::Error::QueryReturnedNoRows => CoreError::NotFound(format!("kg_graph {id}")),
        other => CoreError::Db(other),
    })
}

/// 查询所有图谱
pub fn list(conn: &Connection) -> CoreResult<Vec<KgGraph>> {
    let mut stmt = conn.prepare(
        "SELECT id, uid, name, description, color, icon, created_ts, updated_ts
         FROM kg_graph ORDER BY created_ts ASC",
    )?;
    let rows = stmt.query_map([], map_row)?;
    let mut graphs = Vec::new();
    for r in rows {
        graphs.push(r?);
    }
    Ok(graphs)
}

fn map_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<KgGraph> {
    Ok(KgGraph {
        id: row.get(0)?,
        uid: row.get(1)?,
        name: row.get(2)?,
        description: row.get(3)?,
        color: row.get(4)?,
        icon: row.get(5)?,
        created_ts: row.get(6)?,
        updated_ts: row.get(7)?,
    })
}
```

- [ ] **Step 3: 在 lib.rs 注册模块**

Modify `core/src/lib.rs`, 在 `pub mod kg_node;` 前面加一行：

```rust
pub mod kg_graph;
pub mod kg_node;
```

- [ ] **Step 4: 在 kg.rs 测试文件追加 kg_graph 测试**

Modify `core/tests/kg.rs`, 在文件末尾追加：

```rust
// ========== kg_graph 测试 ==========

fn make_graph(conn: &rusqlite::Connection, name: &str) -> memos_core::kg_graph::KgGraph {
    memos_core::kg_graph::create(conn, &memos_core::kg_graph::UpsertKgGraph {
        uid: format!("graph-{}", name),
        name: name.to_string(),
        description: String::new(),
        color: String::new(),
        icon: String::new(),
    })
    .expect("创建图谱失败")
}

#[test]
fn kg_graph_create_and_get() {
    let store = open_test_store();
    let conn = store.lock_conn();
    let g = make_graph(&conn, "我的图谱");
    assert_eq!(g.name, "我的图谱");
    assert_eq!(g.uid, "graph-我的图谱");
    assert!(g.description.is_empty());

    let got = memos_core::kg_graph::get(&conn, g.id).unwrap();
    assert_eq!(got.id, g.id);
    assert_eq!(got.name, "我的图谱");
}

#[test]
fn kg_graph_update() {
    let store = open_test_store();
    let conn = store.lock_conn();
    let g = make_graph(&conn, "图谱1");

    let updated = memos_core::kg_graph::update(&conn, g.id, &memos_core::kg_graph::UpsertKgGraph {
        uid: "graph-图谱1".into(),
        name: "图谱2".into(),
        description: "描述".into(),
        color: "blue".into(),
        icon: "StarIcon".into(),
    }).unwrap();
    assert_eq!(updated.name, "图谱2");
    assert_eq!(updated.description, "描述");
    assert_eq!(updated.color, "blue");
    assert_eq!(updated.icon, "StarIcon");
}

#[test]
fn kg_graph_list() {
    let store = open_test_store();
    let conn = store.lock_conn();
    // 迁移会自动创建默认图谱，所以 list 至少有 1 个
    let initial = memos_core::kg_graph::list(&conn).unwrap();
    assert!(!initial.is_empty(), "默认图谱应存在");

    make_graph(&conn, "g1");
    make_graph(&conn, "g2");
    let list = memos_core::kg_graph::list(&conn).unwrap();
    assert!(list.len() >= 3, "应有默认 + g1 + g2");
}

#[test]
fn kg_graph_delete_not_found() {
    let store = open_test_store();
    let conn = store.lock_conn();
    let err = memos_core::kg_graph::delete(&conn, 99999);
    assert!(err.is_err());
}
```

- [ ] **Step 5: 运行测试验证通过**

Run: `cargo test -p memos-core --test kg`
Expected: 所有测试 PASS（包括新增的 4 个 kg_graph 测试和原有测试）

注意：原有测试此时仍能通过，因为 `make_node` helper 尚未修改，`UpsertKgNode` 还没有 `graph_id` 字段。Task 2 会修改 `make_node`。

- [ ] **Step 6: Commit**

```bash
git add core/migrations/V13__add_kg_graph.sql core/src/kg_graph.rs core/src/lib.rs core/tests/kg.rs
git commit -m "feat(kg): add kg_graph module with CRUD and migration V13"
```

---

## Task 2: 后端 - kg_node 改造（graph_id 字段 + 过滤 + 校验）

**Files:**
- Modify: `core/src/kg_node.rs`
- Test: `core/tests/kg.rs`

**Interfaces:**
- Consumes: `KgGraph` from Task 1（用于校验父节点同图谱）
- Produces: `KgNode.graph_id: i32` 字段
- Produces: `UpsertKgNode.graph_id: i32` 字段（create 时使用，update 时忽略）
- Produces: `FindKgNode.graph_id: Option<i32>`（None=全部，Some(id)=指定图谱）
- Produces: `kg_node::get_graph_id(conn, id) -> CoreResult<i32>` helper

- [ ] **Step 1: 修改 KgNode 结构体加 graph_id**

Modify `core/src/kg_node.rs`, 在 `KgNode` 结构体中 `id` 字段后加 `graph_id`：

```rust
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct KgNode {
    pub id: i32,
    pub graph_id: i32,
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
```

- [ ] **Step 2: 修改 UpsertKgNode 加 graph_id**

同一文件，在 `UpsertKgNode` 结构体中 `uid` 字段后加 `graph_id`：

```rust
#[derive(Debug, Clone)]
pub struct UpsertKgNode {
    pub uid: String,
    pub graph_id: i32,
    pub name: String,
    pub description: String,
    pub color: String,
    pub icon: String,
    pub parent_id: Option<i32>,
    pub pos_x: Option<f64>,
    pub pos_y: Option<f64>,
    pub collapsed: bool,
}
```

- [ ] **Step 3: 修改 FindKgNode 加 graph_id 过滤**

同一文件，在 `FindKgNode` 结构体中加 `graph_id`：

```rust
#[derive(Debug, Clone, Default)]
pub struct FindKgNode {
    pub graph_id: Option<i32>,
    /// None=全部; Some(None)=根节点; Some(Some(id))=指定父的子节点
    pub parent_id: Option<Option<i32>>,
    pub id_list: Vec<i32>,
}
```

- [ ] **Step 4: 修改 create 函数加 graph_id**

同一文件，修改 `create` 函数的 SQL 和参数：

```rust
pub fn create(conn: &Connection, upsert: &UpsertKgNode) -> CoreResult<KgNode> {
    let now = chrono::Utc::now().timestamp();
    conn.execute(
        "INSERT INTO kg_node (uid, graph_id, name, description, color, icon, parent_id, pos_x, pos_y, collapsed, created_ts, updated_ts)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?11)",
        params![
            upsert.uid,
            upsert.graph_id,
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
```

- [ ] **Step 5: 修改 update 函数（不改 graph_id，校验父节点同图谱）**

同一文件，修改 `update` 函数，在循环校验前加父节点同图谱校验：

```rust
pub fn update(conn: &Connection, id: i32, upsert: &UpsertKgNode) -> CoreResult<KgNode> {
    // 循环校验：parent_id 不能是自身或后代
    if let Some(new_parent) = upsert.parent_id {
        if new_parent == id {
            return Err(CoreError::Other("不能将节点的父级设为自身".into()));
        }
        // 校验父节点必须属于同一图谱
        let current_graph = get_graph_id(conn, id)?;
        let parent_graph = get_graph_id(conn, new_parent)?;
        if parent_graph != current_graph {
            return Err(CoreError::Other("父节点必须属于同一图谱".into()));
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
```

注意：update SQL 不包含 `graph_id`，即 graph_id 不可更改。

- [ ] **Step 6: 修改 get 函数的 SQL 和 map_row**

同一文件，修改 `get` 函数 SQL 加 `graph_id`：

```rust
pub fn get(conn: &Connection, id: i32) -> CoreResult<KgNode> {
    let mut stmt = conn.prepare(
        "SELECT id, graph_id, uid, name, description, color, icon, parent_id, pos_x, pos_y, collapsed, created_ts, updated_ts
         FROM kg_node WHERE id=?1",
    )?;
    let mut node: KgNode = stmt.query_row(params![id], map_row)?;
    node.tags = get_tags(conn, id)?;
    Ok(node)
}
```

- [ ] **Step 7: 修改 list 函数 SQL 加 graph_id 和过滤**

同一文件，修改 `list` 函数：

```rust
pub fn list(conn: &Connection, find: &FindKgNode) -> CoreResult<Vec<KgNode>> {
    let mut sql = String::from(
        "SELECT id, graph_id, uid, name, description, color, icon, parent_id, pos_x, pos_y, collapsed, created_ts, updated_ts
         FROM kg_node WHERE 1=1",
    );
    let mut args: Vec<Box<dyn rusqlite::ToSql>> = Vec::new();

    if let Some(gid) = find.graph_id {
        sql.push_str(" AND graph_id=?");
        args.push(Box::new(gid));
    }

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
    let arg_refs: Vec<&dyn rusqlite::ToSql> = args.iter().map(|b| b.as_ref()).collect();
    let rows = stmt.query_map(arg_refs.as_slice(), map_row)?;
    let mut nodes = Vec::new();
    for row in rows {
        let mut node = row?;
        node.tags = get_tags(conn, node.id)?;
        nodes.push(node);
    }
    Ok(nodes)
}
```

- [ ] **Step 8: 修改 map_row 函数加 graph_id**

同一文件，修改 `map_row` 函数（字段索引全部 +1）：

```rust
fn map_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<KgNode> {
    Ok(KgNode {
        id: row.get(0)?,
        graph_id: row.get(1)?,
        uid: row.get(2)?,
        name: row.get(3)?,
        description: row.get(4)?,
        color: row.get(5)?,
        icon: row.get(6)?,
        parent_id: row.get(7)?,
        pos_x: row.get(8)?,
        pos_y: row.get(9)?,
        collapsed: row.get::<_, i32>(10)? != 0,
        created_ts: row.get(11)?,
        updated_ts: row.get(12)?,
        tags: Vec::new(),
    })
}
```

- [ ] **Step 9: 新增 get_graph_id helper**

同一文件，在 `get_parent_id` 函数后加 `get_graph_id`：

```rust
fn get_graph_id(conn: &Connection, id: i32) -> CoreResult<i32> {
    let graph_id: Option<i32> = conn
        .query_row("SELECT graph_id FROM kg_node WHERE id=?1", params![id], |row| {
            row.get(0)
        })
        .optional()?;
    graph_id.ok_or_else(|| CoreError::NotFound(format!("kg_node {id}")))
}
```

- [ ] **Step 10: 更新测试文件中的 make_node helper**

Modify `core/tests/kg.rs`，修改 `make_node` 函数接受 `graph_id` 参数：

```rust
fn make_node(conn: &rusqlite::Connection, graph_id: i32, name: &str) -> KgNode {
    kg_node::create(conn, &UpsertKgNode {
        uid: format!("kg-{}", name),
        graph_id,
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

- [ ] **Step 11: 更新所有现有测试调用 make_node 的地方**

Modify `core/tests/kg.rs`，所有 `make_node(&conn, "xxx")` 改为 `make_node(&conn, 1, "xxx")`（用默认图谱 id=1）。

需要更新的测试函数和调用点：
- `kg_node_create`: `make_node(&conn, "root")` → `make_node(&conn, 1, "root")`
- `kg_node_update_and_circular_check`: 2 处（parent 和 make_node 调用）
- `kg_node_tags_and_position`: `make_node(&conn, "n1")` → `make_node(&conn, 1, "n1")`
- `kg_node_delete_cascades`: 2 处（n1, n2）
- `kg_edge_create_and_list`: 2 处（n1, n2）
- `kg_edge_unique_and_delete`: 2 处（n1, n2）
- `memo_kg_node_link_and_find`: 2 处（rust-node, manual-node）
- `memo_kg_node_empty_tags`: 1 处（empty-node）

同时 `kg_node_update_and_circular_check` 中的 `kg_node::create` 调用需要加 `graph_id: 1`：

```rust
let child = kg_node::create(&conn, &UpsertKgNode {
    uid: "kg-child".into(),
    graph_id: 1,
    name: "child".into(),
    description: String::new(),
    color: String::new(),
    icon: String::new(),
    parent_id: Some(parent.id),
    pos_x: None,
    pos_y: None,
    collapsed: false,
}).unwrap();
```

以及 `kg_node_update_and_circular_check` 中的两个 `kg_node::update` 调用需要加 `graph_id: 1`：

```rust
let updated = kg_node::update(&conn, child.id, &UpsertKgNode {
    uid: "kg-child".into(),
    graph_id: 1,
    name: "child2".into(),
    // ... 其余不变
}).unwrap();
```

```rust
let err = kg_node::update(&conn, parent.id, &UpsertKgNode {
    uid: "kg-parent".into(),
    graph_id: 1,
    name: "parent".into(),
    // ... 其余不变
});
```

- [ ] **Step 12: 追加 graph_id 隔离测试**

在 `core/tests/kg.rs` 末尾追加：

```rust
#[test]
fn kg_node_graph_isolation() {
    let store = open_test_store();
    let conn = store.lock_conn();

    // 创建第二个图谱
    let g2 = make_graph(&conn, "图谱2");

    // 在默认图谱(id=1)和图谱2各创建节点
    let n1 = make_node(&conn, 1, "default-node");
    let n2 = make_node(&conn, g2.id, "g2-node");

    // list 按 graph_id 过滤
    let default_nodes = kg_node::list(&conn, &FindKgNode { graph_id: Some(1), parent_id: None, id_list: vec![] }).unwrap();
    assert!(default_nodes.iter().any(|n| n.id == n1.id));
    assert!(!default_nodes.iter().any(|n| n.id == n2.id));

    let g2_nodes = kg_node::list(&conn, &FindKgNode { graph_id: Some(g2.id), parent_id: None, id_list: vec![] }).unwrap();
    assert!(g2_nodes.iter().any(|n| n.id == n2.id));
    assert!(!g2_nodes.iter().any(|n| n.id == n1.id));
}

#[test]
fn kg_node_cross_graph_parent_rejected() {
    let store = open_test_store();
    let conn = store.lock_conn();

    let g2 = make_graph(&conn, "图谱2");
    let n1 = make_node(&conn, 1, "default-node");
    let n2 = make_node(&conn, g2.id, "g2-node");

    // 尝试把 n2 的 parent 设为 n1（跨图谱）应失败
    let err = kg_node::update(&conn, n2.id, &UpsertKgNode {
        uid: n2.uid.clone(),
        graph_id: g2.id,
        name: n2.name.clone(),
        description: String::new(),
        color: String::new(),
        icon: String::new(),
        parent_id: Some(n1.id),
        pos_x: None,
        pos_y: None,
        collapsed: false,
    });
    assert!(err.is_err(), "应拒绝跨图谱父子关系");
}
```

- [ ] **Step 13: 运行测试验证通过**

Run: `cargo test -p memos-core --test kg`
Expected: 所有测试 PASS（包括原有测试和新增的 graph 隔离测试）

- [ ] **Step 14: Commit**

```bash
git add core/src/kg_node.rs core/tests/kg.rs
git commit -m "feat(kg): add graph_id to kg_node with isolation and cross-graph validation"
```

---

## Task 3: IPC 命令层（kg_graph CRUD + 扩展 kg_node 命令）

**Files:**
- Modify: `src-tauri/src/commands/kg.rs`
- Modify: `src-tauri/src/main.rs`

**Interfaces:**
- Consumes: `kg_graph` module from Task 1, updated `kg_node` from Task 2
- Produces: Tauri commands: `kg_graph_create`, `kg_graph_update`, `kg_graph_delete`, `kg_graph_get`, `kg_graph_list`
- Produces: Updated `UpsertKgNodeRequest` with `graph_id: i32`
- Produces: Updated `ListKgNodesRequest` with `graph_id: Option<i32>`

- [ ] **Step 1: 在 commands/kg.rs 顶部加 kg_graph 导入**

Modify `src-tauri/src/commands/kg.rs`，修改 import 行：

```rust
use memos_core::kg_edge::{self, KgEdge};
use memos_core::kg_graph::{self, KgGraph, UpsertKgGraph};
use memos_core::kg_node::{self, FindKgNode, KgNode, UpsertKgNode};
use memos_core::memo;
use memos_core::memo_kg_node;
use serde::Deserialize;
```

- [ ] **Step 2: 修改 UpsertKgNodeRequest 加 graph_id**

同一文件，在 `UpsertKgNodeRequest` 结构体中 `uid` 后加 `graph_id`：

```rust
#[derive(Debug, Deserialize)]
pub struct UpsertKgNodeRequest {
    pub uid: String,
    pub graph_id: i32,
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
```

- [ ] **Step 3: 修改 From<UpsertKgNodeRequest> for UpsertKgNode impl**

同一文件，修改 `From` impl 加 `graph_id`：

```rust
impl From<UpsertKgNodeRequest> for UpsertKgNode {
    fn from(r: UpsertKgNodeRequest) -> Self {
        UpsertKgNode {
            uid: r.uid,
            graph_id: r.graph_id,
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
```

注意：`UpsertKgNodeRequest` 缺少 `name` 字段（原代码如此），需确认。查看原代码发现 `name` 字段确实在结构体中存在但被遗漏了。补上：

```rust
#[derive(Debug, Deserialize)]
pub struct UpsertKgNodeRequest {
    pub uid: String,
    pub graph_id: i32,
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
```

- [ ] **Step 4: 修改 ListKgNodesRequest 加 graph_id**

同一文件，在 `ListKgNodesRequest` 结构体中加 `graph_id`：

```rust
#[derive(Debug, Deserialize, Default)]
pub struct ListKgNodesRequest {
    pub graph_id: Option<i32>,
    /// None=全部; Some(None)=根节点; Some(Some(id))=指定父的子节点
    pub parent_id: Option<Option<i32>>,
    pub id_list: Option<Vec<i32>>,
}
```

- [ ] **Step 5: 修改 kg_node_list 命令传 graph_id**

同一文件，修改 `kg_node_list` 函数：

```rust
#[tauri::command]
pub fn kg_node_list(state: tauri::State<'_, AppState>, req: ListKgNodesRequest) -> IpcResult<Vec<KgNode>> {
    let store = state.store();
    let find = FindKgNode {
        graph_id: req.graph_id,
        parent_id: req.parent_id,
        id_list: req.id_list.unwrap_or_default(),
    };
    Ok(store.with_conn(|c| kg_node::list(c, &find))?)
}
```

- [ ] **Step 6: 新增 UpsertKgGraphRequest 和 kg_graph_* 命令**

同一文件，在 `ListKgEdgesRequest` 定义前加：

```rust
#[derive(Debug, Deserialize)]
pub struct UpsertKgGraphRequest {
    pub uid: String,
    pub name: String,
    #[serde(default)]
    pub description: String,
    #[serde(default)]
    pub color: String,
    #[serde(default)]
    pub icon: String,
}

impl From<UpsertKgGraphRequest> for UpsertKgGraph {
    fn from(r: UpsertKgGraphRequest) -> Self {
        UpsertKgGraph {
            uid: r.uid,
            name: r.name,
            description: r.description,
            color: r.color,
            icon: r.icon,
        }
    }
}

#[tauri::command]
pub fn kg_graph_create(state: tauri::State<'_, AppState>, req: UpsertKgGraphRequest) -> IpcResult<KgGraph> {
    let store = state.store();
    Ok(store.with_conn(|c| kg_graph::create(c, &req.into()))?)
}

#[tauri::command]
pub fn kg_graph_update(state: tauri::State<'_, AppState>, id: i32, req: UpsertKgGraphRequest) -> IpcResult<KgGraph> {
    let store = state.store();
    Ok(store.with_conn(|c| kg_graph::update(c, id, &req.into()))?)
}

#[tauri::command]
pub fn kg_graph_delete(state: tauri::State<'_, AppState>, id: i32) -> IpcResult<()> {
    let store = state.store();
    store.with_conn(|c| kg_graph::delete(c, id))?;
    Ok(())
}

#[tauri::command]
pub fn kg_graph_get(state: tauri::State<'_, AppState>, id: i32) -> IpcResult<KgGraph> {
    let store = state.store();
    Ok(store.with_conn(|c| kg_graph::get(c, id))?)
}

#[tauri::command]
pub fn kg_graph_list(state: tauri::State<'_, AppState>) -> IpcResult<Vec<KgGraph>> {
    let store = state.store();
    Ok(store.with_conn(|c| kg_graph::list(c))?)
}
```

- [ ] **Step 7: 在 main.rs 注册新命令**

Modify `src-tauri/src/main.rs`，在 `// knowledge graph` 注释块的 `commands::kg::kg_node_create` 前加 5 个图谱命令：

```rust
            // knowledge graph
            commands::kg::kg_graph_create,
            commands::kg::kg_graph_update,
            commands::kg::kg_graph_delete,
            commands::kg::kg_graph_get,
            commands::kg::kg_graph_list,
            commands::kg::kg_node_create,
```

- [ ] **Step 8: 验证编译通过**

Run: `$env:Path += ";$env:USERPROFILE\.cargo\bin"; cargo check --manifest-path src-tauri/Cargo.toml`
Expected: 编译成功无错误

- [ ] **Step 9: Commit**

```bash
git add src-tauri/src/commands/kg.rs src-tauri/src/main.rs
git commit -m "feat(kg): add kg_graph IPC commands and graph_id to kg_node requests"
```

---

## Task 4: 前端 - 类型 + hooks

**Files:**
- Modify: `src/types/kg.ts`
- Modify: `src/hooks/useKgQueries.ts`

**Interfaces:**
- Consumes: Tauri commands from Task 3
- Produces: `KgGraph`/`UpsertKgGraphRequest` TypeScript 类型
- Produces: `useKgGraphs`/`useCreateKgGraph`/`useUpdateKgGraph`/`useDeleteKgGraph` hooks
- Produces: Updated `useKgNodes(graphId?)` 接受可选 graphId 参数

- [ ] **Step 1: 在 types/kg.ts 加 KgGraph 类型和更新 KgNode**

Modify `src/types/kg.ts`，在文件顶部加 `KgGraph` 类型，并在 `KgNode` 中加 `graph_id`：

```typescript
// 知识图谱前端类型（与后端 Rust serde 序列化对齐）

export interface KgGraph {
  id: number;
  uid: string;
  name: string;
  description: string;
  color: string;
  icon: string;
  created_ts: number;
  updated_ts: number;
}

export interface UpsertKgGraphRequest {
  uid: string;
  name: string;
  description?: string;
  color?: string;
  icon?: string;
}

export interface KgNode {
  id: number;
  graph_id: number;
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
  graph_id: number;
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
  graph_id?: number | null;
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

- [ ] **Step 2: 在 useKgQueries.ts 加 graph query keys**

Modify `src/hooks/useKgQueries.ts`，在 `kgKeys` 中加 `graphs`：

```typescript
export const kgKeys = {
  all: ["kg"] as const,
  graphs: () => [...kgKeys.all, "graphs"] as const,
  nodes: () => [...kgKeys.all, "nodes"] as const,
  edges: () => [...kgKeys.all, "edges"] as const,
  nodeMemos: (nodeId: number) => [...kgKeys.all, "nodeMemos", nodeId] as const,
  memoNodes: (memoUid: string) => [...kgKeys.all, "memoNodes", memoUid] as const,
};
```

- [ ] **Step 3: 修改 useKgNodes 接受 graphId 参数**

同一文件，修改 `useKgNodes`：

```typescript
export function useKgNodes(graphId?: number) {
  return useQuery<KgNode[]>({
    queryKey: [...kgKeys.nodes(), graphId ?? "all"],
    queryFn: () =>
      invoke<KgNode[]>("kg_node_list", {
        req: { graph_id: graphId ?? null } as ListKgNodesRequest,
      }),
  });
}
```

- [ ] **Step 4: 更新 useCreateKgNode/useUpdateKgNode 的 onSuccess 失效策略**

同一文件，修改 `useCreateKgNode` 和 `useUpdateKgNode` 的 `onSuccess`，改为失效整个 nodes 缓存（因为按 graphId 分了 key）：

```typescript
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
```

注意：`kgKeys.nodes()` 返回 `["kg", "nodes"]`，`invalidateQueries` 会匹配所有以它为前缀的 key，包括 `["kg", "nodes", 1]` 和 `["kg", "nodes", "all"]`。

- [ ] **Step 5: 新增 kg_graph hooks**

同一文件，在 `useKgNodes` 前加图谱 hooks：

```typescript
export function useKgGraphs() {
  return useQuery<KgGraph[]>({
    queryKey: kgKeys.graphs(),
    queryFn: () => invoke<KgGraph[]>("kg_graph_list"),
  });
}

export function useCreateKgGraph() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (req: UpsertKgGraphRequest) => invoke<KgGraph>("kg_graph_create", { req }),
    onSuccess: () => qc.invalidateQueries({ queryKey: kgKeys.graphs() }),
  });
}

export function useUpdateKgGraph() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, req }: { id: number; req: UpsertKgGraphRequest }) =>
      invoke<KgGraph>("kg_graph_update", { id, req }),
    onSuccess: () => qc.invalidateQueries({ queryKey: kgKeys.graphs() }),
  });
}

export function useDeleteKgGraph() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: number) => invoke<void>("kg_graph_delete", { id }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: kgKeys.graphs() });
      qc.invalidateQueries({ queryKey: kgKeys.all });
    },
  });
}
```

- [ ] **Step 6: 更新 import 导入新类型**

同一文件，修改 import 加 `KgGraph` 和 `UpsertKgGraphRequest`：

```typescript
import type {
  CreateKgEdgeRequest,
  KgEdge,
  KgGraph,
  KgNode,
  ListKgNodesRequest,
  SetKgPositionRequest,
  UpdateKgEdgeRequest,
  UpsertKgGraphRequest,
  UpsertKgNodeRequest,
} from "@/types/kg";
```

- [ ] **Step 7: 验证 TypeScript 编译通过**

Run: `pnpm tsc --noEmit`
Expected: 无错误

- [ ] **Step 8: Commit**

```bash
git add src/types/kg.ts src/hooks/useKgQueries.ts
git commit -m "feat(kg): add KgGraph types and hooks, update useKgNodes with graphId param"
```

---

## Task 5: 前端 - 图谱切换器 + 编辑对话框组件

**Files:**
- Create: `src/components/KnowledgeGraph/KgGraphSwitcher.tsx`
- Create: `src/components/KnowledgeGraph/KgGraphEditDialog.tsx`

**Interfaces:**
- Consumes: `useKgGraphs`/`useCreateKgGraph`/`useUpdateKgGraph`/`useDeleteKgGraph` from Task 4
- Produces: `KgGraphSwitcher` 组件（props: currentGraphId, onSelect, onCreateGraph）
- Produces: `KgGraphEditDialog` 组件（props: open, onOpenChange, editGraphId?）

- [ ] **Step 1: 创建 KgGraphEditDialog 组件**

Create `src/components/KnowledgeGraph/KgGraphEditDialog.tsx`:

```tsx
import { useEffect, useState } from "react";
import { generateUUID } from "@/utils/uuid";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { useCreateKgGraph, useKgGraphs, useUpdateKgGraph } from "@/hooks/useKgQueries";
import type { UpsertKgGraphRequest } from "@/types/kg";
import { NODE_COLOR_PALETTE } from "./constants";

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** 传入图谱 id 表示编辑；null/undefined 表示新建 */
  editGraphId?: number | null;
}

export default function KgGraphEditDialog({ open, onOpenChange, editGraphId }: Props) {
  const { data: graphs = [] } = useKgGraphs();
  const createGraph = useCreateKgGraph();
  const updateGraph = useUpdateKgGraph();

  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [color, setColor] = useState("");

  useEffect(() => {
    if (!open) return;
    if (editGraphId != null) {
      const graph = graphs.find((g) => g.id === editGraphId);
      if (graph) {
        setName(graph.name);
        setDescription(graph.description);
        setColor(graph.color);
      }
    } else {
      setName("");
      setDescription("");
      setColor("");
    }
  }, [open, editGraphId, graphs]);

  const handleSave = () => {
    if (!name.trim()) return;
    const editingGraph = editGraphId != null ? graphs.find((g) => g.id === editGraphId) : undefined;
    const req: UpsertKgGraphRequest = {
      uid: editingGraph?.uid ?? generateUUID(),
      name: name.trim(),
      description,
      color,
    };
    if (editGraphId != null) {
      updateGraph.mutate(
        { id: editGraphId, req },
        { onSuccess: () => onOpenChange(false) },
      );
    } else {
      createGraph.mutate(req, {
        onSuccess: () => onOpenChange(false),
      });
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>{editGraphId != null ? "编辑图谱" : "新建图谱"}</DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          <div className="space-y-1">
            <Label htmlFor="kg-graph-name">名称 *</Label>
            <Input id="kg-graph-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="图谱名称" />
          </div>
          <div className="space-y-1">
            <Label htmlFor="kg-graph-desc">描述</Label>
            <Textarea id="kg-graph-desc" value={description} onChange={(e) => setDescription(e.target.value)} rows={2} />
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
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            取消
          </Button>
          <Button onClick={handleSave} disabled={!name.trim() || createGraph.isPending || updateGraph.isPending}>
            保存
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
```

- [ ] **Step 2: 创建 KgGraphSwitcher 组件**

Create `src/components/KnowledgeGraph/KgGraphSwitcher.tsx`:

```tsx
import { ChevronDownIcon, PlusIcon, SettingsIcon, Trash2Icon } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { useDeleteKgGraph, useKgGraphs } from "@/hooks/useKgQueries";
import KgGraphEditDialog from "./KgGraphEditDialog";

interface Props {
  currentGraphId: number | null;
  onSelect: (id: number) => void;
}

export default function KgGraphSwitcher({ currentGraphId, onSelect }: Props) {
  const { data: graphs = [] } = useKgGraphs();
  const deleteGraph = useDeleteKgGraph();
  const [dropdownOpen, setDropdownOpen] = useState(false);
  const [editDialogOpen, setEditDialogOpen] = useState(false);
  const [editGraphId, setEditGraphId] = useState<number | null>(null);

  const currentGraph = graphs.find((g) => g.id === currentGraphId);

  const handleCreate = () => {
    setEditGraphId(null);
    setEditDialogOpen(true);
    setDropdownOpen(false);
  };

  const handleEdit = (id: number) => {
    setEditGraphId(id);
    setEditDialogOpen(true);
    setDropdownOpen(false);
  };

  const handleDelete = (id: number, name: string) => {
    if (!confirm(`确定删除图谱「${name}」吗？所有节点和关联将被删除。`)) return;
    deleteGraph.mutate(id);
    setDropdownOpen(false);
  };

  return (
    <div className="relative">
      <Button
        size="sm"
        variant="outline"
        onClick={() => setDropdownOpen((v) => !v)}
        className="min-w-[140px] justify-between"
      >
        <span className="truncate">{currentGraph?.name ?? "选择图谱"}</span>
        <ChevronDownIcon className="ml-1 h-4 w-4 shrink-0" />
      </Button>

      {dropdownOpen && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setDropdownOpen(false)} />
          <div className="absolute left-0 top-full z-50 mt-1 min-w-[220px] rounded-md border border-border bg-popover shadow-md">
            <div className="max-h-[300px] overflow-auto py-1">
              {graphs.length === 0 ? (
                <p className="px-3 py-2 text-sm text-muted-foreground">暂无图谱</p>
              ) : (
                graphs.map((g) => (
                  <div
                    key={g.id}
                    className={`group flex items-center gap-1 px-2 py-1.5 hover:bg-accent ${g.id === currentGraphId ? "bg-accent/50" : ""}`}
                  >
                    <button
                      type="button"
                      onClick={() => {
                        onSelect(g.id);
                        setDropdownOpen(false);
                      }}
                      className="min-w-0 flex-1 text-left text-sm"
                    >
                      <span className="truncate">{g.name}</span>
                      {g.description && (
                        <span className="ml-1 text-xs text-muted-foreground">— {g.description}</span>
                      )}
                    </button>
                    <button
                      type="button"
                      onClick={() => handleEdit(g.id)}
                      className="shrink-0 rounded p-0.5 text-muted-foreground opacity-0 hover:text-foreground group-hover:opacity-100"
                      title="编辑"
                    >
                      <SettingsIcon className="h-3.5 w-3.5" />
                    </button>
                    <button
                      type="button"
                      onClick={() => handleDelete(g.id, g.name)}
                      className="shrink-0 rounded p-0.5 text-muted-foreground opacity-0 hover:text-destructive group-hover:opacity-100"
                      title="删除"
                    >
                      <Trash2Icon className="h-3.5 w-3.5" />
                    </button>
                  </div>
                ))
              )}
            </div>
            <div className="border-t border-border py-1">
              <button
                type="button"
                onClick={handleCreate}
                className="flex w-full items-center gap-1.5 px-2 py-1.5 text-left text-sm hover:bg-accent"
              >
                <PlusIcon className="h-4 w-4" />
                新建图谱
              </button>
            </div>
          </div>
        </>
      )}

      <KgGraphEditDialog open={editDialogOpen} onOpenChange={setEditDialogOpen} editGraphId={editGraphId} />
    </div>
  );
}
```

- [ ] **Step 3: 验证 TypeScript 编译通过**

Run: `pnpm tsc --noEmit`
Expected: 无错误

- [ ] **Step 4: Commit**

```bash
git add src/components/KnowledgeGraph/KgGraphSwitcher.tsx src/components/KnowledgeGraph/KgGraphEditDialog.tsx
git commit -m "feat(kg): add KgGraphSwitcher and KgGraphEditDialog components"
```

---

## Task 6: 前端 - 集成（路由 + 页面 + 工具栏 + i18n）

**Files:**
- Modify: `src/router/index.tsx`
- Modify: `src/components/KnowledgeGraph/KnowledgeGraphPage.tsx`
- Modify: `src/components/KnowledgeGraph/KgToolbar.tsx`
- Modify: `src/components/KnowledgeGraph/KgNodeEditDialog.tsx`
- Modify: `src/locales/zh-Hans.json`
- Modify: `src/locales/en.json`

**Interfaces:**
- Consumes: All components and hooks from Tasks 4-5
- Produces: 路由 `/knowledge-graph/:graphId` 支持
- Produces: KnowledgeGraphPage 从路由参数读取 graphId
- Produces: KgToolbar 集成图谱切换器

- [ ] **Step 1: 在 router/index.tsx 加 :graphId 路由**

Modify `src/router/index.tsx`，在现有 `knowledge-graph` 路由后加一条：

```tsx
          { path: Routes.KNOWLEDGE_GRAPH, element: <KnowledgeGraph /> },
          { path: "knowledge-graph/:graphId", element: <KnowledgeGraph /> },
```

- [ ] **Step 2: 修改 KnowledgeGraphPage 从路由读取 graphId**

Modify `src/components/KnowledgeGraph/KnowledgeGraphPage.tsx`:

```tsx
import { useState } from "react";
import { useNavigate, useParams, useSearchParams } from "react-router-dom";
import KgCanvas from "./KgCanvas";
import KgGraphSwitcher from "./KgGraphSwitcher";
import KgNodeDetailPanel from "./KgNodeDetailPanel";
import KgNodeEditDialog from "./KgNodeEditDialog";
import KgToolbar from "./KgToolbar";

export default function KnowledgeGraphPage() {
  const params = useParams();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();

  const graphId = params.graphId ? Number(params.graphId) : null;
  const initialSelect = searchParams.get("select");
  const [selectedNodeId, setSelectedNodeId] = useState<number | null>(
    initialSelect ? Number(initialSelect) : null,
  );
  const [editNodeId, setEditNodeId] = useState<number | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);

  const handleSelectGraph = (id: number) => {
    navigate(`/knowledge-graph/${id}`);
  };

  const handleCreateNode = () => {
    if (graphId == null) return;
    setEditNodeId(null);
    setDialogOpen(true);
  };

  const handleEditNode = (id: number) => {
    setEditNodeId(id);
    setDialogOpen(true);
  };

  if (graphId == null) {
    return (
      <div className="flex h-svh w-full flex-col">
        <KgToolbar graphId={null} onCreateNode={handleCreateNode} onSelectGraph={handleSelectGraph} />
        <div className="flex flex-1 items-center justify-center text-sm text-muted-foreground">
          请选择或创建一个图谱
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-svh w-full flex-col">
      <KgToolbar graphId={graphId} onCreateNode={handleCreateNode} onSelectGraph={handleSelectGraph} />
      <div className="flex min-h-0 flex-1">
        <div className="min-w-0 flex-1">
          <KgCanvas
            graphId={graphId}
            selectedNodeId={selectedNodeId}
            onSelectNode={setSelectedNodeId}
            onRequestEditNode={handleEditNode}
          />
        </div>
        <div className="w-[300px] shrink-0 border-l border-border bg-background">
          <KgNodeDetailPanel nodeId={selectedNodeId} onEditNode={handleEditNode} />
        </div>
      </div>
      <KgNodeEditDialog open={dialogOpen} onOpenChange={setDialogOpen} editNodeId={editNodeId} graphId={graphId} />
    </div>
  );
}
```

- [ ] **Step 3: 修改 KgToolbar 集成图谱切换器**

Modify `src/components/KnowledgeGraph/KgToolbar.tsx`:

```tsx
import { PlusIcon, RotateCcwIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useKgNodes, useSetKgNodePosition } from "@/hooks/useKgQueries";
import { useTranslate } from "@/utils/i18n";
import KgGraphSwitcher from "./KgGraphSwitcher";

interface Props {
  graphId: number | null;
  onCreateNode: () => void;
  onSelectGraph: (id: number) => void;
}

export default function KgToolbar({ graphId, onCreateNode, onSelectGraph }: Props) {
  const t = useTranslate() as (key: string, params?: Record<string, unknown>) => string;
  const { data: nodes = [] } = useKgNodes(graphId ?? undefined);
  const setPos = useSetKgNodePosition();

  const handleResetLayout = () => {
    nodes.forEach((n) => {
      if (n.pos_x != null || n.pos_y != null) {
        setPos.mutate({ id: n.id, x: null, y: null });
      }
    });
  };

  return (
    <div className="flex items-center gap-2 border-b border-border px-3 py-2">
      <KgGraphSwitcher currentGraphId={graphId} onSelect={onSelectGraph} />
      <Button size="sm" onClick={onCreateNode} disabled={graphId == null}>
        <PlusIcon className="mr-1 h-4 w-4" />
        {t("kg.new-node")}
      </Button>
      <Button size="sm" variant="ghost" onClick={handleResetLayout} disabled={graphId == null}>
        <RotateCcwIcon className="mr-1 h-4 w-4" />
        {t("kg.reset-layout")}
      </Button>
    </div>
  );
}
```

- [ ] **Step 4: 修改 KgCanvas 接受 graphId 参数**

Modify `src/components/KnowledgeGraph/KgCanvas.tsx`，在 Props 接口加 `graphId`，并传给 `useKgNodes`：

```tsx
interface Props {
  graphId: number;
  selectedNodeId: number | null;
  onSelectNode: (id: number | null) => void;
  onRequestEditNode: (id: number) => void;
}

function KgCanvasInner({ graphId, selectedNodeId, onSelectNode, onRequestEditNode }: Props) {
  const { data: nodes = [] } = useKgNodes(graphId);
  const { data: edges = [] } = useKgEdges();
  // ... 其余不变
```

同时修改 `KgCanvas` 默认导出函数的 Props 传递（不变，因为外层组件会传 graphId）。

- [ ] **Step 5: 修改 KgNodeDetailPanel 使用全量节点查询**

Modify `src/components/KnowledgeGraph/KgNodeDetailPanel.tsx`，由于 `useKgNodes` 现在需要 graphId，但详情面板只需要从缓存中找到节点。改为不带 graphId 查询全部节点：

```tsx
const { data: nodes = [] } = useKgNodes();
```

这样会查询所有图谱的节点（`graph_id=null`），确保能找到选中的节点。React Query 会复用缓存。

- [ ] **Step 6: 修改 KgNodeEditDialog 接受 graphId 参数**

Modify `src/components/KnowledgeGraph/KgNodeEditDialog.tsx`：

在 Props 接口加 `graphId`：

```tsx
interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  editNodeId?: number | null;
  defaultParentId?: number | null;
  graphId: number;
}
```

在 `handleSave` 中，创建节点时使用传入的 `graphId`：

```tsx
const handleSave = () => {
  if (!name.trim()) return;
  const editingNode = editNodeId != null ? nodes.find((n) => n.id === editNodeId) : undefined;
  const req: UpsertKgNodeRequest = {
    uid: editingNode?.uid ?? generateUUID(),
    graph_id: editingNode?.graph_id ?? graphId,
    name: name.trim(),
    description,
    color,
    icon,
    parent_id: parentId,
    pos_x: editingNode?.pos_x ?? null,
    pos_y: editingNode?.pos_y ?? null,
    collapsed: editingNode?.collapsed ?? false,
  };
  // ... 其余不变
};
```

同时修改函数签名：

```tsx
export default function KgNodeEditDialog({ open, onOpenChange, editNodeId, defaultParentId, graphId }: Props) {
```

以及候选父节点列表只显示同一图谱的节点：

```tsx
const candidateParents = nodes.filter((n) => n.id !== editNodeId && n.graph_id === graphId);
```

- [ ] **Step 7: 修改 KgNodePicker 适配全量查询**

`src/components/KnowledgeGraph/KgNodePicker.tsx` 已经使用 `useKgNodes()`（不带参数），这会查询全部图谱的节点。保持不变即可。

- [ ] **Step 8: 修改 MemoDetailSidebar 跳转 URL 带上 graphId**

Modify `src/components/MemoDetailSidebar/MemoDetailSidebar.tsx`，节点跳转 URL 从 `/knowledge-graph?select=xxx` 改为 `/knowledge-graph/{graphId}?select=xxx`：

```tsx
{kgNodes.map((node) => (
  <button
    key={node.id}
    type="button"
    onClick={() => navigate(`/knowledge-graph/${node.graph_id}?select=${node.id}`)}
    className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-md border border-border/60 bg-muted/60 text-sm text-muted-foreground hover:bg-muted hover:text-foreground/80 transition-colors"
  >
    <Link2Icon className="w-3 h-3 opacity-50" />
    {node.name}
  </button>
))}
```

- [ ] **Step 9: 追加 i18n 键**

Modify `src/locales/zh-Hans.json`，在 `kg` 命名空间内追加（在 `"memo-sidebar-link"` 后）：

```json
    "memo-sidebar-link": "关联节点",
    "graph-select-prompt": "请选择或创建一个图谱",
    "graph-delete-confirm": "确定删除图谱「{{name}}」吗？所有节点和关联将被删除。",
    "graph-edit": "编辑图谱",
    "graph-new": "新建图谱"
```

Modify `src/locales/en.json`，同样在 `kg` 命名空间内追加：

```json
    "memo-sidebar-link": "Link Node",
    "graph-select-prompt": "Please select or create a graph",
    "graph-delete-confirm": "Delete graph \"{{name}}\"? All nodes and associations will be removed.",
    "graph-edit": "Edit Graph",
    "graph-new": "New Graph"
```

- [ ] **Step 10: 验证 TypeScript 编译通过**

Run: `pnpm tsc --noEmit`
Expected: 无错误

- [ ] **Step 11: 验证后端编译通过**

Run: `$env:Path += ";$env:USERPROFILE\.cargo\bin"; cargo check --manifest-path src-tauri/Cargo.toml`
Expected: 编译成功

- [ ] **Step 12: 启动应用验证**

Run: `$env:Path += ";$env:USERPROFILE\.cargo\bin"; pnpm tauri dev`

验证清单：
1. 访问 `/knowledge-graph`，显示"请选择或创建一个图谱"提示
2. 通过切换器创建新图谱，自动跳转到 `/knowledge-graph/:graphId`
3. 在图谱中创建节点，节点归属到当前图谱
4. 切换到另一个图谱，节点列表独立
5. 从笔记侧栏点击节点链接，跳转到正确图谱并选中节点
6. 删除图谱后，节点和关联被级联清理

- [ ] **Step 13: Commit**

```bash
git add src/router/index.tsx src/components/KnowledgeGraph/KnowledgeGraphPage.tsx src/components/KnowledgeGraph/KgToolbar.tsx src/components/KnowledgeGraph/KgCanvas.tsx src/components/KnowledgeGraph/KgNodeDetailPanel.tsx src/components/KnowledgeGraph/KgNodeEditDialog.tsx src/components/MemoDetailSidebar/MemoDetailSidebar.tsx src/locales/zh-Hans.json src/locales/en.json
git commit -m "feat(kg): integrate multi-graph support with routing and UI"
```

---

## Self-Review

### Spec coverage 检查

- ✅ 新增 `kg_graph` 顶层表 — Task 1
- ✅ `kg_node` 增加 `graph_id` 外键归属 — Task 2
- ✅ 节点/边按 `graph_id` 隔离 — Task 2（list 过滤 + 跨图谱校验）
- ✅ 现有数据迁移到默认图谱 — Task 1（V13 迁移自动处理）
- ✅ 图谱 CRUD IPC 命令 — Task 3
- ✅ 前端图谱 hooks — Task 4
- ✅ 图谱切换器 UI — Task 5
- ✅ 路由参数 `/knowledge-graph/:graphId` — Task 6
- ✅ 笔记侧栏跳转带 graphId — Task 6
- ✅ i18n 键 — Task 6

### Placeholder 检查

- ✅ 无 TBD/TODO
- ✅ 所有代码步骤都有完整代码
- ✅ 所有测试步骤都有完整测试代码

### 类型一致性检查

- ✅ `KgGraph` 在 Rust 和 TypeScript 中字段一致
- ✅ `KgNode.graph_id` 在 Rust (`i32`) 和 TypeScript (`number`) 中一致
- ✅ `UpsertKgNode.graph_id` 在 Rust 和 TypeScript 中一致
- ✅ `FindKgNode.graph_id` 类型为 `Option<i32>`，对应 IPC 的 `Option<i32>`
- ✅ `useKgNodes(graphId?)` 参数可选，与 `ListKgNodesRequest.graph_id` 对应
- ✅ Task 5 的 `KgGraphSwitcher` props 与 Task 6 `KgToolbar` 调用一致
- ✅ Task 5 的 `KgGraphEditDialog` props 与 Task 6 `KnowledgeGraphPage` 调用一致
