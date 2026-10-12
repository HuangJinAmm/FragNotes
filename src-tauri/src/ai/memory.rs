//! AI 长期记忆的召回与自动抽取
//!
//! 三个入口：
//! - `build_memory_section`：按相关性挑选记忆并渲染成注入 system prompt 的段落；
//! - `extract_and_save`：对话结束后用 LLM 抽取值得长期记住的信息并落库（含冲突消解）；
//! - `sediment_summary`：上下文被压缩时，把即将丢弃的历史摘要沉淀为情节记忆。
//!
//! 召回为「关键词命中 + 语义相似度 + 重要度 + 时效 + 命中衰减」的加权打分：
//! 语义分依赖本地向量（`ai_memory_vec`）与已下载的嵌入模型，**任一前提不满足时自动
//! 回退到纯关键词打分**，绝不因为向量能力不可用而影响对话。

use crate::ai::llm_call;
use crate::ai::provider::ProviderConfig;
use crate::embedding;
use memos_core::memory::{self, AiMemory, MemoryKind, MemorySource};
use memos_core::{ConfigStore, Store};
use serde::Deserialize;
use serde_json::Value;
use std::collections::HashMap;
use std::time::{SystemTime, UNIX_EPOCH};

/// 注入段的固定前缀（无记忆时返回空串）
const SECTION_HEADER: &str = "\n\n## 用户记忆（跨会话）\n\
以下是你在以往对话中记录下的关于用户的事实与偏好，请自然地遵守，不要逐条复述，\n\
也不要主动向用户罗列这些记忆：\n";

/// 抽取时送入 LLM 的对话文本上限
const MAX_EXTRACT_INPUT_CHARS: usize = 12_000;
/// 抽取时最多回顾的消息条数
const MAX_EXTRACT_MESSAGES: usize = 8;
/// 抽取/冲突消解时送给 LLM 的已有记忆条数上限
const MAX_CONFLICT_CANDIDATES: usize = 40;
/// 单次次对话最多补齐多少条缺失向量（避免长时间占用对话线程）
const MAX_BACKFILL_PER_RUN: usize = 5;
/// 时效加分窗口（30 天）
const RECENCY_WINDOW_SECS: i64 = 30 * 24 * 3600;
/// 命中衰减：超过该天数未被命中开始降权
const DECAY_START_DAYS: i64 = 30;
/// 命中衰减：超过该天数未被命中加重降权
const DECAY_HARD_DAYS: i64 = 90;

fn now_ts() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

fn is_cjk(c: char) -> bool {
    matches!(
        c as u32,
        0x3040..=0x30FF      // 日文假名
        | 0x3400..=0x4DBF    // 扩展 A
        | 0x4E00..=0x9FFF    // 基本汉字
        | 0xAC00..=0xD7AF    // 谚文
    )
}

/// 把文本切成用于匹配的检索词。
///
/// - 拉丁/数字词：整词（长度 ≥ 2）
/// - CJK 串：切成 bigram（中文没有空格，整串匹配几乎不可能命中）
fn query_terms(text: &str) -> Vec<String> {
    let mut terms: Vec<String> = Vec::new();
    for run in text.split(|c: char| !c.is_alphanumeric()) {
        if run.is_empty() {
            continue;
        }
        let chars: Vec<char> = run.chars().collect();
        if chars.iter().any(|c| is_cjk(*c)) {
            if chars.len() == 1 {
                terms.push(run.to_lowercase());
            } else {
                for w in chars.windows(2) {
                    terms.push(w.iter().collect::<String>().to_lowercase());
                }
            }
        } else if chars.len() >= 2 {
            terms.push(run.to_lowercase());
        }
    }
    terms.sort();
    terms.dedup();
    terms.truncate(64);
    terms
}

/// 打分所需的上下文信号
struct Signals<'a> {
    /// 关键词命中用检索词
    terms: &'a [String],
    /// 语义相似度（memory id → 0..1），无向量能力时为空
    semantic: &'a HashMap<i64, f64>,
    now: i64,
}

/// 命中衰减：长期未被注入的记忆降权
fn decay_penalty(m: &AiMemory, now: i64) -> i64 {
    let reference = m.last_hit_ts.unwrap_or(m.updated_ts);
    let days = (now - reference) / 86_400;
    if days >= DECAY_HARD_DAYS {
        3
    } else if days >= DECAY_START_DAYS {
        1
    } else {
        0
    }
}

