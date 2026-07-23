-- Skills：AI agent 工具使用指南
-- skill: 用户自定义 skill（内置 skill 通过 include_str! 编译期嵌入，不入库）

CREATE TABLE IF NOT EXISTS skill (
    id           TEXT PRIMARY KEY,        -- "u-<slug>"
    name         TEXT NOT NULL,
    description  TEXT NOT NULL,           -- 注入 LLM 元数据的单行摘要
    tools        TEXT NOT NULL,           -- JSON 数组，如 ["office_cli"]
    body         TEXT NOT NULL,           -- Markdown 正文（不含 frontmatter）
    enabled      INTEGER NOT NULL DEFAULT 1,
    created_ts   INTEGER NOT NULL,
    updated_ts   INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_skill_enabled ON skill(enabled);
