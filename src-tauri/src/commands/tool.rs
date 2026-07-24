//! Tool 管理 IPC 命令

use crate::error::IpcResult;
use crate::state::AppState;
use memos_core::tool::Tool;
use tauri::State;

#[derive(Debug, Clone, serde::Serialize)]
pub struct ToolDto {
    pub id: String,
    pub name: String,
    pub command: String,
    pub permission: String, // snake_case 字符串
    pub description: String,
    pub timeout_ms: i64,
    pub enabled: bool,
    pub created_ts: i64,
    pub updated_ts: i64,
}

impl From<Tool> for ToolDto {
    fn from(t: Tool) -> Self {
        Self {
            id: t.id,
            name: t.name,
            command: t.command,
            permission: t.permission.as_str().to_string(),
            description: t.description,
            timeout_ms: t.timeout_ms,
            enabled: t.enabled,
            created_ts: t.created_ts,
            updated_ts: t.updated_ts,
        }
    }
}

#[tauri::command]
pub fn tool_list(
    enabled: Option<bool>,
    state: State<'_, AppState>,
) -> IpcResult<Vec<ToolDto>> {
    let store = state.store();
    let tools = match enabled {
        Some(true) => memos_core::tool::list_enabled(&store)?,
        Some(false) | None => memos_core::tool::list(&store)?,
    };
    Ok(tools.into_iter().map(ToolDto::from).collect())
}

#[tauri::command]
pub fn tool_create(tool: Tool, state: State<'_, AppState>) -> IpcResult<ToolDto> {
    let store = state.store();
    let created = memos_core::tool::create(&store, tool)?;
    Ok(ToolDto::from(created))
}

#[tauri::command]
pub fn tool_update(tool: Tool, state: State<'_, AppState>) -> IpcResult<ToolDto> {
    let store = state.store();
    let updated = memos_core::tool::update(&store, tool)?;
    Ok(ToolDto::from(updated))
}

#[tauri::command]
pub fn tool_delete(id: String, state: State<'_, AppState>) -> IpcResult<()> {
    let store = state.store();
    memos_core::tool::delete(&store, &id)?;
    Ok(())
}

#[tauri::command]
pub fn tool_set_enabled(id: String, enabled: bool, state: State<'_, AppState>) -> IpcResult<()> {
    let store = state.store();
    memos_core::tool::set_enabled(&store, &id, enabled)?;
    Ok(())
}

#[tauri::command]
pub fn tool_confirm_response(
    call_id: u64,
    approved: bool,
    state: State<'_, AppState>,
) -> IpcResult<bool> {
    Ok(state.pending_confirmations.respond(call_id, approved))
}
