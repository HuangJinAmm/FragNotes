//! 工作空间注册表：管理 workspaces.json 索引文件
//!
//! workspaces.json 存于引导目录（Tauri app_config_dir），
//! 记录所有工作空间列表和当前 active workspace。
//! 工作空间目录本身由用户选择，包含 memos.db 和 attachments/。

use crate::error::{IpcError, IpcResult};
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use uuid::Uuid;

/// 单个工作空间记录
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Workspace {
    pub id: String,
    pub name: String,
    pub path: PathBuf,
    pub created_ts: i64,
}

/// workspaces.json 根结构
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WorkspaceRegistry {
    pub version: u32,
    pub active_workspace_id: Option<String>,
    pub workspaces: Vec<Workspace>,
}

impl Default for WorkspaceRegistry {
    fn default() -> Self {
        Self {
            version: 1,
            active_workspace_id: None,
            workspaces: Vec::new(),
        }
    }
}

/// 工作空间校验结果
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum WorkspaceStatus {
    Valid,
    PathNotFound,
    PathNotDir,
    NotWritable,
}

impl WorkspaceRegistry {
    /// 从引导目录加载 workspaces.json
    pub fn load(config_dir: &Path) -> Self {
        let path = config_dir.join("workspaces.json");
        match std::fs::read_to_string(&path) {
            Ok(content) => match serde_json::from_str::<WorkspaceRegistry>(&content) {
                Ok(reg) => reg,
                Err(e) => {
                    tracing::warn!("workspaces.json 解析失败: {}，备份后重建空 registry", e);
                    let backup = config_dir.join(format!(
                        "workspaces.json.corrupt.{}",
                        std::time::SystemTime::now()
                            .duration_since(std::time::UNIX_EPOCH)
                            .unwrap_or_default()
                            .as_secs()
                    ));
                    let _ = std::fs::rename(&path, &backup);
                    WorkspaceRegistry::default()
                }
            },
            Err(_) => {
                tracing::info!("workspaces.json 不存在，初始化空 registry");
                WorkspaceRegistry::default()
            }
        }
    }

    /// 原子保存到引导目录（.tmp + rename）
    pub fn save(&self, config_dir: &Path) -> IpcResult<()> {
        let path = config_dir.join("workspaces.json");
        let tmp_path = config_dir.join("workspaces.json.tmp");
        let content = serde_json::to_string_pretty(self)
            .map_err(|e| IpcError::Internal(format!("序列化 workspaces.json 失败: {e}")))?;
        std::fs::write(&tmp_path, content)
            .map_err(|e| IpcError::Internal(format!("写入 workspaces.json.tmp 失败: {e}")))?;
        std::fs::rename(&tmp_path, &path)
            .map_err(|e| IpcError::Internal(format!("rename workspaces.json 失败: {e}")))?;
        Ok(())
    }

    pub fn add(&mut self, name: &str, path: PathBuf) -> &Workspace {
        let ws = Workspace {
            id: format!("ws-{}", Uuid::new_v4()),
            name: name.to_string(),
            path,
            created_ts: std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap_or_default()
                .as_secs() as i64,
        };
        if self.active_workspace_id.is_none() {
            self.active_workspace_id = Some(ws.id.clone());
        }
        self.workspaces.push(ws);
        self.workspaces.last().unwrap()
    }

    pub fn remove(&mut self, id: &str) -> IpcResult<()> {
        let before = self.workspaces.len();
        self.workspaces.retain(|w| w.id != id);
        if self.workspaces.len() == before {
            return Err(IpcError::NotFound(format!("workspace {id}")));
        }
        if self.active_workspace_id.as_deref() == Some(id) {
            self.active_workspace_id = self.workspaces.first().map(|w| w.id.clone());
        }
        Ok(())
    }

    pub fn rename(&mut self, id: &str, new_name: &str) -> IpcResult<()> {
        let ws = self
            .workspaces
            .iter_mut()
            .find(|w| w.id == id)
            .ok_or_else(|| IpcError::NotFound(format!("workspace {id}")))?;
        ws.name = new_name.to_string();
        Ok(())
    }

    pub fn set_active(&mut self, id: &str) -> IpcResult<()> {
        if !self.workspaces.iter().any(|w| w.id == id) {
            return Err(IpcError::NotFound(format!("workspace {id}")));
        }
        self.active_workspace_id = Some(id.to_string());
        Ok(())
    }

    pub fn get_active(&self) -> Option<&Workspace> {
        self.active_workspace_id
            .as_ref()
            .and_then(|id| self.workspaces.iter().find(|w| &w.id == id))
    }

    pub fn get(&self, id: &str) -> Option<&Workspace> {
        self.workspaces.iter().find(|w| w.id == id)
    }

    pub fn validate(path: &Path) -> WorkspaceStatus {
        if !path.exists() {
            return WorkspaceStatus::PathNotFound;
        }
        if !path.is_dir() {
            return WorkspaceStatus::PathNotDir;
        }
        let test_file = path.join(".workspace_write_test");
        match std::fs::File::create(&test_file) {
            Ok(_) => {
                let _ = std::fs::remove_file(&test_file);
                WorkspaceStatus::Valid
            }
            Err(_) => WorkspaceStatus::NotWritable,
        }
    }
}