/// 记忆打分。
///
/// - 关键词命中为主导（+10 起），保证「当前话题相关」优先于「高分但无关」
/// - 语义相似度作为补充（0..10）
/// - 重要度（1..5）、近 30 天更新（+1）、命中频率（+1/+2）为排序细化
/// - 长期未命中按天衰减（-1/-3）
fn score(m: &AiMemory, sig: &Signals) -> i64 {
    let mut s = m.importance;

    if !sig.terms.is_empty() {
        let haystack = m.content.to_lowercase();
        let hits = sig.terms.iter().filter(|t| haystack.contains(t.as_str())).count();
        if hits > 0 {
            s += 10 + (hits as i64).min(3);
        }
    }

    if let Some(sim) = sig.semantic.get(&m.id) {
        s += (sim * 10.0).round().clamp(0.0, 10.0) as i64;
    }

    if sig.now - m.updated_ts < RECENCY_WINDOW_SECS {
        s += 1;
    }
    if m.hits >= 5 {
        s += 2;
    } else if m.hits > 0 {
        s += 1;
    }

    s - decay_penalty(m, sig.now)
}

/// 按打分降序排序记忆
fn rank<'a>(memories: &'a [AiMemory], sig: &Signals) -> Vec<(i64, &'a AiMemory)> {
    let mut scored: Vec<(i64, &AiMemory)> = memories.iter().map(|m| (score(m, sig), m)).collect();
    scored.sort_by(|a, b| {
        b.0.cmp(&a.0)
            .then_with(|| b.1.importance.cmp(&a.1.importance))
            .then_with(|| b.1.updated_ts.cmp(&a.1.updated_ts))
    });
    scored
}

fn kind_label(kind: MemoryKind) -> &'static str {
    match kind {
        MemoryKind::Fact => "事实",
        MemoryKind::Preference => "偏好",
        MemoryKind::Episode => "要点",
    }
}

/// 惰性补齐缺失的记忆向量。
///
/// 仅在嵌入模型文件已存在时执行 —— 绝不在对话过程中触发 90MB 模型下载；
/// 模型缺失时保持纯关键词召回，用户可在设置页手动重建向量。
fn backfill_embeddings(store: &Store) {
    if !embedding::is_model_available() {
        return;
    }
    let missing = match memory::list_without_embedding(store, MAX_BACKFILL_PER_RUN) {
        Ok(m) => m,
        Err(e) => {
            eprintln!("查询待补向量的记忆失败: {e}");
            return;
        }
    };
    for (id, content) in missing {
        match embedding::embed_to_json(&content) {
            Ok(json) => {
                if let Err(e) = memory::set_embedding(store, id, &json) {
                    eprintln!("记忆向量写入失败(id={id}): {e}");
                }
            }
            Err(e) => {
                // 模型不可用或推理失败：静默放弃，后续对话再重试
                eprintln!("记忆向量生成失败(id={id})，本次跳过: {e}");
                return;
            }
        }
    }
}

/// 语义相似度打分（memory id → 0..1）。
///
/// 任一步失败（无向量 / 模型不可用 / 推理失败 / KNN 失败）都返回空 map，
/// 调用方自动退回关键词打分。
fn semantic_scores(store: &Store, query: &str, top_k: usize) -> HashMap<i64, f64> {
    let mut out = HashMap::new();
    if query.trim().is_empty() {
        return out;
    }
    match memory::embedded_ids(store) {
        Ok(ids) if ids.is_empty() => return out,
        Ok(_) => {}
        Err(e) => {
            eprintln!("查询记忆向量索引失败: {e}");
            return out;
        }
    }
    if !embedding::is_model_available() {
        return out;
    }
    let query_json = match embedding::embed_to_json(query) {
        Ok(j) => j,
        Err(e) => {
            eprintln!("记忆召回生成查询向量失败，退回关键词召回: {e}");
            return out;
        }
    };
    // KNN 取略多于注入上限的候选，交给打分函数统一排序
    match memory::knn(store, &query_json, top_k.max(1) * 3) {
        Ok(hits) => {
            for (id, distance) in hits {
                // vec0 默认 L2 距离，向量已 L2 归一化 → cos = 1 - d²/2
                let sim = (1.0 - (distance * distance) / 2.0).clamp(0.0, 1.0);
                out.insert(id, sim);
            }
        }
        Err(e) => eprintln!("记忆向量召回失败，退回关键词召回: {e}"),
    }
    out
}

