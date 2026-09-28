//! System Tray（系统托盘）模块
//!
//! 在系统托盘区创建应用图标，并挂载三个菜单项：
//! - 显示窗口：还原并聚焦主窗口
//! - 记笔记：显示主窗口并 emit 事件，通知前端以聚焦模式打开记笔记窗口
//! - 退出：复用统一的退出清理流程（LAN/LLM/MCP 等资源回收）
//!
//! 同时负责「点击关闭按钮隐藏到托盘」：拦截主窗口的 CloseRequested，
//! 隐藏窗口而不销毁它，应用继续在后台运行，退出只能通过托盘菜单触发。

use std::sync::atomic::{AtomicBool, Ordering};

use tauri::{
    menu::{Menu, MenuEvent, MenuItem},
    tray::TrayIconBuilder,
    AppHandle, Emitter, Manager, Runtime, Window, WindowEvent,
};

/// 托盘图标 id，需要时可通过 `app.tray_by_id(TRAY_ID)` 取回
pub const TRAY_ID: &str = "main-tray";

/// 主窗口 label，与 tauri.conf.json 中 app.windows[0].label 保持一致
const MAIN_WINDOW_LABEL: &str = "main";

/// 托盘是否创建成功。创建失败时关闭窗口必须保持默认行为（退出应用），
/// 否则窗口隐藏后既没有托盘图标也无法唤回，应用会变成「僵尸进程」。
static TRAY_READY: AtomicBool = AtomicBool::new(false);

/// 菜单项 id
const MENU_ID_SHOW_WINDOW: &str = "tray_show_window";
const MENU_ID_NEW_NOTE: &str = "tray_new_note";
const MENU_ID_QUIT: &str = "tray_quit";

/// 通知前端打开记笔记窗口的事件名。
/// 必须与 src/contexts/NewNoteWindowContext.tsx 中的 OPEN_NEW_NOTE_EVENT 保持一致。
const EVENT_OPEN_NEW_NOTE: &str = "open-new-memo";

/// 初始化系统托盘：创建图标、菜单，并绑定菜单事件处理。
///
/// 托盘图标复用应用默认窗口图标（来自 tauri.conf.json 的 bundle.icon），
/// 因此不需要额外的图标资源文件。托盘图标由 Tauri 资源表持有，
/// 返回值无需保存。
pub fn init<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<()> {
    let show_window = MenuItem::with_id(app, MENU_ID_SHOW_WINDOW, "显示窗口", true, None::<&str>)?;
    let new_note = MenuItem::with_id(app, MENU_ID_NEW_NOTE, "记笔记", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, MENU_ID_QUIT, "退出", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&show_window, &new_note, &quit])?;

    let mut builder = TrayIconBuilder::with_id(TRAY_ID)
        .menu(&menu)
        // Windows 上默认即左键单击弹出菜单，这里显式声明以表明意图
        .show_menu_on_left_click(true)
        .tooltip("破碎星球")
        .on_menu_event(on_menu_event);

    if let Some(icon) = app.default_window_icon() {
        builder = builder.icon(icon.clone());
    }

    builder.build(app)?;
    TRAY_READY.store(true, Ordering::SeqCst);

    tracing::info!(pid = std::process::id(), "系统托盘初始化完成");
    Ok(())
}

/// 判断托盘是否可用（已成功创建）
pub fn is_ready() -> bool {
    TRAY_READY.load(Ordering::SeqCst)
}

/// 窗口事件处理，通过 `Builder::on_window_event` 注册。
///
/// 主窗口的关闭请求不销毁窗口，而是隐藏到系统托盘：
/// 这样 webview 与前端状态得以保留，同时避免「最后一个窗口关闭」触发应用退出。
/// 托盘不可用时不做拦截，保持默认的「关闭即退出」行为。
pub fn on_window_event<R: Runtime>(window: &Window<R>, event: &WindowEvent) {
    let WindowEvent::CloseRequested { api, .. } = event else {
        return;
    };
    if window.label() != MAIN_WINDOW_LABEL {
        return;
    }
    if !is_ready() {
        tracing::warn!("系统托盘不可用，关闭主窗口将直接退出应用");
        return;
    }

    api.prevent_close();
    match window.hide() {
        Ok(()) => tracing::info!(
            pid = std::process::id(),
            "主窗口已隐藏到系统托盘，应用继续在后台运行"
        ),
        Err(e) => tracing::warn!("系统托盘：隐藏主窗口失败: {}", e),
    }
}

/// 托盘菜单事件分发
fn on_menu_event<R: Runtime>(app: &AppHandle<R>, event: MenuEvent) {
    match event.id().as_ref() {
        MENU_ID_SHOW_WINDOW => show_main_window(app),
        MENU_ID_NEW_NOTE => open_new_note(app),
        MENU_ID_QUIT => quit_app(app),
        other => tracing::warn!("系统托盘：收到未处理的菜单项 id={}", other),
    }
}

/// 显示窗口：还原（若已最小化）并聚焦主窗口
fn show_main_window<R: Runtime>(app: &AppHandle<R>) {
    let Some(window) = app.get_webview_window(MAIN_WINDOW_LABEL) else {
        tracing::warn!("系统托盘：未找到主窗口 label={}", MAIN_WINDOW_LABEL);
        return;
    };
    if let Err(e) = window.show() {
        tracing::warn!("系统托盘：显示主窗口失败: {}", e);
    }
    if let Err(e) = window.unminimize() {
        tracing::warn!("系统托盘：还原主窗口失败: {}", e);
    }
    if let Err(e) = window.set_focus() {
        tracing::warn!("系统托盘：聚焦主窗口失败: {}", e);
    }
}

/// 记笔记：先把主窗口显示出来（可能刚从托盘隐藏/最小化状态恢复），
/// 再通知前端以聚焦模式打开记笔记窗口。
///
/// 系统托盘菜单与全局热键（`crate::hotkey`）共用此入口。
pub(crate) fn open_new_note<R: Runtime>(app: &AppHandle<R>) {
    tracing::info!(pid = std::process::id(), "系统托盘：点击「记笔记」");
    show_main_window(app);
    if let Err(e) = app.emit(EVENT_OPEN_NEW_NOTE, ()) {
        tracing::warn!("系统托盘：通知前端打开记笔记窗口失败: {}", e);
    }
}

/// 退出应用：走 RunEvent::ExitRequested 的统一清理流程
fn quit_app<R: Runtime>(app: &AppHandle<R>) {
    tracing::info!(pid = std::process::id(), "系统托盘：请求退出应用");
    app.exit(0);
}
