//! officecli watch 子进程管理
//!
//! 每次调用 officecli 工具时，会尝试为当前操作的文档启动一个 `officecli watch <file>` 子进程，
//! 在 http://localhost:26315 暴露实时预览。同一文件不会重复启动；切换到新文件时会先停掉旧 watch。
//! 应用退出时统一 kill 所有 watch 子进程。

use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::Mutex;
use std::time::{Duration, Instant};
use tauri::Manager;

/// watch 预览服务监听的端口
pub const WATCH_PORT: u16 = 26315;

/// 单个 watch 子进程句柄及其元数据
pub struct WatchHandle {
    pub file: PathBuf,
    pub child: std::process::Child,
    pub spawned_at: Instant,
}

impl WatchHandle {
    /// 尝试结束子进程（best effort）
    pub fn kill(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

/// 全局 watch 进程管理器（同时只保留一个 watch 进程）
///
/// 设计：单文件预览模式。同端口 26315 一次只能服务一个文件。
/// 切换文件时停掉旧 watch，再启动新 watch。
pub struct OfficecliWatchManager {
    inner: Mutex<Option<WatchHandle>>,
}

impl OfficecliWatchManager {
    pub fn new() -> Self {
        Self {
            inner: Mutex::new(None),
        }
    }

    /// 确保指定文件已启动 watch 服务。
    ///
    /// - 若当前 watch 的就是该文件（按规范化路径比较），直接返回 Ok(false)
    /// - 否则先停掉旧 watch，再启动新 watch，返回 Ok(true)
    ///
    /// 使用 std::process::Command 同步 spawn（watch 是长驻进程，spawn 后立即返回）
    pub fn ensure_watching(
        &self,
        binary_path: &Path,
        file: &Path,
        cwd: &Path,
    ) -> std::io::Result<bool> {
        let normalized = normalize_path(file);

        let mut guard = self.inner.lock().expect("watch Mutex poisoned");

        // 已有 watch 且是同一文件 → 跳过
        if let Some(handle) = guard.as_mut() {
            let current_norm = normalize_path(&handle.file);
            if current_norm == normalized {
                // 检查子进程是否仍在运行
                match handle.child.try_wait() {
                    Ok(None) => {
                        tracing::debug!(
                            file = %file.display(),
                            "officecli watch: 已在运行，跳过启动"
                        );
                        return Ok(false);
                    }
                    Ok(Some(_)) => {
                        tracing::info!(
                            file = %file.display(),
                            "officecli watch: 旧 watch 进程已退出，将重启"
                        );
                        // 已退出，清理后重启
                        let _ = guard.take();
                    }
                    Err(_) => {
                        let _ = guard.take();
                    }
                }
            }
        }

        // 停掉旧 watch（不同文件 → 切换）
        if let Some(mut old) = guard.take() {
            tracing::info!(
                old_file = %old.file.display(),
                "officecli watch: 停止旧 watch 进程"
            );
            old.kill();
            // 短暂等待端口释放
            drop(old);
            std::thread::sleep(Duration::from_millis(150));
        }

        // 启动新 watch
        let mut cmd = std::process::Command::new(binary_path);
        cmd.arg("watch").arg(file).current_dir(cwd);
        cmd.stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null());

        #[cfg(windows)]
        {
            const CREATE_NO_WINDOW: u32 = 0x08000000;
            use std::os::windows::process::CommandExt;
            cmd.creation_flags(CREATE_NO_WINDOW);
        }

        let child = cmd.spawn()?;

        tracing::info!(
            file = %file.display(),
            port = WATCH_PORT,
            "officecli watch: 已启动预览服务"
        );

        *guard = Some(WatchHandle {
            file: file.to_path_buf(),
            child,
            spawned_at: Instant::now(),
        });

        Ok(true)
    }

    /// 停止所有 watch 子进程
    pub fn stop_all(&self) {
        let mut guard = self.inner.lock().expect("watch Mutex poisoned");
        if let Some(mut handle) = guard.take() {
            tracing::info!(
                file = %handle.file.display(),
                "officecli watch: 应用退出，停止 watch 进程"
            );
            handle.kill();
        }
    }
}

/// 规范化路径用于比较（小写化 + 标准化分隔符）
#[cfg(windows)]
fn normalize_path(p: &Path) -> PathBuf {
    let mut s = p.to_string_lossy().to_lowercase();
    s = s.replace('/', "\\");
    PathBuf::from(s)
}

#[cfg(not(windows))]
fn normalize_path(p: &Path) -> PathBuf {
    p.to_path_buf()
}

/// 在 Tauri 应用中打开预览窗口（如果尚未打开则创建，否则聚焦）
///
/// 创建新窗口时会注册 CloseRequested 事件：用户关闭窗口时自动停止 watch 子进程。
pub fn open_preview_window(app_handle: &tauri::AppHandle) {
    let label = "officecli-preview";

    if let Some(window) = app_handle.get_webview_window(label) {
        // 已存在窗口：聚焦并刷新
        tracing::debug!("officecli watch: 预览窗口已存在，聚焦");
        let _ = window.show();
        let _ = window.set_focus();
        // 刷新以加载最新预览
        let _ = window.eval("window.location.reload();");
        return;
    }

    tracing::info!("officecli watch: 创建新预览窗口");
    let url = format!("http://localhost:{}/", WATCH_PORT);

    let build_result = tauri::WebviewWindowBuilder::new(
        app_handle,
        label,
        tauri::WebviewUrl::External(url.parse().expect("valid url")),
    )
    .title("Officecli Preview")
    .inner_size(1024.0, 720.0)
    .min_inner_size(480.0, 360.0)
    .build();

    match build_result {
        Ok(window) => {
            // 注册关闭事件：用户关闭预览窗口时停止 watch 子进程
            let app_handle_clone = app_handle.clone();
            window.on_window_event(move |event| {
                if let tauri::WindowEvent::CloseRequested { .. } = event {
                    tracing::info!(
                        "officecli watch: 预览窗口关闭请求，停止 watch 进程"
                    );
                    let state = app_handle_clone.state::<crate::state::AppState>();
                    state.officecli_watch.stop_all();
                }
            });
        }
        Err(e) => {
            tracing::warn!("officecli watch: 创建预览窗口失败: {}", e);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_normalize_path_windows() {
        #[cfg(windows)]
        {
            let a = normalize_path(Path::new("C:/Users/Test/File.PPTX"));
            let b = normalize_path(Path::new("c:\\users\\test\\file.pptx"));
            assert_eq!(a, b);
        }
    }

    #[test]
    fn test_manager_start_and_stop() {
        // 仅测试内部状态机，不实际 spawn 进程
        let mgr = OfficecliWatchManager::new();
        // 初始状态为空
        {
            let guard = mgr.inner.lock().unwrap();
            assert!(guard.is_none());
        }
        // stop_all 不应 panic
        mgr.stop_all();
    }
}
