//! memos-core: 本地业务逻辑库
//!
//! 提供 memo / attachment / reaction / memo_relation / 设置 的 CRUD，
//! 基于 rusqlite + refinery + moka 缓存。

pub mod attachment;
pub mod cache;
pub mod chat_session;
pub mod error;
pub mod markdown;
pub mod memo;
pub mod memo_relation;
pub mod migration;
pub mod config_migration;
pub mod config_store;
pub mod reaction;
pub mod review;
pub mod setting;
pub mod skill;
pub mod tool;
pub mod store;
pub mod tag;
pub mod types;

pub use error::{CoreError, CoreResult};
pub use config_store::ConfigStore;
pub use store::Store;