/// 构造注入 system prompt 的记忆段落。
///
/// 未启用、无记忆或读取失败时返回空串（调用方直接拼接即可）。
pub fn build_memory_section(store: &Store, config_store: &ConfigStore, query: &str) -> String {
    let config = memory::load_config(config_store);
    if !config.enabled {
        return String::new();
    }
    let memories = match memory::list_enabled(store) {
        Ok(m) => m,
        Err(e) => {
            eprintln!("加载 AI 记忆失败: {e}");
            return String::new();
        }
    };
    if memories.is_empty() {
        return String::new();
    }

    backfill_embeddings(store);

    let terms = query_terms(query);
    let now = now_ts();
    let semantic = semantic_scores(store, query, config.max_items);
    let sig = Signals {
        terms: &terms,
        semantic: &semantic,
        now,
    };

    let mut lines: Vec<String> = Vec::new();
    let mut injected_ids: Vec<i64> = Vec::new();
    let mut used_chars = 0usize;
    for (_, m) in rank(&memories, &sig).into_iter().take(config.max_items) {
        let line = format!("- [{}] {}", kind_label(m.kind), m.content);
        let cost = line.chars().count() + 1;
        if used_chars + cost > config.max_chars {
            break;
        }
        used_chars += cost;
        lines.push(line);
        injected_ids.push(m.id);
    }
    if lines.is_empty() {
        return String::new();
    }

    // 命中统计：驱动后续的命中加成与衰减排序
    if let Err(e) = memory::bump_hits(store, &injected_ids) {
        eprintln!("记忆命中统计失败: {e}");
    }

    format!("{SECTION_HEADER}{}", lines.join("\n"))
}

/// 自动抽取开关（总开关关闭时即使开了自动抽取也不生效）
pub fn auto_extract_enabled(config_store: &ConfigStore) -> bool {
    let config = memory::load_config(config_store);
    config.enabled && config.auto_extract
}

/// 把消息列表压成抽取用的对话文本；无可抽取内容时返回 None
fn conversation_text(msgs: &[Value]) -> Option<String> {
    let mut parts: Vec<String> = Vec::new();
    for m in msgs.iter().rev() {
        if parts.len() >= MAX_EXTRACT_MESSAGES {
            break;
        }
        let role = m.get("role").and_then(|r| r.as_str()).unwrap_or("");
        if role != "user" && role != "assistant" {
            continue;
        }
        let Some(text) = m.get("content").and_then(|c| c.as_str()) else {
            continue; // 图片等数组型 content 跳过
        };
        let text = text.trim();
        if text.is_empty() {
            continue;
        }
        let speaker = if role == "user" { "用户" } else { "助手" };
        parts.push(format!("{speaker}: {text}"));
    }
    if parts.is_empty() {
        return None;
    }
    parts.reverse();
    Some(truncate_chars(&parts.join("\n"), MAX_EXTRACT_INPUT_CHARS))
}

fn truncate_chars(text: &str, max: usize) -> String {
    if text.chars().count() <= max {
        return text.to_string();
    }
    text.chars().take(max).collect()
}

const EXTRACT_SYSTEM_PROMPT: &str = "你是记忆抽取器。从一段对话中抽取值得长期记住的、关于用户的信息，并与已有记忆做冲突消解。\n\
只输出一个 JSON 数组，不要输出任何解释文字或 Markdown 代码围栏。每项格式：\n\
{\"action\":\"add\",\"kind\":\"fact|preference|episode\",\"content\":\"一句简短的陈述\",\"importance\":3}\n\
{\"action\":\"update\",\"id\":已有记忆的id,\"kind\":\"fact|preference|episode\",\"content\":\"更新后的陈述\",\"importance\":3}\n\
规则：\n\
- fact：关于用户的稳定事实（职业、技术栈、所在地、长期项目）\n\
- preference：用户的偏好（回答风格、语言、格式、工具选择）\n\
- episode：值得后续对话引用的要点（正在推进的决策、约束、已确认的结论）\n\
- 若新信息与某条已有记忆说的是同一件事（补充、修正、更精确），用 action=update 并给出它的 id\n\
- 若是全新的信息，用 action=add，不要给出 id\n\
- content 用第三人称陈述句，不超过 60 字，必须脱离上下文也能看懂\n\
- importance 为 1-5 的整数，越重要越高\n\
- 不要记录一次性临时信息、寒暄、用户笔记的正文内容、以及助手自己的说法\n\
- 没有值得记录的内容时输出 []";

const SEDIMENT_SYSTEM_PROMPT: &str = "你是记忆抽取器。输入是某段较长对话被压缩后的摘要，\
请从中抽取值得长期记住的、关于用户的要点，并与已有记忆做冲突消解。\n\
只输出一个 JSON 数组，不要输出任何解释文字或 Markdown 代码围栏。每项格式：\n\
{\"action\":\"add\",\"kind\":\"episode\",\"content\":\"一句简短的陈述\",\"importance\":3}\n\
{\"action\":\"update\",\"id\":已有记忆的id,\"kind\":\"episode\",\"content\":\"更新后的陈述\",\"importance\":3}\n\
规则：\n\
- 默认 kind 用 episode；若摘要里明确体现用户偏好或稳定事实，可分别用 preference / fact\n\
- 只保留仍有后续价值的结论、决策、约束；一次性信息与寒暄一律丢弃\n\
- content 用第三人称陈述句，不超过 60 字，必须脱离上下文也能看懂\n\
- 若与某条已有记忆是同一件事，用 action=update 并给出它的 id\n\
- 没有值得记录的内容时输出 []";

