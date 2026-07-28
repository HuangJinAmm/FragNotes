//! 共享配置 Store：管理 app_config.db 连接
//!
//! 持有 app_setting、instance_setting、tool 三张表的访问器
//! 与 Store（memos.db）独立，跨工作空间共享

use crate::cache::{new_string_cache, CacheConfig};
use crate::error::CoreResult;
use crate::setting::SettingStore;
use rusqlite::Connection;
use std::path::Path;
use std::sync::Mutex;

pub struct ConfigStore {
    conn: Mutex<Connection>,
    pub setting: SettingStore,
}

impl ConfigStore {
    pub fn open<P: AsRef<Path>>(db_path: P) -> CoreResult<Self> {
        let conn = Connection::open(db_path)?;
        conn.execute("PRAGMA foreign_keys = ON", [])?;
        conn.execute_batch("PRAGMA busy_timeout = 5000;")?;
        let mut conn_mut = conn;
        crate::config_migration::run(&mut conn_mut)?;
        let conn = conn_mut;

        let cfg = CacheConfig::default();
        let app_cache = new_string_cache(&cfg);
        let instance_cache = new_string_cache(&cfg);
        let setting = SettingStore::new(app_cache, instance_cache);

        Ok(Self {
            conn: Mutex::new(conn),
            setting,
        })
    }

    pub fn open_in_memory() -> CoreResult<Self> {
        let conn = Connection::open_in_memory()?;
        conn.execute_batch("PRAGMA busy_timeout = 5000;")?;
        let mut conn_mut = conn;
        crate::config_migration::run(&mut conn_mut)?;
        let conn = conn_mut;

        let cfg = CacheConfig::default();
        let app_cache = new_string_cache(&cfg);
        let instance_cache = new_string_cache(&cfg);
        let setting = SettingStore::new(app_cache, instance_cache);

        Ok(Self {
            conn: Mutex::new(conn),
            setting,
        })
    }

    pub fn with_conn<F, T>(&self, f: F) -> CoreResult<T>
    where
        F: FnOnce(&Connection) -> CoreResult<T>,
    {
        let conn = self.conn.lock().expect("ConfigStore Mutex poisoned");
        f(&conn)
    }

    pub fn with_conn_mut<F, T>(&self, f: F) -> CoreResult<T>
    where
        F: FnOnce(&mut Connection) -> CoreResult<T>,
    {
        let mut conn = self.conn.lock().expect("ConfigStore Mutex poisoned");
        f(&mut conn)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_open_in_memory_creates_tables() {
        let store = ConfigStore::open_in_memory().unwrap();
        store
            .with_conn(|c| {
                let count: i64 = c.query_row(
                    "SELECT count(*) FROM sqlite_master WHERE type='table' AND name IN ('app_setting', 'instance_setting', 'tool')",
                    [],
                    |row| row.get(0),
                )?;
                assert_eq!(count, 3);
                Ok(())
            })
            .unwrap();
    }

    #[test]
    fn test_app_setting_crud() {
        let store = ConfigStore::open_in_memory().unwrap();
        store
            .with_conn(|c| store.setting.app.upsert(c, "test_key", "test_value"))
            .unwrap();

        let v = store
            .with_conn(|c| store.setting.app.get(c, "test_key"))
            .unwrap();
        assert_eq!(v, Some("test_value".to_string()));

        store
            .with_conn(|c| store.setting.app.delete(c, "test_key"))
            .unwrap();
        let v = store
            .with_conn(|c| store.setting.app.get(c, "test_key"))
            .unwrap();
        assert_eq!(v, None);
    }

    #[test]
    fn test_instance_setting_crud() {
        let store = ConfigStore::open_in_memory().unwrap();
        store
            .with_conn(|c| {
                store
                    .setting
                    .instance
                    .upsert(c, "name1", "value1", "desc1")
            })
            .unwrap();

        let v = store
            .with_conn(|c| store.setting.instance.get(c, "name1"))
            .unwrap();
        assert_eq!(v, Some("value1".to_string()));
    }
}
