//! AI agent 工具：定义 OpenAI function-calling schema + 执行分发

use crate::ai::pending_confirmations::PendingConfirmations;
use crate::state::AppState;
use memos_core::markdown;
use memos_core::memo::{CreateMemo, FindMemo, UpdateMemo};
use memos_core::memo_relation::{UpsertMemoRelation};
use memos_core::review::{self, ReviewCard};
use memos_core::skill::Skill;
use memos_core::tool::Tool;
use memos_core::types::{MemoRelationType, RowStatus, Visibility};
use memos_core::Store;
use serde_json::{json, Value};
use std::process::Stdio;
use std::time::Duration;
use tauri::async_runtime;

/// 返回 OpenAI function-calling 格式的工具定义
pub fn tool_definitions(user_tools: &[Tool]) -> Vec<Value> {
    let mut defs: Vec<Value> = vec![
        json!({
            "type": "function",
            "function": {
                "name": "list_memos",
                "description": "搜索用户的笔记。支持全文搜索（FTS）和列出最近的笔记。",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "query": { "type": "string", "description": "全文搜索关键词，留空则返回最近笔记" },
                        "limit": { "type": "number", "description": "返回数量，默认 10，最大 50" }
                    }
                }
            }
        }),
        json!({
            "type": "function",
            "function": {
                "name": "get_memo",
                "description": "获取单条笔记的完整内容。",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "uid": { "type": "string", "description": "笔记的唯一 ID" }
                    },
                    "required": ["uid"]
                }
            }
        }),
        json!({
            "type": "function",
            "function": {
                "name": "create_memo",
                "description": "创建一条新笔记。",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "content": { "type": "string", "description": "笔记内容，Markdown 格式" }
                    },
                    "required": ["content"]
                }
            }
        }),
        json!({
            "type": "function",
            "function": {
                "name": "list_tags",
                "description": "列出用户所有标签及其使用次数。",
                "parameters": { "type": "object", "properties": {} }
            }
        }),
        json!({
            "type": "function",
            "function": {
                "name": "list_memos_by_tag",
                "description": "List memos that contain ALL specified tags. Returns memo content for card generation.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "tags": { "type": "array", "items": { "type": "string" }, "description": "Tags to filter (memo must contain ALL)" },
                        "limit": { "type": "number", "description": "Max results, default 50" }
                    },
                    "required": ["tags"]
                }
            }
        }),
        json!({
            "type": "function",
            "function": {
                "name": "update_memo",
                "description": "更新一条笔记的内容或置顶状态。只需提供要修改的字段。",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "uid": { "type": "string", "description": "笔记唯一 ID" },
                        "content": { "type": "string", "description": "新的笔记内容（Markdown），不传则不改内容" },
                        "pinned": { "type": "boolean", "description": "是否置顶，不传则不改" }
                    },
                    "required": ["uid"]
                }
            }
        }),
        json!({
            "type": "function",
            "function": {
                "name": "search_semantic",
                "description": "语义搜索笔记：基于向量相似度查找与查询含义最相近的笔记。适合查找\"关于某主题的想法\"这类模糊查询。首次调用会下载嵌入模型（约90MB），可能耗时数十秒。",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "query": { "type": "string", "description": "自然语言查询，如\"Rust 内存管理\"或\"如何做时间管理\"" },
                        "limit": { "type": "number", "description": "返回数量，默认 10，最大 50" }
                    },
                    "required": ["query"]
                }
            }
        }),
        json!({
            "type": "function",
            "function": {
                "name": "link_memos",
                "description": "在两条笔记之间建立关联关系（引用或评论）。",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "from_uid": { "type": "string", "description": "源笔记 uid" },
                        "to_uid": { "type": "string", "description": "目标笔记 uid" },
                        "relation_type": { "type": "string", "enum": ["REFERENCE", "COMMENT"], "description": "关系类型：REFERENCE=引用，COMMENT=评论" }
                    },
                    "required": ["from_uid", "to_uid", "relation_type"]
                }
            }
        }),
        json!({
            "type": "function",
            "function": {
                "name": "create_review_cards",
                "description": "为指定 deck 批量创建复习卡片。卡片内容由你（AI）根据笔记内容生成后传入。每张卡需指定 memo_uid、card_type、front、back、angle。",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "deck_id": { "type": "number", "description": "目标 deck ID" },
                        "cards": {
                            "type": "array",
                            "description": "卡片数组",
                            "items": {
                                "type": "object",
                                "properties": {
                                    "memo_uid": { "type": "string", "description": "来源笔记 uid" },
                                    "card_type": { "type": "string", "enum": ["basic", "reversed", "cloze", "concept", "compare"], "description": "卡片类型" },
                                    "front": { "type": "string", "description": "正面内容（Markdown）" },
                                    "back": { "type": "string", "description": "背面内容（Markdown）" },
                                    "cloze_answer": { "type": "string", "description": "填空答案（仅 cloze 类型需要）" },
                                    "angle": { "type": "string", "description": "考核点，如：定义|应用|对比|列举|原理" }
                                },
                                "required": ["memo_uid", "card_type", "front", "back"]
                            }
                        }
                    },
                    "required": ["deck_id", "cards"]
                }
            }
        }),
        json!({
            "type": "function",
            "function": {
                "name": "load_skill",
                "description": "加载一个 skill 的完整指南文档到上下文。在调用任何业务工具前，若系统提示中列出的 skill 元数据与当前任务相关，请先调用本工具加载该 skill 的完整内容。一次只加载一个 skill；多个相关 skill 可分别调用。",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "skill_id": { "type": "string", "description": "要加载的 skill id" }
                    },
                    "required": ["skill_id"]
                }
            }
        }),
    ];
    // 追加用户工具定义
    for ut in user_tools.iter().filter(|t| t.enabled) {
        defs.push(json!({
            "type": "function",
            "function": {
                "name": ut.name,
                "description": format!(
                    "{}\n\n[权限等级: {}] 执行用户配置的 shell 命令。配置默认命令: `{}`。\
                     调用时传入完整 command 字符串，后端在固定工作目录执行。",
                    ut.description, ut.permission.as_str(), ut.command
                ),
                "parameters": {
                    "type": "object",
                    "properties": {
                        "command": {
                            "type": "string",
                            "description": "要执行的完整 shell 命令字符串"
                        }
                    },
                    "required": ["command"]
                }
            }
        }));
    }
    defs
}