#[derive(Debug, Deserialize)]
struct ExtractedMemory {
    #[serde(default)]
    action: String,
    #[serde(default)]
    kind: String,
    #[serde(default)]
    content: String,
    #[serde(default)]
    id: Option<i64>,
    #[serde(default = "default_importance")]
    importance: i64,
}

fn default_importance() -> i64 {
    3
}

/// 从 LLM 回复中解析记忆数组：容忍代码围栏与前后多余文本
fn parse_extracted(raw: &str) -> Vec<ExtractedMemory> {
    let cleaned = raw
        .trim()
        .trim_start_matches("```json")
        .trim_start_matches("```")
        .trim_end_matches("```")
        .trim();
    let (Some(start), Some(end)) = (cleaned.find('['), cleaned.rfind(']')) else {
        return Vec::new();
    };
    if end < start {
        return Vec::new();
    }
    serde_json::from_str::<Vec<ExtractedMemory>>(&cleaned[start..=end]).unwrap_or_default()
}

/// 去掉对话文本里的说话人前缀。
///
/// 「用户」「助手」这类词几乎会命中每一条记忆，会让关键词打分退化成按重要度排序，
/// 因此计算检索词前先剔除说话人标签。
fn strip_speaker_labels(text: &str) -> String {
    text.replace("用户: ", " ").replace("助手: ", " ")
}

/// 挑选与文本最相关的已有记忆，供 LLM 做冲突消解（id + 类型 + 内容）
fn conflict_candidates(store: &Store, text: &str) -> Vec<(i64, MemoryKind, String)> {
    let memories = match memory::list_enabled(store) {
        Ok(m) => m,
        Err(e) => {
            eprintln!("加载已有记忆失败: {e}");
            return Vec::new();
        }
    };
    if memories.is_empty() {
        return Vec::new();
    }
    let terms = query_terms(&strip_speaker_labels(text));
    let empty = HashMap::new();
    let sig = Signals {
        terms: &terms,
        semantic: &empty,
        now: now_ts(),
    };
    rank(&memories, &sig)
        .into_iter()
        .take(MAX_CONFLICT_CANDIDATES)
        .map(|(_, m)| (m.id, m.kind, m.content.clone()))
        .collect()
}

fn build_extract_user_prompt(text: &str, existing: &[(i64, MemoryKind, String)]) -> String {
    let mut prompt = String::new();
    if existing.is_empty() {
        prompt.push_str("已有记忆：（暂无）\n\n");
    } else {
        prompt.push_str("已有记忆（格式：id | 类型 | 内容）：\n");
        for (id, kind, content) in existing {
            prompt.push_str(&format!("{id} | {} | {}\n", kind.as_str(), content));
        }
        prompt.push('\n');
    }
    prompt.push_str("待处理的对话内容：\n\n");
    prompt.push_str(text);
    prompt
}

/// 应用抽取结果。
///
/// 只允许 `add`（新增）与 `update`（修正已有记忆）——**不允许 LLM 删除记忆**，
/// 删除只能由用户在设置页或通过 `forget` 工具显式执行。
///
/// `session_id` 写入新增记忆的 `source_session_id`，用于在设置页追溯记忆来源。
fn apply_extracted(store: &Store, items: &[ExtractedMemory], session_id: Option<i64>) -> usize {
    let mut saved = 0usize;
    for item in items {
        let content = item.content.trim();
        if content.is_empty() {
            continue;
        }
        let kind = MemoryKind::parse(&item.kind).unwrap_or(MemoryKind::Fact);

        if item.action == "update" {
            if let Some(id) = item.id {
                if let Ok(Some(existing)) = memory::get(store, id) {
                    // 重要度只升不降：避免 LLM 把用户手动调高的记忆降权
                    let importance = item.importance.clamp(1, 5).max(existing.importance);
                    match memory::update(store, id, kind, content, importance, existing.enabled) {
                        Ok(_) => {
                            saved += 1;
                            continue;
                        }
                        Err(e) => {
                            eprintln!("记忆修正失败(id={id})，改为新增: {e}");
                        }
                    }
                }
            }
        }

        match memory::create(
            store,
            kind,
            content,
            MemorySource::Ai,
            item.importance,
            session_id,
        ) {
            Ok(_) => saved += 1,
            Err(e) => eprintln!("AI 记忆写入失败: {e}"),
        }
    }
    saved
}

