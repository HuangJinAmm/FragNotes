-- AI 跨会话长期记忆：用户偏好 / 稳定事实 / 会话要点
-- 记忆存业务库（随工作空间隔离），配置开关存 app_config.db 的 app_setting

CREATE TABLE IF NOT EXISTS ai_memory (
    id                INTEGER PRIMARY KEY AUTOINCREMENT,
    kind              TEXT NOT NULL DEFAULT 'fact',   -- fact | preference | episode
    content           TEXT NOT NULL,                  -- 记忆正文（单行，自然语言）
    content_key       TEXT NOT NULL UNIQUE,           -- 归一化去重键
    source            TEXT NOT NULL DEFAULT 'manual', -- manual | ai
    source_session_id INTEGER,                        -- 来源会话（AI 抽取时填写）
    importance        INTEGER NOT NULL DEFAULT 3,     -- 1..5，越高越优先注入
    confidence        REAL NOT NULL DEFAULT 1.0,      -- 抽取置信度（M3 使用）
    hits              INTEGER NOT NULL DEFAULT 0,     -- 注入命中次数（M3 使用）
    last_hit_ts       INTEGER,
    enabled           INTEGER NOT NULL DEFAULT 1,
    created_ts        INTEGER NOT NULL,
    updated_ts        INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_ai_memory_enabled ON ai_memory(enabled);
CREATE INDEX IF NOT EXISTS idx_ai_memory_rank ON ai_memory(enabled, importance DESC, updated_ts DESC);
