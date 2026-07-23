//! 内置 skill：通过 include_str! 编译期嵌入，启动时解析 frontmatter 缓存到 AppState
//!
//! frontmatter 格式（YAML）：
//!   ---
//!   id: b-xxx
//!   name: xxx
//!   description: xxx
//!   tools: [tool1, tool2]
//!   ---
//!   # Markdown body...

use memos_core::skill::{Skill, SkillSource};

/// 嵌入内置 skill 文件
const RAW_FILES: &[(&str, &str)] = &[
    (
        "review_card_best_practices",
        include_str!("../../skills/review_card_best_practices.md"),
    ),
    (
        "semantic_search_tips",
        include_str!("../../skills/semantic_search_tips.md"),
    ),
    (
        "office_cli_guide",
        include_str!("../../skills/office_cli_guide.md"),
    ),
];

/// 解析单个 skill 文件的 frontmatter + body
fn parse(raw: &str) -> Result<Skill, String> {
    let raw = raw.trim_start();
    if !raw.starts_with("---") {
        return Err("missing frontmatter start delimiter".into());
    }
    let after_start = &raw[3..];
    let end = after_start
        .find("\n---")
        .ok_or_else(|| "missing frontmatter end delimiter".to_string())?;
    let frontmatter = &after_start[..end];
    let body = after_start[end + 4..].trim_start_matches('\n');

    let mut id = None;
    let mut name = None;
    let mut description = None;
    let mut tools: Vec<String> = Vec::new();

    for line in frontmatter.lines() {
        let line = line.trim();
        if let Some(v) = line.strip_prefix("id:") {
            id = Some(v.trim().to_string());
        } else if let Some(v) = line.strip_prefix("name:") {
            name = Some(v.trim().to_string());
        } else if let Some(v) = line.strip_prefix("description:") {
            description = Some(v.trim().to_string());
        } else if let Some(v) = line.strip_prefix("tools:") {
            // 格式: [a, b, c]
            let v = v.trim().trim_start_matches('[').trim_end_matches(']');
            tools = v
                .split(',')
                .map(|s| s.trim().to_string())
                .filter(|s| !s.is_empty())
                .collect();
        }
    }

    Ok(Skill {
        id: id.ok_or("missing id")?,
        name: name.ok_or("missing name")?,
        description: description.ok_or("missing description")?,
        tools,
        body: body.to_string(),
        enabled: true,
        source: SkillSource::BuiltIn,
        created_ts: 0,
        updated_ts: 0,
    })
}

/// 启动时调用一次，解析所有内置 skill。解析失败的跳过并记录日志。
pub fn load_builtin_skills() -> Vec<Skill> {
    let mut result = Vec::new();
    for (name, raw) in RAW_FILES {
        match parse(raw) {
            Ok(s) => {
                if !s.id.starts_with("b-") {
                    tracing::error!("内置 skill {} 的 id 不以 b- 开头: {}", name, s.id);
                    continue;
                }
                result.push(s);
            }
            Err(e) => {
                tracing::error!("解析内置 skill {} 失败: {}", name, e);
            }
        }
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_builtin_skills_loaded() {
        let skills = load_builtin_skills();
        assert!(!skills.is_empty(), "至少应加载一个内置 skill");
    }

    #[test]
    fn test_builtin_skill_ids_prefixed() {
        let skills = load_builtin_skills();
        for s in &skills {
            assert!(
                s.id.starts_with("b-"),
                "内置 skill id 必须以 b- 开头: {}",
                s.id
            );
        }
    }

    #[test]
    fn test_parse_valid() {
        let raw = "---\nid: b-test\nname: Test\ndescription: a test\ntools: [a, b]\n---\n# Body\ncontent";
        let s = parse(raw).unwrap();
        assert_eq!(s.id, "b-test");
        assert_eq!(s.name, "Test");
        assert_eq!(s.description, "a test");
        assert_eq!(s.tools, vec!["a".to_string(), "b".to_string()]);
        assert_eq!(s.body, "# Body\ncontent");
    }

    #[test]
    fn test_parse_missing_frontmatter() {
        let raw = "no frontmatter here";
        assert!(parse(raw).is_err());
    }
}