/// 执行工具调用，返回结果 JSON
pub fn execute_tool(
    name: &str,
    args: &Value,
    store: &Store,
    builtin: &[Skill],
    state: &AppState,
) -> memos_core::CoreResult<Value> {
    match name {
        "list_memos" => execute_list_memos(args, store),
        "get_memo" => execute_get_memo(args, store),
        "create_memo" => execute_create_memo(args, store),
        "list_tags" => execute_list_tags(store),
        "list_memos_by_tag" => execute_list_memos_by_tag(args, store),
        "update_memo" => execute_update_memo(args, store),
        "search_semantic" => execute_search_semantic(args, store),
        "link_memos" => execute_link_memos(args, store),
        "create_review_cards" => execute_create_review_cards(args, store),
        "load_skill" => execute_load_skill(args, store, builtin),
        other => {
            // 内置工具名已知但没匹配上（不应该发生）
            if memos_core::tool::BUILTIN_TOOL_NAMES.contains(&other) {
                return Err(memos_core::CoreError::Other(format!("内置工具未实现: {other}")));
            }
            // 查用户工具
            let user_tool = memos_core::tool::get_by_name(store, other)?
                .ok_or_else(|| memos_core::CoreError::Other(format!("未知工具: {name}")))?;
            if !user_tool.enabled {
                return Ok(json!({"error": format!("工具 {} 已禁用", name)}));
            }
            let command = args
                .get("command")
                .and_then(|v| v.as_str())
                .ok_or_else(|| memos_core::CoreError::Other("缺少 command 参数".into()))?;
            execute_user_tool(user_tool, command, state)
        }
    }
}

fn execute_list_memos(args: &Value, store: &Store) -> memos_core::CoreResult<Value> {
    let query = args.get("query").and_then(|v| v.as_str()).unwrap_or("");
    let limit = args
        .get("limit")
        .and_then(|v| v.as_i64())
        .map(|n| n as i32)
        .unwrap_or(10)
        .min(50)
        .max(1);

    let mut find = FindMemo {
        limit: Some(limit),
        row_status: Some(RowStatus::Normal),
        order_by_time_asc: false,
        ..Default::default()
    };
    if !query.is_empty() {
        let words: Vec<&str> = query.split_whitespace().filter(|w| !w.is_empty()).collect();
        let has_short = words.iter().any(|w| w.len() < 3);
        if has_short {
            find.content_contains = Some(query.to_string());
        } else {
            find.fts_query = Some(
                words
                    .iter()
                    .map(|w| format!("\"{}\"", w.replace('"', "\"\"")))
                    .collect::<Vec<_>>()
                    .join(" "),
            );
        }
    }

    let memos = store.with_conn(|c| memos_core::memo::list(c, &find))?;
    let result: Vec<Value> = memos
        .iter()
        .map(|m| {
            json!({
                "uid": m.uid,
                "snippet": markdown::generate_snippet(&m.content, 200),
                "tags": markdown::extract_tags(&m.content),
                "created_ts": m.created_ts,
                "updated_ts": m.updated_ts,
            })
        })
        .collect();
    Ok(json!({ "memos": result }))
}

