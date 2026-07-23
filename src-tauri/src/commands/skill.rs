//! Skill 管理 IPC 命令

use crate::error::IpcResult;
use crate::state::AppState;
use memos_core::skill::{Skill, SkillSource};
use tauri::State;

#[derive(Debug, Clone, serde::Serialize)]
pub struct SkillDto {
    pub id: String,
    pub name: String,
    pub description: String,
    pub tools: Vec<String>,
    pub body: String,
    pub enabled: bool,
    pub source: String, // "builtin" | "user"
    pub created_ts: i64,
    pub updated_ts: i64,
}

impl From<Skill> for SkillDto {
    fn from(s: Skill) -> Self {
        Self {
            source: match s.source {
                SkillSource::BuiltIn => "builtin".to_string(),
                SkillSource::User => "user".to_string(),
            },
            id: s.id,
            name: s.name,
            description: s.description,
            tools: s.tools,
            body: s.body,
            enabled: s.enabled,
            created_ts: s.created_ts,
            updated_ts: s.updated_ts,
        }
    }
}

#[tauri::command]
pub fn skill_list(state: State<'_, AppState>) -> IpcResult<Vec<SkillDto>> {
    let store = state.store();
    let builtin = state.builtin_skills.clone();
    let skills = memos_core::skill::list(&builtin, &store)?;
    Ok(skills.into_iter().map(SkillDto::from).collect())
}

#[tauri::command]
pub fn skill_create(state: State<'_, AppState>, skill: Skill) -> IpcResult<SkillDto> {
    let store = state.store();
    let created = memos_core::skill::create(&store, skill)?;
    Ok(SkillDto::from(created))
}

#[tauri::command]
pub fn skill_update(state: State<'_, AppState>, skill: Skill) -> IpcResult<SkillDto> {
    let store = state.store();
    let updated = memos_core::skill::update(&store, skill)?;
    Ok(SkillDto::from(updated))
}

#[tauri::command]
pub fn skill_delete(state: State<'_, AppState>, id: String) -> IpcResult<()> {
    let store = state.store();
    memos_core::skill::delete(&store, &id)?;
    Ok(())
}

#[tauri::command]
pub fn skill_set_enabled(state: State<'_, AppState>, id: String, enabled: bool) -> IpcResult<()> {
    let store = state.store();
    memos_core::skill::set_enabled(&store, &id, enabled)?;
    Ok(())
}
