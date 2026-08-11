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