fn execute_get_memo(args: &Value, store: &Store) -> memos_core::CoreResult<Value> {
    let uid = args
        .get("uid")
        .and_then(|v| v.as_str())
        .ok_or_else(|| memos_core::CoreError::Other("缺少 uid 参数".to_string()))?;

    let find = FindMemo {
        uid: Some(uid.to_string()),
        ..Default::default()
    };
    let memo = store.with_conn(|c| memos_core::memo::get(c, &find))?;
    match memo {
        Some(m) => Ok(json!({
            "uid": m.uid,
            "content": m.content,
            "tags": markdown::extract_tags(&m.content),
            "created_ts": m.created_ts,
            "updated_ts": m.updated_ts,
            "visibility": format!("{:?}", m.visibility),
            "pinned": m.pinned,
        })),
        None => Ok(json!({ "error": "未找到该笔记" })),
    }
}

fn execute_create_memo(args: &Value, store: &Store) -> memos_core::CoreResult<Value> {
    let content = args
        .get("content")
        .and_then(|v| v.as_str())
        .ok_or_else(|| memos_core::CoreError::Other("缺少 content 参数".to_string()))?;

    let uid = uuid_like();
    let create = CreateMemo {
        uid: uid.clone(),
        content: content.to_string(),
        visibility: Visibility::Private,
        pinned: false,
        payload: serde_json::Value::Object(Default::default()),
        location: None,
        parent_id: None,
    };
    let memo = store.with_conn(|c| memos_core::memo::create(c, &create))?;
    if let Err(e) = crate::commands::memo::sync_memo_embedding_for_memo(store, &memo) {
        tracing::warn!("AI 工具创建 memo {} 后同步 embedding 失败: {}", memo.id, e);
    }
    Ok(json!({
        "uid": memo.uid,
        "id": memo.id,
        "created_ts": memo.created_ts,
    }))
}

fn execute_list_tags(store: &Store) -> memos_core::CoreResult<Value> {
    let tags = store.with_conn(|c| memos_core::tag::list_tags(c))?;
    let tags: Vec<Value> = tags
        .into_iter()
        .map(|(tag, count)| json!({ "tag": tag, "count": count }))
        .collect();
    Ok(json!({ "tags": tags }))
}

fn execute_list_memos_by_tag(args: &Value, store: &Store) -> memos_core::CoreResult<Value> {
    let tags: Vec<String> = args
        .get("tags")
        .and_then(|v| v.as_array())
        .map(|a| {
            a.iter()
                .filter_map(|v| v.as_str().map(String::from))
                .collect()
        })
        .unwrap_or_default();

    if tags.is_empty() {
        return Ok(json!({ "memos": [] }));
    }

    let limit = args
        .get("limit")
        .and_then(|v| v.as_i64())
        .map(|n| n as i32)
        .unwrap_or(50)
        .min(200)
        .max(1) as i32;

    let find = FindMemo {
        tag_search: tags.clone(),
        row_status: Some(RowStatus::Normal),
        limit: Some(limit),
        ..Default::default()
    };

    let memos = store.with_conn(|c| memos_core::memo::list(c, &find))?;
    let result: Vec<Value> = memos
        .iter()
        .map(|m| {
            json!({
                "uid": m.uid,
                "content": m.content,
                "tags": markdown::extract_tags(&m.content),
                "created_ts": m.created_ts,
                "updated_ts": m.updated_ts,
            })
        })
        .collect();
    Ok(json!({ "memos": result }))
}

fn execute_update_memo(args: &Value, store: &Store) -> memos_core::CoreResult<Value> {
    let uid = args
        .get("uid")
        .and_then(|v| v.as_str())
        .ok_or_else(|| memos_core::CoreError::Other("缺少 uid 参数".to_string()))?;

    // uid → id
    let memo = store
        .with_conn(|c| memos_core::memo::get(c, &FindMemo { uid: Some(uid.to_string()), ..Default::default() }))?
        .ok_or_else(|| memos_core::CoreError::NotFound(format!("memo uid={uid}")))?;

    let content = args.get("content").and_then(|v| v.as_str()).map(String::from);
    let pinned = args.get("pinned").and_then(|v| v.as_bool());

    let update = UpdateMemo {
        id: memo.id,
        content: content.clone(),
        pinned,
        ..Default::default()
    };
    let updated = store.with_conn(|c| memos_core::memo::update(c, &update))?;

    // 内容变更时同步 embedding（同步阻塞，在 spawn_blocking 上下文中可接受）
    if content.is_some() && updated.parent_id.is_none() {
        if let Err(e) = crate::commands::memo::sync_memo_embedding_for_memo(store, &updated) {
            tracing::warn!("AI 工具更新 memo {} 后同步 embedding 失败: {}", updated.id, e);
        }
    }

    Ok(json!({
        "uid": updated.uid,
        "id": updated.id,
        "updated_ts": updated.updated_ts,
        "content": updated.content,
        "pinned": updated.pinned,
    }))
}

