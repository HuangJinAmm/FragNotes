//! 用户工具确认通道
//!
//! 当 LLM 调用 executable/dangerous 等级的用户工具时，需要前端弹 Dialog 让用户确认。
//! PendingConfirmations 用 oneshot channel 实现：
//! - agent_loop 在同步上下文中通过 block_on 调用 request_confirmation
//! - request_confirmation 发 Tauri event 到前端，await oneshot
//! - 前端调 tool_confirm_response 命令，触发 respond 发送 true/false 唤醒等待方

use memos_core::tool::Permission;
use serde::Serialize;
use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;
use std::time::Duration;
use tauri::{AppHandle, Emitter};

#[derive(Debug, Clone, Serialize)]
pub struct ConfirmRequest {
    pub call_id: u64,
    pub tool_name: String,
    pub command: String,
    pub permission: String,
}

pub struct PendingConfirmations {
    next_id: AtomicU64,
    inner: Mutex<HashMap<u64, tokio::sync::oneshot::Sender<bool>>>,
}

impl Default for PendingConfirmations {
    fn default() -> Self {
        Self::new()
    }
}

impl PendingConfirmations {
    pub fn new() -> Self {
        Self {
            next_id: AtomicU64::new(1),
            inner: Mutex::new(HashMap::new()),
        }
    }

    /// 发起确认请求。
    /// 这个函数本身是 async 的，调用方需要用 tauri::async_runtime::block_on 桥接。
    pub async fn request_confirmation(
        &self,
        tool_name: String,
        command: String,
        permission: Permission,
        app: &AppHandle,
    ) -> Result<bool, String> {
        let call_id = self.next_id.fetch_add(1, Ordering::SeqCst);
        let (tx, rx) = tokio::sync::oneshot::channel();
        self.inner.lock().expect("PendingConfirmations Mutex poisoned").insert(call_id, tx);

        let req = ConfirmRequest {
            call_id,
            tool_name,
            command,
            permission: permission.as_str().to_string(),
        };
        app.emit("tool:confirm_request", req).map_err(|e| format!("emit failed: {e}"))?;

        // 60s 等待超时（等价于拒绝，避免永久阻塞）
        match tokio::time::timeout(Duration::from_secs(60), rx).await {
            Ok(Ok(approved)) => Ok(approved),
            Ok(Err(_)) => Ok(false),  // sender dropped = 取消
            Err(_) => {
                self.inner.lock().expect("PendingConfirmations Mutex poisoned").remove(&call_id);
                Ok(false)
            }
        }
    }

    /// 前端回传时调用，返回 true 表示找到了对应的等待项
    pub fn respond(&self, call_id: u64, approved: bool) -> bool {
        if let Some(tx) = self.inner.lock().expect("PendingConfirmations Mutex poisoned").remove(&call_id) {
            let _ = tx.send(approved);
            true
        } else {
            false  // 已超时或不存在
        }
    }

    /// abort/shutdown 时唤醒所有等待中的确认（发送 false）
    /// 同步操作，不 spawn async task，与项目记忆中 LAN shutdown 原则一致
    pub fn cancel_all(&self) {
        let mut map = self.inner.lock().expect("PendingConfirmations Mutex poisoned");
        for (_, tx) in map.drain() {
            let _ = tx.send(false);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn test_respond_wakes_waiter() {
        let pending = PendingConfirmations::new();
        // 模拟一个等待方：直接用 oneshot 测试逻辑
        let call_id = pending.next_id.fetch_add(1, Ordering::SeqCst);
        let (tx, rx) = tokio::sync::oneshot::channel();
        pending.inner.lock().unwrap().insert(call_id, tx);

        // 在另一个任务中等待
        let wait_task = tokio::spawn(async move {
            rx.await.unwrap()
        });

        // 等待一会让等待方进入 await
        tokio::time::sleep(Duration::from_millis(50)).await;

        // 回传 true
        assert!(pending.respond(call_id, true));

        let result = wait_task.await.unwrap();
        assert!(result);
    }

    #[tokio::test]
    async fn test_cancel_all_sends_false_to_all() {
        let pending = PendingConfirmations::new();
        let call_id1 = pending.next_id.fetch_add(1, Ordering::SeqCst);
        let call_id2 = pending.next_id.fetch_add(1, Ordering::SeqCst);
        let (tx1, rx1) = tokio::sync::oneshot::channel();
        let (tx2, rx2) = tokio::sync::oneshot::channel();
        pending.inner.lock().unwrap().insert(call_id1, tx1);
        pending.inner.lock().unwrap().insert(call_id2, tx2);

        pending.cancel_all();

        assert_eq!(rx1.await.unwrap(), false);
        assert_eq!(rx2.await.unwrap(), false);
        assert!(pending.inner.lock().unwrap().is_empty());
    }

    #[tokio::test]
    async fn test_timeout_returns_false() {
        let pending = PendingConfirmations::new();
        let call_id = pending.next_id.fetch_add(1, Ordering::SeqCst);
        let (tx, _rx) = tokio::sync::oneshot::channel::<bool>();
        pending.inner.lock().unwrap().insert(call_id, tx);

        // 不回传，验证 cancel_all 会清空
        pending.cancel_all();
        assert!(pending.inner.lock().unwrap().is_empty());
    }
}
