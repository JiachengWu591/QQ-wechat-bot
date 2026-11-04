#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod engine;

use engine::Connection;
use std::sync::atomic::{AtomicBool, Ordering};
use tauri::{
    image::Image,
    menu::{Menu, MenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    AppHandle, Emitter, Manager, State, WebviewWindow, WindowEvent, Wry,
};

const TRAY_ON: &[u8] = include_bytes!("../icons/tray-on.png");
const TRAY_OFF: &[u8] = include_bytes!("../icons/tray-off.png");

struct Shell {
    connection: Connection,
    running: AtomicBool,
    toggle_item: MenuItem<Wry>,
}

#[tauri::command]
fn engine_connection(shell: State<'_, Shell>) -> Connection {
    shell.connection.clone()
}

#[tauri::command]
fn set_running(app: AppHandle, shell: State<'_, Shell>, running: bool) -> tauri::Result<()> {
    shell.running.store(running, Ordering::SeqCst);
    shell.toggle_item.set_text(if running { "关闭总闸" } else { "打开总闸" })?;
    if let Some(tray) = app.tray_by_id("main") {
        tray.set_icon(Some(Image::from_bytes(if running { TRAY_ON } else { TRAY_OFF })?))?;
        tray.set_tooltip(Some(if running { "枢：运行中" } else { "枢：已停止" }))?;
    }
    Ok(())
}

#[tauri::command]
fn hide_window(window: WebviewWindow) -> tauri::Result<()> {
    window.hide()
}

// Exiting closes the job handle, which kills the engine and everything it started.
#[tauri::command]
fn quit_app(app: AppHandle) {
    app.exit(0);
}

fn show_console(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
    }
}

fn main() {
    engine::tie_children_to_this_process().expect("couldn't create the job object that keeps child processes from outliving the app");

    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| show_console(app)))
        .setup(|app| {
            let connection = Connection::new()?;
            let show_item = MenuItem::with_id(app, "show", "显示控制台", true, None::<&str>)?;
            let toggle_item = MenuItem::with_id(app, "toggle", "打开总闸", true, None::<&str>)?;
            let quit_item = MenuItem::with_id(app, "quit", "退出并停止全部", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&show_item, &toggle_item, &quit_item])?;

            TrayIconBuilder::with_id("main")
                .icon(Image::from_bytes(TRAY_OFF)?)
                .tooltip("枢：已停止")
                .menu(&menu)
                .show_menu_on_left_click(false)
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "show" => show_console(app),
                    "toggle" => {
                        let _ = app.emit("tray-toggle", ());
                    }
                    "quit" => app.exit(0),
                    _ => {}
                })
                .on_tray_icon_event(|tray, event| {
                    if let TrayIconEvent::Click { button: MouseButton::Left, button_state: MouseButtonState::Up, .. } = event {
                        show_console(tray.app_handle());
                    }
                })
                .build(app)?;

            engine::supervise(connection.clone(), app.handle().clone());
            app.manage(Shell { connection, running: AtomicBool::new(false), toggle_item });
            Ok(())
        })
        .on_window_event(|window, event| {
            if let WindowEvent::CloseRequested { api, .. } = event {
                // Closing a window mustn't silently leave the bot answering people, so
                // while it's running the console asks. Stopped, there's nothing to keep.
                if window.state::<Shell>().running.load(Ordering::SeqCst) {
                    api.prevent_close();
                    let _ = window.emit("close-requested", ());
                } else {
                    window.app_handle().exit(0);
                }
            }
        })
        .invoke_handler(tauri::generate_handler![engine_connection, set_running, hide_window, quit_app])
        .run(tauri::generate_context!())
        .expect("couldn't start the app");
}
