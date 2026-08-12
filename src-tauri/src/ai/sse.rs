//! SSE 流式响应解析：解析 OpenAI chat/completions 的 stream 格式
//!
//! SSE 协议：每行 `data: {json}\n\n`，最后 `data: [DONE]\n\n`
//! tool_calls 分多块到达，需按 index 拼接

use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::io::{BufRead, BufReader, Read};

/// 累积的 tool_call（OpenAI 流式协议中按 index 拼接）
#[derive(Debug, Clone, Default)]
pub struct ToolCallAccumulator {
    pub index: u32,
    pub id: String,
    pub name: String,
    pub arguments: String,
}

/// 单条 SSE 事件解析结果
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SseEvent {
    /// 文本内容增量（可能为空）
    pub content_delta: Option<String>,
    /// 思考/推理内容增量（DeepSeek reasoning_content 或 reasoning 字段，可能为空）
    pub reasoning_delta: Option<String>,
    /// tool_calls 增量（按 index）
    pub tool_call_delta: Option<ToolCallDelta>,
    /// finish_reason（流结束时出现）
    pub finish_reason: Option<String>,
    /// token 用量（OpenAI 在最后一帧或独立帧返回，部分 provider 不返回）
    pub usage: Option<SseUsage>,
}

/// SSE 中的 token 用量统计
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct SseUsage {
    pub prompt_tokens: u64,
    pub completion_tokens: u64,
    pub total_tokens: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ToolCallDelta {
    pub index: u32,
    pub id: Option<String>,
    pub function_name: Option<String>,
    pub arguments_chunk: Option<String>,
}

/// 解析一行 SSE data，返回 SseEvent
/// 输入行应为 `data: {...}` 或 `data: [DONE]`
pub fn parse_sse_line(line: &str) -> Option<SseEvent> {
    let line = line.trim();
    if !line.starts_with("data:") {
        return None;
    }
    let data = line.trim_start_matches("data:").trim();
    if data == "[DONE]" {
        return Some(SseEvent {
            content_delta: None,
            reasoning_delta: None,
            tool_call_delta: None,
            finish_reason: Some("[DONE]".to_string()),
            usage: None,
        });
    }

    let json: Value = serde_json::from_str(data).ok()?;

    // usage 可能出现在独立帧（choices 为空数组）或最后一帧（与 finish_reason 同帧）
    let usage = json.get("usage").map(|u| SseUsage {
        prompt_tokens: u.get("prompt_tokens").and_then(|v| v.as_u64()).unwrap_or(0),
        completion_tokens: u.get("completion_tokens").and_then(|v| v.as_u64()).unwrap_or(0),
        total_tokens: u.get("total_tokens").and_then(|v| v.as_u64()).unwrap_or(0),
    });

    // usage-only 帧（choices 为空数组）：仅返回 usage，其余字段为 None
    let choices = json.get("choices");
    if let Some(arr) = choices.and_then(|c| c.as_array()) {
        if arr.is_empty() {
            return Some(SseEvent {
                content_delta: None,
                reasoning_delta: None,
                tool_call_delta: None,
                finish_reason: None,
                usage,
            });
        }
    }

    let choice = choices?.get(0)?;
    let delta = choice.get("delta")?;
    let finish_reason = choice
        .get("finish_reason")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string());

    let content_delta = delta
        .get("content")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string());

    // 思考/推理内容：优先 reasoning_content（DeepSeek），其次 reasoning（部分 provider）
    let reasoning_delta = delta
        .get("reasoning_content")
        .or_else(|| delta.get("reasoning"))
        .and_then(|v| v.as_str())
        .map(|s| s.to_string());

    let tool_call_delta = delta.get("tool_calls").and_then(|tcs| {
        let tc = tcs.get(0)?;
        let index = tc.get("index").and_then(|v| v.as_u64()).unwrap_or(0) as u32;
        let id = tc.get("id").and_then(|v| v.as_str()).map(|s| s.to_string());
        let function_name = tc
            .get("function")
            .and_then(|f| f.get("name"))
            .and_then(|v| v.as_str())
            .map(|s| s.to_string());
        let arguments_chunk = tc
            .get("function")
            .and_then(|f| f.get("arguments"))
            .and_then(|v| v.as_str())
            .map(|s| s.to_string());
        if id.is_none() && function_name.is_none() && arguments_chunk.is_none() {
            None
        } else {
            Some(ToolCallDelta {
                index,
                id,
                function_name,
                arguments_chunk,
            })
        }
    });

    Some(SseEvent {
        content_delta,
        reasoning_delta,
        tool_call_delta,
        finish_reason,
        usage,
    })
}

