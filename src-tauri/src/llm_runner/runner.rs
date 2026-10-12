//! 进程管理：spawn / kill / 状态查询 / 日志捕获
//!
//! 生命周期模型：前台长驻子进程。
//! 应用不内置任何模型运行时（不自带 llama.cpp / LM Studio 等命令），
//! 只把用户在设置页填写的完整命令行解析后 spawn 为子进程，跟踪 PID；
//! stop 时终止该子进程（Windows 下连同子进程树）。

use crate::llm_runner::config::{effective_base_url, LlmRunnerConfig};
use serde::Serialize;
use std::collections::VecDeque;
use std::io::{BufRead, BufReader};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, RwLock};
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Emitter};
use thiserror::Error;

/// 日志环缓冲区最大行数
const LOG_BUFFER_LINES: usize = 500;

/// 启动器错误
#[derive(Debug, Error)]
pub enum LlmRunnerError {
    #[error("IO 错误: {0}")]
    Io(#[from] std::io::Error),
    #[error("配置错误: {0}")]
    Config(String),
}

/// 运行状态快照（IPC 返回）
#[derive(Debug, Clone, Serialize)]
pub struct LlmRunnerStatus {
    pub running: bool,
    pub pid: Option<u32>,
    pub base_url: String,
    pub started_at: Option<i64>,
    pub last_error: Option<String>,
    pub recent_logs: Vec<String>,
    pub config: LlmRunnerConfig,
}

/// 运行时状态：持有子进程、运行标志、日志缓冲
pub struct LlmRunnerState {
    pub config: RwLock<LlmRunnerConfig>,
    /// 用户命令行启动的子进程句柄
    child: Mutex<Option<Child>>,
    running: AtomicBool,
    logs: RwLock<VecDeque<String>>,
    started_at: RwLock<Option<i64>>,
    last_error: RwLock<Option<String>>,
}

impl LlmRunnerState {
    pub fn new(config: LlmRunnerConfig) -> Self {
        Self {
            config: RwLock::new(config),
            child: Mutex::new(None),
            running: AtomicBool::new(false),
            logs: RwLock::new(VecDeque::with_capacity(LOG_BUFFER_LINES)),
            started_at: RwLock::new(None),
            last_error: RwLock::new(None),
        }
    }

    /// 当前是否仍在运行（双检子进程状态，进程已退出时自动回收）
    pub fn is_running(&self) -> bool {
        if !self.running.load(Ordering::SeqCst) {
            return false;
        }
        let mut guard = self.child.lock().unwrap();
        if let Some(child) = guard.as_mut() {
            match child.try_wait() {
                Ok(Some(_)) => {
                    // 进程已退出，回收并清空
                    *guard = None;
                    self.running.store(false, Ordering::SeqCst);
                    *self.started_at.write().unwrap() = None;
                    false
                }
                Ok(None) => true,
                Err(_) => {
                    *guard = None;
                    self.running.store(false, Ordering::SeqCst);
                    *self.started_at.write().unwrap() = None;
                    false
                }
            }
        } else {
            self.running.store(false, Ordering::SeqCst);
            false
        }
    }

    /// 当前 base_url（OpenAI 兼容端点）
    ///
    /// 优先返回用户在配置中显式填写的 `base_url`；为空时回退到默认值。
    pub fn base_url(&self) -> String {
        let cfg = self.config.read().unwrap();
        effective_base_url(&cfg)
    }

    /// 状态快照
    pub fn status(&self) -> LlmRunnerStatus {
        let running = self.is_running();
        let pid = self
            .child
            .lock()
            .unwrap()
            .as_ref()
            .map(|c| c.id());
        LlmRunnerStatus {
            running,
            pid,
            base_url: self.base_url(),
            started_at: *self.started_at.read().unwrap(),
            last_error: self.last_error.read().unwrap().clone(),
            recent_logs: self.logs.read().unwrap().iter().cloned().collect(),
            config: self.config.read().unwrap().clone(),
        }
    }

    fn set_last_error(&self, msg: String) {
        *self.last_error.write().unwrap() = Some(msg);
    }

    fn append_log(&self, line: String) {
        let mut logs = self.logs.write().unwrap();
        if logs.len() >= LOG_BUFFER_LINES {
            logs.pop_front();
        }
        logs.push_back(line);
    }

