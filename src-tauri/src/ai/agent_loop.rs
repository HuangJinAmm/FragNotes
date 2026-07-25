//! Agent 循环运行态跟踪
//!
//! 通过全局原子计数器统计当前正在运行的 agent_loop 数量，
//! 供工作空间切换等敏感操作判断是否需要拦截。
//!
//! 实际 agent_loop 函数位于 `commands::ai_chat::agent_loop`，
//! 在其入口处通过 `start()` 获得 `RunningGuard`，无论该函数因何原因
//! （正常返回、错误、abort）退出，guard 的 Drop 都会自动递减计数器。

use std::sync::atomic::{AtomicUsize, Ordering};

/// 全局运行中 agent_loop 计数器
static RUNNING_COUNT: AtomicUsize = AtomicUsize::new(0);

/// RAII guard：构造时递增计数器，Drop 时递减，保证异常/提前返回路径也能正确收尾。
pub struct RunningGuard {
    _private: (),
}

impl RunningGuard {
    fn new() -> Self {
        RUNNING_COUNT.fetch_add(1, Ordering::SeqCst);
        RunningGuard { _private: () }
    }
}

impl Drop for RunningGuard {
    fn drop(&mut self) {
        RUNNING_COUNT.fetch_sub(1, Ordering::SeqCst);
    }
}

/// 在 agent_loop 入口调用，返回 guard 持续到函数退出。
pub fn start() -> RunningGuard {
    RunningGuard::new()
}

/// 检查是否有任何 agent_loop 正在运行
pub fn is_any_running() -> bool {
    RUNNING_COUNT.load(Ordering::SeqCst) > 0
}