fn execute_search_semantic(args: &Value, store: &Store) -> memos_core::CoreResult<Value> {
    let query = args
        .get("query")
        .and_then(|v| v.as_str())
        .ok_or_else(|| memos_core::CoreError::Other("缺少 query 参数".to_string()))?;

    let limit = args
        .get("limit")
        .and_then(|v| v.as_i64())
        .map(|n| n as u32)
        .unwrap_or(10)
        .min(50)
        .max(1);

    // 生成查询向量（阻塞调用，在 spawn_blocking 上下文中可接受）
    let embedding_json = crate::embedding::embed_to_json(query)
        .map_err(|e| memos_core::CoreError::Other(format!("生成 embedding 失败: {e}")))?;

    let find = FindMemo {
        vector_embedding: Some(embedding_json),
        vector_top_k: Some(limit),
        row_status: Some(RowStatus::Normal),
        ..Default::default()
    };

    let memos = store.with_conn(|c| memos_core::memo::list(c, &find))?;
    let result: Vec<Value> = memos
        .iter()
        .map(|m| {
            json!({
                "uid": m.uid,
                "snippet": markdown::generate_snippet(&m.content, 200),
                "tags": markdown::extract_tags(&m.content),
                "created_ts": m.created_ts,
                "updated_ts": m.updated_ts,
            })
        })
        .collect();
    Ok(json!({ "memos": result, "query": query }))
}

fn execute_link_memos(args: &Value, store: &Store) -> memos_core::CoreResult<Value> {
    let from_uid = args
        .get("from_uid")
        .and_then(|v| v.as_str())
        .ok_or_else(|| memos_core::CoreError::Other("缺少 from_uid 参数".to_string()))?;
    let to_uid = args
        .get("to_uid")
        .and_then(|v| v.as_str())
        .ok_or_else(|| memos_core::CoreError::Other("缺少 to_uid 参数".to_string()))?;
    let relation_type_str = args
        .get("relation_type")
        .and_then(|v| v.as_str())
        .ok_or_else(|| memos_core::CoreError::Other("缺少 relation_type 参数".to_string()))?;

    let relation_type = match relation_type_str {
        "REFERENCE" => MemoRelationType::Reference,
        "COMMENT" => MemoRelationType::Comment,
        other => return Err(memos_core::CoreError::Other(format!("未知关系类型: {other}"))),
    };

    // 解析两个 uid → id
    let from_memo = store
        .with_conn(|c| memos_core::memo::get(c, &FindMemo { uid: Some(from_uid.to_string()), ..Default::default() }))?
        .ok_or_else(|| memos_core::CoreError::NotFound(format!("memo uid={from_uid}")))?;
    let to_memo = store
        .with_conn(|c| memos_core::memo::get(c, &FindMemo { uid: Some(to_uid.to_string()), ..Default::default() }))?
        .ok_or_else(|| memos_core::CoreError::NotFound(format!("memo uid={to_uid}")))?;

    store.with_conn(|c| {
        memos_core::memo_relation::upsert(c, &UpsertMemoRelation {
            memo_id: from_memo.id,
            related_memo_id: to_memo.id,
            r#type: relation_type,
        })
    })?;

    Ok(json!({
        "from_uid": from_uid,
        "to_uid": to_uid,
        "relation_type": relation_type_str,
    }))
}

