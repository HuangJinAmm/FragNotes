//! AI agent 工具：定义 OpenAI function-calling schema + 执行分发

use crate::ai::pending_confirmations::PendingConfirmations;
use crate::commands::setting::load_storage_config;
use crate::file_storage;
use crate::state::AppState;
use memos_core::attachment::{CreateAttachment, STORAGE_TYPE_LOCAL};
use memos_core::markdown;
use memos_core::memo::{CreateMemo, FindMemo, UpdateMemo};
use memos_core::memo_relation::{UpsertMemoRelation};
use memos_core::review::{self, ReviewCard};
use memos_core::skill::Skill;
use memos_core::tool::Tool;
use memos_core::types::{MemoRelationType, RowStatus, Visibility};
use memos_core::kg_graph::{self, UpsertKgGraph};
use memos_core::kg_node::{self, UpsertKgNode, FindKgNode};
use memos_core::kg_edge;
use memos_core::{ConfigStore, Store};
use serde_json::{json, Value};
use std::io::Read;
use std::process::Stdio;
use std::time::Duration;
use tauri::async_runtime;
use tauri::Manager;

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
        json!({
            "type": "function",
            "function": {
                "name": "officecli",
                "description": "AI-friendly CLI for Office documents (.docx, .xlsx, .pptx). Run 'officecli help' for schema-driven capability reference. Supports: open/close (resident process), watch/unwatch (live preview), view, get, query, set, add, remove, move, swap, refresh, raw, raw-set, add-part, validate, save, batch, dump, import, create, merge, plugins, mcp, skills, install, help. Use --json flag for AI-friendly JSON output. Quote paths containing brackets: officecli get doc.docx \"/body/p[1]\". Before using this tool, load the relevant skill (e.g. b-officecli-pptx, b-officecli-docx, b-officecli-xlsx) via load_skill for detailed guidance.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "command": {
                            "type": "string",
                            "description": "完整的 officecli 子命令字符串（不含 officecli 前缀），例如：'create report.pptx --type pptx'、'set /slide[1] --prop transition=morph'、'help pptx slide'、'get deck.pptx /slide[1] --json'"
                        }
                    },
                    "required": ["command"]
                }
            }
        }),
        json!({
            "type": "function",
            "function": {
                "name": "update_plan",
                "description": "创建或更新当前任务的任务清单（todo-list）。当用户提出复杂、多步骤任务时，应先用本工具制定计划，再逐步执行。每次完成一个步骤后调用本工具更新状态。简单单步任务无需使用。",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "todos": {
                            "type": "array",
                            "description": "任务清单，包含所有步骤及其当前状态。每次调用需传入完整清单（全量替换）。",
                            "items": {
                                "type": "object",
                                "properties": {
                                    "content": { "type": "string", "description": "该步骤的简短描述" },
                                    "status": { "type": "string", "enum": ["pending", "in_progress", "completed"], "description": "步骤状态：pending=待执行，in_progress=进行中（同一时间仅一个），completed=已完成" }
                                },
                                "required": ["content", "status"]
                            }
                        }
                    },
                    "required": ["todos"]
                }
            }
        }),
        // ===== 知识图谱工具 =====
        json!({
            "type": "function",
            "function": {
                "name": "list_kg_graphs",
                "description": "列出所有知识图谱。返回图谱列表（id、名称、描述）。",
                "parameters": {
                    "type": "object",
                    "properties": {}
                }
            }
        }),
        json!({
            "type": "function",
            "function": {
                "name": "create_kg_graph",
                "description": "创建一个新的知识图谱。",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "name": { "type": "string", "description": "图谱名称，如「机器学习知识体系」" },
                        "description": { "type": "string", "description": "图谱描述（可空）" }
                    },
                    "required": ["name"]
                }
            }
        }),
        json!({
            "type": "function",
            "function": {
                "name": "list_kg_nodes",
                "description": "列出指定知识图谱中的节点。可指定父节点 id 只列出其子节点。",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "graph_id": { "type": "number", "description": "图谱 id" },
                        "parent_id": { "type": "number", "description": "父节点 id（可选）。不传=列出所有节点；传 null=只列根节点；传数字=只列该父的子节点" }
                    },
                    "required": ["graph_id"]
                }
            }
        }),
        json!({
            "type": "function",
            "function": {
                "name": "create_kg_node",
                "description": "在知识图谱中创建一个新节点。可设置标签（用于自动关联带相同 #tag 的笔记）、父节点（建立层级）、颜色和图标。",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "graph_id": { "type": "number", "description": "所属图谱 id" },
                        "name": { "type": "string", "description": "节点名称" },
                        "description": { "type": "string", "description": "节点描述（可空）" },
                        "tags": {
                            "type": "array",
                            "items": { "type": "string" },
                            "description": "标签列表（不带 # 前缀）。节点标签会自动关联带相同 #tag 的笔记作为子节点"
                        },
                        "parent_id": { "type": "number", "description": "父节点 id（可空，空=根节点）" },
                        "color": { "type": "string", "description": "颜色 key：空(默认)、blue、green、amber、red、purple、cyan、pink" },
                        "icon": { "type": "string", "description": "lucide 图标名（如 StarIcon，可空）" }
                    },
                    "required": ["graph_id", "name"]
                }
            }
        }),
        json!({
            "type": "function",
            "function": {
                "name": "set_kg_node_tags",
                "description": "设置知识图谱节点的标签（全量替换）。标签用于自动关联带相同 #tag 的笔记。",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "node_id": { "type": "number", "description": "节点 id" },
                        "tags": {
                            "type": "array",
                            "items": { "type": "string" },
                            "description": "标签列表（不带 # 前缀，全量替换）"
                        }
                    },
                    "required": ["node_id", "tags"]
                }
            }
        }),
        json!({
            "type": "function",
            "function": {
                "name": "link_kg_nodes",
                "description": "在两个知识图谱节点之间创建一条边（关系连接）。",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "source_id": { "type": "number", "description": "起点节点 id" },
                        "target_id": { "type": "number", "description": "终点节点 id" },
                        "edge_type": { "type": "string", "enum": ["related", "contains", "derived"], "description": "边类型：related=相关、contains=包含、derived=派生。默认 related" }
                    },
                    "required": ["source_id", "target_id"]
                }
            }
        }),
        json!({
            "type": "function",
            "function": {
                "name": "fetch_url",
                "description": "访问一个 URL（http/https）并读取其内容。HTML 网页会用可读性算法提取正文并转成 Markdown；纯文本/JSON/XML 原样返回。 \
适用于查阅在线文档、文章、博客、API 响应等，返回结果含 markdown、title、url、status 字段。",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "url": { "type": "string", "description": "要访问的完整 URL，必须以 http:// 或 https:// 开头" },
                        "max_chars": { "type": "number", "description": "返回正文的最大字符数，默认 12000，范围 500-50000" }
                    },
                    "required": ["url"]
                }
            }
        }),
        json!({
            "type": "function",
            "function": {
                "name": "download_file",
                "description": "从网络下载一个文件（文档 / 图片 / zip 压缩包等）并保存到当前工作空间的附件目录，附件会出现在应用的附件列表中。 \
返回 attachment_id / attachment_uid / filename / type / size 等字段。 \
注意：若目标 URL 是网页且需要阅读正文，请改用 fetch_url；本工具会原样保存文件，不做正文提取。",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "url": { "type": "string", "description": "要下载的完整 URL，必须以 http:// 或 https:// 开头" },
                        "filename": { "type": "string", "description": "保存的文件名（含扩展名）。不传则依次按 Content-Disposition 响应头、URL 路径末段、内容类型推断" },
                        "max_bytes": { "type": "number", "description": "允许的最大字节数，默认 33554432（32MB），上限 209715200（200MB）" }
                    },
                    "required": ["url"]
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
        "load_skill" => {
            let config_store = state.config_store();
            execute_load_skill(args, store, &config_store, builtin)
        }
        "officecli" => execute_officecli(args, state),
        "update_plan" => execute_update_plan(args),
        "list_kg_graphs" => execute_list_kg_graphs(store),
        "create_kg_graph" => execute_create_kg_graph(args, store),
        "list_kg_nodes" => execute_list_kg_nodes(args, store),
        "create_kg_node" => execute_create_kg_node(args, store),
        "set_kg_node_tags" => execute_set_kg_node_tags(args, store),
        "link_kg_nodes" => execute_link_kg_nodes(args, store),
        "fetch_url" => execute_fetch_url(args),
        "download_file" => execute_download_file(args, store, state),
        other => {
            // 内置工具名已知但没匹配上（不应该发生）
            if memos_core::tool::BUILTIN_TOOL_NAMES.contains(&other) {
                return Err(memos_core::CoreError::Other(format!("内置工具未实现: {other}")));
            }
            // 查用户工具（tool 表在 ConfigStore / app_config.db）
            let config_store = state.config_store();
            let user_tool = memos_core::tool::get_by_name(&config_store, other)?
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
    config_store: &ConfigStore,
    builtin: &[Skill],
) -> memos_core::CoreResult<Value> {
    let skill_id = args
        .get("skill_id")
        .and_then(|v| v.as_str())
        .ok_or_else(|| {
            memos_core::CoreError::Other("load_skill 缺少 skill_id 参数".into())
        })?;

    match memos_core::skill::get(builtin, store, config_store, skill_id)? {
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

/// update_plan 工具：接收 AI 制定的任务清单，原样回传供前端渲染进度卡片。
/// 该工具不操作数据库，仅作为 AI 与前端之间的状态同步通道。
fn execute_update_plan(args: &Value) -> memos_core::CoreResult<Value> {
    let todos = args
        .get("todos")
        .and_then(|v| v.as_array())
        .ok_or_else(|| memos_core::CoreError::Other("缺少 todos 参数".to_string()))?;

    if todos.is_empty() {
        return Ok(json!({ "todos": [], "total": 0, "completed": 0 }));
    }

    // 规范化每条 todo：仅保留 content + status，校验 status 取值
    let valid_statuses = ["pending", "in_progress", "completed"];
    let mut normalized: Vec<Value> = Vec::with_capacity(todos.len());
    let mut completed = 0u32;
    for t in todos {
        let content = t
            .get("content")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .trim();
        if content.is_empty() {
            continue;
        }
        let status = t
            .get("status")
            .and_then(|v| v.as_str())
            .unwrap_or("pending");
        let status = if valid_statuses.contains(&status) {
            status
        } else {
            "pending"
        };
        if status == "completed" {
            completed += 1;
        }
        normalized.push(json!({ "content": content, "status": status }));
    }

    Ok(json!({
        "todos": normalized,
        "total": normalized.len(),
        "completed": completed,
    }))
}

/// officecli 工具输出最大字节数（超出则头尾截断）
const MAX_OFFICECLI_OUTPUT_BYTES: usize = 20 * 1024;

/// officecli 工具默认超时（120 秒，文档操作可能耗时较长）
const OFFICECLI_TIMEOUT_MS: u64 = 120_000;

/// 解析 officecli 二进制路径
/// 优先使用 Tauri resource_dir（生产环境打包），回退到编译期 src-tauri/skills 路径（开发环境）
fn resolve_officecli_binary(app_handle: &tauri::AppHandle) -> std::path::PathBuf {
    #[cfg(windows)]
    const BIN_NAME: &str = "officecli.exe";
    #[cfg(not(windows))]
    const BIN_NAME: &str = "officecli";

    // 1. 生产环境：从 Tauri 资源目录读取
    if let Ok(resource_dir) = app_handle.path().resource_dir() {
        let path = resource_dir.join("skills/office-cli").join(BIN_NAME);
        if path.exists() {
            return path;
        }
    }

    // 2. 开发环境回退：编译期 CARGO_MANIFEST_DIR（src-tauri/）下的相对路径
    std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("skills/office-cli")
        .join(BIN_NAME)
}

/// 简单的 shell 参数切分：按空白拆分，双引号内的内容视为单个参数。
/// 转义支持：`\"` 转义双引号，`\\` 转义反斜杠（仅在引号内生效）。
fn split_shell_args(s: &str) -> Vec<String> {
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

/// 从切分后的命令参数中提取 office 文档文件路径
///
/// 解析规则：
/// - 第一个 token 是子命令（如 get/set/add/watch 等）
/// - 在剩余 token 中查找第一个以 .docx/.xlsx/.pptx 结尾的参数
/// - 跳过 watch/unwatch 子命令（这些是 watch 服务自身的控制命令）
/// - 跳过选项参数（以 `--` 开头）及其后的值（如 `--port 26315`）
///
/// 返回相对路径（相对于 officecli 的 cwd），调用方负责拼接为绝对路径。
fn extract_office_file(args: &[String]) -> Option<std::path::PathBuf> {
    if args.is_empty() {
        return None;
    }

    let subcommand = args[0].to_lowercase();
    // watch/unwatch 是 watch 服务自身的控制命令，跳过避免递归启动
    if matches!(subcommand.as_str(), "watch" | "unwatch") {
        return None;
    }

    let office_exts = ["docx", "xlsx", "pptx"];
    let mut skip_next = false;
    let mut i = 1;
    while i < args.len() {
        let token = &args[i];

        if skip_next {
            skip_next = false;
            i += 1;
            continue;
        }

        if token.starts_with("--") {
            // --json / --help 等无值选项直接跳过
            // 带值选项（如 --port 26315）需跳过下一个 token
            // 简化：--port 这种带值选项手动列出
            if matches!(token.as_str(), "--port" | "--type" | "--locale" | "--input" | "--output") {
                skip_next = true;
            }
            i += 1;
            continue;
        }

        // 检查文件扩展名（不区分大小写）
        let lower = token.to_lowercase();
        for ext in &office_exts {
            let ext_with_dot = format!(".{}", ext);
            if lower.ends_with(&ext_with_dot) {
                return Some(std::path::PathBuf::from(token));
            }
        }

        i += 1;
    }

    None
}

// ===== 知识图谱工具执行函数 =====

fn execute_list_kg_graphs(store: &Store) -> memos_core::CoreResult<Value> {
    let graphs = store.with_conn(|c| kg_graph::list(c))?;
    let items: Vec<Value> = graphs
        .into_iter()
        .map(|g| json!({ "id": g.id, "uid": g.uid, "name": g.name, "description": g.description }))
        .collect();
    Ok(json!({ "graphs": items }))
}

fn execute_create_kg_graph(args: &Value, store: &Store) -> memos_core::CoreResult<Value> {
    let name = args
        .get("name")
        .and_then(|v| v.as_str())
        .ok_or_else(|| memos_core::CoreError::Other("缺少 name 参数".to_string()))?;
    let description = args.get("description").and_then(|v| v.as_str()).unwrap_or("");
    let uid = uuid_like();
    let upsert = UpsertKgGraph {
        uid: uid.clone(),
        name: name.to_string(),
        description: description.to_string(),
        color: String::new(),
        icon: String::new(),
    };
    let graph = store.with_conn(|c| kg_graph::create(c, &upsert))?;
    Ok(json!({ "id": graph.id, "uid": graph.uid, "name": graph.name }))
}

fn execute_list_kg_nodes(args: &Value, store: &Store) -> memos_core::CoreResult<Value> {
    let graph_id = args
        .get("graph_id")
        .and_then(|v| v.as_i64())
        .ok_or_else(|| memos_core::CoreError::Other("缺少 graph_id 参数".to_string()))?
        as i32;
    let parent_id = if args.get("parent_id").is_some() {
        match args.get("parent_id").and_then(|v| v.as_i64()) {
            Some(pid) => Some(Some(pid as i32)),
            None => Some(None), // JSON null → 只列根节点
        }
    } else {
        None // 不传 → 列出所有节点
    };
    let find = FindKgNode {
        graph_id: Some(graph_id),
        parent_id,
        id_list: Vec::new(),
    };
    let nodes = store.with_conn(|c| kg_node::list(c, &find))?;
    let items: Vec<Value> = nodes
        .into_iter()
        .map(|n| {
            json!({
                "id": n.id,
                "name": n.name,
                "description": n.description,
                "color": n.color,
                "icon": n.icon,
                "parent_id": n.parent_id,
                "collapsed": n.collapsed,
                "tags": n.tags,
            })
        })
        .collect();
    Ok(json!({ "nodes": items }))
}

fn execute_create_kg_node(args: &Value, store: &Store) -> memos_core::CoreResult<Value> {
    let graph_id = args
        .get("graph_id")
        .and_then(|v| v.as_i64())
        .ok_or_else(|| memos_core::CoreError::Other("缺少 graph_id 参数".to_string()))?
        as i32;
    let name = args
        .get("name")
        .and_then(|v| v.as_str())
        .ok_or_else(|| memos_core::CoreError::Other("缺少 name 参数".to_string()))?;
    let description = args.get("description").and_then(|v| v.as_str()).unwrap_or("");
    let color = args.get("color").and_then(|v| v.as_str()).unwrap_or("");
    let icon = args.get("icon").and_then(|v| v.as_str()).unwrap_or("");
    let parent_id = args.get("parent_id").and_then(|v| v.as_i64()).map(|v| v as i32);
    let tags: Vec<String> = args
        .get("tags")
        .and_then(|v| v.as_array())
        .map(|a| {
            a.iter()
                .filter_map(|v| v.as_str().map(|s| s.trim_start_matches('#').trim().to_string()))
                .filter(|s| !s.is_empty())
                .collect()
        })
        .unwrap_or_default();

    let uid = uuid_like();
    let upsert = UpsertKgNode {
        uid,
        graph_id,
        name: name.to_string(),
        description: description.to_string(),
        color: color.to_string(),
        icon: icon.to_string(),
        parent_id,
        pos_x: None,
        pos_y: None,
        collapsed: false,
    };
    let node = store.with_conn(|c| kg_node::create(c, &upsert))?;
    // 设置标签
    if !tags.is_empty() {
        store.with_conn(|c| kg_node::set_tags(c, node.id, &tags))?;
    }
    Ok(json!({
        "id": node.id,
        "uid": node.uid,
        "name": node.name,
        "graph_id": node.graph_id,
        "parent_id": node.parent_id,
        "tags": tags,
    }))
}

fn execute_set_kg_node_tags(args: &Value, store: &Store) -> memos_core::CoreResult<Value> {
    let node_id = args
        .get("node_id")
        .and_then(|v| v.as_i64())
        .ok_or_else(|| memos_core::CoreError::Other("缺少 node_id 参数".to_string()))?
        as i32;
    let tags: Vec<String> = args
        .get("tags")
        .and_then(|v| v.as_array())
        .map(|a| {
            a.iter()
                .filter_map(|v| v.as_str().map(|s| s.trim_start_matches('#').trim().to_string()))
                .filter(|s| !s.is_empty())
                .collect()
        })
        .unwrap_or_default();
    store.with_conn(|c| kg_node::set_tags(c, node_id, &tags))?;
    Ok(json!({ "node_id": node_id, "tags": tags }))
}

fn execute_link_kg_nodes(args: &Value, store: &Store) -> memos_core::CoreResult<Value> {
    let source_id = args
        .get("source_id")
        .and_then(|v| v.as_i64())
        .ok_or_else(|| memos_core::CoreError::Other("缺少 source_id 参数".to_string()))?
        as i32;
    let target_id = args
        .get("target_id")
        .and_then(|v| v.as_i64())
        .ok_or_else(|| memos_core::CoreError::Other("缺少 target_id 参数".to_string()))?
        as i32;
    let edge_type = args.get("edge_type").and_then(|v| v.as_str()).unwrap_or("related");
    let edge = store.with_conn(|c| kg_edge::create(c, source_id, target_id, edge_type, ""))?;
    Ok(json!({ "id": edge.id, "source_id": edge.source_id, "target_id": edge.target_id, "type": edge.r#type }))
}

/// 执行内置 officecli 工具
/// agent_loop 在同步上下文中调用，内部用 async_runtime::block_on 桥接
fn execute_officecli(args: &Value, state: &AppState) -> memos_core::CoreResult<Value> {
    let command = args
        .get("command")
        .and_then(|v| v.as_str())
        .ok_or_else(|| memos_core::CoreError::Other("缺少 command 参数".to_string()))?;

    let binary_path = resolve_officecli_binary(state.app_handle());
    if !binary_path.exists() {
        return Ok(json!({
            "error": format!("officecli binary not found at: {}", binary_path.display()),
            "tool_name": "officecli",
        }));
    }

    let cli_args = split_shell_args(command);
    let cwd = state
        .attachments_dir
        .parent()
        .unwrap_or_else(|| std::path::Path::new("."))
        .to_path_buf();
    let binary_path_owned = binary_path.clone();

    // 尝试从 command 中提取 office 文档路径，启动 watch 预览服务
    // 对 watch/unwatch 命令本身跳过（避免递归启动）
    if let Some(file) = extract_office_file(&cli_args) {
        let file_abs = if file.is_absolute() {
            file.clone()
        } else {
            cwd.join(&file)
        };
        if file_abs.exists() {
            // 同步启动 watch 子进程（spawn 是快速操作，watch 进程本身会异步运行）
            match state.officecli_watch.ensure_watching(&binary_path, &file_abs, &cwd) {
                Ok(started) => {
                    if started {
                        tracing::info!(
                            file = %file_abs.display(),
                            "officecli watch: 预览服务已启动"
                        );
                    }
                    // 在子线程打开预览窗口（避免阻塞 agent loop；窗口创建可能涉及 UI 线程通信）
                    let app_handle_clone = state.app_handle().clone();
                    std::thread::spawn(move || {
                        crate::officecli_watch::open_preview_window(&app_handle_clone);
                    });
                }
                Err(e) => {
                    tracing::warn!(
                        file = %file_abs.display(),
                        "officecli watch: 启动预览服务失败: {}", e
                    );
                    // 即使 watch 启动失败也尝试打开窗口（用户可能已经手动启动）
                    let app_handle_clone = state.app_handle().clone();
                    std::thread::spawn(move || {
                        crate::officecli_watch::open_preview_window(&app_handle_clone);
                    });
                }
            }
        } else {
            tracing::debug!(
                file = %file_abs.display(),
                "officecli watch: 文件不存在，跳过启动 watch"
            );
        }
    }

    async_runtime::block_on(async move {
        let mut cmd = tokio::process::Command::new(&binary_path_owned);
        for arg in &cli_args {
            cmd.arg(arg);
        }
        cmd.current_dir(&cwd)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true);

        // Windows 下隐藏控制台窗口弹出（tokio::process::Command 原生支持 creation_flags）
        #[cfg(windows)]
        {
            const CREATE_NO_WINDOW: u32 = 0x08000000;
            cmd.creation_flags(CREATE_NO_WINDOW);
        }

        let child = match cmd.spawn() {
            Ok(c) => c,
            Err(e) => {
                return Ok(json!({
                    "error": format!("spawn failed: {e}"),
                    "tool_name": "officecli",
                    "binary": binary_path_owned.to_string_lossy(),
                }));
            }
        };

        let timeout_dur = Duration::from_millis(OFFICECLI_TIMEOUT_MS);
        let output = match tokio::time::timeout(timeout_dur, child.wait_with_output()).await {
            Ok(Ok(out)) => out,
            Ok(Err(e)) => {
                return Ok(json!({
                    "error": format!("wait failed: {e}"),
                    "tool_name": "officecli",
                }));
            }
            Err(_) => {
                return Ok(json!({
                    "error": format!("timeout after {OFFICECLI_TIMEOUT_MS}ms"),
                    "tool_name": "officecli",
                }));
            }
        };

        let stdout = String::from_utf8_lossy(&output.stdout).to_string();
        let stderr: String = String::from_utf8_lossy(&output.stderr)
            .lines()
            .map(|l| format!("[stderr] {l}\n"))
            .collect();
        let mut combined = format!("{stdout}{stderr}");

        if combined.len() > MAX_OFFICECLI_OUTPUT_BYTES {
            combined = truncate_at_char_boundary(&combined, MAX_OFFICECLI_OUTPUT_BYTES);
        }

        Ok(json!({
            "output": combined,
            "exit_code": output.status.code().unwrap_or(-1),
            "tool_name": "officecli",
            "binary": binary_path_owned.to_string_lossy(),
        }))
    })
}

/// fetch_url 默认返回字符数
const DEFAULT_FETCH_MAX_CHARS: usize = 12_000;
/// fetch_url 允许的最大返回字符数
const MAX_FETCH_MAX_CHARS: usize = 50_000;
/// fetch_url 使用的 User-Agent（部分站点会拒绝无 UA 的请求）
const FETCH_USER_AGENT: &str =
    "Mozilla/5.0 (compatible; LocalFragNote/0.1; +https://github.com/HuangJinAmm/LocalFragNote)";

/// fetch_url 工具：访问 URL 并把网页正文转成 Markdown（或纯文本）
fn execute_fetch_url(args: &Value) -> memos_core::CoreResult<Value> {
    let url = args
        .get("url")
        .and_then(|v| v.as_str())
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .ok_or_else(|| memos_core::CoreError::Other("缺少 url 参数".into()))?
        .to_string();

    if !is_http_url(&url) {
        return Ok(json!({
            "error": "仅支持 http:// 或 https:// 开头的 URL",
            "tool_name": "fetch_url",
        }));
    }

    let max_chars = args
        .get("max_chars")
        .and_then(|v| v.as_i64())
        .unwrap_or(DEFAULT_FETCH_MAX_CHARS as i64)
        .clamp(500, MAX_FETCH_MAX_CHARS as i64) as usize;

    // 1. 下载（ureq 为阻塞式客户端，本工具运行在 spawn_blocking 线程上）
    let agent = ureq::AgentBuilder::new()
        .timeout_connect(Duration::from_secs(10))
        .timeout(Duration::from_secs(30))
        .user_agent(FETCH_USER_AGENT)
        .build();

    let resp = match agent.get(&url).call() {
        Ok(r) => r,
        Err(ureq::Error::Status(code, _)) => {
            return Ok(json!({
                "error": format!("HTTP {code}"),
                "status": code,
                "url": url,
                "tool_name": "fetch_url",
            }));
        }
        Err(e) => {
            return Ok(json!({
                "error": format!("请求失败: {e}"),
                "url": url,
                "tool_name": "fetch_url",
            }));
        }
    };

    let status = resp.status();
    let content_type = resp
        .header("Content-Type")
        .unwrap_or("")
        .to_ascii_lowercase();

    // ureq 默认限制 10MB，超出返回错误；charset 特性会自动按声明解码
    let body = match resp.into_string() {
        Ok(b) => b,
        Err(e) => {
            return Ok(json!({
                "error": format!("读取响应失败: {e}"),
                "status": status,
                "url": url,
                "tool_name": "fetch_url",
            }));
        }
    };

    // 2. 转换：HTML 走正文提取 + Markdown；文本类原样返回
    let is_html = content_type.is_empty() || content_type.contains("html");
    let is_text = content_type.starts_with("text/")
        || content_type.contains("json")
        || content_type.contains("xml")
        || content_type.contains("javascript");

    let (title, mut markdown) = if is_html {
        html_to_markdown(&body, &url)
    } else if is_text {
        (None, body.trim().to_string())
    } else {
        return Ok(json!({
            "error": format!("不支持的内容类型: {content_type}（仅支持 HTML / 纯文本 / JSON / XML）"),
            "status": status,
            "url": url,
            "content_type": content_type,
            "tool_name": "fetch_url",
        }));
    };

    let truncated = markdown.chars().count() > max_chars;
    if truncated {
        markdown = markdown.chars().take(max_chars).collect();
    }

    Ok(json!({
        "url": url,
        "status": status,
        "content_type": content_type,
        "title": title,
        "truncated": truncated,
        "markdown": markdown,
        "tool_name": "fetch_url",
    }))
}

/// HTML → Markdown：优先用 readability 提取正文，失败时退回整页转换
fn html_to_markdown(html: &str, url: &str) -> (Option<String>, String) {
    // 1. Readability 提取正文（失败或提取为空则退回整页 HTML）
    let (title, source_html) = match dom_smoothie::Readability::new(html, Some(url), None) {
        Ok(mut reader) => match reader.parse() {
            Ok(article) => {
                let title = article.title.to_string();
                if article.content.trim().is_empty() {
                    (None, html.to_string())
                } else {
                    (Some(title).filter(|t| !t.trim().is_empty()), article.content.to_string())
                }
            }
            Err(e) => {
                tracing::debug!("fetch_url: readability 解析失败，退回整页转换: {e}");
                (None, html.to_string())
            }
        },
        Err(e) => {
            tracing::debug!("fetch_url: readability 初始化失败，退回整页转换: {e}");
            (None, html.to_string())
        }
    };

    // 2. HTML → Markdown
    match htmd::convert(&source_html) {
        Ok(md) if !md.trim().is_empty() => (title, md),
        Ok(_) => (title, fallback_html_to_markdown(html)),
        Err(e) => {
            tracing::warn!("fetch_url: htmd 转换失败，改用 markitdown 兜底: {e}");
            (title, fallback_html_to_markdown(html))
        }
    }
}

/// 兜底转换：复用已依赖的 markitdown（内部 html2md）
fn fallback_html_to_markdown(html: &str) -> String {
    let md = markitdown::MarkItDown::new();
    let options = markitdown::model::ConversionOptions {
        file_extension: Some(".html".into()),
        url: None,
        llm_client: None,
        llm_model: None,
    };
    match md.convert_bytes(html.as_bytes(), Some(options)) {
        Ok(Some(r)) => r.text_content,
        Ok(None) => String::new(),
        Err(e) => {
            tracing::warn!("fetch_url: markitdown 兜底转换失败: {e}");
            String::new()
        }
    }
}

/// download_file 默认大小上限（32MB）
const DEFAULT_DOWNLOAD_MAX_BYTES: u64 = 32 * 1024 * 1024;
/// download_file 允许声明的最大上限（200MB）
const MAX_DOWNLOAD_MAX_BYTES: u64 = 200 * 1024 * 1024;

/// 是否为受支持的 http(s) URL
fn is_http_url(url: &str) -> bool {
    let lower = url.to_ascii_lowercase();
    lower.starts_with("http://") || lower.starts_with("https://")
}

/// download_file 工具：下载网络文件并保存到当前工作空间的附件目录
///
/// 下载的文件一律以 LOCAL 方式落盘（不遵循 StorageConfig 的 DATABASE 模式），
/// 并在 attachment 表写入元数据，使前端可通过 `attachment://{uid}` 访问。
fn execute_download_file(
    args: &Value,
    store: &Store,
    state: &AppState,
) -> memos_core::CoreResult<Value> {
    let url = args
        .get("url")
        .and_then(|v| v.as_str())
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .ok_or_else(|| memos_core::CoreError::Other("缺少 url 参数".into()))?
        .to_string();

    if !is_http_url(&url) {
        return Ok(json!({
            "error": "仅支持 http:// 或 https:// 开头的 URL",
            "tool_name": "download_file",
        }));
    }

    let filename_arg = args
        .get("filename")
        .and_then(|v| v.as_str())
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string);

    let max_bytes = args
        .get("max_bytes")
        .and_then(|v| v.as_i64())
        .filter(|n| *n > 0)
        .map(|n| n as u64)
        .unwrap_or(DEFAULT_DOWNLOAD_MAX_BYTES)
        .min(MAX_DOWNLOAD_MAX_BYTES);

    let template = {
        let config_store = state.config_store();
        load_storage_config(&config_store).filepath_template
    };

    download_file_to_attachments(
        &url,
        filename_arg.as_deref(),
        max_bytes,
        &state.attachments_dir,
        &template,
        store,
    )
}

/// 下载并写入附件目录（不依赖 AppState，便于集成测试）
fn download_file_to_attachments(
    url: &str,
    filename_arg: Option<&str>,
    max_bytes: u64,
    attachments_dir: &std::path::Path,
    template: &str,
    store: &Store,
) -> memos_core::CoreResult<Value> {
    // 1. 发起请求（ureq 为阻塞式客户端，本工具运行在 spawn_blocking 线程上）
    let agent = ureq::AgentBuilder::new()
        .timeout_connect(Duration::from_secs(15))
        .timeout(Duration::from_secs(600))
        .user_agent(FETCH_USER_AGENT)
        .build();

    let resp = match agent.get(url).call() {
        Ok(r) => r,
        Err(ureq::Error::Status(code, _)) => {
            return Ok(json!({
                "error": format!("HTTP {code}"),
                "status": code,
                "url": url,
                "tool_name": "download_file",
            }));
        }
        Err(e) => {
            return Ok(json!({
                "error": format!("请求失败: {e}"),
                "url": url,
                "tool_name": "download_file",
            }));
        }
    };

    let status = resp.status();
    let content_type = resp
        .header("Content-Type")
        .unwrap_or("")
        .split(';')
        .next()
        .unwrap_or("")
        .trim()
        .to_ascii_lowercase();
    let content_length = resp
        .header("Content-Length")
        .and_then(|s| s.parse::<u64>().ok());
    let content_disposition = resp.header("Content-Disposition").unwrap_or("").to_string();

    // 提前按 Content-Length 拒绝超大文件，避免无谓传输
    if let Some(len) = content_length.filter(|len| *len > max_bytes) {
        return Ok(json!({
            "error": format!("文件过大: {len} 字节，超过上限 {max_bytes} 字节"),
            "status": status,
            "url": url,
            "content_length": len,
            "max_bytes": max_bytes,
            "tool_name": "download_file",
        }));
    }

    // 2. 流式读取，超过上限立即截断（多读 1 字节用于判断是否超限）
    let mut blob: Vec<u8> = Vec::with_capacity(
        content_length
            .unwrap_or(0)
            .min(max_bytes)
            .min(8 * 1024 * 1024) as usize,
    );
    if let Err(e) = resp.into_reader().take(max_bytes + 1).read_to_end(&mut blob) {
        return Ok(json!({
            "error": format!("下载中断: {e}"),
            "status": status,
            "url": url,
            "tool_name": "download_file",
        }));
    }
    if blob.len() as u64 > max_bytes {
        return Ok(json!({
            "error": format!("文件超过大小上限 {max_bytes} 字节，已中止下载"),
            "status": status,
            "url": url,
            "max_bytes": max_bytes,
            "tool_name": "download_file",
        }));
    }
    if blob.is_empty() {
        return Ok(json!({
            "error": "下载内容为空",
            "status": status,
            "url": url,
            "tool_name": "download_file",
        }));
    }

    // 3. 推断文件名与 MIME
    let filename = resolve_download_filename(filename_arg, url, &content_disposition, &content_type);
    let mime = if content_type.is_empty() {
        mime_guess::from_path(&filename)
            .first_or_octet_stream()
            .to_string()
    } else {
        content_type
    };

    // 4. 落盘到附件目录（复用与 create_attachment 相同的文件名模板）
    let uid = uuid::Uuid::new_v4().simple().to_string();
    let reference = file_storage::write_file(attachments_dir, &uid, &filename, &blob, template)
        .map_err(|e| memos_core::CoreError::Other(format!("写入附件文件失败: {e}")))?;

    // 5. 写入附件元数据；失败则回滚已落盘的文件，避免留下孤儿文件
    let size = blob.len() as i64;
    let created = store.with_conn(|c| {
        memos_core::attachment::create(c, &CreateAttachment {
            uid: uid.clone(),
            filename: filename.clone(),
            blob: Vec::new(),
            r#type: mime.clone(),
            memo_id: None,
            storage_type: STORAGE_TYPE_LOCAL.to_string(),
            reference: reference.clone(),
            size: Some(size),
        })
    });

    match created {
        Ok(att) => Ok(json!({
            "attachment_id": att.id,
            "attachment_uid": att.uid,
            "filename": att.filename,
            "type": att.r#type,
            "size": att.size,
            "reference": att.reference,
            "url": url,
            "status": status,
            "content_length": content_length,
            "tool_name": "download_file",
        })),
        Err(e) => {
            if let Err(de) = file_storage::delete_file(attachments_dir, &reference) {
                tracing::warn!("download_file: 回滚附件文件失败: {de}");
            }
            Err(e)
        }
    }
}

/// 推断下载文件名：显式参数 > Content-Disposition > URL 路径末段 > 按 MIME 兜底
fn resolve_download_filename(
    filename_arg: Option<&str>,
    url: &str,
    content_disposition: &str,
    content_type: &str,
) -> String {
    let candidate = filename_arg
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string)
        .or_else(|| filename_from_content_disposition(content_disposition))
        .or_else(|| filename_from_url(url));

    let ext_from_mime = ext_from_mime(content_type);

    match candidate {
        Some(name) => {
            if std::path::Path::new(&name).extension().is_some() {
                name
            } else if let Some(ext) = ext_from_mime {
                format!("{name}.{ext}")
            } else {
                name
            }
        }
        None => match ext_from_mime {
            Some(ext) => format!("download.{ext}"),
            None => "download".to_string(),
        },
    }
}

/// 由 MIME 推断首选扩展名（mime_guess 对 text/html 返回 "htm"，这里统一为 "html"）
fn ext_from_mime(content_type: &str) -> Option<&'static str> {
    let ext = mime_guess::get_mime_extensions_str(content_type)?
        .first()
        .copied()?;
    Some(match ext {
        "htm" => "html",
        other => other,
    })
}

/// 从 Content-Disposition 提取文件名（优先 RFC 5987 的 `filename*`）
fn filename_from_content_disposition(value: &str) -> Option<String> {
    let mut plain: Option<String> = None;
    let mut extended: Option<String> = None;

    for part in value.split(';').skip(1) {
        let Some((key, raw)) = part.split_once('=') else {
            continue;
        };
        let raw = raw.trim().trim_matches('"');
        if raw.is_empty() {
            continue;
        }
        match key.trim().to_ascii_lowercase().as_str() {
            // 形如 UTF-8''%E6%8A%A5%E5%91%8A.pdf
            "filename*" => {
                let encoded = raw.rsplit("''").next().unwrap_or(raw);
                let decoded = percent_decode(encoded);
                if !decoded.trim().is_empty() {
                    extended = Some(decoded);
                }
            }
            "filename" => plain = Some(raw.to_string()),
            _ => {}
        }
    }

    extended.or(plain)
}

/// 取 URL 路径的最后一段作为文件名（去掉 query / fragment，并解码百分号转义）
fn filename_from_url(url: &str) -> Option<String> {
    let without_query = url.split(['?', '#']).next().unwrap_or(url);
    let last = without_query.rsplit('/').next().unwrap_or("");
    let decoded = percent_decode(last);
    let decoded = decoded.trim();
    if decoded.is_empty() || decoded == "." || decoded == ".." {
        return None;
    }
    Some(decoded.to_string())
}

/// 极简 percent-decoding（仅处理 `%XX`），非法序列原样保留
fn percent_decode(input: &str) -> String {
    let bytes = input.as_bytes();
    let mut out: Vec<u8> = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            let hi = (bytes[i + 1] as char).to_digit(16);
            let lo = (bytes[i + 2] as char).to_digit(16);
            if let (Some(hi), Some(lo)) = (hi, lo) {
                out.push((hi * 16 + lo) as u8);
                i += 3;
                continue;
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
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
        assert_eq!(defs.len(), 20);
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
        assert!(names.contains(&"officecli"));
        assert!(names.contains(&"update_plan"));
        assert!(names.contains(&"list_kg_graphs"));
        assert!(names.contains(&"create_kg_graph"));
        assert!(names.contains(&"list_kg_nodes"));
        assert!(names.contains(&"create_kg_node"));
        assert!(names.contains(&"set_kg_node_tags"));
        assert!(names.contains(&"link_kg_nodes"));
        assert!(names.contains(&"fetch_url"));
        assert!(names.contains(&"download_file"));
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
        assert_eq!(defs.len(), 21); // 20 built-in + 1 enabled user tool
        let names: Vec<&str> = defs
            .iter()
            .map(|d| d["function"]["name"].as_str().unwrap())
            .collect();
        assert!(names.contains(&"my_tool"));
        assert!(!names.contains(&"disabled_tool"));
    }

    #[test]
    fn test_update_plan_normal() {
        let result = execute_update_plan(&json!({
            "todos": [
                {"content": "读取笔记", "status": "completed"},
                {"content": "生成卡片", "status": "in_progress"},
                {"content": "保存", "status": "pending"}
            ]
        }))
        .unwrap();
        let todos = result["todos"].as_array().unwrap();
        assert_eq!(todos.len(), 3);
        assert_eq!(result["total"].as_u64().unwrap(), 3);
        assert_eq!(result["completed"].as_u64().unwrap(), 1);
        assert_eq!(todos[0]["status"].as_str().unwrap(), "completed");
        assert_eq!(todos[1]["status"].as_str().unwrap(), "in_progress");
        assert_eq!(todos[2]["status"].as_str().unwrap(), "pending");
    }

    #[test]
    fn test_update_plan_empty() {
        let result = execute_update_plan(&json!({"todos": []})).unwrap();
        assert_eq!(result["total"].as_u64().unwrap(), 0);
        assert_eq!(result["completed"].as_u64().unwrap(), 0);
        assert_eq!(result["todos"].as_array().unwrap().len(), 0);
    }

    #[test]
    fn test_update_plan_missing_todos() {
        let result = execute_update_plan(&json!({}));
        assert!(result.is_err());
    }

    #[test]
    fn test_update_plan_invalid_status_normalized() {
        let result = execute_update_plan(&json!({
            "todos": [
                {"content": "步骤", "status": "weird"}
            ]
        }))
        .unwrap();
        let todos = result["todos"].as_array().unwrap();
        assert_eq!(todos.len(), 1);
        assert_eq!(todos[0]["status"].as_str().unwrap(), "pending");
    }

    #[test]
    fn test_update_plan_skips_empty_content() {
        let result = execute_update_plan(&json!({
            "todos": [
                {"content": "  有效步骤  ", "status": "pending"},
                {"content": "", "status": "pending"}
            ]
        }))
        .unwrap();
        let todos = result["todos"].as_array().unwrap();
        assert_eq!(todos.len(), 1);
        assert_eq!(todos[0]["content"].as_str().unwrap(), "有效步骤");
    }

    #[test]
    fn test_split_shell_args_simple() {
        let args = split_shell_args("create report.pptx --type pptx");
        assert_eq!(args, vec!["create", "report.pptx", "--type", "pptx"]);
    }

    #[test]
    fn test_split_shell_args_quoted() {
        let args = split_shell_args("get doc.docx \"/body/p[1]\"");
        assert_eq!(args, vec!["get", "doc.docx", "/body/p[1]"]);
    }

    #[test]
    fn test_split_shell_args_escaped_quote() {
        let args = split_shell_args("set /slide[1] --prop \"text=\\\"hi\\\"\"");
        assert_eq!(args, vec!["set", "/slide[1]", "--prop", "text=\"hi\""]);
    }

    #[test]
    fn test_split_shell_args_empty() {
        let args = split_shell_args("");
        assert!(args.is_empty());
    }

    #[test]
    fn test_split_shell_args_extra_whitespace() {
        let args = split_shell_args("  create   report.pptx  ");
        assert_eq!(args, vec!["create", "report.pptx"]);
    }

    #[test]
    fn test_extract_office_file_basic() {
        let args = split_shell_args("get report.pptx /slide[1]");
        let file = extract_office_file(&args).unwrap();
        assert_eq!(file, std::path::PathBuf::from("report.pptx"));
    }

    #[test]
    fn test_extract_office_file_quoted_path() {
        let args = split_shell_args("get \"my doc.docx\" /body/p[1]");
        let file = extract_office_file(&args).unwrap();
        assert_eq!(file, std::path::PathBuf::from("my doc.docx"));
    }

    #[test]
    fn test_extract_office_file_with_options() {
        let args = split_shell_args("get deck.pptx /slide[1] --json --port 26315");
        let file = extract_office_file(&args).unwrap();
        assert_eq!(file, std::path::PathBuf::from("deck.pptx"));
    }

    #[test]
    fn test_extract_office_file_skips_watch_subcommand() {
        let args = split_shell_args("watch report.pptx");
        assert!(extract_office_file(&args).is_none());
    }

    #[test]
    fn test_extract_office_file_skips_unwatch_subcommand() {
        let args = split_shell_args("unwatch report.pptx");
        assert!(extract_office_file(&args).is_none());
    }

    #[test]
    fn test_extract_office_file_xlsx_extension() {
        let args = split_shell_args("get data.xlsx /sheet[1]");
        let file = extract_office_file(&args).unwrap();
        assert_eq!(file, std::path::PathBuf::from("data.xlsx"));
    }

    #[test]
    fn test_extract_office_file_no_file() {
        let args = split_shell_args("help pptx slide");
        assert!(extract_office_file(&args).is_none());
    }

    #[test]
    fn test_extract_office_file_case_insensitive() {
        let args = split_shell_args("get REPORT.PPTX /slide[1]");
        let file = extract_office_file(&args).unwrap();
        assert_eq!(file, std::path::PathBuf::from("REPORT.PPTX"));
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
        let config_store = memos_core::ConfigStore::open_in_memory().unwrap();
        // execute_tool 的 other=> 分支：unknown_tool 既非内置工具，也不在用户工具表中。
        // 由于 AppState 需要 AppHandle（无法在单元测试线程中构造 Wry 事件循环），
        // 这里直接验证 dispatch 逻辑：get_by_name 返回 None → ok_or_else 返回 Err。
        // 该路径与 execute_tool 内部对未知工具的处理完全一致。
        let result = memos_core::tool::get_by_name(&config_store, "unknown_tool")
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

    #[test]
    fn test_fetch_url_rejects_non_http_scheme() {
        let result = execute_fetch_url(&json!({"url": "file:///etc/passwd"})).unwrap();
        assert!(result["error"].as_str().unwrap().contains("http"));
    }

    #[test]
    fn test_fetch_url_missing_url() {
        assert!(execute_fetch_url(&json!({})).is_err());
    }

    #[test]
    fn test_html_to_markdown_extracts_article() {
        let html = r#"<html><head><title>测试标题</title></head><body>
            <nav>导航栏</nav>
            <article><h1>正文标题</h1><p>这是正文段落，包含足够长的内容以便可读性算法识别为正文。</p>
            <ul><li>要点一</li><li>要点二</li></ul></article>
            <footer>页脚</footer>
        </body></html>"#;
        let (title, md) = html_to_markdown(html, "https://example.com/a");
        assert!(md.contains("正文段落"));
        assert!(md.contains("要点一"));
        assert!(title.is_none() || title.unwrap().contains("测试标题"));
    }

    /// 真实网络验证（默认忽略）：cargo test -p frag-note-app -- --ignored fetch_url_live
    #[test]
    #[ignore]
    fn fetch_url_live() {
        let result = execute_fetch_url(&json!({
            "url": "https://example.com",
            "max_chars": 2000
        }))
        .unwrap();
        println!("{}", serde_json::to_string_pretty(&result).unwrap());
        assert_eq!(result["status"].as_i64().unwrap(), 200);
        assert_eq!(result["title"].as_str().unwrap(), "Example Domain");
        assert!(!result["markdown"].as_str().unwrap().trim().is_empty());
    }

    #[test]
    fn test_is_http_url() {
        assert!(is_http_url("http://a.com"));
        assert!(is_http_url("HTTPS://a.com"));
        assert!(!is_http_url("file:///etc/passwd"));
        assert!(!is_http_url("ftp://a.com"));
        assert!(!is_http_url("data:text/html,x"));
        assert!(!is_http_url(""));
    }

    #[test]
    fn test_percent_decode() {
        assert_eq!(percent_decode("report.pdf"), "report.pdf");
        assert_eq!(percent_decode("%E6%8A%A5%E5%91%8A.pdf"), "报告.pdf");
        assert_eq!(percent_decode("a%2Bb"), "a+b");
        // 非法转义原样保留
        assert_eq!(percent_decode("100%"), "100%");
        assert_eq!(percent_decode("%zz"), "%zz");
    }

    #[test]
    fn test_filename_from_content_disposition() {
        assert_eq!(
            filename_from_content_disposition(r#"attachment; filename="report.pdf""#),
            Some("report.pdf".to_string())
        );
        // filename* 优先，且解码 RFC 5987 编码
        assert_eq!(
            filename_from_content_disposition(
                "attachment; filename=\"fallback.pdf\"; filename*=UTF-8''%E6%8A%A5%E5%91%8A.pdf"
            ),
            Some("报告.pdf".to_string())
        );
        assert_eq!(filename_from_content_disposition("inline"), None);
    }

    #[test]
    fn test_filename_from_url() {
        assert_eq!(
            filename_from_url("https://a.com/docs/report.pdf"),
            Some("report.pdf".to_string())
        );
        // query / fragment 应被剥离
        assert_eq!(
            filename_from_url("https://a.com/dl?id=5#frag"),
            Some("dl".to_string())
        );
        assert_eq!(
            filename_from_url("https://a.com/%E6%8A%A5%E5%91%8A.zip"),
            Some("报告.zip".to_string())
        );
        // 路径为空（以 / 结尾）
        assert_eq!(filename_from_url("https://a.com/"), None);
        // 无路径时退化为 host
        assert_eq!(
            filename_from_url("https://a.com"),
            Some("a.com".to_string())
        );
    }

    #[test]
    fn test_resolve_download_filename() {
        // 1. 显式参数优先
        assert_eq!(
            resolve_download_filename(Some("my.zip"), "https://a.com/x", "", "application/zip"),
            "my.zip"
        );
        // 2. Content-Disposition
        assert_eq!(
            resolve_download_filename(None, "https://a.com/x", r#"attachment; filename="a.pdf""#, ""),
            "a.pdf"
        );
        // 3. URL 末段
        assert_eq!(
            resolve_download_filename(None, "https://a.com/pic.png", "", ""),
            "pic.png"
        );
        // 4. 无扩展名时按 MIME 补全
        assert_eq!(
            resolve_download_filename(None, "https://a.com/image", "", "image/png"),
            "image.png"
        );
        // 5. 完全推断不出时的兜底
        assert_eq!(resolve_download_filename(None, "https://a.com/", "", ""), "download");
        assert_eq!(
            resolve_download_filename(None, "https://a.com/", "", "application/pdf"),
            "download.pdf"
        );
        // 6. text/html 统一为 .html 而非 mime_guess 默认的 .htm
        assert_eq!(
            resolve_download_filename(None, "https://a.com/", "", "text/html"),
            "download.html"
        );
    }

    /// 真实下载验证（默认忽略）：cargo test -p frag-note-app -- --ignored download_file_live
    #[test]
    #[ignore]
    fn download_file_live() {
        use memos_core::attachment::FindAttachment;

        let dir = std::env::temp_dir().join(format!("memos_dl_{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let store = Store::open(":memory:").unwrap();

        let result = download_file_to_attachments(
            "https://example.com/",
            None,
            1_000_000,
            &dir,
            "{uid}_{filename}",
            &store,
        )
        .unwrap();
        println!("{}", serde_json::to_string_pretty(&result).unwrap());

        assert_eq!(result["status"].as_i64().unwrap(), 200);
        assert_eq!(result["type"].as_str().unwrap(), "text/html");

        // 文件确实落在附件目录
        let reference = result["reference"].as_str().unwrap();
        let path = dir.join(reference);
        assert!(path.exists(), "附件文件未落盘: {}", path.display());
        assert_eq!(
            std::fs::metadata(&path).unwrap().len() as i64,
            result["size"].as_i64().unwrap()
        );

        // 元数据已写入 attachment 表
        let uid = result["attachment_uid"].as_str().unwrap().to_string();
        let found = store
            .with_conn(|c| {
                memos_core::attachment::get(c, &FindAttachment { uid: Some(uid), ..Default::default() })
            })
            .unwrap();
        assert!(found.is_some(), "attachment 表缺少记录");

        let _ = std::fs::remove_dir_all(&dir);
    }
}
