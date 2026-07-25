//! Skills：AI agent 工具使用指南的存储
//!
//! Skill 来源：
//! - BuiltIn（内置）：通过 include_str! 编译期嵌入，本体只读，禁用状态存 app_setting
//! - User（用户）：存 skill 表，可增删改

use crate::error::{CoreError, CoreResult};
use crate::{ConfigStore, Store};
use rusqlite::params;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum SkillSource {
    BuiltIn,
    User,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Skill {
    pub id: String,
    pub name: String,
    pub description: String,
    pub tools: Vec<String>,
    pub body: String,
    pub enabled: bool,
    pub source: SkillSource,
    #[serde(default)]
    pub created_ts: i64,
    #[serde(default)]
    pub updated_ts: i64,
}

pub const DISABLED_BUILTIN_KEY: &str = "ai_skill_disabled_builtin";

fn load_disabled_builtin(config_store: &ConfigStore) -> Vec<String> {
    config_store
        .with_conn(|conn| {
            Ok(config_store
                .setting
                .app
                .get(conn, DISABLED_BUILTIN_KEY)
                .ok()
                .flatten()
                .and_then(|s| serde_json::from_str::<Vec<String>>(&s).ok())
                .unwrap_or_default())
        })
        .unwrap_or_default()
}

fn save_disabled_builtin(config_store: &ConfigStore, ids: &[String]) -> CoreResult<()> {
    let json = serde_json::to_string(ids)
        .map_err(|e| CoreError::Other(format!("序列化禁用列表失败: {e}")))?;
    config_store.with_conn(|conn| {
        config_store
            .setting
            .app
            .upsert(conn, DISABLED_BUILTIN_KEY, &json)
    })
}

/// 列出所有 skill（合并内置 + 用户），按 name 排序
pub fn list(
    builtin: &[Skill],
    store: &Store,
    config_store: &ConfigStore,
) -> CoreResult<Vec<Skill>> {
    store.with_conn(|conn| {
        let disabled = load_disabled_builtin(config_store);
        let mut result: Vec<Skill> = builtin
            .iter()
            .map(|s| Skill {
                enabled: !disabled.contains(&s.id),
                ..s.clone()
            })
            .collect();

        let mut stmt = conn.prepare(
            "SELECT id, name, description, tools, body, enabled, created_ts, updated_ts
             FROM skill ORDER BY name",
        )?;
        let user_rows = stmt.query_map([], |row| {
            let tools_json: String = row.get(3)?;
            let tools: Vec<String> = serde_json::from_str(&tools_json).unwrap_or_default();
            Ok(Skill {
                id: row.get(0)?,
                name: row.get(1)?,
                description: row.get(2)?,
                tools,
                body: row.get(4)?,
                enabled: row.get::<_, i64>(5)? != 0,
                source: SkillSource::User,
                created_ts: row.get(6)?,
                updated_ts: row.get(7)?,
            })
        })?;
        for r in user_rows {
            result.push(r?);
        }
        result.sort_by(|a, b| a.name.cmp(&b.name));
        Ok(result)
    })
}

/// 仅返回 enabled 的 skill
pub fn list_enabled(
    builtin: &[Skill],
    store: &Store,
    config_store: &ConfigStore,
) -> CoreResult<Vec<Skill>> {
    Ok(list(builtin, store, config_store)?
        .into_iter()
        .filter(|s| s.enabled)
        .collect())
}

/// 按 id 查找（合并内置 + 用户）
pub fn get(
    builtin: &[Skill],
    store: &Store,
    config_store: &ConfigStore,
    id: &str,
) -> CoreResult<Option<Skill>> {
    store.with_conn(|conn| {
        // 先查内置
        if let Some(b) = builtin.iter().find(|s| s.id == id) {
            let disabled = load_disabled_builtin(config_store);
            return Ok(Some(Skill {
                enabled: !disabled.contains(&b.id),
                ..b.clone()
            }));
        }
        // 再查 DB
        let row_opt: Option<Skill> = conn
            .query_row(
                "SELECT id, name, description, tools, body, enabled, created_ts, updated_ts
                 FROM skill WHERE id = ?",
                params![id],
                |row| {
                    let tools_json: String = row.get(3)?;
                    let tools: Vec<String> =
                        serde_json::from_str(&tools_json).unwrap_or_default();
                    Ok(Skill {
                        id: row.get(0)?,
                        name: row.get(1)?,
                        description: row.get(2)?,
                        tools,
                        body: row.get(4)?,
                        enabled: row.get::<_, i64>(5)? != 0,
                        source: SkillSource::User,
                        created_ts: row.get(6)?,
                        updated_ts: row.get(7)?,
                    })
                },
            )
            .ok();
        Ok(row_opt)
    })
}

/// 创建用户 skill。id 必须以 "u-" 开头且不与内置冲突。
pub fn create(store: &Store, mut skill: Skill) -> CoreResult<Skill> {
    if !skill.id.starts_with("u-") {
        return Err(CoreError::Other("用户 skill id 必须以 u- 开头".into()));
    }
    let now = chrono::Utc::now().timestamp();
    skill.source = SkillSource::User;
    skill.created_ts = now;
    skill.updated_ts = now;
    let tools_json = serde_json::to_string(&skill.tools)
        .map_err(|e| CoreError::Other(format!("序列化 tools 失败: {e}")))?;
    store.with_conn(|conn| {
        conn.execute(
            "INSERT INTO skill (id, name, description, tools, body, enabled, created_ts, updated_ts)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?7)",
            params![
                skill.id,
                skill.name,
                skill.description,
                tools_json,
                skill.body,
                skill.enabled as i64,
                now,
            ],
        )?;
        Ok::<(), CoreError>(())
    })?;
    Ok(skill)
}

/// 更新用户 skill（内置 skill 不可改，返回错误）
pub fn update(store: &Store, skill: Skill) -> CoreResult<Skill> {
    if skill.source == SkillSource::BuiltIn {
        return Err(CoreError::Other("built-in skill is read-only".into()));
    }
    let now = chrono::Utc::now().timestamp();
    let tools_json = serde_json::to_string(&skill.tools)
        .map_err(|e| CoreError::Other(format!("序列化 tools 失败: {e}")))?;
    let affected = store.with_conn(|conn| {
        Ok(conn.execute(
            "UPDATE skill SET name=?1, description=?2, tools=?3, body=?4, enabled=?5, updated_ts=?6
             WHERE id=?7",
            params![
                skill.name,
                skill.description,
                tools_json,
                skill.body,
                skill.enabled as i64,
                now,
                skill.id,
            ],
        )?)
    })?;
    if affected == 0 {
        return Err(CoreError::Other(format!("skill {} 不存在", skill.id)));
    }
    Ok(Skill {
        updated_ts: now,
        ..skill
    })
}

/// 删除用户 skill（内置 skill 不可删）
pub fn delete(store: &Store, id: &str) -> CoreResult<()> {
    // 检查是否内置（通过约定：内置 id 以 b- 开头）
    if id.starts_with("b-") {
        return Err(CoreError::Other("built-in skill is read-only".into()));
    }
    store.with_conn(|conn| {
        conn.execute("DELETE FROM skill WHERE id=?1", params![id])?;
        Ok(())
    })
}

/// 设置启用状态。user skill 改 DB；builtin skill 改 app_setting 禁用列表。
pub fn set_enabled(
    store: &Store,
    config_store: &ConfigStore,
    id: &str,
    enabled: bool,
) -> CoreResult<()> {
    if id.starts_with("b-") {
        // 内置 skill：操作禁用列表（存于 app_config.db）
        let mut disabled = load_disabled_builtin(config_store);
        if enabled {
            disabled.retain(|x| x != id);
        } else if !disabled.contains(&id.to_string()) {
            disabled.push(id.to_string());
        }
        save_disabled_builtin(config_store, &disabled)
    } else {
        store.with_conn(|conn| {
            conn.execute(
                "UPDATE skill SET enabled=?1 WHERE id=?2",
                params![enabled as i64, id],
            )?;
            Ok(())
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample_builtin() -> Vec<Skill> {
        vec![Skill {
            id: "b-test".to_string(),
            name: "Test Builtin".to_string(),
            description: "builtin desc".to_string(),
            tools: vec!["list_memos".to_string()],
            body: "# Builtin\n...".to_string(),
            enabled: true,
            source: SkillSource::BuiltIn,
            created_ts: 0,
            updated_ts: 0,
        }]
    }

    #[test]
    fn test_create_and_get_user_skill() {
        let store = Store::open(":memory:").unwrap();
        let config_store = ConfigStore::open_in_memory().unwrap();
        let s = Skill {
            id: "u-my".to_string(),
            name: "My".to_string(),
            description: "desc".to_string(),
            tools: vec!["create_memo".to_string()],
            body: "# body".to_string(),
            enabled: true,
            source: SkillSource::User,
            created_ts: 0,
            updated_ts: 0,
        };
        let created = create(&store, s.clone()).unwrap();
        assert_eq!(created.id, "u-my");
        assert!(created.created_ts > 0);

        let got = get(&[], &store, &config_store, "u-my").unwrap().unwrap();
        assert_eq!(got.name, "My");
        assert_eq!(got.tools, vec!["create_memo".to_string()]);
    }

    #[test]
    fn test_create_rejects_non_u_prefix() {
        let store = Store::open(":memory:").unwrap();
        let s = Skill {
            id: "bad".to_string(),
            name: "n".to_string(),
            description: "d".to_string(),
            tools: vec![],
            body: "b".to_string(),
            enabled: true,
            source: SkillSource::User,
            created_ts: 0,
            updated_ts: 0,
        };
        assert!(create(&store, s).is_err());
    }

    #[test]
    fn test_list_merges_builtin_and_user() {
        let store = Store::open(":memory:").unwrap();
        let config_store = ConfigStore::open_in_memory().unwrap();
        let builtin = sample_builtin();
        create(
            &store,
            Skill {
                id: "u-alpha".to_string(),
                name: "Alpha".to_string(),
                description: "d".to_string(),
                tools: vec![],
                body: "b".to_string(),
                enabled: true,
                source: SkillSource::User,
                created_ts: 0,
                updated_ts: 0,
            },
        )
        .unwrap();
        let all = list(&builtin, &store, &config_store).unwrap();
        assert_eq!(all.len(), 2);
        // 排序后 Alpha 在前
        assert_eq!(all[0].name, "Alpha");
        assert_eq!(all[1].name, "Test Builtin");
    }

    #[test]
    fn test_update_builtin_rejected() {
        let store = Store::open(":memory:").unwrap();
        let s = Skill {
            id: "b-test".to_string(),
            name: "n".to_string(),
            description: "d".to_string(),
            tools: vec![],
            body: "b".to_string(),
            enabled: true,
            source: SkillSource::BuiltIn,
            created_ts: 0,
            updated_ts: 0,
        };
        assert!(update(&store, s).is_err());
    }

    #[test]
    fn test_delete_builtin_rejected() {
        let store = Store::open(":memory:").unwrap();
        assert!(delete(&store, "b-test").is_err());
    }

    #[test]
    fn test_set_enabled_builtin_ok() {
        let store = Store::open(":memory:").unwrap();
        let config_store = ConfigStore::open_in_memory().unwrap();
        // 禁用内置
        set_enabled(&store, &config_store, "b-test", false).unwrap();
        let builtin = sample_builtin();
        let all = list(&builtin, &store, &config_store).unwrap();
        let b = all.iter().find(|s| s.id == "b-test").unwrap();
        assert!(!b.enabled);

        // 重新启用
        set_enabled(&store, &config_store, "b-test", true).unwrap();
        let all = list(&builtin, &store, &config_store).unwrap();
        let b = all.iter().find(|s| s.id == "b-test").unwrap();
        assert!(b.enabled);
    }

    #[test]
    fn test_get_not_found() {
        let store = Store::open(":memory:").unwrap();
        let config_store = ConfigStore::open_in_memory().unwrap();
        assert!(get(&[], &store, &config_store, "nonexistent").unwrap().is_none());
    }
}
