//! 知识图谱节点 CRUD

use crate::error::{CoreError, CoreResult};
use rusqlite::{params, Connection, OptionalExtension};
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
    let mut node: KgNode = stmt.query_row(params![id], map_row)?;
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
