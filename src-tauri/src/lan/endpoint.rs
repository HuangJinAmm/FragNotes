//! iroh Endpoint 初始化与 mDNS 发现
//!
//! - SecretKey 持久化到 用户目录/localFragNote/lan_identity.key
//! - mDNS 通过 iroh-mdns-address-lookup 启用
//! - 展示名通过 instance_setting:lan_display_name 存储
//! - mDNS 发现代码在后台 task 中订阅 DiscoveryEvent 并更新 peers 缓存

use crate::state::AppState;
use crate::lan::{LanError, LanState, PeerInfo, ALPN};
use iroh::endpoint::presets;
use iroh::{Endpoint, SecretKey};
use iroh_mdns_address_lookup::{DiscoveryEvent, MdnsAddressLookup};
use std::path::Path;
use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};
use tokio::sync::RwLock;

/// 默认展示名
const DEFAULT_DISPLAY_NAME: &str = "LocalFragNote";
/// 展示名在 instance_setting 的 key
pub const DISPLAY_NAME_KEY: &str = "lan_display_name";
/// ACL 规则在 app_setting 的 key
pub const ACL_RULES_KEY: &str = "lan_acl_rules";
/// 是否启用 LAN 模块的 app_setting key
pub const ENABLED_KEY: &str = "lan_enabled";
/// 用户资料在 app_setting 的 key（与前端 connect.ts USER_PROFILE_KEY 保持一致）
pub const USER_PROFILE_KEY: &str = "user_profile:local";

/// 加载或创建 SecretKey，持久化到文件
fn load_or_create_secret(path: &Path) -> Result<SecretKey, LanError> {
    if path.exists() {
        let bytes = std::fs::read(path)?;
        let arr: [u8; 32] = bytes
            .as_slice()
            .try_into()
            .map_err(|_| LanError::LocalStore("invalid secret key file".into()))?;
        Ok(SecretKey::from_bytes(&arr))
    } else {
        let secret = SecretKey::generate();
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        std::fs::write(path, secret.to_bytes())?;
        Ok(secret)
    }
}

/// 初始化 LanState：创建 Endpoint，启用 mDNS
pub async fn init_lan_state(config_dir: &Path) -> Result<Arc<LanState>, LanError> {
    let key_path = config_dir.join("lan_identity.key");
    let secret_key = load_or_create_secret(&key_path)?;
    tracing::info!("LAN Endpoint secret key loaded from {}", key_path.display());

    // 不在 builder 链中注册 MdnsAddressLookup，而是 bind 后手动构建并 add，
    // 这样可以保留 MdnsAddressLookup 的 clone 用于订阅 DiscoveryEvent
    let endpoint = Endpoint::builder(presets::N0)
        .secret_key(secret_key)
        .alpns(vec![ALPN.to_vec()])
        .bind()
        .await
        .map_err(|e| LanError::Endpoint(e.to_string()))?;

    let endpoint_id = endpoint.id();
    tracing::info!("LAN Endpoint bound, endpoint_id = {}", endpoint_id);

    // 手动构建 MdnsAddressLookup 并注册到 endpoint，保留 clone 用于订阅发现事件
    let mdns = MdnsAddressLookup::builder()
        .build(endpoint_id)
        .map_err(|e| LanError::Endpoint(e.to_string()))?;
    endpoint
        .address_lookup()
        .map_err(|e| LanError::Endpoint(e.to_string()))?
        .add(mdns.clone());
    tracing::info!("LAN mDNS address lookup registered");

    let display_name = DEFAULT_DISPLAY_NAME.to_string();
    let (shutdown_tx, _shutdown_rx) = tokio::sync::watch::channel(false);
    let state = Arc::new(LanState {
        endpoint,
        mdns,
        peers: RwLock::new(Vec::new()),
        display_name: RwLock::new(display_name),
        shutdown_tx,
    });

    Ok(state)
}

/// 启动 LAN 模块并注册后台循环。
pub async fn start_lan_module(app_handle: &tauri::AppHandle) -> Result<Arc<LanState>, LanError> {
    use tauri::{Emitter, Manager};

    let app_state = app_handle.state::<AppState>();
    if let Ok(lan) = app_state.lan() {
        return Ok(lan);
    }

    // 引导目录（Tauri app_config_dir）：存放 lan_identity.key 等共享配置
    let config_dir = app_state.config_dir.clone();
    std::fs::create_dir_all(&config_dir)?;

    let state = init_lan_state(&config_dir).await?;
    let display_name = {
        let config_store = app_state.config_store();
        load_display_name(&config_store)
    };
    *state.display_name.write().await = display_name;

    app_state.set_lan(Some(state.clone()));
    crate::lan::server::spawn_accept_loop(state.clone(), app_handle.clone());
    spawn_mdns_discovery_loop(state.clone(), app_handle.clone());

    let _ = app_handle.emit("lan:status-changed", ());
    let _ = app_handle.emit("lan:peers-changed", ());
    tracing::info!("LAN 模块已启动");
    Ok(state)
}

