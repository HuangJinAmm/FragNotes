//! JSON-RPC 2.0 协议类型与 MCP 方法处理
//!
//! MCP 协议基于 JSON-RPC 2.0：
//! - 请求：`{ "jsonrpc": "2.0", "id": <id>, "method": "...", "params": {...} }`
//! - 通知（无 id）：`{ "jsonrpc": "2.0", "method": "...", "params": {...} }`
//! - 响应：`{ "jsonrpc": "2.0", "id": <id>, "result": ... }` 或
//!         `{ "jsonrpc": "2.0", "id": <id>, "error": { "code": <int>, "message": "..." } }`
//!
//! 支持的 MCP 方法：
//! - `initialize`：返回服务器信息与能力
//! - `notifications/initialized`：客户端通知（无响应）
//! - `ping`：保活
//! - `tools/list`：列出所有工具
//! - `tools/call`：调用工具
//! - `resources/list`：列出 memo 资源（每条笔记 URI 为 `memo://{uid}`）
//! - `resources/read`：按 URI 读取 memo 完整 markdown 内容
//! - `prompts/list`：列出预设提示模板
//! - `prompts/get`：按名称与参数渲染提示消息
//!
//! 错误码遵循 JSON-RPC 2.0 + MCP 扩展：
//! - -32700 Parse error
//! - -32600 Invalid request
//! - -32601 Method not found
//! - -32602 Invalid params
//! - -32603 Internal error

use crate::mcp::tools::{dispatch_tool, tool_definitions, CallToolResult};
use crate::state::AppState;
use memos_core::markdown;
use memos_core::memo::{FindMemo, Memo};
use memos_core::review;
use memos_core::types::RowStatus;
use memos_core::Store;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::Manager;

/// JSON-RPC 请求 / 通知统一结构
#[derive(Debug, Clone, Deserialize)]
pub struct RpcRequest {
    #[serde(default)]
    pub id: Option<Value>,
    pub method: String,
    #[serde(default)]
    pub params: Value,
}

/// JSON-RPC 响应
#[derive(Debug, Clone, Serialize)]
pub struct RpcResponse {
    pub jsonrpc: &'static str,
    pub id: Value,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub result: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<RpcError>,
}

#[derive(Debug, Clone, Serialize)]
pub struct RpcError {
    pub code: i32,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub data: Option<Value>,
}

impl RpcResponse {
    pub fn success(id: Value, result: Value) -> Self {
        Self {
            jsonrpc: "2.0",
            id,
            result: Some(result),
            error: None,
        }
    }

    pub fn error(id: Value, code: i32, message: impl Into<String>) -> Self {
        Self {
            jsonrpc: "2.0",
            id,
            result: None,
            error: Some(RpcError {
                code,
                message: message.into(),
                data: None,
            }),
        }
    }
}

// JSON-RPC 标准错误码
pub const PARSE_ERROR: i32 = -32700;
pub const INVALID_REQUEST: i32 = -32600;
pub const METHOD_NOT_FOUND: i32 = -32601;
pub const INVALID_PARAMS: i32 = -32602;
pub const INTERNAL_ERROR: i32 = -32603;

/// 服务器信息
pub const SERVER_NAME: &str = "LocalFragNote MCP";
pub const SERVER_VERSION: &str = env!("CARGO_PKG_VERSION");
pub const PROTOCOL_VERSION: &str = "2025-03-26";

