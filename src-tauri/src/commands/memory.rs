//! AI 长期记忆管理 IPC 命令
//!
//! 记忆本体存业务库（随工作空间隔离），开关配置存 app_config.db 的 app_setting。

use crate::error::{IpcError, IpcResult};
use crate::state::AppState;
use memos_core::memory::{
    self, AiMemory, ImportReport, MemoryConfig, MemoryImportItem, MemoryKind, MemorySource,
};
use serde::{Deserialize, Serialize};
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::State;

// ==================== 备份文件格式 ====================

/// 备份文件标识，用于导入时校验文件类型
const MEMORY_BACKUP_KIND: &str = "fragnote-ai-memory";
/// 当前备份格式版本；导入时拒绝高于此版本的（更低版本按缺省字段兼容）
const MEMORY_BACKUP_VERSION: u32 = 1;

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MemoryBackupFile {
    pub kind: String,
    pub version: u32,
    pub exported_ts: i64,
    #[serde(default)]
    pub memories: Vec<MemoryImportItem>,
}

/// 列出记忆。`query` 为内容子串过滤，`include_disabled` 为 true 时包含已停用的记忆。
#[tauri::command]
pub fn memory_list(
    state: State<'_, AppState>,
    query: Option<String>,
    include_disabled: Option<bool>,
) -> IpcResult<Vec<AiMemory>> {
    let store = state.store();
    Ok(memory::list(
        &store,
        query.as_deref(),
        include_disabled.unwrap_or(true),
    )?)
}

#[tauri::command]
pub fn memory_create(
    state: State<'_, AppState>,
    kind: MemoryKind,
    content: String,
    importance: Option<i64>,
) -> IpcResult<AiMemory> {
    let store = state.store();
    Ok(memory::create(
        &store,
        kind,
        &content,
        MemorySource::Manual,
        importance.unwrap_or(3),
        None,
    )?)
}

#[tauri::command]
pub fn memory_update(
    state: State<'_, AppState>,
    id: i64,
    kind: MemoryKind,
    content: String,
    importance: Option<i64>,
    enabled: Option<bool>,
) -> IpcResult<AiMemory> {
    let store = state.store();
    Ok(memory::update(
        &store,
        id,
        kind,
        &content,
        importance.unwrap_or(3),
        enabled.unwrap_or(true),
    )?)
}

#[tauri::command]
pub fn memory_delete(state: State<'_, AppState>, id: i64) -> IpcResult<()> {
    let store = state.store();
    Ok(memory::delete(&store, id)?)
}

#[tauri::command]
pub fn memory_set_enabled(state: State<'_, AppState>, id: i64, enabled: bool) -> IpcResult<()> {
    let store = state.store();
    Ok(memory::set_enabled(&store, id, enabled)?)
}

/// 清空全部记忆，返回删除条数。
#[tauri::command]
pub fn memory_clear(state: State<'_, AppState>) -> IpcResult<usize> {
    let store = state.store();
    Ok(memory::clear(&store)?)
}

/// 重建缺失的记忆向量，返回生成条数。
///
/// 需要嵌入模型已在本地 —— 该命令不会触发 90MB 模型下载，模型缺失时提示用户
/// 先执行一次语义搜索（或使用「本地语义搜索」）以完成模型准备。
#[tauri::command]
pub fn memory_reindex(state: State<'_, AppState>) -> IpcResult<usize> {
    if !crate::embedding::is_model_available() {
        return Err(crate::error::IpcError::BadRequest(
            "嵌入模型尚未准备完成，请先在笔记中执行一次语义搜索以下载模型".into(),
        ));
    }

    // 先在短锁内取出待补条目，再在无锁状态下做推理，最后回写
    let pending = {
        let store = state.store();
        memory::list_without_embedding(&store, 1000)?
    };

    let mut vectors: Vec<(i64, String)> = Vec::with_capacity(pending.len());
    for (id, content) in pending {
        let json = crate::embedding::embed_to_json(&content)
            .map_err(|e| crate::error::IpcError::Internal(format!("生成 embedding 失败: {e}")))?;
        vectors.push((id, json));
    }

    let store = state.store();
    let mut done = 0usize;
    for (id, json) in vectors {
        memory::set_embedding(&store, id, &json)?;
        done += 1;
    }
    Ok(done)
}

/// 导出全部记忆为 JSON 备份（含停用项；不含本地 id / 来源会话）。
///
/// 记忆是用户画像，故意**不并入** `export_memos_json` 的工作空间备份，需用户显式导出。
#[tauri::command]
pub fn memory_export_json(state: State<'_, AppState>) -> IpcResult<String> {
    let store = state.store();
    let memories = memory::export_items(&store)?;
    let exported_ts = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0);
    let file = MemoryBackupFile {
        kind: MEMORY_BACKUP_KIND.to_string(),
        version: MEMORY_BACKUP_VERSION,
        exported_ts,
        memories,
    };
    serde_json::to_string_pretty(&file).map_err(|e| IpcError::Internal(format!("序列化失败: {e}")))
}

/// 导入记忆备份（幂等：内容重复的条目只提升重要度，不覆盖本地状态）。
///
/// 同时接受带封装的对象与裸数组两种形式，便于手工整理后的文件导入。
#[tauri::command]
pub fn memory_import_json(
    state: State<'_, AppState>,
    json_str: String,
) -> IpcResult<ImportReport> {
    let json = json_str.trim();
    if json.is_empty() {
        return Err(IpcError::BadRequest("导入内容为空".into()));
    }

    let items: Vec<MemoryImportItem> = if json.starts_with('[') {
        serde_json::from_str(json)
            .map_err(|e| IpcError::BadRequest(format!("JSON 解析失败: {e}")))?
    } else {
        let file: MemoryBackupFile = serde_json::from_str(json)
            .map_err(|e| IpcError::BadRequest(format!("JSON 解析失败: {e}")))?;
        if file.kind != MEMORY_BACKUP_KIND {
            return Err(IpcError::BadRequest(format!(
                "不是记忆备份文件（kind 为 {}，期望 {}）",
                file.kind, MEMORY_BACKUP_KIND
            )));
        }
        if file.version > MEMORY_BACKUP_VERSION {
            return Err(IpcError::BadRequest(format!(
                "备份文件版本 {} 高于当前支持的版本 {}，请升级应用后再导入",
                file.version, MEMORY_BACKUP_VERSION
            )));
        }
        file.memories
    };

    let store = state.store();
    Ok(memory::import_many(&store, &items)?)
}

#[tauri::command]
pub fn memory_get_config(state: State<'_, AppState>) -> IpcResult<MemoryConfig> {
    let config_store = state.config_store();
    Ok(memory::load_config(&config_store))
}

#[tauri::command]
pub fn memory_set_config(
    state: State<'_, AppState>,
    config: MemoryConfig,
) -> IpcResult<MemoryConfig> {
    let config_store = state.config_store();
    Ok(memory::save_config(&config_store, &config)?)
}
