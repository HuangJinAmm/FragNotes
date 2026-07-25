-- app_config.db 初始 schema：从原 memos.db 拆分出来的共享配置表
-- 这些表跨工作空间共享，与具体笔记数据无关

CREATE TABLE IF NOT EXISTS app_setting (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS instance_setting (
    name TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    description TEXT
);

CREATE TABLE IF NOT EXISTS tool (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL UNIQUE,
    command TEXT NOT NULL,
    permission TEXT NOT NULL,
    description TEXT NOT NULL,
    timeout_ms INTEGER NOT NULL,
    enabled INTEGER NOT NULL DEFAULT 1,
    created_ts INTEGER NOT NULL,
    updated_ts INTEGER NOT NULL
);