pub type SharedWorkspaceRegistry = std::sync::Mutex<WorkspaceRegistry>;

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    #[test]
    fn test_load_missing_file_returns_empty() {
        let tmp = TempDir::new().unwrap();
        let reg = WorkspaceRegistry::load(tmp.path());
        assert_eq!(reg.version, 1);
        assert!(reg.active_workspace_id.is_none());
        assert!(reg.workspaces.is_empty());
    }

    #[test]
    fn test_save_load_roundtrip() {
        let tmp = TempDir::new().unwrap();
        let mut reg = WorkspaceRegistry::default();
        reg.add("Test Workspace", tmp.path().join("ws1"));
        reg.save(tmp.path()).unwrap();

        let loaded = WorkspaceRegistry::load(tmp.path());
        assert_eq!(loaded.workspaces.len(), 1);
        assert_eq!(loaded.workspaces[0].name, "Test Workspace");
        assert_eq!(loaded.workspaces[0].path, tmp.path().join("ws1"));
        assert_eq!(loaded.active_workspace_id, Some(loaded.workspaces[0].id.clone()));
    }

    #[test]
    fn test_add_first_sets_active() {
        let mut reg = WorkspaceRegistry::default();
        let ws = reg.add("First", PathBuf::from("/tmp/ws1")).clone();
        assert_eq!(reg.active_workspace_id, Some(ws.id));
    }

    #[test]
    fn test_add_second_does_not_change_active() {
        let mut reg = WorkspaceRegistry::default();
        let first = reg.add("First", PathBuf::from("/tmp/ws1")).clone();
        reg.add("Second", PathBuf::from("/tmp/ws2"));
        assert_eq!(reg.active_workspace_id, Some(first.id));
    }

    #[test]
    fn test_remove_active_selects_another() {
        let mut reg = WorkspaceRegistry::default();
        let first = reg.add("First", PathBuf::from("/tmp/ws1")).clone();
        reg.add("Second", PathBuf::from("/tmp/ws2"));
        reg.remove(&first.id).unwrap();
        assert!(reg.active_workspace_id.is_some());
        assert_ne!(reg.active_workspace_id, Some(first.id));
    }

    #[test]
    fn test_remove_last_clears_active() {
        let mut reg = WorkspaceRegistry::default();
        let ws = reg.add("Only", PathBuf::from("/tmp/ws1")).clone();
        reg.remove(&ws.id).unwrap();
        assert!(reg.active_workspace_id.is_none());
    }

    #[test]
    fn test_remove_nonexistent_returns_error() {
        let mut reg = WorkspaceRegistry::default();
        assert!(reg.remove("ws-nonexistent").is_err());
    }

    #[test]
    fn test_rename() {
        let mut reg = WorkspaceRegistry::default();
        let ws = reg.add("Old", PathBuf::from("/tmp/ws1")).clone();
        reg.rename(&ws.id, "New Name").unwrap();
        assert_eq!(reg.get(&ws.id).unwrap().name, "New Name");
    }

    #[test]
    fn test_set_active() {
        let mut reg = WorkspaceRegistry::default();
        let first = reg.add("First", PathBuf::from("/tmp/ws1")).clone();
        let second = reg.add("Second", PathBuf::from("/tmp/ws2")).clone();
        reg.set_active(&second.id).unwrap();
        assert_eq!(reg.active_workspace_id, Some(second.id));
        reg.set_active(&first.id).unwrap();
        assert_eq!(reg.active_workspace_id, Some(first.id));
    }

    #[test]
    fn test_set_active_nonexistent_returns_error() {
        let mut reg = WorkspaceRegistry::default();
        assert!(reg.set_active("ws-nonexistent").is_err());
    }

    #[test]
    fn test_validate_path_not_found() {
        let status = WorkspaceRegistry::validate(Path::new("/nonexistent/path/that/does/not/exist"));
        assert_eq!(status, WorkspaceStatus::PathNotFound);
    }

    #[test]
    fn test_validate_path_not_dir() {
        let tmp = TempDir::new().unwrap();
        let file_path = tmp.path().join("not_a_dir.txt");
        std::fs::write(&file_path, "hello").unwrap();
        let status = WorkspaceRegistry::validate(&file_path);
        assert_eq!(status, WorkspaceStatus::PathNotDir);
    }

    #[test]
    fn test_validate_valid_dir() {
        let tmp = TempDir::new().unwrap();
        let status = WorkspaceRegistry::validate(tmp.path());
        assert_eq!(status, WorkspaceStatus::Valid);
    }

    #[test]
    fn test_load_corrupt_json_backs_up_and_returns_empty() {
        let tmp = TempDir::new().unwrap();
        let path = tmp.path().join("workspaces.json");
        std::fs::write(&path, "{ invalid json").unwrap();
        let reg = WorkspaceRegistry::load(tmp.path());
        assert!(reg.workspaces.is_empty());
        let entries = std::fs::read_dir(tmp.path()).unwrap();
        let has_backup = entries.filter_map(|e| e.ok()).any(|e| {
            e.file_name().to_string_lossy().starts_with("workspaces.json.corrupt.")
        });
        assert!(has_backup);
    }
}