/// 停止 LAN 模块并清空运行时状态。
pub async fn stop_lan_module(app_handle: &tauri::AppHandle) -> Result<(), LanError> {
    use tauri::{Emitter, Manager};

    let app_state = app_handle.state::<AppState>();
    let Some(lan_state) = app_state.take_lan() else {
        tracing::info!("LAN 停止：当前没有运行中的 LAN 状态");
        let _ = app_handle.emit("lan:status-changed", ());
        let _ = app_handle.emit("lan:peers-changed", ());
        return Ok(());
    };

    let _ = lan_state.shutdown_tx.send(true);
    tracing::info!("LAN 停止：已发送 shutdown 信号，准备关闭 endpoint");
    lan_state.endpoint.close().await;
    tracing::info!("LAN 停止：endpoint 已关闭");

    let _ = app_handle.emit("lan:status-changed", ());
    let _ = app_handle.emit("lan:peers-changed", ());
    tracing::info!("LAN 停止：已完成");
    Ok(())
}

/// 从 LanState 获取本机 endpoint_id 的字符串表示
pub fn local_peer_id(state: &LanState) -> String {
    state.endpoint.id().to_string()
}

/// 当前 epoch seconds，用于 PeerInfo.last_seen
fn now_epoch_secs() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

/// 启动 mDNS 发现代理：订阅 MdnsAddressLookup 的 DiscoveryEvent 流，
/// 发现 peer 时更新 peers 缓存并向前端推送 "lan:peers-changed" 事件。
///
/// 采用事件驱动模式（非轮询），mDNS 发现/过期时立即更新缓存。
pub fn spawn_mdns_discovery_loop(state: Arc<LanState>, app_handle: tauri::AppHandle) {
    tauri::async_runtime::spawn(async move {
        use std::collections::HashSet;
        use tauri::Emitter;
        use tokio::sync::Mutex;
        use tokio_stream::StreamExt;

        use crate::lan::client::call_remote;
        use crate::lan::protocol::{Request, ResponseData};

        tracing::info!("LAN mDNS discovery loop: subscribe begin");
        let mut events = state.mdns.subscribe().await;
        let mut shutdown_rx = state.shutdown_tx.subscribe();
        tracing::info!("LAN mDNS discovery loop started");

        // 正在进行 GetProfile 请求的 peer_id 集合，用于避免对同一 peer 重复发起并发请求
        let in_flight: Arc<Mutex<HashSet<String>>> = Arc::new(Mutex::new(HashSet::new()));

        loop {
            tokio::select! {
                biased;
                _ = shutdown_rx.changed() => {
                    tracing::info!("LAN mDNS discovery loop: 收到 shutdown 信号");
                    break;
                }
                event = events.next() => {
                    let Some(event) = event else {
                        tracing::info!("LAN mDNS discovery loop: 事件流已结束");
                        break;
                    };
                    let changed = match event {
                        DiscoveryEvent::Discovered { endpoint_info, .. } => {
                            let peer_id = endpoint_info.endpoint_id.to_string();
                            let addrs: Vec<String> = endpoint_info
                                .data
                                .ip_addrs()
                                .map(|sa| sa.to_string())
                                .collect();
                            let relay_url = endpoint_info
                                .data
                                .relay_urls()
                                .next()
                                .map(|u| u.to_string());
                            let now = now_epoch_secs();

                            let prefix = peer_id_chars_prefix(&peer_id, 8);

                            // 更新 peers 缓存：保留已解析的 display_name，避免被 prefix 占位符覆盖
                            let mut peers = state.peers.write().await;
                            let display_name = peers
                                .iter()
                                .find(|p| p.peer_id == peer_id)
                                .map(|p| p.display_name.clone())
                                .unwrap_or_else(|| prefix.clone());
                            let info = PeerInfo {
                                peer_id: peer_id.clone(),
                                display_name,
                                addrs,
                                relay_url,
                                last_seen: now,
                            };
                            if let Some(existing) = peers.iter_mut().find(|p| p.peer_id == peer_id) {
                                *existing = info;
                            } else {
                                peers.push(info);
                            }
                            drop(peers);

                            // 异步获取真实 display_name（去重：同一 peer 同时只允许一个在途请求）
                            // 通过 GetProfile RPC 向对端请求其设置的展示名，并更新 peers 缓存
                            let should_spawn = in_flight.lock().await.insert(peer_id.clone());
                            if should_spawn {
                                let state_clone = state.clone();
                                let app_handle_clone = app_handle.clone();
                                let peer_id_clone = peer_id.clone();
                                let in_flight_clone = in_flight.clone();
                                tauri::async_runtime::spawn(async move {
                                    let result = call_remote(
                                        &state_clone.endpoint,
                                        &peer_id_clone,
                                        &Request::GetProfile,
                                    )
                                    .await;
                                    in_flight_clone.lock().await.remove(&peer_id_clone);

                                    match result {
                                        Ok(ResponseData::Profile { display_name, .. }) => {
                                            if !display_name.is_empty() {
                                                let mut peers = state_clone.peers.write().await;
                                                if let Some(peer) = peers
                                                    .iter_mut()
                                                    .find(|p| p.peer_id == peer_id_clone)
                                                {
                                                    peer.display_name = display_name;
                                                }
                                                drop(peers);
                                                let _ =
                                                    app_handle_clone.emit("lan:peers-changed", ());
                                            }
                                        }
                                        Ok(other) => {
                                            tracing::debug!(
                                                peer_id = %peer_id_clone,
                                                "GetProfile 返回非预期响应: {other:?}"
                                            );
                                        }
                                        Err(e) => {
                                            tracing::debug!(
                                                peer_id = %peer_id_clone,
                                                "GetProfile 失败，将在下次发现时重试: {e}"
                                            );
                                        }
                                    }
                                });
                            }

                            tracing::debug!(%peer_id, "LAN mDNS discovered peer");
                            true
                        }
                        DiscoveryEvent::Expired { endpoint_id } => {
                            let peer_id = endpoint_id.to_string();
                            in_flight.lock().await.remove(&peer_id);
                            let mut peers = state.peers.write().await;
                            let before = peers.len();
                            peers.retain(|p| p.peer_id != peer_id);
                            let removed = before != peers.len();
                            if removed {
                                tracing::debug!(%peer_id, "LAN mDNS peer expired");
                            }
                            removed
                        }
                        _ => false,
                    };

                    if changed {
                        let _ = app_handle.emit("lan:peers-changed", ());
                    }
                }
            }
        }

        tracing::info!("LAN mDNS discovery loop terminated");
    });
}

