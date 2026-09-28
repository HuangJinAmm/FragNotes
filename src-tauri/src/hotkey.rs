//! 全局热键模块
//!
//! 注册系统级快捷键 Alt+W：即使主窗口未聚焦、已最小化或已隐藏到系统托盘，
//! 也能唤出窗口并以聚焦模式打开记笔记窗口。
//!
//! 唤出逻辑与托盘菜单「记笔记」共用 [`crate::tray::open_new_note`]：
//! 先显示窗口，再 emit 事件让前端打开记笔记窗口。

use tauri::{AppHandle, Runtime};
use tauri_plugin_global_shortcut::{Code, GlobalShortcutExt, Modifiers, Shortcut, ShortcutState};

/// 唤起记笔记窗口的全局热键：Alt+W
///
/// `Shortcut::new` 不是 const fn，故用函数构造。
fn new_note_shortcut() -> Shortcut {
    Shortcut::new(Some(Modifiers::ALT), Code::KeyW)
}

/// 注册全局热键。
///
/// 注册失败（例如热键已被其他程序占用）只记录告警：前端仍保留应用内的
/// Alt+W 快捷键，功能不会完全不可用。
pub fn init<R: Runtime>(app: &AppHandle<R>) {
    let result = app
        .global_shortcut()
        .on_shortcut(new_note_shortcut(), |app, shortcut, event| {
            // 按下与松开都会回调，只在按下时响应一次
            if event.state != ShortcutState::Pressed {
                return;
            }
            tracing::info!(
                pid = std::process::id(),
                shortcut = %shortcut.into_string(),
                "全局热键：唤起记笔记窗口"
            );
            crate::tray::open_new_note(app);
        });

    match result {
        Ok(()) => tracing::info!("全局热键已注册：Alt+W"),
        Err(e) => tracing::warn!("全局热键 Alt+W 注册失败（应用其他功能不受影响）: {}", e),
    }
}