/// 统一的抽取流程：选冲突候选 → 调 LLM → 解析 → 落库
fn extract_with_prompt(
    provider: &ProviderConfig,
    store: &Store,
    config_store: &ConfigStore,
    system_prompt: &str,
    text: &str,
    session_id: Option<i64>,
) -> usize {
    if text.trim().is_empty() {
        return 0;
    }
    let existing = conflict_candidates(store, text);
    let user_prompt = build_extract_user_prompt(text, &existing);
    let raw = match llm_call::call_with_provider(provider, config_store, system_prompt, &user_prompt) {
        Ok(r) => r,
        Err(e) => {
            eprintln!("AI 记忆抽取失败: {e}");
            return 0;
        }
    };
    apply_extracted(store, &parse_extracted(&raw), session_id)
}

/// 对话结束后抽取记忆并落库，返回写入（含修正）条数。
///
/// `session_id` 为当前聊天会话，写入记忆的 `source_session_id` 以便溯源。
/// 任何失败都只记录日志并返回 0，绝不影响主对话流程。
pub fn extract_and_save(
    provider: &ProviderConfig,
    store: &Store,
    config_store: &ConfigStore,
    msgs: &[Value],
    session_id: Option<i64>,
) -> usize {
    if !auto_extract_enabled(config_store) {
        return 0;
    }
    let Some(text) = conversation_text(msgs) else {
        return 0;
    };
    extract_with_prompt(
        provider,
        store,
        config_store,
        EXTRACT_SYSTEM_PROMPT,
        &text,
        session_id,
    )
}