    /// 更新运行配置（仅在未运行时调用，避免运行中改配置导致状态不一致）
    pub fn update_config(&self, config: LlmRunnerConfig) {
        *self.config.write().unwrap() = config;
    }
}

/// 启动本地 LLM 服务（按用户配置的命令行 spawn 子进程）
pub fn start_runner(
    state: Arc<LlmRunnerState>,
    app_handle: AppHandle,
) -> Result<(), LlmRunnerError> {
    if state.is_running() {
        return Ok(());
    }

    let config = state.config.read().unwrap().clone();

    let mut cmd = match build_command(&config) {
        Ok(c) => c,
        Err(e) => {
            state.set_last_error(e.to_string());
            let _ = app_handle.emit("llm:status-changed", ());
            return Err(e);
        }
    };
    cmd.stdout(Stdio::piped()).stderr(Stdio::piped());

    tracing::info!(?cmd, "LLM 启动器: spawn 用户命令行进程");

    let mut child = match cmd.spawn() {
        Ok(c) => c,
        Err(e) => {
            let msg = format!("启动失败: {e}");
            state.set_last_error(msg.clone());
            state.append_log(format!("[error] {msg}"));
            let _ = app_handle.emit("llm:status-changed", ());
            return Err(LlmRunnerError::Io(e));
        }
    };

    let pid = child.id();
    let stdout = child.stdout.take();
    let stderr = child.stderr.take();
    *state.child.lock().unwrap() = Some(child);
    state.running.store(true, Ordering::SeqCst);
    *state.started_at.write().unwrap() = Some(now_epoch_secs());
    *state.last_error.write().unwrap() = None;
    state.append_log(format!("[info] 进程已启动 (pid={pid})"));
    state.append_log(format!("[info] 命令行: {}", config.command.trim()));

    // 日志捕获 + 退出监控线程
    let state_clone = Arc::clone(&state);
    let app_clone = app_handle.clone();
    std::thread::spawn(move || {
        // 先消费 stderr（模型服务主要日志输出到 stderr），再消费 stdout
        if let Some(stderr) = stderr {
            let reader = BufReader::new(stderr);
            for line in reader.lines() {
                match line {
                    Ok(l) if !l.is_empty() => {
                        state_clone.append_log(l.clone());
                        let _ = app_clone.emit("llm:log", l);
                    }
                    Ok(_) => {}
                    Err(_) => break,
                }
            }
        }
        if let Some(stdout) = stdout {
            let reader = BufReader::new(stdout);
            for line in reader.lines() {
                match line {
                    Ok(l) if !l.is_empty() => {
                        state_clone.append_log(l.clone());
                        let _ = app_clone.emit("llm:log", l);
                    }
                    Ok(_) => {}
                    Err(_) => break,
                }
            }
        }
        // 进程已退出（管道 EOF），回收子进程并清理状态
        let mut guard = state_clone.child.lock().unwrap();
        if let Some(mut child) = guard.take() {
            let _ = child.wait();
        }
        drop(guard);
        state_clone.running.store(false, Ordering::SeqCst);
        *state_clone.started_at.write().unwrap() = None;
        state_clone.append_log("[info] 进程已退出".to_string());
        let _ = app_clone.emit("llm:status-changed", ());
    });

    let _ = app_handle.emit("llm:status-changed", ());
    Ok(())
}

/// 停止本地 LLM 服务：终止用户命令行启动的子进程，释放显存/内存
pub fn stop_runner(
    state: Arc<LlmRunnerState>,
    app_handle: AppHandle,
) -> Result<(), LlmRunnerError> {
    let mut guard = state.child.lock().unwrap();
    if let Some(mut child) = guard.take() {
        terminate_child(&mut child);
        state.append_log("[info] 已终止子进程".to_string());
    }
    drop(guard);
    state.running.store(false, Ordering::SeqCst);
    *state.started_at.write().unwrap() = None;
    let _ = app_handle.emit("llm:status-changed", ());
    Ok(())
}

/// 终止子进程；Windows 下连同其子进程树一起结束（避免残留孙子进程占用显存）
fn terminate_child(child: &mut Child) {
    #[cfg(windows)]
    {
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        use std::os::windows::process::CommandExt;
        let mut cmd = Command::new("taskkill");
        cmd.args(["/PID", &child.id().to_string(), "/T", "/F"]);
        cmd.stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .creation_flags(CREATE_NO_WINDOW);
        if cmd.status().map(|s| s.success()).unwrap_or(false) {
            let _ = child.wait();
            return;
        }
    }
    let _ = child.kill();
    let _ = child.wait();
}

/// 根据用户命令行构造启动命令
///
/// 直接以第一个 token 作为可执行文件 spawn（不经过 shell，避免注入），
/// 其余 token 作为参数透传。
fn build_command(config: &LlmRunnerConfig) -> Result<Command, LlmRunnerError> {
    let tokens = split_command_line(&config.command);
    let Some((program, args)) = tokens.split_first() else {
        return Err(LlmRunnerError::Config(
            "启动命令行不能为空，请填写完整的可执行文件与参数".into(),
        ));
    };
    let mut cmd = Command::new(program);
    cmd.args(args);

    // Windows 下隐藏控制台窗口（GUI 应用不需要弹出黑框，日志已通过管道回传前端）
    #[cfg(windows)]
    {
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }

    Ok(cmd)
}

/// 解析用户填写的命令行：按空白拆分，双引号内的内容视为单个 token。
///
/// 转义支持：`\"` 转义双引号，`\\` 转义反斜杠（仅在引号内生效）。
pub fn split_command_line(s: &str) -> Vec<String> {
    let mut args = Vec::new();
    let mut current = String::new();
    let mut in_quotes = false;
    let mut chars = s.chars().peekable();

    while let Some(c) = chars.next() {
        match c {
            '"' if !in_quotes => {
                in_quotes = true;
            }
            '"' if in_quotes => {
                in_quotes = false;
            }
            '\\' if in_quotes => {
                if let Some(&next) = chars.peek() {
                    if next == '"' || next == '\\' {
                        current.push(chars.next().unwrap());
                        continue;
                    }
                }
                current.push(c);
            }
            c if c.is_whitespace() && !in_quotes => {
                if !current.is_empty() {
                    args.push(std::mem::take(&mut current));
                }
            }
            _ => {
                current.push(c);
            }
        }
    }
    if !current.is_empty() {
        args.push(current);
    }
    args
}

fn now_epoch_secs() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::llm_runner::config::DEFAULT_BASE_URL;

