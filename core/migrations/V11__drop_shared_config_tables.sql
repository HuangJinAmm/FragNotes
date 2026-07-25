-- 删除从 memos.db 拆分到 app_config.db 的共享配置表
-- 这些表现在由 app_config.db 管理，跨工作空间共享

DROP TABLE IF EXISTS app_setting;
DROP TABLE IF EXISTS instance_setting;
DROP TABLE IF EXISTS tool;