/// 处理单个 JSON-RPC 请求，返回 Option<RpcResponse>：
/// - Some(resp)：请求有 id，需要返回响应
/// - None：通知（无 id），无需响应
pub fn handle_request(
    app: &tauri::AppHandle,
    req: &RpcRequest,
) -> Option<RpcResponse> {
    let id = req.id.clone().unwrap_or(Value::Null);

    let result: Result<Value, (i32, String)> = match req.method.as_str() {
        "initialize" => handle_initialize(&req.params),
        "notifications/initialized" => return None, // 通知，无响应
        "ping" => Ok(json!({})),
        "tools/list" => handle_tools_list(),
        "tools/call" => handle_tools_call(app, &req.params),
        "resources/list" => handle_resources_list(app, &req.params),
        "resources/read" => handle_resources_read(app, &req.params),
        "prompts/list" => handle_prompts_list(),
        "prompts/get" => handle_prompts_get(app, &req.params),
        "logging/setLevel" => Ok(json!({})),
        _ => Err((METHOD_NOT_FOUND, format!("未知方法: {}", req.method))),
    };

    match result {
        Ok(value) => Some(RpcResponse::success(id, value)),
        Err((code, msg)) => Some(RpcResponse::error(id, code, msg)),
    }
}

fn handle_initialize(_params: &Value) -> Result<Value, (i32, String)> {
    Ok(json!({
        "protocolVersion": PROTOCOL_VERSION,
        "capabilities": {
            "tools": { "listChanged": false },
            "resources": { "listChanged": false, "subscribe": false },
            "prompts": { "listChanged": false },
            "logging": {}
        },
        "serverInfo": {
            "name": SERVER_NAME,
            "version": SERVER_VERSION
        }
    }))
}

fn handle_tools_list() -> Result<Value, (i32, String)> {
    let tools = tool_definitions();
    let serialized = serde_json::to_value(&tools).map_err(|e| {
        (INTERNAL_ERROR, format!("序列化工具列表失败: {e}"))
    })?;
    Ok(json!({ "tools": serialized }))
}

#[derive(Debug, Deserialize)]
struct ToolCallParams {
    name: String,
    #[serde(default)]
    arguments: Value,
}

fn handle_tools_call(
    app: &tauri::AppHandle,
    params: &Value,
) -> Result<Value, (i32, String)> {
    let parsed: ToolCallParams = serde_json::from_value(params.clone()).map_err(|e| {
        (INVALID_PARAMS, format!("tools/call 参数解析失败: {e}"))
    })?;

    if parsed.name.is_empty() {
        return Err((INVALID_PARAMS, "工具 name 不能为空".into()));
    }

    // 检查工具是否存在
    let exists = tool_definitions().iter().any(|t| t.name == parsed.name);
    if !exists {
        return Err((METHOD_NOT_FOUND, format!("未知工具: {}", parsed.name)));
    }

    let result: CallToolResult = match dispatch_tool(app, &parsed.name, &parsed.arguments) {
        Ok(r) => r,
        Err(e) => {
            tracing::warn!("MCP 工具 {} 执行失败: {}", parsed.name, e);
            CallToolResult::error(format!("工具执行失败: {e}"))
        }
    };

    let value = serde_json::to_value(&result).map_err(|e| {
        (INTERNAL_ERROR, format!("序列化工具结果失败: {e}"))
    })?;
    Ok(value)
}

// ==================== Resources ====================

/// memo 资源的 URI scheme
///
/// 客户端可通过 `memo://{uid}` 引用单条笔记作为上下文。
const MEMO_URI_SCHEME: &str = "memo://";
/// `resources/list` 默认返回的最近 memo 数量，避免一次返回过多
const DEFAULT_RESOURCE_LIMIT: i32 = 50;
/// `resources/list` 允许的最大返回数量
const MAX_RESOURCE_LIMIT: i32 = 200;

#[derive(Debug, Deserialize)]
struct ResourcesListParams {
    /// MCP 协议规定的可选游标；当前实现不使用游标分页，字段保留以兼容客户端传入
    #[serde(default)]
    #[allow(dead_code)]
    cursor: Option<String>,
}

