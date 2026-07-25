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
    // OfficeCLI 内置 skills —— 与 officecli 工具关联
    (
        "officecli-academic-paper",
        include_str!("../../skills/office-cli/officecli-academic-paper/SKILL.md"),
    ),
    (
        "officecli-data-dashboard",
        include_str!("../../skills/office-cli/officecli-data-dashboard/SKILL.md"),
    ),
    (
        "officecli-docx",
        include_str!("../../skills/office-cli/officecli-docx/SKILL.md"),
    ),
    (
        "officecli-financial-model",
        include_str!("../../skills/office-cli/officecli-financial-model/SKILL.md"),
    ),
    (
        "officecli-pitch-deck",
        include_str!("../../skills/office-cli/officecli-pitch-deck/SKILL.md"),
    ),
    (
        "officecli-pptx",
        include_str!("../../skills/office-cli/officecli-pptx/SKILL.md"),
    ),
    (
        "officecli-word-form",
        include_str!("../../skills/office-cli/officecli-word-form/SKILL.md"),
    ),
    (
        "officecli-xlsx",
        include_str!("../../skills/office-cli/officecli-xlsx/SKILL.md"),
    ),
];

/// 去除字符串两侧的成对双引号（YAML 常见写法）
fn strip_quotes(s: &str) -> &str {
    let s = s.trim();
    if s.len() >= 2 && s.starts_with('"') && s.ends_with('"') {
        &s[1..s.len() - 1]
    } else {
        s
    }
}

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
            id = Some(strip_quotes(v.trim()).to_string());
        } else if let Some(v) = line.strip_prefix("name:") {
            name = Some(strip_quotes(v.trim()).to_string());
        } else if let Some(v) = line.strip_prefix("description:") {
            description = Some(strip_quotes(v.trim()).to_string());
        } else if let Some(v) = line.strip_prefix("tools:") {
            // 格式: [a, b, c]
            let v = v.trim().trim_start_matches('[').trim_end_matches(']');
            tools = v
                .split(',')
                .map(|s| strip_quotes(s.trim()).to_string())
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
        // 2 个原有 skill + 8 个 office-cli skill = 10
        assert_eq!(skills.len(), 10, "应加载 10 个内置 skill");
    }

    #[test]
    fn test_officecli_skills_have_officecli_tool() {
        let skills = load_builtin_skills();
        let officecli_skills: Vec<_> = skills
            .iter()
            .filter(|s| s.id.starts_with("b-officecli-"))
            .collect();
        assert_eq!(officecli_skills.len(), 8, "应有 8 个 officecli 相关 skill");
        for s in &officecli_skills {
            assert!(
                s.tools.contains(&"officecli".to_string()),
                "skill {} 的 tools 应包含 officecli",
                s.id
            );
        }
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
    fn test_parse_quoted_description() {
        let raw = "---\nid: b-test\nname: Test\ndescription: \"a quoted test\"\ntools: [\"a\", b]\n---\n# Body";
        let s = parse(raw).unwrap();
        assert_eq!(s.description, "a quoted test");
        assert_eq!(s.tools, vec!["a".to_string(), "b".to_string()]);
    }

    #[test]
    fn test_strip_quotes() {
        assert_eq!(strip_quotes("\"hello\""), "hello");
        assert_eq!(strip_quotes("hello"), "hello");
        assert_eq!(strip_quotes("\"unclosed"), "\"unclosed");
        assert_eq!(strip_quotes(""), "");
    }

    #[test]
    fn test_parse_missing_frontmatter() {
        let raw = "no frontmatter here";
        assert!(parse(raw).is_err());
    }
}
