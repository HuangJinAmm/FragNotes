//! AI 跨会话长期记忆：用户偏好 / 稳定事实 / 会话要点
//!
//! 与相邻模块的区别：
//! - `chat_session` 是对话记录（不跨会话读取）；
//! - `skill` 是人工编写的指令型文档；
//! - `review`（FSRS）是学习记忆，语义与命名均与本模块区分。
//!
//! 记忆存业务库 `memos.db`（随工作空间隔离），开关配置存 `app_config.db` 的 `app_setting`。

use crate::error::{CoreError, CoreResult};
use crate::{ConfigStore, Store};
use rusqlite::{params, Connection, Row};
use serde::{Deserialize, Serialize};
use std::collections::HashSet;

// ==================== 配置 ====================

pub const MEMORY_ENABLED_KEY: &str = "ai_memory_enabled";
pub const MEMORY_AUTO_EXTRACT_KEY: &str = "ai_memory_auto_extract";
pub const MEMORY_MAX_ITEMS_KEY: &str = "ai_memory_max_items";
pub const MEMORY_MAX_CHARS_KEY: &str = "ai_memory_max_chars";

/// 单次注入 system prompt 的字符预算硬上限（防止 prompt 膨胀）
pub const MAX_SECTION_CHARS_LIMIT: usize = 4000;
/// 单条记忆正文的长度上限
pub const MAX_CONTENT_CHARS: usize = 1000;

/// 记忆模块配置。默认全部关闭：记忆涉及用户画像，需用户显式开启。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MemoryConfig {
    #[serde(default)]
    pub enabled: bool,
    #[serde(default)]
    pub auto_extract: bool,
    #[serde(default = "default_max_items")]
    pub max_items: usize,
    #[serde(default = "default_max_chars")]
    pub max_chars: usize,
}

fn default_max_items() -> usize {
    20
}

fn default_max_chars() -> usize {
    800
}

impl Default for MemoryConfig {
    fn default() -> Self {
        Self {
            enabled: false,
            auto_extract: false,
            max_items: default_max_items(),
            max_chars: default_max_chars(),
        }
    }
}

impl MemoryConfig {
    /// 钳制到合法范围，避免前端传入异常值撑爆 prompt
    pub fn sanitized(mut self) -> Self {
        self.max_items = self.max_items.clamp(1, 200);
        self.max_chars = self.max_chars.clamp(100, MAX_SECTION_CHARS_LIMIT);
        self
    }
}

fn get_app_setting(config_store: &ConfigStore, key: &str) -> Option<String> {
    config_store
        .with_conn(|conn| {
            Ok(config_store
                .setting
                .app
                .get(conn, key)
                .ok()
                .flatten()
                .filter(|s| !s.trim().is_empty()))
        })
        .ok()
        .flatten()
}

fn set_app_setting(config_store: &ConfigStore, key: &str, value: &str) -> CoreResult<()> {
    config_store.with_conn(|conn| config_store.setting.app.upsert(conn, key, value))
}

/// 读取记忆配置；任一项缺失或解析失败时回退到默认值
pub fn load_config(config_store: &ConfigStore) -> MemoryConfig {
    let defaults = MemoryConfig::default();
    MemoryConfig {
        enabled: get_app_setting(config_store, MEMORY_ENABLED_KEY)
            .map(|v| v == "true" || v == "1")
            .unwrap_or(defaults.enabled),
        auto_extract: get_app_setting(config_store, MEMORY_AUTO_EXTRACT_KEY)
            .map(|v| v == "true" || v == "1")
            .unwrap_or(defaults.auto_extract),
        max_items: get_app_setting(config_store, MEMORY_MAX_ITEMS_KEY)
            .and_then(|v| v.parse().ok())
            .unwrap_or(defaults.max_items),
        max_chars: get_app_setting(config_store, MEMORY_MAX_CHARS_KEY)
            .and_then(|v| v.parse().ok())
            .unwrap_or(defaults.max_chars),
    }
    .sanitized()
}

/// 保存记忆配置（全量写入）
pub fn save_config(config_store: &ConfigStore, config: &MemoryConfig) -> CoreResult<MemoryConfig> {
    let config = config.clone().sanitized();
    set_app_setting(config_store, MEMORY_ENABLED_KEY, &config.enabled.to_string())?;
    set_app_setting(
        config_store,
        MEMORY_AUTO_EXTRACT_KEY,
        &config.auto_extract.to_string(),
    )?;
    set_app_setting(
        config_store,
        MEMORY_MAX_ITEMS_KEY,
        &config.max_items.to_string(),
    )?;
    set_app_setting(
        config_store,
        MEMORY_MAX_CHARS_KEY,
        &config.max_chars.to_string(),
    )?;
    Ok(config)
}

/// 记忆总开关（供 agent_loop 快速判断，避免构造完整配置）
pub fn is_enabled(config_store: &ConfigStore) -> bool {
    load_config(config_store).enabled
}