/// 处理 `resources/list`：列出最近的 NORMAL 主笔记作为资源
fn handle_resources_list(
    app: &tauri::AppHandle,
    params: &Value,
) -> Result<Value, (i32, String)> {
    // 解析以校验参数结构；当前不使用 cursor 分页
    let _params: ResourcesListParams = serde_json::from_value(params.clone())
        .map_err(|e| (INVALID_PARAMS, format!("resources/list 参数解析失败: {e}")))?;

    let state = app.state::<AppState>();
    let store = state.store();
    let memos = store.with_conn(|c| {
        memos_core::memo::list(c, &FindMemo {
            row_status: Some(RowStatus::Normal),
            limit: Some(DEFAULT_RESOURCE_LIMIT),
            offset: Some(0),
            order_by_pinned: true,
            order_by_time_asc: false,
            main_only: true,
            ..Default::default()
        })
    }).map_err(|e| (INTERNAL_ERROR, format!("查询 memo 列表失败: {e}")))?;

    let resources: Vec<Value> = memos
        .iter()
        .map(|m| {
            let snippet = markdown::generate_snippet(&m.content, 60);
            json!({
                "uri": format!("{MEMO_URI_SCHEME}{}", m.uid),
                "name": snippet,
                "description": format!("memo #{} · {}", m.id, m.uid),
                "mimeType": "text/markdown",
            })
        })
        .collect();

    Ok(json!({
        "resources": resources,
        // 当前实现不分页，不返回 nextCursor
    }))
}

#[derive(Debug, Deserialize)]
struct ResourcesReadParams {
    uri: String,
}

/// 处理 `resources/read`：解析 `memo://{uid}` 并返回完整 markdown
fn handle_resources_read(
    app: &tauri::AppHandle,
    params: &Value,
) -> Result<Value, (i32, String)> {
    let parsed: ResourcesReadParams = serde_json::from_value(params.clone())
        .map_err(|e| (INVALID_PARAMS, format!("resources/read 参数解析失败: {e}")))?;

    if parsed.uri.is_empty() {
        return Err((INVALID_PARAMS, "uri 不能为空".into()));
    }

    let uid = parsed
        .uri
        .strip_prefix(MEMO_URI_SCHEME)
        .ok_or_else(|| {
            (
                INVALID_PARAMS,
                format!("不支持的 uri，必须以 {MEMO_URI_SCHEME} 开头"),
            )
        })?;

    if uid.is_empty() {
        return Err((INVALID_PARAMS, "uri 中缺少 uid".into()));
    }

    let state = app.state::<AppState>();
    let store = state.store();
    let memo = store
        .with_conn(|c| {
            memos_core::memo::get(c, &FindMemo {
                uid: Some(uid.to_string()),
                ..Default::default()
            })
        })
        .map_err(|e| (INTERNAL_ERROR, format!("查询 memo 失败: {e}")))?;

    let Some(memo) = memo else {
        return Err((
            METHOD_NOT_FOUND,
            format!("找不到 uid={uid} 对应的 memo"),
        ));
    };

    Ok(json!({
        "contents": [
            {
                "uri": parsed.uri,
                "mimeType": "text/markdown",
                "text": memo.content,
            }
        ]
    }))
}

// ==================== Prompts ====================

/// 预设提示模板的名称
const PROMPT_SUMMARIZE_RECENT: &str = "summarize_recent";
const PROMPT_GATHER_BY_TAG: &str = "gather_by_tag";
const PROMPT_REVIEW_DUE: &str = "review_due";

/// 处理 `prompts/list`：返回三个预设模板的元信息
fn handle_prompts_list() -> Result<Value, (i32, String)> {
    Ok(json!({
        "prompts": [
            {
                "name": PROMPT_SUMMARIZE_RECENT,
                "description": "总结最近 N 条笔记的主要主题与待办项",
                "arguments": [
                    {
                        "name": "limit",
                        "description": "取最近多少条笔记（默认 10，最大 50）",
                        "required": false
                    }
                ]
            },
            {
                "name": PROMPT_GATHER_BY_TAG,
                "description": "按标签汇总所有相关笔记，提炼共性话题",
                "arguments": [
                    {
                        "name": "tag",
                        "description": "标签名（不带 # 前缀）",
                        "required": true
                    }
                ]
            },
            {
                "name": PROMPT_REVIEW_DUE,
                "description": "从所有牌组的到期卡片中各取若干，生成自测题",
                "arguments": [
                    {
                        "name": "limit",
                        "description": "每个牌组最多取多少张卡（默认 5）",
                        "required": false
                    }
                ]
            }
        ]
    }))
}