    fn sample_config(command: &str) -> LlmRunnerConfig {
        LlmRunnerConfig {
            command: command.to_string(),
            base_url: String::new(),
            auto_start: false,
        }
    }

    #[test]
    fn test_build_command_splits_program_and_args() {
        let cfg = sample_config("llama-server -m model.gguf --port 8080 -ngl 99");
        let cmd = build_command(&cfg).unwrap();
        assert_eq!(cmd.get_program().to_string_lossy(), "llama-server");
        let args: Vec<String> = cmd
            .get_args()
            .map(|s| s.to_string_lossy().into_owned())
            .collect();
        assert_eq!(
            args,
            vec!["-m", "model.gguf", "--port", "8080", "-ngl", "99"]
        );
    }

    #[test]
    fn test_build_command_keeps_quoted_path_as_single_arg() {
        let cfg = sample_config(r#"llama-server -m "D:\models\qwen 2.5-7b.gguf" --port 8080"#);
        let cmd = build_command(&cfg).unwrap();
        let args: Vec<String> = cmd
            .get_args()
            .map(|s| s.to_string_lossy().into_owned())
            .collect();
        assert_eq!(
            args,
            vec!["-m", r"D:\models\qwen 2.5-7b.gguf", "--port", "8080"]
        );
    }

    #[test]
    fn test_build_command_rejects_empty_command() {
        let err = build_command(&sample_config("   ")).unwrap_err();
        assert!(matches!(err, LlmRunnerError::Config(_)));
    }

    #[test]
    fn test_split_command_line_handles_escapes() {
        assert_eq!(split_command_line("a \"b c\" d"), vec!["a", "b c", "d"]);
        assert_eq!(
            split_command_line(r#"x "C:\Program Files\app.exe" y"#),
            vec!["x", r"C:\Program Files\app.exe", "y"]
        );
        // 引号内 \" 转义为字面双引号
        assert_eq!(split_command_line(r#"a "b\"c" d"#), vec!["a", "b\"c", "d"]);
        assert!(split_command_line("   ").is_empty());
    }

    #[test]
    fn test_llm_runner_state_default_not_running() {
        let state = LlmRunnerState::new(LlmRunnerConfig::default());
        assert!(!state.is_running());
        let status = state.status();
        assert!(!status.running);
        assert!(status.pid.is_none());
        assert_eq!(status.base_url, DEFAULT_BASE_URL);
        assert!(status.recent_logs.is_empty());
    }

    #[test]
    fn test_append_log_caps_buffer() {
        let state = LlmRunnerState::new(LlmRunnerConfig::default());
        // 直接塞入超过上限的日志，验证不会无限增长
        for i in 0..(LOG_BUFFER_LINES + 100) {
            state.append_log(format!("line {i}"));
        }
        let logs = state.logs.read().unwrap();
        assert_eq!(logs.len(), LOG_BUFFER_LINES);
        // 最早的日志已被淘汰，最后一条是最新写入的
        assert_eq!(logs.back().unwrap(), &format!("line {}", LOG_BUFFER_LINES + 99));
    }

    #[test]
    fn test_update_config_replaces_runtime_config() {
        let state = LlmRunnerState::new(LlmRunnerConfig::default());
        let mut cfg = LlmRunnerConfig::default();
        cfg.base_url = "http://0.0.0.0:9999/v1".to_string();
        state.update_config(cfg);
        assert_eq!(state.base_url(), "http://0.0.0.0:9999/v1");
    }

    #[test]
    fn test_base_url_reflects_config() {
        let mut cfg = LlmRunnerConfig::default();
        cfg.base_url = "http://192.168.1.5:1234/v1".to_string();
        let state = LlmRunnerState::new(cfg);
        assert_eq!(state.base_url(), "http://192.168.1.5:1234/v1");
    }

    #[test]
    fn test_base_url_falls_back_to_default() {
        let state = LlmRunnerState::new(LlmRunnerConfig::default());
        assert_eq!(state.base_url(), DEFAULT_BASE_URL);
    }
}
