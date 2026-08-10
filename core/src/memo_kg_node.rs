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
    let arg_refs: Vec<&dyn rusqlite::ToSql> = args.iter().map(|b| b.as_ref()).collect();
    let rows = stmt.query_map(arg_refs.as_slice(), |row| row.get::<_, i32>(0))?;
    let mut out = Vec::new();
    for r in rows {
        out.push(r?);
    }
    Ok(out)
}