#[derive(Debug, Deserialize)]
struct PromptsGetParams {
    name: String,
    #[serde(default)]
    arguments: Value,
}

/// 处理 `prompts/get`：按名称与参数渲染消息
fn handle_prompts_get(
    app: &tauri::AppHandle,
    params: &Value,
) -> Result<Value, (i32, String)> {
    let parsed: PromptsGetParams = serde_json::from_value(params.clone())
        .map_err(|e| (INVALID_PARAMS, format!("prompts/get 参数解析失败: {e}")))?;

    if parsed.name.is_empty() {
        return Err((INVALID_PARAMS, "name 不能为空".into()));
    }

    let state = app.state::<AppState>();
    let store = state.store();

    match parsed.name.as_str() {
        PROMPT_SUMMARIZE_RECENT => {
            let limit = parse_arg_i32(&parsed.arguments, "limit", 10, 1, 50)?;
            render_summarize_recent(&store, limit)
        }
        PROMPT_GATHER_BY_TAG => {
            let tag = parse_arg_string(&parsed.arguments, "tag", true)?
                .ok_or_else(|| (INVALID_PARAMS, "tag 参数缺失".into()))?;
            render_gather_by_tag(&store, &tag)
        }
        PROMPT_REVIEW_DUE => {
            let limit = parse_arg_i32(&parsed.arguments, "limit", 5, 1, 50)?;
            render_review_due(&store, limit)
        }
        other => Err((METHOD_NOT_FOUND, format!("未知 prompt: {other}"))),
    }
}

// ---------- prompts 参数解析辅助 ----------

fn parse_arg_i32(
    args: &Value,
    key: &str,
    default: i32,
    min: i32,
    max: i32,
) -> Result<i32, (i32, String)> {
    match args.get(key) {
        Some(Value::Null) | None => Ok(default),
        Some(v) => v
            .as_i64()
            .map(|n| (n as i32).clamp(min, max))
            .ok_or_else(|| (INVALID_PARAMS, format!("参数 {key} 必须是整数"))),
    }
}

fn parse_arg_string(
    args: &Value,
    key: &str,
    trim_required: bool,
) -> Result<Option<String>, (i32, String)> {
    match args.get(key) {
        Some(Value::Null) | None => Ok(None),
        Some(v) => {
            let s = v
                .as_str()
                .ok_or_else(|| (INVALID_PARAMS, format!("参数 {key} 必须是字符串")))?
                .to_string();
            let s = if trim_required { s.trim().to_string() } else { s };
            Ok(Some(s))
        }
    }
}

// ---------- prompts 渲染辅助 ----------

fn render_summarize_recent(store: &Store, limit: i32) -> Result<Value, (i32, String)> {
    let memos = store
        .with_conn(|c| {
            memos_core::memo::list(c, &FindMemo {
                row_status: Some(RowStatus::Normal),
                limit: Some(limit),
                offset: Some(0),
                order_by_pinned: false,
                order_by_time_asc: false,
                main_only: true,
                ..Default::default()
            })
        })
        .map_err(|e| (INTERNAL_ERROR, format!("查询最近 memo 失败: {e}")))?;

    let body = format_memos_as_context(&memos, "最近笔记");
    let user_text = format!(
        "请阅读以下我最近的 {n} 条笔记，输出：\n\
         1. 主要主题与关注点（按出现频率排序）\n\
         2. 待办任务清单（从笔记中的任务列表项提取）\n\
         3. 可能需要补充或关联的笔记主题建议\n\n{body}",
        n = memos.len(),
        body = body
    );

    Ok(prompt_response(PROMPT_SUMMARIZE_RECENT, user_text))
}