fn execute_create_review_cards(args: &Value, store: &Store) -> memos_core::CoreResult<Value> {
    let deck_id = args
        .get("deck_id")
        .and_then(|v| v.as_i64())
        .ok_or_else(|| memos_core::CoreError::Other("缺少 deck_id 参数".to_string()))?
        as i32;

    let cards_arr = args
        .get("cards")
        .and_then(|v| v.as_array())
        .ok_or_else(|| memos_core::CoreError::Other("缺少 cards 参数".to_string()))?;

    if cards_arr.is_empty() {
        return Ok(json!({ "inserted": 0, "deck_id": deck_id }));
    }

    // 验证 deck 存在
    let deck = store
        .with_conn(|c| review::get_deck(c, deck_id))?
        .ok_or_else(|| memos_core::CoreError::NotFound(format!("deck id={deck_id}")))?;

    let now = chrono::Utc::now().timestamp();
    let mut inserted = 0u32;
    let mut errors: Vec<String> = Vec::new();

    for card in cards_arr {
        let memo_uid = card
            .get("memo_uid")
            .and_then(|v| v.as_str())
            .unwrap_or("");
        let card_type = card
            .get("card_type")
            .and_then(|v| v.as_str())
            .unwrap_or("basic");
        let front = card
            .get("front")
            .and_then(|v| v.as_str())
            .unwrap_or("");
        let back = card
            .get("back")
            .and_then(|v| v.as_str())
            .unwrap_or("");
        let cloze_answer = card.get("cloze_answer").and_then(|v| v.as_str()).map(String::from);
        let angle = card.get("angle").and_then(|v| v.as_str()).unwrap_or("");

        if memo_uid.is_empty() || front.is_empty() {
            errors.push(format!("跳过无效卡片：memo_uid 或 front 为空"));
            continue;
        }

        let review_card = ReviewCard {
            id: 0,
            deck_id,
            memo_uid: memo_uid.to_string(),
            card_type: card_type.to_string(),
            front: front.to_string(),
            back: back.to_string(),
            cloze_answer,
            angle: angle.to_string(),
            stability: 0.0,
            difficulty: 0.0,
            due: now,
            last_review: None,
            reps: 0,
            lapses: 0,
            state: 0,
            created_ts: now,
            memo_deleted: false,
        };

        match store.with_conn(|c| review::create_card(c, &review_card)) {
            Ok(_) => inserted += 1,
            Err(e) => errors.push(format!("card memo_uid={memo_uid}: {e}")),
        }
    }

    Ok(json!({
        "inserted": inserted,
        "deck_id": deck.id,
        "deck_name": deck.name,
        "errors": errors,
    }))
}

const MAX_SKILL_BODY_BYTES: usize = 50 * 1024;

fn execute_load_skill(
    args: &Value,
    store: &Store,
    builtin: &[Skill],
) -> memos_core::CoreResult<Value> {
    let skill_id = args
        .get("skill_id")
        .and_then(|v| v.as_str())
        .ok_or_else(|| {
            memos_core::CoreError::Other("load_skill 缺少 skill_id 参数".into())
        })?;

    match memos_core::skill::get(builtin, store, skill_id)? {
        Some(s) if s.enabled => {
            let body = if s.body.len() > MAX_SKILL_BODY_BYTES {
                // Find a safe UTF-8 boundary at or before MAX_SKILL_BODY_BYTES
                let mut end = MAX_SKILL_BODY_BYTES;
                while end > 0 && !s.body.is_char_boundary(end) {
                    end -= 1;
                }
                let mut truncated = s.body[..end].to_string();
                truncated.push_str("\n\n…[已截断]");
                truncated
            } else {
                s.body
            };
            Ok(json!({
                "id": s.id,
                "name": s.name,
                "body": body,
            }))
        }
        _ => Ok(json!({
            "error": "skill not found or disabled"
        })),
    }
}

/// 生成 16 字符 hex ID
fn uuid_like() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    format!("{:016x}", now & 0xFFFF_FFFF_FFFF_FFFF)
}

/// 用户工具执行的最大输出字节数（超出则头尾截断）
const MAX_USER_TOOL_OUTPUT_BYTES: usize = 10 * 1024;

#[cfg(windows)]
fn build_shell_command(command: &str) -> tokio::process::Command {
    let mut c = tokio::process::Command::new("cmd");
    c.arg("/C").arg(command);
    c
}

#[cfg(not(windows))]
fn build_shell_command(command: &str) -> tokio::process::Command {
    let mut c = tokio::process::Command::new("sh");
    c.arg("-c").arg(command);
    c
}

/// 在不超过 max_bytes 的前提下，保留头部和尾部各 max_bytes/2 字节，
/// 中间用 truncation marker 占位。所有切点都对齐 UTF-8 字符边界。
fn truncate_at_char_boundary(s: &str, max_bytes: usize) -> String {
    if s.len() <= max_bytes {
        return s.to_string();
    }
    let half = max_bytes / 2;

    let mut head_end = half;
    while !s.is_char_boundary(head_end) && head_end > 0 {
        head_end -= 1;
    }

    let tail_start_target = s.len() - half;
    let mut tail_start = tail_start_target;
    while !s.is_char_boundary(tail_start) && tail_start < s.len() {
        tail_start += 1;
    }

    let truncated_bytes = s.len() - head_end - (s.len() - tail_start);
    format!(
        "{}\n...[truncated {} bytes]...\n{}",
        &s[..head_end],
        truncated_bytes,
        &s[tail_start..]
    )
}

