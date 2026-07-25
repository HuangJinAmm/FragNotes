//! Tools：用户可配置的 shell 命令工具
//!
//! Tool 与 Skill 的区别：
//! - Skill 是 Markdown 指南文档，告诉 LLM 如何使用工具
//! - Tool 是可执行的工具，LLM 调用时传完整 command 字符串，后端在固定工作目录执行

use crate::error::{CoreError, CoreResult};
use crate::ConfigStore;
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
    "officecli",
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
pub fn list(store: &ConfigStore) -> CoreResult<Vec<Tool>> {
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
pub fn list_enabled(store: &ConfigStore) -> CoreResult<Vec<Tool>> {
    Ok(list(store)?.into_iter().filter(|t| t.enabled).collect())
}

/// 按 id 查找
pub fn get(store: &ConfigStore, id: &str) -> CoreResult<Option<Tool>> {
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
pub fn get_by_name(store: &ConfigStore, name: &str) -> CoreResult<Option<Tool>> {
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
pub fn create(store: &ConfigStore, mut tool: Tool) -> CoreResult<Tool> {
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
pub fn update(store: &ConfigStore, mut tool: Tool) -> CoreResult<Tool> {
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
pub fn delete(store: &ConfigStore, id: &str) -> CoreResult<()> {
    store.with_conn(|conn| {
        conn.execute("DELETE FROM tool WHERE id=?1", params![id])?;
        Ok(())
    })
}

/// 设置启用状态
pub fn set_enabled(store: &ConfigStore, id: &str, enabled: bool) -> CoreResult<()> {
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
        let store = ConfigStore::open_in_memory().unwrap();
        let t = create(&store, sample_tool("u-my", "my_tool")).unwrap();
        assert_eq!(t.id, "u-my");
        assert!(t.created_ts > 0);

        let got = get(&store, "u-my").unwrap().unwrap();
        assert_eq!(got.name, "my_tool");
        assert_eq!(got.permission, Permission::ReadOnly);
    }

    #[test]
    fn test_create_rejects_non_u_prefix() {
        let store = ConfigStore::open_in_memory().unwrap();
        let result = create(&store, sample_tool("bad", "my_tool"));
        assert!(result.is_err());
    }

    #[test]
    fn test_create_rejects_builtin_name() {
        let store = ConfigStore::open_in_memory().unwrap();
        let mut t = sample_tool("u-x", "list_memos");
        let result = create(&store, t.clone());
        assert!(result.is_err());
        t.name = "create_memo".to_string();
        assert!(create(&store, t).is_err());
    }

    #[test]
    fn test_create_rejects_invalid_name() {
        let store = ConfigStore::open_in_memory().unwrap();
        // 大写字母不允许
        let mut t = sample_tool("u-x", "MyTool");
        assert!(create(&store, t.clone()).is_err());
        // 空格不允许
        t.name = "my tool".to_string();
        assert!(create(&store, t).is_err());
    }

    #[test]
    fn test_get_by_name() {
        let store = ConfigStore::open_in_memory().unwrap();
        create(&store, sample_tool("u-a", "tool_a")).unwrap();
        let got = get_by_name(&store, "tool_a").unwrap().unwrap();
        assert_eq!(got.id, "u-a");
        assert!(get_by_name(&store, "nonexistent").unwrap().is_none());
    }

    #[test]
    fn test_name_unique_constraint() {
        let store = ConfigStore::open_in_memory().unwrap();
        create(&store, sample_tool("u-a", "tool_a")).unwrap();
        // 同名不同 id 应失败
        let result = create(&store, sample_tool("u-b", "tool_a"));
        assert!(result.is_err());
    }

    #[test]
    fn test_list_and_list_enabled() {
        let store = ConfigStore::open_in_memory().unwrap();
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
        let store = ConfigStore::open_in_memory().unwrap();
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
        let store = ConfigStore::open_in_memory().unwrap();
        create(&store, sample_tool("u-a", "tool_a")).unwrap();
        delete(&store, "u-a").unwrap();
        assert!(get(&store, "u-a").unwrap().is_none());
    }

    #[test]
    fn test_set_enabled() {
        let store = ConfigStore::open_in_memory().unwrap();
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
        let store = ConfigStore::open_in_memory().unwrap();
        let mut t = sample_tool("u-a", "tool_a");
        t.timeout_ms = 500;
        assert!(create(&store, t.clone()).is_err());
        t.timeout_ms = 700_000;
        assert!(create(&store, t).is_err());
    }

    #[test]
    fn test_permission_serde() {
        let p = Permission::ReadOnly;
        assert_eq!(serde_json::to_string(&p).unwrap(), "\"read_only\"");
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
