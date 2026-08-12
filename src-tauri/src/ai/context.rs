//! 上下文窗口管理：token 估算 + 超限摘要压缩
//!
//! agent_loop 每轮调用 `maybe_compact_context`，当累计 token 超过阈值时，
//! 对最早的消息生成 LLM 摘要并替换原文，避免上下文无限增长导致 API 报错。

use crate::ai::provider::ProviderConfig;
use crate::error::{IpcError, IpcResult};
use memos_core::ConfigStore;
use serde_json::{json, Value};

/// 默认 token 阈值：超过此值触发摘要压缩。
/// 取 50k 是保守值，留出响应空间，兼容 64k 上下文窗口的模型。
/// 本地小模型（如 Ollama 4k/8k）用户后续可通过设置调整。
const DEFAULT_TOKEN_THRESHOLD: usize = 50_000;

/// 摘要后保留的最近消息条数。
/// 约 10-15 轮对话，保证近期上下文完整不被压缩。
const KEEP_RECENT_MSG_COUNT: usize = 20;

/// 摘要请求的对话文本最大长度（字符数），避免摘要请求本身过大。
const MAX_SUMMARIZE_CHARS: usize = 30_000;

/// 粗略估算消息列表的 token 数。
///
/// 启发式：混合中英文约 3 字符/token。
/// 对 content（字符串或 vision 数组）、tool_calls、tool_call_id、role 均计入。
pub fn estimate_tokens(messages: &[Value]) -> usize {
    let mut total_chars: usize = 0;
    for msg in messages {
        if let Some(content) = msg.get("content") {
            if let Some(s) = content.as_str() {
                total_chars += s.len();
            } else {
                total_chars += content.to_string().len();
            }
        }
        if let Some(tc) = msg.get("tool_calls") {
            if !tc.is_null() {
                total_chars += tc.to_string().len();
            }
        }
        if let Some(id) = msg.get("tool_call_id").and_then(|v| v.as_str()) {
            total_chars += id.len();
        }
        if let Some(role) = msg.get("role").and_then(|v| v.as_str()) {
            total_chars += role.len();
        }
    }
    total_chars / 3
}

/// 检查并压缩上下文：若 token 数超阈值，对最早的消息生成摘要。
///
/// 策略：
/// 1. 保留最近 KEEP_RECENT_MSG_COUNT 条消息不动
/// 2. 在保留区间之前找到安全的分割点（user 消息边界，不破坏 tool_calls→tool 配对）
/// 3. 对分割点之前的消息生成 LLM 摘要，替换为一条 system 消息
///
/// 摘要失败时不修改 msgs（降级为不压缩），避免阻断主流程。
pub fn maybe_compact_context(
    msgs: &mut Vec<Value>,
    provider: &ProviderConfig,
    config_store: &ConfigStore,
) -> IpcResult<bool> {
    let total_tokens = estimate_tokens(msgs);
    if total_tokens <= DEFAULT_TOKEN_THRESHOLD {
        return Ok(false);
    }

    if msgs.len() <= KEEP_RECENT_MSG_COUNT {
        return Ok(false);
    }

    let desired_split = msgs.len() - KEEP_RECENT_MSG_COUNT;
    let split_idx = find_safe_split(msgs, desired_split);
    if split_idx == 0 {
        // 找不到安全分割点，放弃压缩
        return Ok(false);
    }

    let to_summarize = &msgs[..split_idx];
    let recent: Vec<Value> = msgs[split_idx..].to_vec();

    let conversation_text = messages_to_text(to_summarize);
    if conversation_text.is_empty() {
        return Ok(false);
    }

    let summary = match summarize_conversation(provider, config_store, &conversation_text) {
        Ok(s) if !s.trim().is_empty() => s,
        Ok(_) => return Ok(false), // 空摘要，放弃
        Err(_) => return Ok(false), // 摘要失败，放弃（不阻断主流程）
    };

    let summary_msg = json!({
        "role": "system",
        "content": format!(
            "以下是之前对话的摘要，供你参考上下文：\n\n{summary}\n\n请注意：以上为压缩摘要，具体细节可能已简化。如需精确信息请重新查询。"
        ),
    });

    *msgs = vec![summary_msg];
    msgs.extend(recent);
    Ok(true)
}