/// 执行用户配置的 shell 命令工具
/// agent_loop 在同步上下文中调用，内部用 async_runtime::block_on 桥接
fn execute_user_tool(
    tool: memos_core::tool::Tool,
    command: &str,
    state: &AppState,
) -> memos_core::CoreResult<Value> {
    use tokio::process::Command as TokioCommand;

    let permission = tool.permission;
    let timeout_ms = tool.timeout_ms;
    let tool_name = tool.name.clone();
    let cwd = state
        .attachments_dir
        .parent()
        .unwrap_or_else(|| std::path::Path::new("."))
        .to_path_buf();
    let pending = &state.pending_confirmations;
    let app_handle = state.app_handle().clone();
    let command_owned = command.to_string();

    async_runtime::block_on(async move {
        // 1. 权限分级拦截
        if permission.requires_confirmation() {
            let approved = pending
                .request_confirmation(tool_name.clone(), command_owned.clone(), permission, &app_handle)
                .await
                .map_err(|e| memos_core::CoreError::Other(format!("确认失败: {e}")))?;
            if !approved {
                return Ok(json!({
                    "error": "user denied the tool call",
                    "denied": true,
                    "tool_name": tool_name,
                    "permission": permission.as_str(),
                }));
            }
        }

        // 2. 构建 tokio::process::Command
        #[cfg(windows)]
        let mut cmd = {
            let mut c = TokioCommand::new("cmd");
            c.arg("/C").arg(&command_owned);
            c
        };
        #[cfg(not(windows))]
        let mut cmd = {
            let mut c = TokioCommand::new("sh");
            c.arg("-c").arg(&command_owned);
            c
        };
        cmd.current_dir(&cwd)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true);

        let child = match cmd.spawn() {
            Ok(c) => c,
            Err(e) => {
                return Ok(json!({
                    "error": format!("spawn failed: {e}"),
                    "tool_name": tool_name,
                    "permission": permission.as_str(),
                }));
            }
        };

        // 3. 超时强制 kill
        let timeout_dur = Duration::from_millis(timeout_ms as u64);
        let output = match tokio::time::timeout(timeout_dur, child.wait_with_output()).await {
            Ok(Ok(out)) => out,
            Ok(Err(e)) => {
                return Ok(json!({
                    "error": format!("wait failed: {e}"),
                    "tool_name": tool_name,
                    "permission": permission.as_str(),
                }));
            }
            Err(_) => {
                // 超时：kill_on_drop 会在 child drop 时 kill
                return Ok(json!({
                    "error": format!("timeout after {timeout_ms}ms"),
                    "tool_name": tool_name,
                    "permission": permission.as_str(),
                }));
            }
        };

        // 4. 合并 stdout+stderr
        let stdout = String::from_utf8_lossy(&output.stdout).to_string();
        let stderr: String = String::from_utf8_lossy(&output.stderr)
            .lines()
            .map(|l| format!("[stderr] {l}\n"))
            .collect();
        let mut combined = format!("{stdout}{stderr}");

        if combined.len() > MAX_USER_TOOL_OUTPUT_BYTES {
            combined = truncate_at_char_boundary(&combined, MAX_USER_TOOL_OUTPUT_BYTES);
        }

        Ok(json!({
            "output": combined,
            "exit_code": output.status.code().unwrap_or(-1),
            "tool_name": tool_name,
            "permission": permission.as_str(),
        }))
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use memos_core::memo::CreateMemo;
    use memos_core::types::Visibility;

    fn setup_store_with_memos() -> Store {
        let store = Store::open(":memory:").unwrap();
        for i in 0..3 {
            let create = CreateMemo {
                uid: format!("uid{i}"),
                content: format!("#rust 笔记 {i}：关于 Rust 所有权的内容"),
                visibility: Visibility::Private,
                pinned: false,
                payload: serde_json::Value::Object(Default::default()),
                location: None,
                parent_id: None,
            };
            store
                .with_conn(|c| memos_core::memo::create(c, &create))
                .unwrap();
        }
        store
    }

    #[test]
    fn test_tool_definitions_count() {
        let defs = tool_definitions(&[]);
        assert_eq!(defs.len(), 10);
        let names: Vec<&str> = defs
            .iter()
            .map(|d| d["function"]["name"].as_str().unwrap())
            .collect();
        assert!(names.contains(&"list_memos"));
        assert!(names.contains(&"get_memo"));
        assert!(names.contains(&"create_memo"));
        assert!(names.contains(&"list_tags"));
        assert!(names.contains(&"list_memos_by_tag"));
        assert!(names.contains(&"update_memo"));
        assert!(names.contains(&"search_semantic"));
        assert!(names.contains(&"link_memos"));
        assert!(names.contains(&"create_review_cards"));
        assert!(names.contains(&"load_skill"));
    }

    #[test]
    fn test_tool_definitions_with_user_tools() {
        use memos_core::tool::Permission;
        let enabled = Tool {
            id: "u-a".to_string(),
            name: "my_tool".to_string(),
            command: "echo hi".to_string(),
            permission: Permission::ReadOnly,
            description: "test".to_string(),
            timeout_ms: 30000,
            enabled: true,
            created_ts: 0,
            updated_ts: 0,
        };
        let disabled = Tool {
            id: "u-b".to_string(),
            name: "disabled_tool".to_string(),
            enabled: false,
            ..enabled.clone()
        };
        let defs = tool_definitions(&[enabled, disabled]);
        assert_eq!(defs.len(), 11); // 10 + 1 enabled
        let names: Vec<&str> = defs
            .iter()
            .map(|d| d["function"]["name"].as_str().unwrap())
            .collect();
        assert!(names.contains(&"my_tool"));
        assert!(!names.contains(&"disabled_tool"));
    }

    #[test]
    fn test_list_memos_all() {
        let store = setup_store_with_memos();
        let result = execute_list_memos(&json!({}), &store).unwrap();
        let memos = result["memos"].as_array().unwrap();
        assert_eq!(memos.len(), 3);
        assert!(memos[0]["snippet"].as_str().unwrap().contains("Rust"));
    }

    #[test]
    fn test_list_memos_with_fts_query() {
        let store = setup_store_with_memos();
        let result = execute_list_memos(&json!({"query": "Rust"}), &store).unwrap();
        let memos = result["memos"].as_array().unwrap();
        assert_eq!(memos.len(), 3);
    }

    #[test]
    fn test_get_memo_found() {
        let store = setup_store_with_memos();
        let result = execute_get_memo(&json!({"uid": "uid0"}), &store).unwrap();
        assert_eq!(result["uid"].as_str().unwrap(), "uid0");
        assert!(result["content"].as_str().unwrap().contains("Rust"));
        let tags = result["tags"].as_array().unwrap();
        assert_eq!(tags.len(), 1);
        assert_eq!(tags[0].as_str().unwrap(), "rust");
    }

    #[test]
    fn test_get_memo_not_found() {
        let store = setup_store_with_memos();
        let result = execute_get_memo(&json!({"uid": "nonexistent"}), &store).unwrap();
        assert!(result.get("error").is_some());
    }

    #[test]
    fn test_create_memo() {
        let store = Store::open(":memory:").unwrap();
        let result = execute_create_memo(&json!({"content": "#test 新笔记"}), &store).unwrap();
        assert!(result["uid"].as_str().unwrap().len() > 0);
        assert!(result["id"].as_i64().unwrap() > 0);
    }

    #[test]
    fn test_create_memo_missing_content() {
        let store = Store::open(":memory:").unwrap();
        let result = execute_create_memo(&json!({}), &store);
        assert!(result.is_err());
    }

    #[test]
    fn test_list_tags() {
        let store = setup_store_with_memos();
        let result = execute_list_tags(&store).unwrap();
        let tags = result["tags"].as_array().unwrap();
        assert_eq!(tags.len(), 1);
        assert_eq!(tags[0]["tag"].as_str().unwrap(), "rust");
        assert_eq!(tags[0]["count"].as_i64().unwrap(), 3);
    }

    #[test]
    fn test_execute_tool_unknown() {
        let store = Store::open(":memory:").unwrap();
        // execute_tool 的 other=> 分支：unknown_tool 既非内置工具，也不在用户工具表中。
        // 由于 AppState 需要 AppHandle（无法在单元测试线程中构造 Wry 事件循环），
        // 这里直接验证 dispatch 逻辑：get_by_name 返回 None → ok_or_else 返回 Err。
        // 该路径与 execute_tool 内部对未知工具的处理完全一致。
        let result = memos_core::tool::get_by_name(&store, "unknown_tool")
            .and_then(|opt| {
                opt.ok_or_else(|| {
                    memos_core::CoreError::Other(format!("未知工具: unknown_tool"))
                })
            });
        assert!(result.is_err());
    }

    #[test]
    fn test_update_memo_content() {
        let store = setup_store_with_memos();
        let result = execute_update_memo(
            &json!({"uid": "uid0", "content": "#rust 更新后的内容"}),
            &store,
        )
        .unwrap();
        assert_eq!(result["uid"].as_str().unwrap(), "uid0");
        assert!(result["content"].as_str().unwrap().contains("更新后"));
    }

    #[test]
    fn test_update_memo_pinned() {
        let store = setup_store_with_memos();
        let result = execute_update_memo(&json!({"uid": "uid1", "pinned": true}), &store).unwrap();
        assert_eq!(result["pinned"].as_bool().unwrap(), true);
    }

    #[test]
    fn test_update_memo_not_found() {
        let store = setup_store_with_memos();
        let result = execute_update_memo(&json!({"uid": "nope"}), &store);
        assert!(result.is_err());
    }

    #[test]
    fn test_update_memo_missing_uid() {
        let store = setup_store_with_memos();
        let result = execute_update_memo(&json!({}), &store);
        assert!(result.is_err());
    }

    #[test]
    fn test_link_memos_reference() {
        let store = setup_store_with_memos();
        let result = execute_link_memos(
            &json!({"from_uid": "uid0", "to_uid": "uid1", "relation_type": "REFERENCE"}),
            &store,
        )
        .unwrap();
        assert_eq!(result["from_uid"].as_str().unwrap(), "uid0");
        assert_eq!(result["to_uid"].as_str().unwrap(), "uid1");
        assert_eq!(result["relation_type"].as_str().unwrap(), "REFERENCE");

        // 验证关系已写入
        let relations = store
            .with_conn(|c| {
                memos_core::memo_relation::list(
                    c,
                    &memos_core::memo_relation::FindMemoRelation::default(),
                )
            })
            .unwrap();
        assert_eq!(relations.len(), 1);
    }

    #[test]
    fn test_link_memos_invalid_type() {
        let store = setup_store_with_memos();
        let result = execute_link_memos(
            &json!({"from_uid": "uid0", "to_uid": "uid1", "relation_type": "INVALID"}),
            &store,
        );
        assert!(result.is_err());
    }

    #[test]
    fn test_link_memos_not_found() {
        let store = setup_store_with_memos();
        let result = execute_link_memos(
            &json!({"from_uid": "uid0", "to_uid": "missing", "relation_type": "REFERENCE"}),
            &store,
        );
        assert!(result.is_err());
    }

    #[test]
    fn test_create_review_cards() {
        let store = setup_store_with_memos();
        // 先创建 deck
        let deck = store
            .with_conn(|c| memos_core::review::create_deck(c, "test-deck", &["rust".to_string()], 3))
            .unwrap();

        let result = execute_create_review_cards(
            &json!({
                "deck_id": deck.id,
                "cards": [
                    {"memo_uid": "uid0", "card_type": "basic", "front": "什么是所有权？", "back": "Rust 的所有权机制", "angle": "定义"},
                    {"memo_uid": "uid1", "card_type": "cloze", "front": "Rust 用 {{}} 管理内存", "back": "所有权", "cloze_answer": "所有权", "angle": "应用"},
                ]
            }),
            &store,
        )
        .unwrap();
        assert_eq!(result["inserted"].as_u64().unwrap(), 2);
        assert_eq!(result["deck_name"].as_str().unwrap(), "test-deck");

        // 验证卡片已写入
        let cards = store
            .with_conn(|c| memos_core::review::list_cards(c, deck.id))
            .unwrap();
        assert_eq!(cards.len(), 2);
    }

    #[test]
    fn test_create_review_cards_invalid_card() {
        let store = setup_store_with_memos();
        let deck = store
            .with_conn(|c| memos_core::review::create_deck(c, "d2", &[], 1))
            .unwrap();
        let result = execute_create_review_cards(
            &json!({
                "deck_id": deck.id,
                "cards": [
                    {"memo_uid": "", "card_type": "basic", "front": "", "back": "x"},
                    {"memo_uid": "uid0", "card_type": "basic", "front": "ok", "back": "ok"},
                ]
            }),
            &store,
        )
        .unwrap();
        assert_eq!(result["inserted"].as_u64().unwrap(), 1);
        let errors = result["errors"].as_array().unwrap();
        assert_eq!(errors.len(), 1);
    }

    #[test]
    fn test_create_review_cards_deck_not_found() {
        let store = setup_store_with_memos();
        let result = execute_create_review_cards(
            &json!({"deck_id": 9999, "cards": [{"memo_uid": "uid0", "card_type": "basic", "front": "q", "back": "a"}]}),
            &store,
        );
        assert!(result.is_err());
    }
}