/// 从 reader 读取完整 SSE 流，累积 tool_calls，返回 (完整文本, tool_calls, usage)
/// 每读到 content_delta 时调用 on_chunk 回调（用于流式推送）
/// 每读到 reasoning_delta 时调用 on_reasoning 回调（用于推送思考过程，不累积到返回值）
/// usage 在最后一帧返回，部分 provider 不返回 usage 时为 None
pub fn read_sse_stream<R: Read, F: FnMut(&str), G: FnMut(&str)>(
    reader: R,
    mut on_chunk: F,
    mut on_reasoning: G,
) -> std::io::Result<(String, Vec<ToolCallAccumulator>, Option<SseUsage>)> {
    let buf_reader = BufReader::new(reader);
    let mut full_content = String::new();
    let mut tool_calls: Vec<ToolCallAccumulator> = Vec::new();
    let mut usage: Option<SseUsage> = None;

    for line_result in buf_reader.lines() {
        let line = line_result?;
        if line.is_empty() || line.starts_with(':') {
            continue;
        }
        if let Some(event) = parse_sse_line(&line) {
            if let Some(delta) = &event.content_delta {
                full_content.push_str(delta);
                on_chunk(delta);
            }
            if let Some(reasoning) = &event.reasoning_delta {
                on_reasoning(reasoning);
            }
            if let Some(tc_delta) = &event.tool_call_delta {
                let idx = tc_delta.index as usize;
                while tool_calls.len() <= idx {
                    tool_calls.push(ToolCallAccumulator::default());
                    tool_calls[idx].index = idx as u32;
                }
                if let Some(id) = &tc_delta.id {
                    tool_calls[idx].id = id.clone();
                }
                if let Some(name) = &tc_delta.function_name {
                    tool_calls[idx].name = name.clone();
                }
                if let Some(args) = &tc_delta.arguments_chunk {
                    tool_calls[idx].arguments.push_str(args);
                }
            }
            // usage 可能在独立帧或与 finish_reason 同帧
            if let Some(u) = &event.usage {
                usage = Some(u.clone());
            }
            if let Some(fr) = &event.finish_reason {
                if fr == "[DONE]" {
                    break;
                }
            }
        }
    }

    Ok((full_content, tool_calls, usage))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Cursor;

    #[test]
    fn test_parse_sse_line_content() {
        let line = r#"data: {"choices":[{"delta":{"content":"hello"}}]}"#;
        let event = parse_sse_line(line).unwrap();
        assert_eq!(event.content_delta.as_deref(), Some("hello"));
        assert!(event.reasoning_delta.is_none());
        assert!(event.tool_call_delta.is_none());
    }

    #[test]
    fn test_parse_sse_line_reasoning_content() {
        let line = r#"data: {"choices":[{"delta":{"reasoning_content":"思考中"}}]}"#;
        let event = parse_sse_line(line).unwrap();
        assert_eq!(event.reasoning_delta.as_deref(), Some("思考中"));
        assert!(event.content_delta.is_none());
    }

    #[test]
    fn test_parse_sse_line_reasoning() {
        let line = r#"data: {"choices":[{"delta":{"reasoning":"thinking"}}]}"#;
        let event = parse_sse_line(line).unwrap();
        assert_eq!(event.reasoning_delta.as_deref(), Some("thinking"));
    }

    #[test]
    fn test_parse_sse_line_done() {
        let line = "data: [DONE]";
        let event = parse_sse_line(line).unwrap();
        assert_eq!(event.finish_reason.as_deref(), Some("[DONE]"));
    }

    #[test]
    fn test_parse_sse_line_non_data() {
        assert!(parse_sse_line(": comment").is_none());
        assert!(parse_sse_line("").is_none());
    }

    #[test]
    fn test_parse_sse_line_tool_call_start() {
        let line = r#"data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_abc","function":{"name":"list_memos","arguments":""}}]}}]}"#;
        let event = parse_sse_line(line).unwrap();
        let tc = event.tool_call_delta.unwrap();
        assert_eq!(tc.index, 0);
        assert_eq!(tc.id.as_deref(), Some("call_abc"));
        assert_eq!(tc.function_name.as_deref(), Some("list_memos"));
    }

    #[test]
    fn test_parse_sse_line_tool_call_args_chunk() {
        let line = r#"data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{\"quer"}}]}}]}"#;
        let event = parse_sse_line(line).unwrap();
        let tc = event.tool_call_delta.unwrap();
        assert_eq!(tc.arguments_chunk.as_deref(), Some("{\"quer"));
        assert!(tc.id.is_none());
    }

    #[test]
    fn test_read_sse_stream_simple_content() {
        let input = "data: {\"choices\":[{\"delta\":{\"content\":\"Hi\"}}]}\n\ndata: {\"choices\":[{\"delta\":{\"content\":\" there\"}}]}\n\ndata: [DONE]\n\n";
        let cursor = Cursor::new(input);
        let mut chunks = Vec::new();
        let (content, tool_calls, usage) = read_sse_stream(cursor, |c| chunks.push(c.to_string()), |_| {}).unwrap();
        assert_eq!(content, "Hi there");
        assert_eq!(chunks, vec!["Hi", " there"]);
        assert!(tool_calls.is_empty());
        assert!(usage.is_none());
    }

    #[test]
    fn test_read_sse_stream_tool_calls_accumulated() {
        let input = "data: {\"choices\":[{\"delta\":{\"tool_calls\":[{\"index\":0,\"id\":\"call_1\",\"function\":{\"name\":\"list_memos\",\"arguments\":\"\"}}]}}]}\n\ndata: {\"choices\":[{\"delta\":{\"tool_calls\":[{\"index\":0,\"function\":{\"arguments\":\"{\\\"query\\\":\\\"Rust\\\"}\"}}]}}]}\n\ndata: [DONE]\n\n";
        let cursor = Cursor::new(input);
        let (content, tool_calls, _) = read_sse_stream(cursor, |_| {}, |_| {}).unwrap();
        assert_eq!(content, "");
        assert_eq!(tool_calls.len(), 1);
        assert_eq!(tool_calls[0].id, "call_1");
        assert_eq!(tool_calls[0].name, "list_memos");
        assert_eq!(tool_calls[0].arguments, r#"{"query":"Rust"}"#);
    }

    #[test]
    fn test_read_sse_stream_mixed_content_and_tool_calls() {
        let input = "data: {\"choices\":[{\"delta\":{\"content\":\"让我查一下\"}}]}\n\ndata: {\"choices\":[{\"delta\":{\"tool_calls\":[{\"index\":0,\"id\":\"call_1\",\"function\":{\"name\":\"list_tags\",\"arguments\":\"{}\"}}]}}]}\n\ndata: [DONE]\n\n";
        let cursor = Cursor::new(input);
        let (content, tool_calls, _) = read_sse_stream(cursor, |_| {}, |_| {}).unwrap();
        assert_eq!(content, "让我查一下");
        assert_eq!(tool_calls.len(), 1);
        assert_eq!(tool_calls[0].name, "list_tags");
    }

    #[test]
    fn test_parse_sse_line_usage_in_last_frame() {
        let line = r#"data: {"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":50,"completion_tokens":30,"total_tokens":80}}"#;
        let event = parse_sse_line(line).unwrap();
        let usage = event.usage.unwrap();
        assert_eq!(usage.prompt_tokens, 50);
        assert_eq!(usage.completion_tokens, 30);
        assert_eq!(usage.total_tokens, 80);
    }

    #[test]
    fn test_parse_sse_line_usage_only_frame() {
        // OpenAI stream_options.include_usage 最后一帧：choices 为空数组
        let line = r#"data: {"choices":[],"usage":{"prompt_tokens":100,"completion_tokens":50,"total_tokens":150}}"#;
        let event = parse_sse_line(line).unwrap();
        let usage = event.usage.unwrap();
        assert_eq!(usage.total_tokens, 150);
        assert!(event.content_delta.is_none());
        assert!(event.finish_reason.is_none());
    }

    #[test]
    fn test_read_sse_stream_with_usage() {
        let input = "data: {\"choices\":[{\"delta\":{\"content\":\"hi\"}}]}\n\ndata: {\"choices\":[],\"usage\":{\"prompt_tokens\":10,\"completion_tokens\":5,\"total_tokens\":15}}\n\ndata: [DONE]\n\n";
        let cursor = Cursor::new(input);
        let (content, _, usage) = read_sse_stream(cursor, |_| {}, |_| {}).unwrap();
        assert_eq!(content, "hi");
        let usage = usage.unwrap();
        assert_eq!(usage.total_tokens, 15);
    }
}
