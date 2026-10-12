//! 本地 LLM 启动器配置：持久化在 app_setting 表的 `llm_runner_config` key（JSON 字符串）
//!
//! 应用不内置任何模型运行时（不带 llama.cpp / LM Studio 等命令），
//! 只保存用户自己填写的**完整启动命令行**，由 [`crate::llm_runner::runner`] 直接 spawn。

use memos_core::ConfigStore;
use serde::{Deserialize, Serialize};

/// app_setting 中的 key
pub const CONFIG_KEY: &str = "llm_runner_config";

/// 未填写 `base_url` 时使用的默认 OpenAI 兼容端点
pub const DEFAULT_BASE_URL: &str = "http://127.0.0.1:8080/v1";

/// 本地 LLM 启动器配置
///
/// - `command`：用户自己输入的完整命令行（可执行文件 + 参数），
///   生命周期由本模块直接管理：spawn 后跟踪 PID，stop 时终止子进程
/// - `base_url`：应用连接本地服务的 OpenAI 兼容端点
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LlmRunnerConfig {
    /// 完整启动命令行，如
    /// `llama-server -m "D:\models\qwen2.5-7b.gguf" --port 8080 -ngl 99`
    ///
    /// 第一个 token 为可执行文件，其余为参数；含空格的路径用双引号包裹。
    #[serde(default)]
    pub command: String,

    /// OpenAI 兼容端点 Base URL（应用按此地址访问本地服务）。
    /// 留空时回退到 [`DEFAULT_BASE_URL`]。
    #[serde(default)]
    pub base_url: String,

    /// 是否在应用启动时自动执行 `command`
    #[serde(default)]
    pub auto_start: bool,
}

impl Default for LlmRunnerConfig {
    fn default() -> Self {
        Self {
            command: String::new(),
            base_url: String::new(),
            auto_start: false,
        }
    }
}

/// 返回有效的 Base URL：优先使用用户配置的 `base_url`，为空时回退到默认值。
pub fn effective_base_url(config: &LlmRunnerConfig) -> String {
    let trimmed = config.base_url.trim();
    if trimmed.is_empty() {
        DEFAULT_BASE_URL.to_string()
    } else {
        trimmed.trim_end_matches('/').to_string()
    }
}

/// 从 app_setting 读取配置，缺失则返回默认值
pub fn load_config(config_store: &ConfigStore) -> LlmRunnerConfig {
    let json: Option<String> = config_store
        .with_conn(|c| config_store.setting.app.get(c, CONFIG_KEY))
        .unwrap_or(None);
    json.as_deref()
        .and_then(|s| serde_json::from_str(s).ok())
        .unwrap_or_default()
}

/// 保存配置到 app_setting
pub fn save_config(config_store: &ConfigStore, config: &LlmRunnerConfig) -> memos_core::CoreResult<()> {
    let json = serde_json::to_string(config).map_err(|e| {
        memos_core::CoreError::Other(format!("序列化 LLM 启动器配置失败: {e}"))
    })?;
    config_store.with_conn(|c| config_store.setting.app.upsert(c, CONFIG_KEY, &json))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_default_config() {
        let c = LlmRunnerConfig::default();
        assert!(c.command.is_empty());
        assert!(c.base_url.is_empty());
        assert!(!c.auto_start);
    }

    #[test]
    fn test_config_serde_roundtrip() {
        let c = LlmRunnerConfig {
            command: "llama-server -m model.gguf --port 8080".to_string(),
            base_url: "http://192.168.1.10:8080/v1".to_string(),
            auto_start: true,
        };
        let json = serde_json::to_string(&c).unwrap();
        let back: LlmRunnerConfig = serde_json::from_str(&json).unwrap();
        assert_eq!(c.command, back.command);
        assert_eq!(c.base_url, back.base_url);
        assert_eq!(c.auto_start, back.auto_start);
    }

    #[test]
    fn test_partial_json_uses_defaults() {
        // 缺失字段应使用 serde default（含空 base_url）
        let json = r#"{"command":"vllm serve Qwen/Qwen2.5-7B-Instruct"}"#;
        let c: LlmRunnerConfig = serde_json::from_str(json).unwrap();
        assert_eq!(c.command, "vllm serve Qwen/Qwen2.5-7B-Instruct");
        assert!(c.base_url.is_empty());
        assert!(!c.auto_start);
    }

    #[test]
    fn test_legacy_json_ignores_removed_fields() {
        // 旧版本配置（runner_type / executable_path / model_path ...）不再被识别，
        // 只保留仍然有效的字段，command 为空表示需要用户重新填写命令行
        let json = r#"{"runner_type":"lms","executable_path":"lms","model_path":"qwen2.5-7b-instruct","host":"127.0.0.1","port":1234,"context_size":8192,"gpu_layers":99,"extra_args":"--verbose","base_url":"http://10.0.0.5:1234/v1","auto_start":true}"#;
        let c: LlmRunnerConfig = serde_json::from_str(json).unwrap();
        assert!(c.command.is_empty());
        assert_eq!(c.base_url, "http://10.0.0.5:1234/v1");
        assert!(c.auto_start);
    }

    #[test]
    fn test_load_config_default_when_absent() {
        let config_store = ConfigStore::open_in_memory().unwrap();
        let c = load_config(&config_store);
        assert!(c.command.is_empty());
        assert_eq!(effective_base_url(&c), DEFAULT_BASE_URL);
    }

    #[test]
    fn test_save_and_load_config() {
        let config_store = ConfigStore::open_in_memory().unwrap();
        let mut c = LlmRunnerConfig::default();
        c.command = "llama-server -m /models/test.gguf -ngl 33".to_string();
        c.base_url = "http://example.com:9999/v1".to_string();
        c.auto_start = true;
        save_config(&config_store, &c).unwrap();
        let loaded = load_config(&config_store);
        assert_eq!(loaded.command, c.command);
        assert_eq!(loaded.base_url, c.base_url);
        assert!(loaded.auto_start);
    }

    #[test]
    fn test_effective_base_url_uses_override() {
        let mut c = LlmRunnerConfig::default();
        c.base_url = "http://10.0.0.5:8080/v1/".to_string();
        // override 优先，尾部斜杠被去除
        assert_eq!(effective_base_url(&c), "http://10.0.0.5:8080/v1");
    }

    #[test]
    fn test_effective_base_url_falls_back_to_default() {
        let mut c = LlmRunnerConfig::default();
        c.base_url = "   ".to_string(); // 空白视为未设置
        assert_eq!(effective_base_url(&c), DEFAULT_BASE_URL);
    }
}