// ==================== 实体 ====================

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum MemoryKind {
    /// 关于用户的稳定事实
    Fact,
    /// 用户的偏好
    Preference,
    /// 跨会话要点
    Episode,
}

impl MemoryKind {
    pub fn as_str(&self) -> &'static str {
        match self {
            MemoryKind::Fact => "fact",
            MemoryKind::Preference => "preference",
            MemoryKind::Episode => "episode",
        }
    }

    pub fn parse(s: &str) -> CoreResult<Self> {
        match s {
            "fact" => Ok(MemoryKind::Fact),
            "preference" => Ok(MemoryKind::Preference),
            "episode" => Ok(MemoryKind::Episode),
            other => Err(CoreError::Other(format!("未知记忆类型: {other}"))),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum MemorySource {
    /// 用户在设置页手动添加 / 编辑
    Manual,
    /// AI 自动抽取或通过 remember 工具写入
    Ai,
    /// 从备份文件导入
    Imported,
}

impl MemorySource {
    pub fn as_str(&self) -> &'static str {
        match self {
            MemorySource::Manual => "manual",
            MemorySource::Ai => "ai",
            MemorySource::Imported => "imported",
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AiMemory {
    pub id: i64,
    pub kind: MemoryKind,
    pub content: String,
    pub source: MemorySource,
    pub source_session_id: Option<i64>,
    /// 1..5，越高越优先注入
    pub importance: i64,
    pub confidence: f64,
    pub hits: i64,
    pub last_hit_ts: Option<i64>,
    pub enabled: bool,
    pub created_ts: i64,
    pub updated_ts: i64,
}

// ==================== 工具函数 ====================

/// 归一化去重键：trim + 空白折叠 + 小写
pub fn normalize_key(content: &str) -> String {
    content
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .to_lowercase()
}

const SELECT_COLS: &str = "id, kind, content, source, source_session_id, importance, confidence, \
                           hits, last_hit_ts, enabled, created_ts, updated_ts";

fn row_to_memory(row: &Row<'_>) -> rusqlite::Result<AiMemory> {
    let kind: String = row.get(1)?;
    let source: String = row.get(3)?;
    Ok(AiMemory {
        id: row.get(0)?,
        kind: match kind.as_str() {
            "preference" => MemoryKind::Preference,
            "episode" => MemoryKind::Episode,
            _ => MemoryKind::Fact,
        },
        content: row.get(2)?,
        source: match source.as_str() {
            "manual" => MemorySource::Manual,
            "imported" => MemorySource::Imported,
            _ => MemorySource::Ai,
        },
        source_session_id: row.get(4)?,
        importance: row.get(5)?,
        confidence: row.get(6)?,
        hits: row.get(7)?,
        last_hit_ts: row.get(8)?,
        enabled: row.get::<_, i64>(9)? != 0,
        created_ts: row.get(10)?,
        updated_ts: row.get(11)?,
    })
}

fn validate_content(content: &str) -> CoreResult<String> {
    let trimmed = content.trim();
    if trimmed.is_empty() {
        return Err(CoreError::Other("记忆内容不能为空".into()));
    }
    if trimmed.chars().count() > MAX_CONTENT_CHARS {
        return Err(CoreError::Other(format!(
            "记忆内容过长（上限 {MAX_CONTENT_CHARS} 字符）"
        )));
    }
    Ok(trimmed.to_string())
}

// ==================== CRUD ====================

/// 列出记忆。`query` 为内容子串过滤；`include_disabled` 为 false 时只返回启用的。
pub fn list(
    store: &Store,
    query: Option<&str>,
    include_disabled: bool,
) -> CoreResult<Vec<AiMemory>> {
    let query = query
        .map(|q| q.trim().to_string())
        .filter(|q| !q.is_empty());

    store.with_conn(|conn| {
        let mut sql = format!("SELECT {SELECT_COLS} FROM ai_memory WHERE 1=1");
        if !include_disabled {
            sql.push_str(" AND enabled = 1");
        }
        if query.is_some() {
            sql.push_str(" AND content LIKE ?1");
        }
        sql.push_str(" ORDER BY enabled DESC, importance DESC, updated_ts DESC");

        let mut stmt = conn.prepare(&sql)?;
        let mut out: Vec<AiMemory> = Vec::new();
        match &query {
            Some(q) => {
                let like = format!("%{q}%");
                let mut rows = stmt.query_map(params![like], row_to_memory)?;
                while let Some(r) = rows.next() {
                    out.push(r?);
                }
            }
            None => {
                let mut rows = stmt.query_map([], row_to_memory)?;
                while let Some(r) = rows.next() {
                    out.push(r?);
                }
            }
        }
        Ok(out)
    })
}

/// 全部启用中的记忆（供召回使用）
pub fn list_enabled(store: &Store) -> CoreResult<Vec<AiMemory>> {
    list(store, None, false)
}

pub fn get(store: &Store, id: i64) -> CoreResult<Option<AiMemory>> {
    store.with_conn(|conn| {
        Ok(conn
            .query_row(
                &format!("SELECT {SELECT_COLS} FROM ai_memory WHERE id = ?1"),
                params![id],
                row_to_memory,
            )
            .ok())
    })
}

fn get_by_key(conn: &Connection, key: &str) -> CoreResult<Option<AiMemory>> {
    Ok(conn
        .query_row(
            &format!("SELECT {SELECT_COLS} FROM ai_memory WHERE content_key = ?1"),
            params![key],
            row_to_memory,
        )
        .ok())
}

/// 写入一条记忆。内容归一化后若已存在，则更新重要度/类型/时间戳并重新启用（upsert）。
pub fn create(
    store: &Store,
    kind: MemoryKind,
    content: &str,
    source: MemorySource,
    importance: i64,
    source_session_id: Option<i64>,
) -> CoreResult<AiMemory> {
    let content = validate_content(content)?;
    let key = normalize_key(&content);
    if key.is_empty() {
        return Err(CoreError::Other("记忆内容不能为空".into()));
    }
    let importance = importance.clamp(1, 5);
    let now = chrono::Utc::now().timestamp();

    store.with_conn(|conn| {
        conn.execute(
            "INSERT INTO ai_memory
                 (kind, content, content_key, source, source_session_id, importance, created_ts, updated_ts)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?7)
             ON CONFLICT(content_key) DO UPDATE SET
                 content           = excluded.content,
                 kind              = excluded.kind,
                 importance        = MAX(ai_memory.importance, excluded.importance),
                 enabled           = 1,
                 updated_ts        = excluded.updated_ts",
            params![
                kind.as_str(),
                content,
                key,
                source.as_str(),
                source_session_id,
                importance,
                now,
            ],
        )?;
        get_by_key(conn, &key)?
            .ok_or_else(|| CoreError::Other("记忆写入后未能读回".into()))
    })
}

/// 更新一条记忆（用户编辑）。内容变更后与其他记忆重复时返回错误。
pub fn update(
    store: &Store,
    id: i64,
    kind: MemoryKind,
    content: &str,
    importance: i64,
    enabled: bool,
) -> CoreResult<AiMemory> {
    let content = validate_content(content)?;
    let key = normalize_key(&content);
    let importance = importance.clamp(1, 5);
    let now = chrono::Utc::now().timestamp();

    store.with_conn(|conn| {
        let affected = conn.execute(
            "UPDATE ai_memory
             SET kind=?1, content=?2, content_key=?3, importance=?4, enabled=?5, updated_ts=?6
             WHERE id=?7",
            params![
                kind.as_str(),
                content,
                key,
                importance,
                enabled as i64,
                now,
                id
            ],
        );
        match affected {
            Ok(0) => return Err(CoreError::Other(format!("记忆 {id} 不存在"))),
            Ok(_) => {}
            Err(e) => {
                // UNIQUE 约束冲突：目标内容与另一条记忆重复
                return Err(CoreError::Other(format!("已存在内容相同的记忆，无法保存: {e}")));
            }
        }
        // 内容变更后旧向量已失效，删除以便下次召回时按需重建
        conn.execute("DELETE FROM ai_memory_vec WHERE rowid = ?1", params![id])?;
        conn.query_row(
            &format!("SELECT {SELECT_COLS} FROM ai_memory WHERE id = ?1"),
            params![id],
            row_to_memory,
        )
        .map_err(Into::into)
    })
}

pub fn delete(store: &Store, id: i64) -> CoreResult<()> {
    store.with_conn(|conn| {
        conn.execute("DELETE FROM ai_memory WHERE id = ?1", params![id])?;
        conn.execute("DELETE FROM ai_memory_vec WHERE rowid = ?1", params![id])?;
        Ok(())
    })
}

/// 按内容删除（`forget` 工具使用）。返回删除条数。
pub fn delete_by_content(store: &Store, content: &str) -> CoreResult<usize> {
    let key = normalize_key(content);
    if key.is_empty() {
        return Ok(0);
    }
    store.with_conn(|conn| {
        let id: Option<i64> = conn
            .query_row(
                "SELECT id FROM ai_memory WHERE content_key = ?1",
                params![key],
                |r| r.get(0),
            )
            .ok();
        let Some(id) = id else { return Ok(0) };
        conn.execute("DELETE FROM ai_memory WHERE id = ?1", params![id])?;
        conn.execute("DELETE FROM ai_memory_vec WHERE rowid = ?1", params![id])?;
        Ok(1)
    })
}

pub fn set_enabled(store: &Store, id: i64, enabled: bool) -> CoreResult<()> {
    let now = chrono::Utc::now().timestamp();
    store.with_conn(|conn| {
        conn.execute(
            "UPDATE ai_memory SET enabled=?1, updated_ts=?2 WHERE id=?3",
            params![enabled as i64, now, id],
        )?;
        Ok(())
    })
}

/// 清空全部记忆，返回删除条数。
pub fn clear(store: &Store) -> CoreResult<usize> {
    store.with_conn(|conn| {
        let tx = conn.unchecked_transaction()?;
        let removed = tx.execute("DELETE FROM ai_memory", [])?;
        tx.execute("DELETE FROM ai_memory_vec", [])?;
        tx.commit()?;
        Ok(removed)
    })
}

// ==================== 向量索引（可选能力） ====================
//
// `ai_memory_vec` 是 vec0 虚拟表，rowid 与 ai_memory.id 一致。
// 向量由 src-tauri 侧注入（core 不依赖 ONNX）；未生成向量的记忆仍可通过关键词召回。

/// 已生成向量的记忆 id 集合（用于判断是否值得走语义召回）
pub fn embedded_ids(store: &Store) -> CoreResult<HashSet<i64>> {
    store.with_conn(|conn| {
        let mut stmt = conn.prepare("SELECT rowid FROM ai_memory_vec")?;
        let mut rows = stmt.query_map([], |r| r.get::<_, i64>(0))?;
        let mut out = HashSet::new();
        while let Some(r) = rows.next() {
            out.insert(r?);
        }
        Ok(out)
    })
}

/// 尚未生成向量的启用中记忆（id + 正文），按最近更新优先，最多 `limit` 条
pub fn list_without_embedding(store: &Store, limit: usize) -> CoreResult<Vec<(i64, String)>> {
    store.with_conn(|conn| {
        let embedded = {
            let mut stmt = conn.prepare("SELECT rowid FROM ai_memory_vec")?;
            let mut rows = stmt.query_map([], |r| r.get::<_, i64>(0))?;
            let mut set = HashSet::new();
            while let Some(r) = rows.next() {
                set.insert(r?);
            }
            set
        };

        let mut stmt = conn.prepare(
            "SELECT id, content FROM ai_memory WHERE enabled = 1 ORDER BY updated_ts DESC LIMIT ?1",
        )?;
        let mut rows = stmt.query_map(params![(limit * 4) as i64], |r| {
            Ok((r.get::<_, i64>(0)?, r.get::<_, String>(1)?))
        })?;
        let mut out = Vec::new();
        while let Some(r) = rows.next() {
            let (id, content) = r?;
            if !embedded.contains(&id) {
                out.push((id, content));
                if out.len() >= limit {
                    break;
                }
            }
        }
        Ok(out)
    })
}

/// 写入/覆盖一条记忆的向量（JSON 数组字符串，维度必须为 384）
pub fn set_embedding(store: &Store, id: i64, embedding_json: &str) -> CoreResult<()> {
    store.with_conn(|conn| {
        conn.execute("DELETE FROM ai_memory_vec WHERE rowid = ?1", params![id])?;
        conn.execute(
            "INSERT INTO ai_memory_vec(rowid, embedding) VALUES (?1, ?2)",
            params![id, embedding_json],
        )?;
        Ok(())
    })
}

pub fn delete_embedding(store: &Store, id: i64) -> CoreResult<()> {
    store.with_conn(|conn| {
        conn.execute("DELETE FROM ai_memory_vec WHERE rowid = ?1", params![id])?;
        Ok(())
    })
}

/// KNN 语义检索，返回 (memory_id, distance) 按距离升序
pub fn knn(store: &Store, embedding_json: &str, top_k: usize) -> CoreResult<Vec<(i64, f64)>> {
    store.with_conn(|conn| {
        let mut stmt = conn.prepare(
            "SELECT rowid, distance FROM ai_memory_vec WHERE embedding MATCH ? ORDER BY distance LIMIT ?",
        )?;
        let mut rows = stmt.query_map(params![embedding_json, top_k as i64], |r| {
            Ok((r.get::<_, i64>(0)?, r.get::<_, f64>(1)?))
        })?;
        let mut out = Vec::new();
        while let Some(r) = rows.next() {
            out.push(r?);
        }
        Ok(out)
    })
}

/// 记录注入命中（M3 衰减排序使用）
pub fn bump_hits(store: &Store, ids: &[i64]) -> CoreResult<()> {
    if ids.is_empty() {
        return Ok(());
    }
    let now = chrono::Utc::now().timestamp();
    store.with_conn(|conn| {
        let tx = conn.unchecked_transaction()?;
        for id in ids {
            tx.execute(
                "UPDATE ai_memory SET hits = hits + 1, last_hit_ts = ?1 WHERE id = ?2",
                params![now, id],
            )?;
        }
        tx.commit()?;
        Ok(())
    })
}

// ==================== 导入 / 导出 ====================
//
// 备份文件只包含「语义」字段：`id` 与 `source_session_id` 是本地概念，换工作空间/设备后
// 无意义，因此不进入文件；导入的条目统一标记为 `MemorySource::Imported`。

/// 备份文件中的单条记忆（导出与导入共用）。
///
/// 导入侧字段全部可选并对越界值做钳制，以便容忍手工编辑过的 JSON。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MemoryImportItem {
    pub content: String,
    #[serde(default)]
    pub kind: Option<MemoryKind>,
    #[serde(default)]
    pub importance: Option<i64>,
    #[serde(default)]
    pub confidence: Option<f64>,
    #[serde(default)]
    pub hits: Option<i64>,
    #[serde(default)]
    pub enabled: Option<bool>,
    #[serde(default)]
    pub created_ts: Option<i64>,
    #[serde(default)]
    pub updated_ts: Option<i64>,
}

impl From<&AiMemory> for MemoryImportItem {
    fn from(m: &AiMemory) -> Self {
        Self {
            content: m.content.clone(),
            kind: Some(m.kind),
            importance: Some(m.importance),
            confidence: Some(m.confidence),
            hits: Some(m.hits),
            enabled: Some(m.enabled),
            created_ts: Some(m.created_ts),
            updated_ts: Some(m.updated_ts),
        }
    }
}

/// 导出全部记忆（含停用项），按内容排序保证输出稳定、便于 diff
pub fn export_items(store: &Store) -> CoreResult<Vec<MemoryImportItem>> {
    let mut all = list(store, None, true)?;
    all.sort_by(|a, b| a.content.cmp(&b.content));
    Ok(all.iter().map(MemoryImportItem::from).collect())
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportReport {
    /// 新增条目数
    pub imported: usize,
    /// 与已有记忆内容重复、只提升重要度的条目数
    pub merged: usize,
    /// 内容为空或超长的无效条目数
    pub skipped: usize,
}

/// 导入记忆（幂等）。
///
/// 内容归一化后已存在的条目**只提升重要度**，不覆盖本地启用状态、命中统计与创建时间 ——
/// 避免一次导入把用户手工调整过的记忆状态抹掉。
pub fn import_many(store: &Store, items: &[MemoryImportItem]) -> CoreResult<ImportReport> {
    let now = chrono::Utc::now().timestamp();
    let mut report = ImportReport {
        imported: 0,
        merged: 0,
        skipped: 0,
    };

    store.with_conn(|conn| {
        let tx = conn.unchecked_transaction()?;
        for item in items {
            let content = match validate_content(&item.content) {
                Ok(c) => c,
                Err(_) => {
                    report.skipped += 1;
                    continue;
                }
            };
            let key = normalize_key(&content);
            if key.is_empty() {
                report.skipped += 1;
                continue;
            }

            let importance = item.importance.unwrap_or(3).clamp(1, 5);
            let existing: Option<i64> = tx
                .query_row(
                    "SELECT id FROM ai_memory WHERE content_key = ?1",
                    params![key],
                    |r| r.get(0),
                )
                .ok();

            if let Some(id) = existing {
                tx.execute(
                    "UPDATE ai_memory SET importance = MAX(importance, ?1), updated_ts = ?2 WHERE id = ?3",
                    params![importance, now, id],
                )?;
                report.merged += 1;
                continue;
            }

            tx.execute(
                "INSERT INTO ai_memory
                     (kind, content, content_key, source, source_session_id, importance, confidence,
                      hits, last_hit_ts, enabled, created_ts, updated_ts)
                 VALUES (?1, ?2, ?3, ?4, NULL, ?5, ?6, ?7, NULL, ?8, ?9, ?10)",
                params![
                    item.kind.unwrap_or(MemoryKind::Fact).as_str(),
                    content,
                    key,
                    MemorySource::Imported.as_str(),
                    importance,
                    item.confidence.unwrap_or(1.0).clamp(0.0, 1.0),
                    item.hits.unwrap_or(0).max(0),
                    item.enabled.unwrap_or(true) as i64,
                    item.created_ts.unwrap_or(now),
                    item.updated_ts.unwrap_or(now),
                ],
            )?;
            report.imported += 1;
        }
        tx.commit()?;
        Ok(report)
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn seed(store: &Store, content: &str) -> AiMemory {
        create(
            store,
            MemoryKind::Fact,
            content,
            MemorySource::Manual,
            3,
            None,
        )
        .unwrap()
    }

    #[test]
    fn test_default_config_is_disabled() {
        let config_store = ConfigStore::open_in_memory().unwrap();
        let cfg = load_config(&config_store);
        assert!(!cfg.enabled);
        assert!(!cfg.auto_extract);
        assert_eq!(cfg.max_items, 20);
        assert_eq!(cfg.max_chars, 800);
        assert!(!is_enabled(&config_store));
    }

    #[test]
    fn test_config_round_trip_and_clamp() {
        let config_store = ConfigStore::open_in_memory().unwrap();
        let saved = save_config(
            &config_store,
            &MemoryConfig {
                enabled: true,
                auto_extract: true,
                max_items: 9999,
                max_chars: 1,
            },
        )
        .unwrap();
        assert_eq!(saved.max_items, 200);
        assert_eq!(saved.max_chars, 100);

        let loaded = load_config(&config_store);
        assert!(loaded.enabled);
        assert!(loaded.auto_extract);
        assert_eq!(loaded.max_items, 200);
        assert!(is_enabled(&config_store));
    }

    #[test]
    fn test_normalize_key() {
        assert_eq!(normalize_key("  Hello   World "), "hello world");
        assert_eq!(normalize_key("用户   喜欢   简洁"), "用户 喜欢 简洁");
    }

    #[test]
    fn test_create_and_dedup_same_content() {
        let store = Store::open_in_memory().unwrap();
        let a = seed(&store, "用户主力语言是 Rust");
        let b = create(
            &store,
            MemoryKind::Preference,
            "  用户主力语言是   Rust  ",
            MemorySource::Ai,
            5,
            Some(7),
        )
        .unwrap();

        assert_eq!(a.id, b.id, "归一化后相同内容应命中同一行");
        assert_eq!(list(&store, None, false).unwrap().len(), 1);
        assert_eq!(b.importance, 5, "重要度取较大值");
        assert_eq!(b.kind, MemoryKind::Preference);
    }

    #[test]
    fn test_create_rejects_empty_and_too_long() {
        let store = Store::open_in_memory().unwrap();
        assert!(
            create(&store, MemoryKind::Fact, "   ", MemorySource::Manual, 3, None).is_err()
        );
        let long = "a".repeat(MAX_CONTENT_CHARS + 1);
        assert!(create(&store, MemoryKind::Fact, &long, MemorySource::Manual, 3, None).is_err());
    }

    #[test]
    fn test_importance_and_content_trimmed() {
        let store = Store::open_in_memory().unwrap();
        let m = create(
            &store,
            MemoryKind::Fact,
            "  用户在北京  ",
            MemorySource::Manual,
            99,
            None,
        )
        .unwrap();
        assert_eq!(m.content, "用户在北京");
        assert_eq!(m.importance, 5);
        assert_eq!(m.source, MemorySource::Manual);
        assert!(m.enabled);
    }

    #[test]
    fn test_list_query_and_include_disabled() {
        let store = Store::open_in_memory().unwrap();
        let a = seed(&store, "用户喜欢 Rust");
        seed(&store, "用户喜欢简洁回答");
        set_enabled(&store, a.id, false).unwrap();

        assert_eq!(list(&store, None, false).unwrap().len(), 1);
        assert_eq!(list(&store, None, true).unwrap().len(), 2);

        let hit = list(&store, Some("Rust"), true).unwrap();
        assert_eq!(hit.len(), 1);
        assert_eq!(hit[0].id, a.id);

        assert!(list(&store, Some("不存在的关键词"), true).unwrap().is_empty());
    }

    #[test]
    fn test_list_orders_by_importance() {
        let store = Store::open_in_memory().unwrap();
        create(&store, MemoryKind::Fact, "低", MemorySource::Manual, 1, None).unwrap();
        create(&store, MemoryKind::Fact, "高", MemorySource::Manual, 5, None).unwrap();
        let all = list(&store, None, false).unwrap();
        assert_eq!(all[0].content, "高");
    }

    #[test]
    fn test_update_and_conflict() {
        let store = Store::open_in_memory().unwrap();
        let a = seed(&store, "甲");
        seed(&store, "乙");

        let updated = update(&store, a.id, MemoryKind::Preference, "甲改", 4, true).unwrap();
        assert_eq!(updated.content, "甲改");
        assert_eq!(updated.kind, MemoryKind::Preference);
        assert_eq!(updated.importance, 4);

        // 改成与另一条相同 → UNIQUE 冲突
        assert!(update(&store, a.id, MemoryKind::Fact, "乙", 3, true).is_err());
        // 不存在的 id
        assert!(update(&store, 9999, MemoryKind::Fact, "丙", 3, true).is_err());
    }

    #[test]
    fn test_delete_and_clear_and_delete_by_content() {
        let store = Store::open_in_memory().unwrap();
        let a = seed(&store, "用户喜欢 Rust");
        let b = seed(&store, "用户在杭州");

        assert_eq!(
            delete_by_content(&store, "用户喜欢Rust").unwrap(),
            0,
            "空白差异不匹配"
        );
        assert_eq!(delete_by_content(&store, " 用户喜欢 Rust ").unwrap(), 1);
        assert!(get(&store, a.id).unwrap().is_none());

        assert_eq!(clear(&store).unwrap(), 1);
        assert!(list(&store, None, true).unwrap().is_empty());
        assert!(get(&store, b.id).unwrap().is_none());
    }

    #[test]
    fn test_delete_single() {
        let store = Store::open_in_memory().unwrap();
        let a = seed(&store, "待删除");
        delete(&store, a.id).unwrap();
        assert!(list(&store, None, true).unwrap().is_empty());
    }

    #[test]
    fn test_bump_hits() {
        let store = Store::open_in_memory().unwrap();
        let a = seed(&store, "命中统计");
        bump_hits(&store, &[a.id]).unwrap();
        bump_hits(&store, &[a.id]).unwrap();

        let loaded = get(&store, a.id).unwrap().unwrap();
        assert_eq!(loaded.hits, 2);
        assert!(loaded.last_hit_ts.is_some());
    }

    /// 构造 384 维假向量：第 `dim` 维为 1，其余为 0
    fn fake_embedding(dim: usize) -> String {
        let mut v = vec![0f32; 384];
        v[dim] = 1.0;
        serde_json::to_string(&v).unwrap()
    }

    #[test]
    fn test_embedding_lifecycle() {
        let store = Store::open_in_memory().unwrap();
        let a = seed(&store, "用户主力语言是 Rust");

        assert!(embedded_ids(&store).unwrap().is_empty());
        let missing = list_without_embedding(&store, 10).unwrap();
        assert_eq!(missing.len(), 1);
        assert_eq!(missing[0].0, a.id);
        assert_eq!(missing[0].1, "用户主力语言是 Rust");

        set_embedding(&store, a.id, &fake_embedding(0)).unwrap();
        assert!(embedded_ids(&store).unwrap().contains(&a.id));
        assert!(list_without_embedding(&store, 10).unwrap().is_empty());

        // 重复写入应覆盖而非报错（vec0 无 UNIQUE 约束）
        set_embedding(&store, a.id, &fake_embedding(1)).unwrap();
        assert_eq!(embedded_ids(&store).unwrap().len(), 1);

        let hits = knn(&store, &fake_embedding(1), 5).unwrap();
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].0, a.id);
        assert!(hits[0].1.abs() < 1e-6, "同向量距离应近似为 0");
    }

    #[test]
    fn test_knn_orders_by_distance() {
        let store = Store::open_in_memory().unwrap();
        let a = seed(&store, "记忆 A");
        let b = seed(&store, "记忆 B");
        set_embedding(&store, a.id, &fake_embedding(0)).unwrap();
        set_embedding(&store, b.id, &fake_embedding(1)).unwrap();

        let hits = knn(&store, &fake_embedding(0), 5).unwrap();
        assert_eq!(hits.len(), 2);
        assert_eq!(hits[0].0, a.id, "与查询同向的记忆应排在首位");
        assert!(hits[0].1 < hits[1].1);

        assert!(knn(&store, &fake_embedding(0), 1).unwrap().len() == 1);
    }

    #[test]
    fn test_update_invalidates_embedding() {
        let store = Store::open_in_memory().unwrap();
        let a = seed(&store, "旧内容");
        set_embedding(&store, a.id, &fake_embedding(0)).unwrap();

        update(&store, a.id, MemoryKind::Fact, "新内容", 3, true).unwrap();
        assert!(embedded_ids(&store).unwrap().is_empty(), "内容变更后旧向量应失效");
    }

    #[test]
    fn test_delete_and_clear_remove_embeddings() {
        let store = Store::open_in_memory().unwrap();
        let a = seed(&store, "甲");
        let b = seed(&store, "乙");
        set_embedding(&store, a.id, &fake_embedding(0)).unwrap();
        set_embedding(&store, b.id, &fake_embedding(1)).unwrap();

        delete(&store, a.id).unwrap();
        assert_eq!(embedded_ids(&store).unwrap().len(), 1);

        // 按内容删除同样清理向量
        assert_eq!(delete_by_content(&store, "乙").unwrap(), 1);
        assert!(embedded_ids(&store).unwrap().is_empty());

        let c = seed(&store, "丙");
        set_embedding(&store, c.id, &fake_embedding(2)).unwrap();
        assert_eq!(clear(&store).unwrap(), 1);
        assert!(embedded_ids(&store).unwrap().is_empty());
    }

    #[test]
    fn test_backfill_skips_disabled_and_respects_limit() {
        let store = Store::open_in_memory().unwrap();
        let a = seed(&store, "启用中");
        let b = seed(&store, "已停用");
        set_enabled(&store, b.id, false).unwrap();

        let missing = list_without_embedding(&store, 10).unwrap();
        assert_eq!(missing.len(), 1);
        assert_eq!(missing[0].0, a.id, "停用的记忆不参与向量回填");

        let c = seed(&store, "另一条");
        assert_eq!(list_without_embedding(&store, 1).unwrap().len(), 1);
        let _ = c;
    }

    // ---------- 导入 / 导出 ----------

    #[test]
    fn test_export_import_round_trip() {
        let source = Store::open_in_memory().unwrap();
        let a = create(&source, MemoryKind::Preference, "用户偏好简洁回答", MemorySource::Manual, 4, None).unwrap();
        let b = create(&source, MemoryKind::Episode, "用户在推进记忆模块", MemorySource::Ai, 2, Some(7)).unwrap();
        set_enabled(&source, b.id, false).unwrap();
        bump_hits(&source, &[a.id]).unwrap();

        let items = export_items(&source).unwrap();
        assert_eq!(items.len(), 2);
        // 备份文件不含本地字段
        let json = serde_json::to_string(&items).unwrap();
        assert!(!json.contains("sourceSessionId"), "不应导出本地会话 id");

        // 导入到一个空库
        let target = Store::open_in_memory().unwrap();
        let report = import_many(&target, &items).unwrap();
        assert_eq!((report.imported, report.merged, report.skipped), (2, 0, 0));

        let all = list(&target, None, true).unwrap();
        assert_eq!(all.len(), 2);
        let pref = all.iter().find(|m| m.content == "用户偏好简洁回答").unwrap();
        assert_eq!(pref.kind, MemoryKind::Preference);
        assert_eq!(pref.importance, 4);
        assert_eq!(pref.hits, 1, "命中统计应保留");
        assert!(pref.enabled);
        assert_eq!(pref.source, MemorySource::Imported);

        let episode = all.iter().find(|m| m.content == "用户在推进记忆模块").unwrap();
        assert_eq!(episode.kind, MemoryKind::Episode);
        assert!(!episode.enabled, "停用状态应保留");
        assert_eq!(episode.source_session_id, None, "来源会话是本地概念，不随文件迁移");
    }

    #[test]
    fn test_import_is_idempotent_and_promotes_importance() {
        let store = Store::open_in_memory().unwrap();
        let existing = create(&store, MemoryKind::Fact, "用户在北京", MemorySource::Manual, 2, None).unwrap();

        let items = vec![MemoryImportItem {
            content: "  用户在北京  ".into(),
            kind: Some(MemoryKind::Fact),
            importance: Some(5),
            confidence: None,
            hits: None,
            enabled: Some(false),
            created_ts: None,
            updated_ts: None,
        }];
        let report = import_many(&store, &items).unwrap();
        assert_eq!((report.imported, report.merged), (0, 1));

        let loaded = get(&store, existing.id).unwrap().unwrap();
        assert_eq!(list(&store, None, true).unwrap().len(), 1, "不应产生重复条目");
        assert_eq!(loaded.importance, 5, "重要度取较大值");
        assert!(loaded.enabled, "不覆盖本地启用状态");

        // 再导入一次仍然幂等
        let again = import_many(&store, &items).unwrap();
        assert_eq!((again.imported, again.merged), (0, 1));
        assert_eq!(list(&store, None, true).unwrap().len(), 1);
    }

    #[test]
    fn test_import_skips_invalid_entries() {
        let store = Store::open_in_memory().unwrap();
        let items = vec![
            MemoryImportItem {
                content: "   ".into(),
                kind: None,
                importance: None,
                confidence: None,
                hits: None,
                enabled: None,
                created_ts: None,
                updated_ts: None,
            },
            MemoryImportItem {
                content: "x".repeat(MAX_CONTENT_CHARS + 1),
                kind: None,
                importance: None,
                confidence: None,
                hits: None,
                enabled: None,
                created_ts: None,
                updated_ts: None,
            },
            MemoryImportItem {
                content: "有效的记忆".into(),
                kind: None,
                importance: None,
                confidence: None,
                hits: None,
                enabled: None,
                created_ts: None,
                updated_ts: None,
            },
        ];
        let report = import_many(&store, &items).unwrap();
        assert_eq!((report.imported, report.skipped), (1, 2));

        // 缺省字段使用默认值而非报错
        let only = list(&store, None, true).unwrap();
        assert_eq!(only[0].kind, MemoryKind::Fact);
        assert_eq!(only[0].importance, 3);
        assert!(only[0].enabled);
        assert_eq!(only[0].source, MemorySource::Imported);
    }

    #[test]
    fn test_import_item_tolerates_partial_json() {
        // 仅提供 content 也应可解析（手工编辑过的备份文件）
        let item: MemoryImportItem = serde_json::from_str(r#"{"content":"用户用 Vim"}"#).unwrap();
        assert_eq!(item.content, "用户用 Vim");
        assert!(item.kind.is_none());

        let store = Store::open_in_memory().unwrap();
        let report = import_many(&store, &[item]).unwrap();
        assert_eq!(report.imported, 1);
        assert_eq!(get(&store, 1).unwrap().unwrap().content, "用户用 Vim");
    }

    #[test]
    fn test_import_clamps_out_of_range_values() {
        let store = Store::open_in_memory().unwrap();
        let items = vec![MemoryImportItem {
            content: "越界值".into(),
            kind: None,
            importance: Some(99),
            confidence: Some(3.0),
            hits: Some(-5),
            enabled: None,
            created_ts: None,
            updated_ts: None,
        }];
        import_many(&store, &items).unwrap();
        let m = list(&store, None, true).unwrap().remove(0);
        assert_eq!(m.importance, 5);
        assert_eq!(m.confidence, 1.0);
        assert_eq!(m.hits, 0);
    }
}
