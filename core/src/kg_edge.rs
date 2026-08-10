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
    let arg_refs: Vec<&dyn rusqlite::ToSql> = args.iter().map(|b| b.as_ref()).collect();
    let rows = stmt.query_map(arg_refs.as_slice(), |row| {
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
