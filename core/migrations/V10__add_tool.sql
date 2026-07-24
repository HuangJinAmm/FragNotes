-- Tools：用户可配置的 shell 命令工具
-- 与 skill 表对称：用户工具存 DB，内置工具硬编码在 tools.rs
CREATE TABLE IF NOT EXISTS tool (
    id           TEXT PRIMARY KEY,        -- "u-<slug>"
    name         TEXT NOT NULL UNIQUE,    -- LLM 可见的工具名（与内置 10 个不可冲突）
    command      TEXT NOT NULL,           -- 默认/示例命令（仅展示，LLM 调用时传完整 command 覆盖）
    permission   TEXT NOT NULL CHECK(permission IN ('read_only','writable','executable','dangerous')),
    description  TEXT NOT NULL,           -- 注入 LLM 工具描述
    timeout_ms   INTEGER NOT NULL DEFAULT 30000,
    enabled      INTEGER NOT NULL DEFAULT 1,
    created_ts   INTEGER NOT NULL,
    updated_ts   INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_tool_enabled ON tool(enabled);
