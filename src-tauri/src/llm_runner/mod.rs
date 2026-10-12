//! 本地 LLM 启动器：由用户自行填写启动命令行（不限定具体运行时，如
//! `llama-server`、`vllm serve`、`ollama serve` 等），应用只负责拉起进程与连接
//! OpenAI 兼容端点（`/v1/chat/completions`）。
//!
//! 模块组成：
//! - [`config`]：配置持久化（app_setting 表的 `llm_runner_config` key）
//! - [`runner`]：进程管理（spawn / kill / 状态查询 / 日志捕获）

pub mod config;
pub mod runner;

pub use config::{effective_base_url, load_config, save_config, LlmRunnerConfig};
pub use runner::{LlmRunnerError, LlmRunnerState, LlmRunnerStatus};