/// 在 msgs 中找到安全的分割索引。
///
/// 安全分割点 = user 消息的位置，保证 to_keep 部分以 user 消息开头，
/// 不会出现孤立的 tool 消息或缺少 tool 响应的 assistant(tool_calls)。
/// 从 desired_idx 向前扫描，找到最近的 user 消息。
fn find_safe_split(msgs: &[Value], desired_idx: usize) -> usize {
    if desired_idx >= msgs.len() {
        return msgs.len();
    }
    let upper = desired_idx.min(msgs.len().saturating_sub(1));
    for i in (1..=upper).rev() {
        let role = msgs[i].get("role").and_then(|v| v.as_str()).unwrap_or("");
        if role == "user" {
            return i;
        }
    }
    0
}

/// 将消息列表格式化为可读文本，用于摘要请求。
/// 截断到 MAX_SUMMARIZE_CHARS 防止摘要请求本身过大。
fn messages_to_text(messages: &[Value]) -> String {
    let mut text = String::new();
    for msg in messages {
        let role = msg.get("role").and_then(|v| v.as_str()).unwrap_or("unknown");
        let content = if let Some(c) = msg.get("content") {
            if let Some(s) = c.as_str() {
                s.to_string()
            } else {
                c.to_string()
            }
        } else {
            String::new()
        };

        // tool 消息只取摘要（结果可能很大）
        if role == "tool" {
            let tool_name = msg.get("tool_name").and_then(|v| v.as_str()).unwrap_or("tool");
            let preview = if content.len() > 200 {
                format!("{}...(已截断)", &content[..200])
            } else {
                content.clone()
            };
            text.push_str(&format!("[tool:{tool_name}]: {preview}\n"));
            continue;
        }

        text.push_str(&format!("[{role}]: {content}\n"));

        if let Some(tc) = msg.get("tool_calls") {
            if !tc.is_null() {
                // 只记录工具名，不记录完整参数
                if let Some(arr) = tc.as_array() {
                    for call in arr {
                        let name = call
                            .get("function")
                            .and_then(|f| f.get("name"))
                            .and_then(|n| n.as_str())
                            .unwrap_or("unknown");
                        text.push_str(&format!("  → 调用工具: {name}\n"));
                    }
                }
            }
        }
    }

    if text.len() > MAX_SUMMARIZE_CHARS {
        text.truncate(MAX_SUMMARIZE_CHARS);
        text.push_str("\n...(对话已截断)");
    }
    text
}