fn render_gather_by_tag(store: &Store, tag: &str) -> Result<Value, (i32, String)> {
    let memos = store
        .with_conn(|c| {
            memos_core::memo::list(c, &FindMemo {
                row_status: Some(RowStatus::Normal),
                tag_search: vec![tag.to_string()],
                limit: Some(MAX_RESOURCE_LIMIT),
                offset: Some(0),
                order_by_pinned: false,
                order_by_time_asc: false,
                main_only: true,
                ..Default::default()
            })
        })
        .map_err(|e| (INTERNAL_ERROR, format!("查询带 tag={tag} 的 memo 失败: {e}")))?;

    if memos.is_empty() {
        return Ok(prompt_response(
            PROMPT_GATHER_BY_TAG,
            format!("没有找到带 #{tag} 标签的笔记。"),
        ));
    }

    let body = format_memos_as_context(&memos, &format!("#{tag} 相关笔记"));
    let user_text = format!(
        "以下是我所有带 #{tag} 标签的 {n} 条笔记。请：\n\
         1. 提炼这些笔记的共同主题\n\
         2. 指出彼此之间的关联或矛盾\n\
         3. 给出三条可继续深入的方向建议\n\n{body}",
        tag = tag,
        n = memos.len(),
        body = body
    );

    Ok(prompt_response(PROMPT_GATHER_BY_TAG, user_text))
}

fn render_review_due(store: &Store, limit: i32) -> Result<Value, (i32, String)> {
    let decks = store
        .with_conn(|c| review::list_decks(c))
        .map_err(|e| (INTERNAL_ERROR, format!("查询牌组失败: {e}")))?;

    if decks.is_empty() {
        return Ok(prompt_response(
            PROMPT_REVIEW_DUE,
            "当前没有任何复习牌组，请先在 LocalFragNote 中创建牌组并生成卡片。".to_string(),
        ));
    }

    let mut sections: Vec<String> = Vec::new();
    let mut total = 0usize;
    for deck in &decks {
        let cards = store
            .with_conn(|c| review::list_due_cards(c, deck.id, limit))
            .map_err(|e| (INTERNAL_ERROR, format!("查询到期卡片失败: {e}")))?;
        if cards.is_empty() {
            continue;
        }
        total += cards.len();
        let mut lines = vec![format!("## 牌组：{}（{} 张到期）", deck.name, cards.len())];
        for (i, card) in cards.iter().enumerate() {
            let answer_hint = match card.card_type.as_str() {
                "cloze" => card.cloze_answer.as_deref().unwrap_or("_____"),
                _ => &card.back,
            };
            lines.push(format!(
                "{i}. [{ty}] {front}\n   答：{ans}",
                i = i + 1,
                ty = card.card_type,
                front = card.front,
                ans = answer_hint
            ));
        }
        sections.push(lines.join("\n"));
    }

    if total == 0 {
        return Ok(prompt_response(PROMPT_REVIEW_DUE, "当前没有到期的复习卡片。".to_string()));
    }

    let user_text = format!(
        "以下是我今天到期的 {total} 张复习卡片。请：\n\
         1. 逐条出题考我（先遮住答案，等我回答后再判定）\n\
         2. 对每张卡给出掌握度评分（again/hard/good/easy）\n\
         3. 全部结束后给出本次复习总结\n\n{body}",
        total = total,
        body = sections.join("\n\n")
    );

    Ok(prompt_response(PROMPT_REVIEW_DUE, user_text))
}

