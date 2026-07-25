//! app_config.db 的迁移入口
//!
//! 与 memos.db 的迁移独立，连接到不同的 db 文件，使用独立的迁移目录

use crate::error::CoreResult;
use refinery::embed_migrations;

embed_migrations!("config_migrations");

/// 执行 app_config.db 迁移
pub fn run(conn: &mut rusqlite::Connection) -> CoreResult<()> {
    let report = migrations::runner().run(conn)?;
    tracing::info!(
        "app_config.db 迁移完成，应用 {} 个迁移",
        report.applied_migrations().len()
    );
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_run_on_fresh_db() {
        let mut conn = rusqlite::Connection::open_in_memory().unwrap();
        assert!(run(&mut conn).is_ok());
        let count: i64 = conn
            .query_row(
                "SELECT count(*) FROM sqlite_master WHERE type='table' AND name IN ('app_setting', 'instance_setting', 'tool')",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(count, 3);
    }

    #[test]
    fn test_run_idempotent() {
        let mut conn = rusqlite::Connection::open_in_memory().unwrap();
        run(&mut conn).unwrap();
        assert!(run(&mut conn).is_ok());
    }
}
