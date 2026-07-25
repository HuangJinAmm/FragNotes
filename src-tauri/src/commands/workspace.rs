//! 工作空间管理 IPC 命令

use crate::error::{IpcError, IpcResult};
use crate::state::AppState;
use crate::workspace::{Workspace, WorkspaceRegistry, WorkspaceStatus};
use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use tauri::Emitter;

#[derive(Debug, Serialize)]
pub struct WorkspaceInfo {
    pub id: String,
    pub name: String,
    pub path: String,
    pub created_ts: i64,
    pub is_active: bool,
    pub status: String,
}

fn status_str(status: &WorkspaceStatus) -> &'static str {
    match status {
        WorkspaceStatus::Valid => "valid",
        WorkspaceStatus::PathNotFound => "path_not_found",
        WorkspaceStatus::PathNotDir => "path_not_dir",
        WorkspaceStatus::NotWritable => "not_writable",
    }
}

/// 列出所有工作空间
#[tauri::command]
pub fn workspace_list(state: tauri::State<'_, AppState>) -> IpcResult<Vec<WorkspaceInfo>> {
    let reg = state
        .workspace_registry
        .lock()
        .expect("WorkspaceRegistry Mutex poisoned");
    let active_id = reg.active_workspace_id.clone();
    let result = reg
        .workspaces
        .iter()
        .map(|ws| WorkspaceInfo {
            id: ws.id.clone(),
            name: ws.name.clone(),
            path: ws.path.to_string_lossy().to_string(),
            created_ts: ws.created_ts,
            is_active: Some(ws.id.clone()) == active_id,
            status: status_str(&WorkspaceRegistry::validate(&ws.path)).to_string(),
        })
        .collect();
    Ok(result)
}

#[derive(Debug, Deserialize)]
pub struct CreateWorkspaceRequest {
    pub name: String,
    pub path: String,
}

/// 创建新工作空间
#[tauri::command]
pub fn workspace_create(
    state: tauri::State<'_, AppState>,
    req: CreateWorkspaceRequest,
) -> IpcResult<WorkspaceInfo> {
    let path = PathBuf::from(&req.path);

    if path.exists() && !path.is_dir() {
        return Err(IpcError::BadRequest("路径已存在但不是目录".into()));
    }
    if !path.exists() {
        std::fs::create_dir_all(&path)
            .map_err(|e| IpcError::Internal(format!("创建工作空间目录失败: {e}")))?;
    }
    let status = WorkspaceRegistry::validate(&path);
    if status != WorkspaceStatus::Valid {
        return Err(IpcError::BadRequest(format!(
            "工作空间路径无效: {:?}",
            status
        )));
    }

    let db_path = path.join("memos.db");
    if !db_path.exists() {
        memos_core::Store::open(&db_path)
            .map_err(|e| IpcError::Internal(format!("初始化 memos.db 失败: {e}")))?;
    }

    let attachments_dir = path.join("attachments");
    std::fs::create_dir_all(&attachments_dir)
        .map_err(|e| IpcError::Internal(format!("创建 attachments 目录失败: {e}")))?;

    let config_dir = state.config_dir.clone();
    let mut reg = state
        .workspace_registry
        .lock()
        .expect("WorkspaceRegistry Mutex poisoned");
    let ws = reg.add(&req.name, path.clone());
    let ws_id = ws.id.clone();
    let ws_name = ws.name.clone();
    let ws_path = ws.path.clone();
    let ws_created = ws.created_ts;
    let is_active = reg.active_workspace_id == Some(ws_id.clone());
    reg.save(&config_dir)?;

    Ok(WorkspaceInfo {
        id: ws_id,
        name: ws_name,
        path: ws_path.to_string_lossy().to_string(),
        created_ts: ws_created,
        is_active,
        status: "valid".to_string(),
    })
}

/// 切换工作空间（更新 active 并重启应用）
#[tauri::command]
pub async fn workspace_switch(
    state: tauri::State<'_, AppState>,
    app_handle: tauri::AppHandle,
    id: String,
) -> IpcResult<()> {
    // 检查是否有运行中的 AI Agent 任务
    if crate::ai::agent_loop::is_any_running() {
        return Err(IpcError::BadRequest(
            "有正在执行的 AI 任务，请等待完成或中止后再切换".into(),
        ));
    }

    let config_dir = state.config_dir.clone();
    let mut reg = state
        .workspace_registry
        .lock()
        .expect("WorkspaceRegistry Mutex poisoned");

    let ws = reg
        .get(&id)
        .ok_or_else(|| IpcError::NotFound(format!("workspace {id}")))?
        .clone();

    let status = WorkspaceRegistry::validate(&ws.path);
    if status != WorkspaceStatus::Valid {
        return Err(IpcError::BadRequest(format!(
            "工作空间路径无效: {:?}",
            status
        )));
    }

    reg.set_active(&id)?;
    reg.save(&config_dir)?;

    let _ = app_handle.emit("workspace_switching", ());

    std::thread::spawn(move || {
        std::thread::sleep(std::time::Duration::from_millis(500));
        app_handle.restart();
    });

    Ok(())
}

/// 重命名工作空间
#[tauri::command]
pub fn workspace_rename(
    state: tauri::State<'_, AppState>,
    id: String,
    new_name: String,
) -> IpcResult<()> {
    let config_dir = state.config_dir.clone();
    let mut reg = state
        .workspace_registry
        .lock()
        .expect("WorkspaceRegistry Mutex poisoned");
    reg.rename(&id, &new_name)?;
    reg.save(&config_dir)?;
    Ok(())
}

/// 删除工作空间（仅从注册表移除）
#[tauri::command]
pub fn workspace_delete(state: tauri::State<'_, AppState>, id: String) -> IpcResult<()> {
    let config_dir = state.config_dir.clone();
    let mut reg = state
        .workspace_registry
        .lock()
        .expect("WorkspaceRegistry Mutex poisoned");
    reg.remove(&id)?;
    reg.save(&config_dir)?;
    Ok(())
}

/// 在文件管理器中打开工作空间目录
#[tauri::command]
pub fn workspace_open_in_explorer(path: String) -> IpcResult<()> {
    #[cfg(target_os = "windows")]
    {
        std::process::Command::new("explorer")
            .arg(&path)
            .spawn()
            .map_err(|e| IpcError::Internal(format!("打开资源管理器失败: {e}")))?;
    }
    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("open")
            .arg(&path)
            .spawn()
            .map_err(|e| IpcError::Internal(format!("打开 Finder 失败: {e}")))?;
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        std::process::Command::new("xdg-open")
            .arg(&path)
            .spawn()
            .map_err(|e| IpcError::Internal(format!("打开文件管理器失败: {e}")))?;
    }
    Ok(())
}