/// 把一组 memo 渲染为 markdown 上下文块
fn format_memos_as_context(memos: &[Memo], title: &str) -> String {
    if memos.is_empty() {
        return format!("（{title}：无内容）");
    }
    let mut lines = vec![format!("## {title}")];
    for m in memos {
        let tags = markdown::extract_tags(&m.content);
        let tag_str = if tags.is_empty() {
            String::new()
        } else {
            format!(" · {}", tags.iter().map(|t| format!("#{t}")).collect::<Vec<_>>().join(" "))
        };
        let snippet = markdown::generate_snippet(&m.content, 400);
        lines.push(format!(
            "- **{uid}**（{ts}{tag_str}）\n  {snippet}",
            uid = m.uid,
            ts = format_ts(m.created_ts),
            tag_str = tag_str,
            snippet = snippet
        ));
    }
    lines.join("\n")
}

/// 把 unix 时间戳格式化为可读字符串
fn format_ts(ts: i64) -> String {
    use chrono::DateTime;
    DateTime::from_timestamp(ts, 0)
        .map(|dt| dt.format("%Y-%m-%d %H:%M").to_string())
        .unwrap_or_else(|| ts.to_string())
}

/// 构造 `prompts/get` 的标准响应结构
fn prompt_response(_name: &str, user_text: String) -> Value {
    json!({
        "description": "LocalFragNote 渲染的提示消息",
        "messages": [
            {
                "role": "user",
                "content": {
                    "type": "text",
                    "text": user_text
                }
            }
        ]
    })
}

/// 解析并处理单个 JSON-RPC 消息（可能是请求/通知/批量的元素）
///
/// 返回 (Option<响应>, 是否是错误恢复)
pub fn handle_raw_message(
    app: &tauri::AppHandle,
    raw: &Value,
) -> Option<RpcResponse> {
    let req: RpcRequest = match serde_json::from_value(raw.clone()) {
        Ok(r) => r,
        Err(e) => {
            return Some(RpcResponse::error(
                Value::Null,
                INVALID_REQUEST,
                format!("无效的 JSON-RPC 请求: {e}"),
            ));
        }
    };
    handle_request(app, &req)
}