/// 调用 LLM 生成对话摘要。
fn summarize_conversation(
    provider: &ProviderConfig,
    config_store: &ConfigStore,
    conversation: &str,
) -> IpcResult<String> {
    let system_prompt = "你是对话摘要助手。请将以下对话历史压缩为简洁的摘要，必须保留：
1. 用户的核心意图和需求
2. 已经做出的关键决策和结论
3. 涉及的重要标识符（笔记 uid、标签名、图谱节点 id、deck id 等）
4. 尚未完成的任务和下一步计划

摘要应简洁但信息完整，使用中文，控制在 500 字以内。";

    crate::ai::llm_call::call_with_provider(
        provider,
        config_store,
        system_prompt,
        conversation,
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn test_estimate_tokens_simple() {
        let msgs = vec![
            json!({"role": "user", "content": "你好"}),
            json!({"role": "assistant", "content": "你好！有什么可以帮你的？"}),
        ];
        let tokens = estimate_tokens(&msgs);
        // "user" + "你好" + "assistant" + "你好！有什么可以帮你的？" = 4+6+9+24 = 43 chars
        // 43 / 3 ≈ 14
        assert!(tokens > 0);
        assert!(tokens < 100);
    }

    #[test]
    fn test_estimate_tokens_with_tool_calls() {
        let msgs = vec![
            json!({
                "role": "assistant",
                "content": "让我查一下",
                "tool_calls": [{"id": "call_1", "type": "function", "function": {"name": "list_memos", "arguments": "{\"query\":\"rust\"}"}}]
            }),
            json!({"role": "tool", "tool_call_id": "call_1", "content": "结果很长..."}),
        ];
        let tokens = estimate_tokens(&msgs);
        assert!(tokens > 0);
    }

    #[test]
    fn test_find_safe_split_at_user_message() {
        let msgs = vec![
            json!({"role": "user", "content": "问题1"}),
            json!({"role": "assistant", "content": "回答1"}),
            json!({"role": "user", "content": "问题2"}),
            json!({"role": "assistant", "content": "回答2"}),
            json!({"role": "user", "content": "问题3"}),
        ];
        // desired_idx=3 → 从 index 3 向前找 user → index 2
        assert_eq!(find_safe_split(&msgs, 3), 2);
        // desired_idx=4 → index 4 是 user
        assert_eq!(find_safe_split(&msgs, 4), 4);
    }

    #[test]
    fn test_find_safe_split_no_user_found() {
        let msgs = vec![
            json!({"role": "assistant", "content": "回答1"}),
            json!({"role": "tool", "content": "结果"}),
            json!({"role": "assistant", "content": "回答2"}),
        ];
        // 没有 user 消息，返回 0
        assert_eq!(find_safe_split(&msgs, 2), 0);
    }

    #[test]
    fn test_find_safe_split_out_of_bounds() {
        let msgs = vec![json!({"role": "user", "content": "hi"})];
        assert_eq!(find_safe_split(&msgs, 100), 1);
    }

    #[test]
    fn test_messages_to_text_truncates_tool_results() {
        let long_result = "x".repeat(500);
        let msgs = vec![
            json!({"role": "user", "content": "查询"}),
            json!({"role": "tool", "tool_call_id": "c1", "content": long_result, "tool_name": "list_memos"}),
        ];
        let text = messages_to_text(&msgs);
        assert!(text.contains("已截断"));
        assert!(text.len() < 500);
    }

    #[test]
    fn test_messages_to_text_includes_tool_call_names() {
        let msgs = vec![
            json!({
                "role": "assistant",
                "content": "让我查一下",
                "tool_calls": [{"id": "c1", "type": "function", "function": {"name": "list_memos", "arguments": "{}"}}]
            }),
        ];
        let text = messages_to_text(&msgs);
        assert!(text.contains("list_memos"));
        assert!(text.contains("调用工具"));
    }

    #[test]
    fn test_messages_to_text_truncates_long_conversation() {
        let mut msgs = Vec::new();
        for i in 0..1000 {
            msgs.push(json!({"role": "user", "content": format!("问题{}这是一段很长的问题内容", i)}));
        }
        let text = messages_to_text(&msgs);
        assert!(text.len() <= MAX_SUMMARIZE_CHARS + 50); // 50 是截断后缀的余量
        assert!(text.contains("对话已截断"));
    }

    #[test]
    fn test_maybe_compact_context_below_threshold() {
        let config_store = ConfigStore::open_in_memory().unwrap();
        let provider = ProviderConfig {
            id: "test".into(),
            name: "Test".into(),
            base_url: "http://localhost:11434/v1".into(),
            api_key: String::new(),
            model: "test-model".into(),
        };
        let mut msgs = vec![
            json!({"role": "user", "content": "hi"}),
            json!({"role": "assistant", "content": "hello"}),
        ];
        let compacted = maybe_compact_context(&mut msgs, &provider, &config_store).unwrap();
        assert!(!compacted);
        assert_eq!(msgs.len(), 2); // 未修改
    }

    #[test]
    fn test_maybe_compact_context_few_messages() {
        let config_store = ConfigStore::open_in_memory().unwrap();
        let provider = ProviderConfig {
            id: "test".into(),
            name: "Test".into(),
            base_url: "http://localhost:11434/v1".into(),
            api_key: String::new(),
            model: "test-model".into(),
        };
        // 超过 token 阈值但消息数不足 KEEP_RECENT_MSG_COUNT
        let long_content = "x".repeat(200_000);
        let mut msgs = vec![json!({"role": "user", "content": long_content})];
        let compacted = maybe_compact_context(&mut msgs, &provider, &config_store).unwrap();
        assert!(!compacted);
    }
}