/// 取 peer_id（hex 字符串）的前 n 个字符作为占位展示名
fn peer_id_chars_prefix(peer_id: &str, n: usize) -> String {
    peer_id.chars().take(n).collect()
}

/// 从 app_setting 读取用户资料中的 displayName
/// 用户在"个人信息"对话框设置的 displayName 优先于 LAN 专用 display_name
fn load_user_profile_display_name(config_store: &memos_core::ConfigStore) -> Option<String> {
    let json = config_store
        .with_conn(|c| config_store.setting.app.get(c, USER_PROFILE_KEY))
        .ok()
        .flatten()?;
    let value: serde_json::Value = serde_json::from_str(&json).ok()?;
    value
        .get("displayName")
        .and_then(|v| v.as_str())
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
}

/// 读取展示名：优先使用用户资料中的 displayName，其次使用 LAN 专用 display_name
pub fn load_display_name(config_store: &memos_core::ConfigStore) -> String {
    if let Some(name) = load_user_profile_display_name(config_store) {
        return name;
    }
    config_store
        .with_conn(|c| config_store.setting.instance.get(c, DISPLAY_NAME_KEY))
        .unwrap_or(None)
        .unwrap_or_else(|| DEFAULT_DISPLAY_NAME.to_string())
}

/// 保存展示名到 instance_setting
pub fn save_display_name(config_store: &memos_core::ConfigStore, name: &str) -> Result<(), LanError> {
    config_store
        .with_conn(|c| {
            config_store
                .setting
                .instance
                .upsert(c, DISPLAY_NAME_KEY, name, "")
        })
        .map_err(|e| LanError::LocalStore(e.to_string()))?;
    Ok(())
}

/// 从 app_setting 读取 ACL 规则 JSON
pub fn load_acl_rules_json(config_store: &memos_core::ConfigStore) -> String {
    config_store
        .with_conn(|c| config_store.setting.app.get(c, ACL_RULES_KEY))
        .unwrap_or(None)
        .unwrap_or_else(|| "[]".to_string())
}

/// 保存 ACL 规则 JSON 到 app_setting
pub fn save_acl_rules_json(config_store: &memos_core::ConfigStore, json: &str) -> Result<(), LanError> {
    config_store
        .with_conn(|c| config_store.setting.app.upsert(c, ACL_RULES_KEY, json))
        .map_err(|e| LanError::LocalStore(e.to_string()))?;
    Ok(())
}

/// 从 app_setting 读取 LAN 是否启用，默认启用。
pub fn load_enabled(config_store: &memos_core::ConfigStore) -> bool {
    config_store
        .with_conn(|c| config_store.setting.app.get(c, ENABLED_KEY))
        .unwrap_or(None)
        .map(|value| matches!(value.trim(), "1" | "true" | "TRUE" | "True"))
        .unwrap_or(true)
}

/// 保存 LAN 是否启用到 app_setting。
pub fn save_enabled(config_store: &memos_core::ConfigStore, enabled: bool) -> Result<(), LanError> {
    let value = if enabled { "true" } else { "false" };
    config_store
        .with_conn(|c| config_store.setting.app.upsert(c, ENABLED_KEY, value))
        .map_err(|e| LanError::LocalStore(e.to_string()))?;
    Ok(())
}