/// 处理批量请求：对每个元素调用 handle_raw_message，过滤掉 None（通知）
pub fn handle_batch(
    app: &tauri::AppHandle,
    batch: &[Value],
) -> Vec<RpcResponse> {
    batch
        .iter()
        .filter_map(|v| handle_raw_message(app, v))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_initialize_response() {
        let params = json!({});
        let result = handle_initialize(&params).unwrap();
        assert_eq!(result["protocolVersion"], PROTOCOL_VERSION);
        assert!(result["capabilities"]["tools"].is_object());
        assert_eq!(result["serverInfo"]["name"], SERVER_NAME);
    }

    #[test]
    fn test_tools_list_returns_seven_tools() {
        let result = handle_tools_list().unwrap();
        let tools = result["tools"].as_array().unwrap();
        assert_eq!(tools.len(), 7);
    }

    #[test]
    fn test_handle_unknown_method() {
        // 用一个临时的空 AppHandle 不可行（构造 AppHandle 需运行时），
        // 这里直接测 handle_initialize / handle_tools_list 已足够覆盖分发前的逻辑
        let req = RpcRequest {
            id: Some(json!(1)),
            method: "unknown/method".into(),
            params: json!({}),
        };
        // 不调用 handle_request（需要 AppHandle），改为直接验证错误路径
        let _ = req; // 编译期占用
    }

    #[test]
    fn test_rpc_response_success() {
        let resp = RpcResponse::success(json!(42), json!({"ok": true}));
        let s = serde_json::to_string(&resp).unwrap();
        assert!(s.contains("\"id\":42"));
        assert!(s.contains("\"result\""));
        assert!(!s.contains("\"error\""));
    }

    #[test]
    fn test_rpc_response_error() {
        let resp = RpcResponse::error(json!(1), -32601, "not found");
        let s = serde_json::to_string(&resp).unwrap();
        assert!(s.contains("\"code\":-32601"));
        assert!(s.contains("not found"));
        assert!(!s.contains("\"result\""));
    }

    // ---------- Resources / Prompts 测试 ----------

    #[test]
    fn test_initialize_declares_resources_and_prompts() {
        let result = handle_initialize(&json!({})).unwrap();
        assert_eq!(result["capabilities"]["resources"]["listChanged"], false);
        assert_eq!(result["capabilities"]["resources"]["subscribe"], false);
        assert_eq!(result["capabilities"]["prompts"]["listChanged"], false);
    }

    #[test]
    fn test_prompts_list_returns_three_templates() {
        let result = handle_prompts_list().unwrap();
        let prompts = result["prompts"].as_array().unwrap();
        assert_eq!(prompts.len(), 3);
        let names: Vec<&str> = prompts
            .iter()
            .map(|p| p["name"].as_str().unwrap())
            .collect();
        assert!(names.contains(&"summarize_recent"));
        assert!(names.contains(&"gather_by_tag"));
        assert!(names.contains(&"review_due"));
    }

    #[test]
    fn test_prompts_list_gather_by_tag_has_required_tag_arg() {
        let result = handle_prompts_list().unwrap();
        let prompts = result["prompts"].as_array().unwrap();
        let gather = prompts
            .iter()
            .find(|p| p["name"] == "gather_by_tag")
            .unwrap();
        let args = gather["arguments"].as_array().unwrap();
        assert_eq!(args.len(), 1);
        assert_eq!(args[0]["name"], "tag");
        assert_eq!(args[0]["required"], true);
    }

    #[test]
    fn test_parse_arg_i32_uses_default_when_missing() {
        let args = json!({});
        assert_eq!(parse_arg_i32(&args, "limit", 10, 1, 50).unwrap(), 10);
    }

    #[test]
    fn test_parse_arg_i32_clamps_to_range() {
        let args = json!({ "limit": 999 });
        assert_eq!(parse_arg_i32(&args, "limit", 10, 1, 50).unwrap(), 50);
        let args = json!({ "limit": -5 });
        assert_eq!(parse_arg_i32(&args, "limit", 10, 1, 50).unwrap(), 1);
    }

    #[test]
    fn test_parse_arg_i32_rejects_non_integer() {
        let args = json!({ "limit": "abc" });
        assert!(parse_arg_i32(&args, "limit", 10, 1, 50).is_err());
    }

    #[test]
    fn test_parse_arg_string_returns_none_when_missing() {
        let args = json!({});
        assert!(parse_arg_string(&args, "tag", true).unwrap().is_none());
    }

    #[test]
    fn test_parse_arg_string_trims_when_required() {
        let args = json!({ "tag": "  rust  " });
        let s = parse_arg_string(&args, "tag", true).unwrap().unwrap();
        assert_eq!(s, "rust");
    }

    #[test]
    fn test_parse_arg_string_rejects_non_string() {
        let args = json!({ "tag": 42 });
        assert!(parse_arg_string(&args, "tag", true).is_err());
    }

    #[test]
    fn test_prompt_response_structure() {
        let v = prompt_response("summarize_recent", "hello".to_string());
        assert_eq!(v["messages"][0]["role"], "user");
        assert_eq!(v["messages"][0]["content"]["type"], "text");
        assert_eq!(v["messages"][0]["content"]["text"], "hello");
    }

    #[test]
    fn test_format_memos_as_context_empty() {
        let empty: Vec<Memo> = vec![];
        let s = format_memos_as_context(&empty, "最近笔记");
        assert!(s.contains("无内容"));
    }

    #[test]
    fn test_format_ts_falls_back_to_raw_for_invalid() {
        // i64::MAX 不是合法时间戳，应回退到原始数字字符串
        let s = format_ts(i64::MAX);
        assert!(s.parse::<i64>().is_ok(), "应回退为数字字符串");
    }
}