/// 上下文压缩时，把即将被丢弃的历史摘要沉淀为长期记忆。
///
/// 摘要会随上下文反复生成，冲突消解（action=update）可避免同一件事被反复写入。
pub fn sediment_summary(
    provider: &ProviderConfig,
    store: &Store,
    config_store: &ConfigStore,
    summary: &str,
    session_id: Option<i64>,
) -> usize {
    if !auto_extract_enabled(config_store) {
        return 0;
    }
    let text = truncate_chars(summary, MAX_EXTRACT_INPUT_CHARS);
    extract_with_prompt(
        provider,
        store,
        config_store,
        SEDIMENT_SYSTEM_PROMPT,
        &text,
        session_id,
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use memos_core::memory::MemoryConfig;
    use serde_json::json;

    fn memory(id: i64, content: &str, importance: i64) -> AiMemory {
        AiMemory {
            id,
            kind: MemoryKind::Fact,
            content: content.to_string(),
            source: MemorySource::Manual,
            source_session_id: None,
            importance,
            confidence: 1.0,
            hits: 0,
            last_hit_ts: None,
            enabled: true,
            created_ts: 0,
            updated_ts: 0,
        }
    }

    fn signals<'a>(terms: &'a [String], semantic: &'a HashMap<i64, f64>, now: i64) -> Signals<'a> {
        Signals { terms, semantic, now }
    }

    // ---------- 检索词 ----------

    #[test]
    fn test_query_terms_latin_and_cjk() {
        let terms = query_terms("我用 Rust 写了个 CLI 工具");
        assert!(terms.contains(&"rust".to_string()));
        assert!(terms.contains(&"cli".to_string()));
        assert!(terms.contains(&"工具".to_string()), "CJK 应切出 bigram");
    }

    #[test]
    fn test_query_terms_ignores_single_latin_char() {
        assert_eq!(query_terms("a b cc"), vec!["cc".to_string()]);
    }

    // ---------- 打分与衰减 ----------

    #[test]
    fn test_score_prefers_keyword_hit() {
        let terms = query_terms("Rust");
        let empty = HashMap::new();
        let now = now_ts();
        let sig = signals(&terms, &empty, now);
        // 关键词命中的低重要度记忆应超过未命中的高重要度记忆
        assert!(score(&memory(1, "用户喜欢 Rust", 1), &sig) > score(&memory(2, "用户在地球", 3), &sig));
    }

    #[test]
    fn test_score_semantic_similarity_lifts_rank() {
        let empty_terms: Vec<String> = Vec::new();
        let now = now_ts();
        let mut semantic = HashMap::new();
        semantic.insert(2, 0.9);
        let sig = signals(&empty_terms, &semantic, now);
        // 无关键词命中时，语义相似度决定排序
        assert!(score(&memory(2, "记忆 B", 3), &sig) > score(&memory(1, "记忆 A", 3), &sig));
    }

    #[test]
    fn test_decay_penalty_grows_over_time() {
        let now = 1_800_000_000;
        let mut m = memory(1, "长期未命中", 3);
        m.updated_ts = now;
        assert_eq!(decay_penalty(&m, now), 0);

        m.updated_ts = now - 40 * 86_400;
        assert_eq!(decay_penalty(&m, now), 1);

        m.updated_ts = now - 120 * 86_400;
        assert_eq!(decay_penalty(&m, now), 3);

        // 有命中记录时以 last_hit_ts 为基准
        m.last_hit_ts = Some(now - 1);
        assert_eq!(decay_penalty(&m, now), 0);
    }

    #[test]
    fn test_score_hit_bonus() {
        let terms: Vec<String> = Vec::new();
        let empty = HashMap::new();
        let sig = signals(&terms, &empty, now_ts());
        let mut hot = memory(1, "常用", 3);
        hot.hits = 10;
        let mut warm = memory(2, "用过", 3);
        warm.hits = 1;
        let cold = memory(3, "没用过", 3);
        assert!(score(&hot, &sig) > score(&warm, &sig));
        assert!(score(&warm, &sig) > score(&cold, &sig));
    }

    // ---------- 注入段 ----------

    #[test]
    fn test_build_section_disabled_returns_empty() {
        let store = Store::open_in_memory().unwrap();
        let config_store = ConfigStore::open_in_memory().unwrap();
        memory::create(&store, MemoryKind::Fact, "用户喜欢 Rust", MemorySource::Manual, 3, None).unwrap();
        assert_eq!(build_memory_section(&store, &config_store, "Rust"), "");
    }

    #[test]
    fn test_build_section_respects_char_budget() {
        let store = Store::open_in_memory().unwrap();
        let config_store = ConfigStore::open_in_memory().unwrap();
        for i in 0..10 {
            memory::create(
                &store,
                MemoryKind::Fact,
                &format!("记忆条目编号{i}的较长内容用于测试字符预算"),
                MemorySource::Manual,
                3,
                None,
            )
            .unwrap();
        }
        memory::save_config(
            &config_store,
            &MemoryConfig {
                enabled: true,
                auto_extract: false,
                max_items: 10,
                max_chars: 100,
            },
        )
        .unwrap();

        let section = build_memory_section(&store, &config_store, "");
        assert!(section.starts_with("\n\n## 用户记忆（跨会话）"));
        let body: usize = section
            .lines()
            .filter(|l| l.starts_with("- ["))
            .map(|l| l.chars().count() + 1)
            .sum();
        assert!(body <= 100, "正文 {body} 字符应不超过预算");
        assert!(section.lines().filter(|l| l.starts_with("- [")).count() < 10);
    }

    #[test]
    fn test_build_section_orders_by_query_relevance() {
        let store = Store::open_in_memory().unwrap();
        let config_store = ConfigStore::open_in_memory().unwrap();
        memory::create(&store, MemoryKind::Fact, "用户养了一只名叫豆豆的猫", MemorySource::Manual, 5, None).unwrap();
        memory::create(&store, MemoryKind::Preference, "用户偏好用 Rust 写后端", MemorySource::Manual, 1, None).unwrap();
        memory::save_config(
            &config_store,
            &MemoryConfig {
                enabled: true,
                auto_extract: false,
                max_items: 1,
                max_chars: 800,
            },
        )
        .unwrap();

        let section = build_memory_section(&store, &config_store, "帮我用 Rust 写个服务");
        assert!(section.contains("Rust"), "应优先注入关键词命中的记忆: {section}");
        assert!(!section.contains("豆豆"));
    }

    #[test]
    fn test_build_section_bumps_hits() {
        let store = Store::open_in_memory().unwrap();
        let config_store = ConfigStore::open_in_memory().unwrap();
        let m = memory::create(&store, MemoryKind::Fact, "用户喜欢 Rust", MemorySource::Manual, 3, None).unwrap();
        memory::save_config(
            &config_store,
            &MemoryConfig {
                enabled: true,
                auto_extract: false,
                max_items: 5,
                max_chars: 800,
            },
        )
        .unwrap();

        build_memory_section(&store, &config_store, "Rust");
        build_memory_section(&store, &config_store, "Rust");

        let loaded = memory::get(&store, m.id).unwrap().unwrap();
        assert_eq!(loaded.hits, 2, "每次注入都应累计命中次数");
        assert!(loaded.last_hit_ts.is_some());
    }

    #[test]
    fn test_build_section_falls_back_without_model() {
        // 模型文件不存在（CI/未首次使用语义搜索）时必须仍能工作：纯关键词召回
        let store = Store::open_in_memory().unwrap();
        let config_store = ConfigStore::open_in_memory().unwrap();
        memory::create(&store, MemoryKind::Fact, "用户喜欢 Rust", MemorySource::Manual, 3, None).unwrap();
        memory::save_config(
            &config_store,
            &MemoryConfig {
                enabled: true,
                auto_extract: false,
                max_items: 5,
                max_chars: 800,
            },
        )
        .unwrap();

        let section = build_memory_section(&store, &config_store, "Rust 怎么学");
        assert!(section.contains("Rust"));
    }

    // ---------- 对话文本 ----------

    #[test]
    fn test_conversation_text_skips_media_and_tools() {
        let msgs = vec![
            json!({"role": "system", "content": "sys"}),
            json!({"role": "user", "content": [{"type": "image_url"}]}),
            json!({"role": "assistant", "content": "", "tool_calls": []}),
            json!({"role": "user", "content": "我在写一个 Tauri 应用"}),
            json!({"role": "tool", "content": "{}"}),
        ];
        assert_eq!(conversation_text(&msgs).unwrap(), "用户: 我在写一个 Tauri 应用");
    }

    #[test]
    fn test_conversation_text_empty_returns_none() {
        assert!(conversation_text(&[]).is_none());
        assert!(conversation_text(&[json!({"role": "user", "content": "  "})]).is_none());
    }

    #[test]
    fn test_conversation_text_truncates() {
        let long = "长".repeat(MAX_EXTRACT_INPUT_CHARS + 500);
        let msgs = vec![json!({"role": "user", "content": long})];
        let text = conversation_text(&msgs).unwrap();
        assert_eq!(text.chars().count(), MAX_EXTRACT_INPUT_CHARS);
    }

    // ---------- 抽取与冲突消解 ----------

    #[test]
    fn test_parse_extracted_tolerates_fences_and_noise() {
        let raw = "好的，结果如下：\n```json\n[{\"action\":\"add\",\"kind\":\"fact\",\"content\":\"用户是后端工程师\",\"importance\":4}]\n```\n以上。";
        let parsed = parse_extracted(raw);
        assert_eq!(parsed.len(), 1);
        assert_eq!(parsed[0].content, "用户是后端工程师");
        assert_eq!(parsed[0].importance, 4);
        assert_eq!(parsed[0].action, "add");
    }

    #[test]
    fn test_parse_extracted_invalid_returns_empty() {
        assert!(parse_extracted("没有 JSON").is_empty());
        assert!(parse_extracted("[").is_empty());
        assert!(parse_extracted("]/[").is_empty());
        assert!(parse_extracted("{\"a\":1}").is_empty());
    }

    #[test]
    fn test_parse_extracted_defaults_importance() {
        let parsed = parse_extracted("[{\"kind\":\"preference\",\"content\":\"偏好简洁\"}]");
        assert_eq!(parsed[0].importance, 3);
        assert_eq!(parsed[0].id, None);
    }

    #[test]
    fn test_apply_extracted_add_and_update() {
        let store = Store::open_in_memory().unwrap();
        let existing = memory::create(&store, MemoryKind::Fact, "用户主力语言是 Rust", MemorySource::Manual, 2, None).unwrap();

        let items = vec![
            ExtractedMemory {
                action: "update".into(),
                kind: "fact".into(),
                content: "用户主力语言是 Rust 2024".into(),
                id: Some(existing.id),
                importance: 3,
            },
            ExtractedMemory {
                action: "add".into(),
                kind: "preference".into(),
                content: "用户偏好简洁回答".into(),
                id: None,
                importance: 4,
            },
        ];
        assert_eq!(apply_extracted(&store, &items, None), 2);

        let all = memory::list(&store, None, true).unwrap();
        assert_eq!(all.len(), 2, "update 不应产生新条目");
        let updated = memory::get(&store, existing.id).unwrap().unwrap();
        assert_eq!(updated.content, "用户主力语言是 Rust 2024");
        assert_eq!(updated.importance, 3, "重要度只升不降");
    }

    #[test]
    fn test_apply_extracted_update_never_lowers_importance() {
        let store = Store::open_in_memory().unwrap();
        let existing = memory::create(&store, MemoryKind::Fact, "用户很喜欢 Rust", MemorySource::Manual, 5, None).unwrap();
        let items = vec![ExtractedMemory {
            action: "update".into(),
            kind: "fact".into(),
            content: "用户喜欢 Rust".into(),
            id: Some(existing.id),
            importance: 1,
        }];
        apply_extracted(&store, &items, None);
        let loaded = memory::get(&store, existing.id).unwrap().unwrap();
        assert_eq!(loaded.importance, 5);
    }

    #[test]
    fn test_apply_extracted_unknown_update_id_falls_back_to_add() {
        let store = Store::open_in_memory().unwrap();
        let items = vec![ExtractedMemory {
            action: "update".into(),
            kind: "fact".into(),
            content: "用户在北京".into(),
            id: Some(9999),
            importance: 3,
        }];
        assert_eq!(apply_extracted(&store, &items, None), 1);
        assert_eq!(memory::list(&store, None, true).unwrap().len(), 1);
    }

    #[test]
    fn test_apply_extracted_skips_empty_content() {
        let store = Store::open_in_memory().unwrap();
        let items = vec![ExtractedMemory {
            action: "add".into(),
            kind: "fact".into(),
            content: "   ".into(),
            id: None,
            importance: 3,
        }];
        assert_eq!(apply_extracted(&store, &items, None), 0);
        assert!(memory::list(&store, None, true).unwrap().is_empty());
    }

    #[test]
    fn test_conflict_candidates_prefers_relevant() {
        let store = Store::open_in_memory().unwrap();
        memory::create(&store, MemoryKind::Fact, "用户养了一只名叫豆豆的猫", MemorySource::Manual, 5, None).unwrap();
        let rust = memory::create(&store, MemoryKind::Fact, "用户主力语言是 Rust", MemorySource::Manual, 1, None).unwrap();

        let candidates = conflict_candidates(&store, "用户: 我最近在用 Rust 写项目");
        assert!(!candidates.is_empty());
        assert_eq!(candidates[0].0, rust.id, "相关记忆应排在候选首位");
    }

    #[test]
    fn test_conflict_candidates_empty_store() {
        let store = Store::open_in_memory().unwrap();
        assert!(conflict_candidates(&store, "任何文本").is_empty());
    }

    #[test]
    fn test_strip_speaker_labels() {
        assert_eq!(
            strip_speaker_labels("用户: 我要用 Rust\n助手: 好的"),
            " 我要用 Rust\n 好的"
        );
    }

    #[test]
    fn test_build_extract_user_prompt_includes_existing() {
        let existing = vec![(12i64, MemoryKind::Fact, "用户主力语言是 Rust".to_string())];
        let prompt = build_extract_user_prompt("用户: 我在用 Rust", &existing);
        assert!(prompt.contains("12 | fact | 用户主力语言是 Rust"));
        assert!(prompt.contains("用户: 我在用 Rust"));
    }

    #[test]
    fn test_build_extract_user_prompt_without_existing() {
        let prompt = build_extract_user_prompt("用户: 你好", &[]);
        assert!(prompt.contains("（暂无）"));
        assert!(prompt.contains("用户: 你好"));
    }

    #[test]
    fn test_extract_disabled_returns_zero() {
        let store = Store::open_in_memory().unwrap();
        let config_store = ConfigStore::open_in_memory().unwrap();
        let provider = ProviderConfig {
            id: "p".into(),
            name: "p".into(),
            base_url: "http://127.0.0.1:1".into(),
            api_key: String::new(),
            model: "m".into(),
        };
        let msgs = vec![json!({"role": "user", "content": "记住我喜欢 Rust"})];
        // 未开启自动抽取：不应发起任何 LLM 请求
        assert_eq!(extract_and_save(&provider, &store, &config_store, &msgs, None), 0);
        assert_eq!(sediment_summary(&provider, &store, &config_store, "摘要", None), 0);
    }

    #[test]
    fn test_apply_extracted_records_source_session() {
        let store = Store::open_in_memory().unwrap();
        let items = vec![
            ExtractedMemory {
                action: "add".into(),
                kind: "episode".into(),
                content: "用户决定下周重构记忆模块".into(),
                id: None,
                importance: 3,
            },
            ExtractedMemory {
                action: "add".into(),
                kind: "fact".into(),
                content: "用户偏好本地优先方案".into(),
                id: None,
                importance: 3,
            },
        ];
        assert_eq!(apply_extracted(&store, &items, Some(42)), 2);

        let all = memory::list(&store, None, true).unwrap();
        assert_eq!(all.len(), 2);
        assert!(all.iter().all(|m| m.source_session_id == Some(42)), "应记录来源会话");

        // 未提供会话时保持为 NULL（手动添加/remember 工具无会话上下文）
        apply_extracted(
            &store,
            &[ExtractedMemory {
                action: "add".into(),
                kind: "fact".into(),
                content: "用户在北京".into(),
                id: None,
                importance: 3,
            }],
            None,
        );
        let beijing = memory::list(&store, Some("北京"), true).unwrap();
        assert_eq!(beijing[0].source_session_id, None);
    }
}
