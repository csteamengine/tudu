#![allow(unexpected_cfgs)]

mod config;
mod obsidian;
mod store;

use crate::config::Config;
use crate::obsidian::ObsidianVaultStore;
use crate::store::{Task, TaskNode, TaskStore};
use notify::{RecommendedWatcher, RecursiveMode, Watcher};
use parking_lot::Mutex;
use std::fs;
use std::path::{Path, PathBuf};
use tauri::{
    menu::{MenuBuilder, MenuItemBuilder, PredefinedMenuItem},
    tray::TrayIconBuilder,
    AppHandle, Emitter, Manager, Monitor, PhysicalPosition, PhysicalSize, WindowEvent,
};
use tauri_plugin_global_shortcut::{GlobalShortcutExt, Shortcut, ShortcutState};

struct AppState {
    config: Mutex<Config>,
    watcher: Mutex<Option<RecommendedWatcher>>,
    suppress_hide: Mutex<bool>,
}

impl AppState {
    fn new(cfg: Config) -> Self {
        Self {
            config: Mutex::new(cfg),
            watcher: Mutex::new(None),
            suppress_hide: Mutex::new(false),
        }
    }
}

fn sanitize_list_name(name: &str) -> Result<String, String> {
    let trimmed = name.trim();
    if trimmed.is_empty() {
        return Err("list name required".into());
    }
    if trimmed.chars().any(|c| matches!(c, '/' | '\\' | ':' | '\0')) {
        return Err("invalid characters in list name".into());
    }
    Ok(trimmed.to_string())
}

fn list_file(folder: &Path, name: &str) -> PathBuf {
    folder.join(format!("{}.md", name))
}

fn store_for(state: &AppState, name: &str) -> Result<ObsidianVaultStore, String> {
    let name = sanitize_list_name(name)?;
    let folder = state.config.lock().vault_folder.clone();
    let path = list_file(&folder, &name);
    if !path.exists() {
        return Err(format!("list '{}' does not exist", name));
    }
    Ok(ObsidianVaultStore::new(path))
}

fn spawn_watcher(app: AppHandle, folder: PathBuf) -> Option<RecommendedWatcher> {
    let handle = app.clone();
    fs::create_dir_all(&folder).ok();
    let mut watcher = notify::recommended_watcher(move |res: notify::Result<notify::Event>| {
        if let Ok(ev) = res {
            use notify::EventKind::*;
            if matches!(ev.kind, Modify(_) | Create(_) | Remove(_)) {
                let _ = handle.emit("tasks-changed", ());
            }
        }
    })
    .ok()?;
    watcher.watch(&folder, RecursiveMode::NonRecursive).ok()?;
    Some(watcher)
}

#[tauri::command]
fn list_lists(state: tauri::State<AppState>) -> Result<Vec<String>, String> {
    let folder = state.config.lock().vault_folder.clone();
    fs::create_dir_all(&folder).map_err(|e| e.to_string())?;
    let mut names: Vec<String> = Vec::new();
    for entry in fs::read_dir(&folder).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        let path = entry.path();
        if path.is_file() && path.extension().and_then(|s| s.to_str()) == Some("md") {
            if let Some(stem) = path.file_stem().and_then(|s| s.to_str()) {
                names.push(stem.to_string());
            }
        }
    }
    names.sort_by_key(|s| s.to_lowercase());
    Ok(names)
}

#[tauri::command]
fn create_list(name: String, state: tauri::State<AppState>) -> Result<String, String> {
    let name = sanitize_list_name(&name)?;
    let folder = state.config.lock().vault_folder.clone();
    fs::create_dir_all(&folder).map_err(|e| e.to_string())?;
    let path = list_file(&folder, &name);
    if path.exists() {
        return Err(format!("a list named '{}' already exists", name));
    }
    fs::write(&path, "").map_err(|e| e.to_string())?;
    Ok(name)
}

#[tauri::command]
fn delete_list(name: String, state: tauri::State<AppState>) -> Result<(), String> {
    let name = sanitize_list_name(&name)?;
    let folder = state.config.lock().vault_folder.clone();
    let path = list_file(&folder, &name);
    if path.exists() {
        fs::remove_file(&path).map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
fn list_tasks(list: String, state: tauri::State<AppState>) -> Result<Vec<Task>, String> {
    store_for(&state, &list)?.list()
}

#[tauri::command]
fn add_task(
    list: String,
    text: String,
    parent: Option<String>,
    state: tauri::State<AppState>,
) -> Result<Task, String> {
    store_for(&state, &list)?.add(&text, parent.as_deref())
}

#[tauri::command]
fn toggle_task(
    list: String,
    id: String,
    done: bool,
    state: tauri::State<AppState>,
) -> Result<(), String> {
    store_for(&state, &list)?.set_done(&id, done)
}

#[tauri::command]
fn edit_task(
    list: String,
    id: String,
    text: String,
    state: tauri::State<AppState>,
) -> Result<(), String> {
    store_for(&state, &list)?.set_text(&id, text.as_str())
}

#[tauri::command]
fn delete_task(
    list: String,
    id: String,
    state: tauri::State<AppState>,
) -> Result<(), String> {
    store_for(&state, &list)?.delete(&id)
}

#[tauri::command]
fn replace_tasks(
    list: String,
    tree: Vec<TaskNode>,
    state: tauri::State<AppState>,
) -> Result<(), String> {
    store_for(&state, &list)?.replace(&tree)
}

#[tauri::command]
fn get_config(state: tauri::State<AppState>) -> Config {
    state.config.lock().clone()
}

#[tauri::command]
fn set_config(
    mut new_config: Config,
    app: AppHandle,
    state: tauri::State<AppState>,
) -> Result<(), String> {
    let current = state.config.lock().clone();
    let old_folder = current.vault_folder.clone();
    let old_hotkey = current.hotkey.clone();

    if new_config.vault_folder.as_os_str().is_empty() {
        new_config.vault_folder = old_folder.clone();
    }
    if new_config.hotkey.trim().is_empty() {
        new_config.hotkey = old_hotkey.clone();
    }

    new_config.monitor_positions = current.monitor_positions;
    new_config.window_width = new_config.window_width.or(current.window_width);
    new_config.window_height = new_config.window_height.or(current.window_height);
    if new_config.last_list.is_none() {
        new_config.last_list = current.last_list;
    }

    config::save(&new_config).map_err(|e| e.to_string())?;

    if new_config.vault_folder != old_folder {
        let w = spawn_watcher(app.clone(), new_config.vault_folder.clone());
        *state.watcher.lock() = w;
    }

    if new_config.hotkey != old_hotkey {
        register_hotkey(&app, &old_hotkey, &new_config.hotkey)?;
    }

    *state.config.lock() = new_config;
    let _ = app.emit("tasks-changed", ());
    Ok(())
}

#[tauri::command]
fn set_last_list(name: Option<String>, state: tauri::State<AppState>) -> Result<(), String> {
    let mut cfg = state.config.lock();
    cfg.last_list = name;
    config::save(&cfg).map_err(|e| e.to_string())
}

#[cfg(target_os = "macos")]
#[allow(deprecated, unexpected_cfgs)]
fn set_accessory_app_policy() {
    use cocoa::appkit::{NSApp, NSApplication, NSApplicationActivationPolicy};
    unsafe {
        let app = NSApp();
        app.setActivationPolicy_(
            NSApplicationActivationPolicy::NSApplicationActivationPolicyAccessory,
        );
    }
}

#[cfg(target_os = "macos")]
#[allow(deprecated, unexpected_cfgs)]
fn apply_panel_behavior(win: &tauri::WebviewWindow) {
    use cocoa::base::id;
    use objc::declare::ClassDecl;
    use objc::runtime::{Class, Object, Sel, BOOL, YES};
    use objc::{msg_send, sel, sel_impl};

    extern "C" {
        fn object_setClass(obj: *mut Object, cls: *const Class) -> *const Class;
    }

    extern "C" fn can_become_key(_: &Object, _: Sel) -> BOOL { YES }
    extern "C" fn can_become_main(_: &Object, _: Sel) -> BOOL { YES }

    fn register_tudu_panel_class() -> Option<&'static Class> {
        if let Some(cls) = Class::get("TuduPanel") {
            return Some(cls);
        }
        let superclass = Class::get("NSPanel")?;
        let mut decl = ClassDecl::new("TuduPanel", superclass)?;
        unsafe {
            decl.add_method(
                sel!(canBecomeKeyWindow),
                can_become_key as extern "C" fn(&Object, Sel) -> BOOL,
            );
            decl.add_method(
                sel!(canBecomeMainWindow),
                can_become_main as extern "C" fn(&Object, Sel) -> BOOL,
            );
        }
        Some(decl.register())
    }

    let Ok(ns_ptr) = win.ns_window() else { return };
    if ns_ptr.is_null() { return; }
    let ns_window: id = ns_ptr as id;

    unsafe {
        if let Some(panel_class) = register_tudu_panel_class() {
            let obj: *mut Object = ns_window as *mut Object;
            object_setClass(obj, panel_class as *const Class);
        }

        let nonactivating: u64 = 1 << 7;
        let current_mask: u64 = msg_send![ns_window, styleMask];
        let _: () = msg_send![ns_window, setStyleMask: current_mask | nonactivating];

        let behavior: u64 = (1 << 0) | (1 << 8) | (1 << 4);
        let _: () = msg_send![ns_window, setCollectionBehavior: behavior];

        let _: () = msg_send![ns_window, setLevel: 25i64];

        let yes: bool = true;
        let _: () = msg_send![ns_window, setFloatingPanel: yes];
        let _: () = msg_send![ns_window, setHidesOnDeactivate: false];
        let _: () = msg_send![ns_window, setBecomesKeyOnlyIfNeeded: false];
        let _: () = msg_send![ns_window, setHasShadow: yes];
    }
}

#[cfg(target_os = "macos")]
#[allow(deprecated, unexpected_cfgs)]
fn ns_display_ids_by_index() -> Vec<u32> {
    use cocoa::base::{id, nil};
    use cocoa::foundation::NSString;
    use objc::runtime::Class;
    use objc::{msg_send, sel, sel_impl};

    unsafe {
        let Some(nsscreen) = Class::get("NSScreen") else { return vec![] };
        let screens: id = msg_send![nsscreen, screens];
        if screens == nil { return vec![]; }
        let count: usize = msg_send![screens, count];
        let mut out = Vec::with_capacity(count);
        for i in 0..count {
            let s: id = msg_send![screens, objectAtIndex: i];
            let desc: id = msg_send![s, deviceDescription];
            let key = NSString::alloc(nil).init_str("NSScreenNumber");
            let num: id = msg_send![desc, objectForKey: key];
            let id_val: u32 = if num == nil { 0 } else { msg_send![num, unsignedIntValue] };
            out.push(id_val);
        }
        out
    }
}

#[cfg(target_os = "macos")]
#[allow(deprecated, unexpected_cfgs)]
fn cursor_display_id() -> Option<(u32, usize)> {
    use cocoa::base::{id, nil};
    use cocoa::foundation::NSString;
    use objc::runtime::Class;
    use objc::{msg_send, sel, sel_impl};

    #[repr(C)]
    #[derive(Copy, Clone)]
    struct NSPoint { x: f64, y: f64 }
    #[repr(C)]
    #[derive(Copy, Clone)]
    struct NSSize { w: f64, h: f64 }
    #[repr(C)]
    #[derive(Copy, Clone)]
    struct NSRect { origin: NSPoint, size: NSSize }

    unsafe {
        let nsevent = Class::get("NSEvent")?;
        let nsscreen = Class::get("NSScreen")?;
        let loc: NSPoint = msg_send![nsevent, mouseLocation];
        let screens: id = msg_send![nsscreen, screens];
        if screens == nil { return None; }
        let count: usize = msg_send![screens, count];
        for i in 0..count {
            let s: id = msg_send![screens, objectAtIndex: i];
            let frame: NSRect = msg_send![s, frame];
            if loc.x >= frame.origin.x
                && loc.x < frame.origin.x + frame.size.w
                && loc.y >= frame.origin.y
                && loc.y < frame.origin.y + frame.size.h
            {
                let desc: id = msg_send![s, deviceDescription];
                let key_str = NSString::alloc(nil).init_str("NSScreenNumber");
                let num: id = msg_send![desc, objectForKey: key_str];
                let id_val: u32 = if num == nil { 0 } else { msg_send![num, unsignedIntValue] };
                return Some((id_val, i));
            }
        }
        None
    }
}

#[cfg(target_os = "macos")]
fn monitor_under_cursor(app: &AppHandle) -> Option<Monitor> {
    let (_display_id, idx) = cursor_display_id()?;
    app.available_monitors().ok()?.into_iter().nth(idx)
}

#[cfg(target_os = "macos")]
#[allow(deprecated, unexpected_cfgs)]
fn is_window_key(win: &tauri::WebviewWindow) -> bool {
    use cocoa::base::id;
    use objc::{msg_send, sel, sel_impl};
    let Ok(ns_ptr) = win.ns_window() else { return false };
    if ns_ptr.is_null() { return false; }
    let ns_window: id = ns_ptr as id;
    unsafe {
        let is_key: bool = msg_send![ns_window, isKeyWindow];
        is_key
    }
}

#[cfg(target_os = "macos")]
#[allow(deprecated, unexpected_cfgs)]
fn set_window_alpha(win: &tauri::WebviewWindow, alpha: f64) {
    use cocoa::base::id;
    use objc::{msg_send, sel, sel_impl};
    let Ok(ns_ptr) = win.ns_window() else { return };
    if ns_ptr.is_null() { return; }
    let ns_window: id = ns_ptr as id;
    unsafe {
        let _: () = msg_send![ns_window, setAlphaValue: alpha];
    }
}

#[cfg(target_os = "macos")]
#[allow(deprecated, unexpected_cfgs)]
fn animate_window_alpha(win: &tauri::WebviewWindow, alpha: f64, duration: f64) {
    use cocoa::base::id;
    use objc::runtime::Class;
    use objc::{msg_send, sel, sel_impl};

    let Ok(ns_ptr) = win.ns_window() else { return };
    if ns_ptr.is_null() { return; }
    let ns_window: id = ns_ptr as id;
    unsafe {
        let Some(ctx_class) = Class::get("NSAnimationContext") else {
            let _: () = msg_send![ns_window, setAlphaValue: alpha];
            return;
        };
        let _: () = msg_send![ctx_class, beginGrouping];
        let current: id = msg_send![ctx_class, currentContext];
        let _: () = msg_send![current, setDuration: duration];
        let animator: id = msg_send![ns_window, animator];
        let _: () = msg_send![animator, setAlphaValue: alpha];
        let _: () = msg_send![ctx_class, endGrouping];
    }
}

#[cfg(target_os = "macos")]
fn fade_reposition(app: &AppHandle, monitor: Monitor) {
    let Some(win) = app.get_webview_window("main") else { return };
    let win_out = win.clone();
    let app_out = app.clone();
    let _ = app_out.run_on_main_thread(move || animate_window_alpha(&win_out, 0.0, 0.08));

    std::thread::sleep(std::time::Duration::from_millis(95));

    let app_in = app.clone();
    let _ = app_in.clone().run_on_main_thread(move || {
        position_on_monitor(&app_in, &monitor);
        if let Some(w) = app_in.get_webview_window("main") {
            animate_window_alpha(&w, 1.0, 0.18);
        }
    });
}

#[cfg(target_os = "macos")]
#[allow(deprecated, unexpected_cfgs)]
fn order_front_without_activating(win: &tauri::WebviewWindow) {
    use cocoa::base::id;
    use objc::{msg_send, sel, sel_impl};

    let Ok(ns_ptr) = win.ns_window() else { return };
    if ns_ptr.is_null() { return; }
    let ns_window: id = ns_ptr as id;
    unsafe {
        let nil: id = std::ptr::null_mut();
        let _: () = msg_send![ns_window, makeKeyAndOrderFront: nil];
    }
}

fn monitor_key(m: &Monitor, app: &AppHandle) -> String {
    #[cfg(target_os = "macos")]
    {
        let target_pos = m.position();
        let target_size = m.size();
        if let Ok(monitors) = app.available_monitors() {
            for (i, candidate) in monitors.iter().enumerate() {
                if candidate.position() == target_pos && candidate.size() == target_size {
                    let ids = ns_display_ids_by_index();
                    if let Some(&id) = ids.get(i) {
                        if id != 0 {
                            return format!("display-{}", id);
                        }
                    }
                    break;
                }
            }
        }
    }
    let _ = app;
    if let Some(name) = m.name() {
        if !name.is_empty() {
            return name.to_string();
        }
    }
    let pos = m.position();
    let sz = m.size();
    format!("{}x{}@{},{}", sz.width, sz.height, pos.x, pos.y)
}

fn monitor_containing(app: &AppHandle, x: i32, y: i32) -> Option<Monitor> {
    app.available_monitors().ok()?.into_iter().find(|m| {
        let p = m.position();
        let s = m.size();
        x >= p.x && x < p.x + s.width as i32 && y >= p.y && y < p.y + s.height as i32
    })
}

fn resolve_monitor_rect(cfg: &Config, monitor: &Monitor, app: &AppHandle) -> (i32, i32, u32, u32) {
    let key = monitor_key(monitor, app);
    if let Some(stored) = cfg.monitor_positions.get(&key) {
        return (stored.x, stored.y, stored.width, stored.height);
    }
    let m_pos = monitor.position();
    let m_size = monitor.size();
    let scale = monitor.scale_factor();
    let default_w = cfg.window_width.unwrap_or(520);
    let default_h = cfg.window_height.unwrap_or(560);
    let phys_w = (default_w as f64 * scale) as u32;
    let phys_h = (default_h as f64 * scale) as u32;
    let x = m_pos.x + (m_size.width as i32 - phys_w as i32) / 2;
    let y = m_pos.y + (m_size.height as i32 - phys_h as i32) / 2;
    (x, y, phys_w, phys_h)
}

fn position_on_monitor(app: &AppHandle, monitor: &Monitor) {
    let Some(win) = app.get_webview_window("main") else { return };
    let cfg = app.state::<AppState>().config.lock().clone();
    let (x, y, w, h) = resolve_monitor_rect(&cfg, monitor, app);
    let _ = win.set_size(PhysicalSize::new(w, h));
    let _ = win.set_position(PhysicalPosition::new(x, y));
}

fn save_monitor_rect_for(
    app: &AppHandle,
    cfg: &mut Config,
    pos: PhysicalPosition<i32>,
    size: PhysicalSize<u32>,
) {
    let center_x = pos.x + size.width as i32 / 2;
    let center_y = pos.y + size.height as i32 / 2;
    if let Some(monitor) = monitor_containing(app, center_x, center_y) {
        let key = monitor_key(&monitor, app);
        let entry = cfg.monitor_positions.entry(key).or_default();
        entry.x = pos.x;
        entry.y = pos.y;
        entry.width = size.width;
        entry.height = size.height;
    }
}

fn summon_window(app: &AppHandle) {
    let Some(win) = app.get_webview_window("main") else { return };

    #[cfg(target_os = "macos")]
    let monitor = monitor_under_cursor(app)
        .or_else(|| app.primary_monitor().ok().flatten());

    #[cfg(not(target_os = "macos"))]
    let monitor = app
        .cursor_position()
        .ok()
        .and_then(|p| monitor_containing(app, p.x as i32, p.y as i32))
        .or_else(|| app.primary_monitor().ok().flatten());

    if let Some(m) = monitor.as_ref() {
        position_on_monitor(app, m);
    }

    #[cfg(target_os = "macos")]
    set_window_alpha(&win, 1.0);

    let _ = win.show();

    #[cfg(target_os = "macos")]
    order_front_without_activating(&win);

    #[cfg(not(target_os = "macos"))]
    let _ = win.set_focus();

    let _ = app.emit("window-shown", ());
}

#[tauri::command]
fn toggle_window(app: AppHandle) {
    if let Some(win) = app.get_webview_window("main") {
        if win.is_visible().unwrap_or(false) {
            let _ = win.hide();
        } else {
            summon_window(&app);
        }
    }
}

#[tauri::command]
fn set_suppress_hide(suppress: bool, state: tauri::State<AppState>) {
    *state.suppress_hide.lock() = suppress;
}

#[derive(serde::Serialize)]
struct VaultInfo {
    name: String,
    subpath: String,
}

#[tauri::command]
fn get_vault_info(state: tauri::State<AppState>) -> Option<VaultInfo> {
    let folder = PathBuf::from(&state.config.lock().vault_folder);
    let mut dir = folder.as_path();
    let mut segments: Vec<String> = Vec::new();
    loop {
        if dir.join(".obsidian").is_dir() {
            let name = dir.file_name()?.to_string_lossy().to_string();
            segments.reverse();
            return Some(VaultInfo { name, subpath: segments.join("/") });
        }
        match dir.parent() {
            Some(p) if p != dir => {
                if let Some(seg) = dir.file_name() {
                    segments.push(seg.to_string_lossy().to_string());
                }
                dir = p;
            }
            _ => return None,
        }
    }
}

#[tauri::command]
fn get_version() -> &'static str {
    env!("CARGO_PKG_VERSION")
}

#[tauri::command]
fn open_url(url: String) -> Result<(), String> {
    let scheme_ok = url.starts_with("http://")
        || url.starts_with("https://")
        || url.starts_with("mailto:")
        || url.starts_with("obsidian://");
    if !scheme_ok {
        return Err(format!("refusing to open url with disallowed scheme: {}", url));
    }
    let is_web = url.starts_with("http://") || url.starts_with("https://");
    #[cfg(target_os = "macos")]
    {
        if is_web {
            let status = std::process::Command::new("open")
                .args(["-a", "Google Chrome", &url])
                .status()
                .map_err(|e| e.to_string())?;
            if !status.success() {
                std::process::Command::new("open")
                    .arg(&url)
                    .spawn()
                    .map_err(|e| e.to_string())?;
            }
        } else {
            std::process::Command::new("open")
                .arg(&url)
                .spawn()
                .map_err(|e| e.to_string())?;
        }
    }
    #[cfg(target_os = "linux")]
    {
        if is_web {
            let _ = std::process::Command::new("google-chrome")
                .arg(&url)
                .spawn()
                .or_else(|_| std::process::Command::new("xdg-open").arg(&url).spawn())
                .map_err(|e| e.to_string())?;
        } else {
            std::process::Command::new("xdg-open")
                .arg(&url)
                .spawn()
                .map_err(|e| e.to_string())?;
        }
    }
    #[cfg(target_os = "windows")]
    {
        if is_web {
            std::process::Command::new("cmd")
                .args(["/C", "start", "chrome", &url])
                .spawn()
                .map_err(|e| e.to_string())?;
        } else {
            std::process::Command::new("cmd")
                .args(["/C", "start", "", &url])
                .spawn()
                .map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}

#[tauri::command]
fn hide_window(app: AppHandle) {
    if let Some(win) = app.get_webview_window("main") {
        let _ = win.hide();
    }
}

fn parse_shortcut(s: &str) -> Result<Shortcut, String> {
    s.parse::<Shortcut>().map_err(|e| format!("invalid shortcut '{}': {}", s, e))
}

fn register_hotkey(app: &AppHandle, old: &str, new: &str) -> Result<(), String> {
    let gs = app.global_shortcut();
    if !old.is_empty() {
        if let Ok(sc) = parse_shortcut(old) {
            let _ = gs.unregister(sc);
        }
    }
    let sc = parse_shortcut(new)?;
    gs.register(sc).map_err(|e| e.to_string())?;
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let cfg = config::load();
    let state = AppState::new(cfg.clone());

    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(
            tauri_plugin_global_shortcut::Builder::new()
                .with_handler(|app, shortcut, event| {
                    if event.state == ShortcutState::Pressed {
                        let cfg = app.state::<AppState>().config.lock().clone();
                        if let Ok(registered) = parse_shortcut(&cfg.hotkey) {
                            if registered == *shortcut {
                                toggle_window(app.clone());
                            }
                        }
                    }
                })
                .build(),
        )
        .manage(state)
        .invoke_handler(tauri::generate_handler![
            list_lists,
            create_list,
            delete_list,
            list_tasks,
            add_task,
            toggle_task,
            edit_task,
            delete_task,
            replace_tasks,
            get_config,
            set_config,
            set_last_list,
            toggle_window,
            hide_window,
            set_suppress_hide,
            open_url,
            get_vault_info,
            get_version,
        ])
        .on_window_event(|window, event| {
            if window.label() != "main" {
                return;
            }
            let app = window.app_handle();
            match event {
                WindowEvent::Focused(false) => {
                    let state = app.state::<AppState>();
                    let sticky = state.config.lock().sticky;
                    let suppress = *state.suppress_hide.lock();
                    if !sticky && !suppress {
                        let _ = window.hide();
                    }
                }
                _ => {}
            }
        })
        .setup(move |app| {
            let handle = app.handle().clone();
            let state = handle.state::<AppState>();
            let cfg = state.config.lock().clone();

            if let Some(w) = spawn_watcher(handle.clone(), cfg.vault_folder.clone()) {
                *state.watcher.lock() = Some(w);
            }

            if let Err(e) = register_hotkey(&handle, "", &cfg.hotkey) {
                eprintln!("hotkey registration failed: {}", e);
            }

            #[cfg(target_os = "macos")]
            set_accessory_app_policy();

            let open_item = MenuItemBuilder::with_id("open", "Open Tudu").build(app)?;
            let settings_item = MenuItemBuilder::with_id("settings", "Settings…").build(app)?;
            let updates_item = MenuItemBuilder::with_id("check-updates", "Check for Updates…").build(app)?;
            let quit_item = PredefinedMenuItem::quit(app, None)?;
            let tray_menu = MenuBuilder::new(app)
                .items(&[&open_item, &settings_item, &updates_item])
                .separator()
                .item(&quit_item)
                .build()?;
            let icon = app
                .default_window_icon()
                .cloned()
                .expect("bundled window icon missing");
            let _ = TrayIconBuilder::with_id("tudu-tray")
                .icon(icon)
                .icon_as_template(true)
                .menu(&tray_menu)
                .show_menu_on_left_click(true)
                .on_menu_event(|app, event| match event.id().as_ref() {
                    "open" => summon_window(app),
                    "settings" => {
                        summon_window(app);
                        let _ = app.emit("open-settings", ());
                    }
                    "check-updates" => {
                        summon_window(app);
                        let _ = app.emit("open-settings", ());
                        let _ = app.emit("check-updates", ());
                    }
                    _ => {}
                })
                .build(app)?;

            if let Some(win) = handle.get_webview_window("main") {
                #[cfg(target_os = "macos")]
                {
                    use window_vibrancy::{apply_vibrancy, NSVisualEffectMaterial, NSVisualEffectState};
                    let _ = apply_vibrancy(
                        &win,
                        NSVisualEffectMaterial::HudWindow,
                        Some(NSVisualEffectState::Active),
                        Some(14.0),
                    );
                    apply_panel_behavior(&win);
                }
            }

            let follow_handle = handle.clone();
            std::thread::spawn(move || {
                let mut last_monitor: Option<String> = None;
                let mut pending: Option<(String, u8)> = None;
                const DEBOUNCE_TICKS: u8 = 2;
                let mut was_key = false;
                let mut last_seen_rect: Option<(i32, i32, u32, u32)> = None;
                let mut last_saved_rect: Option<(i32, i32, u32, u32)> = None;
                loop {
                    std::thread::sleep(std::time::Duration::from_millis(120));
                    let Some(win) = follow_handle.get_webview_window("main") else { continue };
                    if !win.is_visible().unwrap_or(false) {
                        was_key = false;
                        last_monitor = None;
                        last_seen_rect = None;
                        continue;
                    }

                    let state = follow_handle.state::<AppState>();
                    let sticky = state.config.lock().sticky;
                    let suppress = *state.suppress_hide.lock();

                    #[cfg(target_os = "macos")]
                    {
                        let is_key = is_window_key(&win);
                        if is_key {
                            was_key = true;
                        } else if was_key && !sticky && !suppress {
                            let _ = win.hide();
                            was_key = false;
                            last_monitor = None;
                            last_seen_rect = None;
                            continue;
                        }
                    }

                    // Debounced save: record rect when it's been stable for one tick
                    // (~120ms). This avoids overwriting the origin monitor's position
                    // with mid-crossing values while the user drags across displays.
                    if let (Ok(pos), Ok(size)) = (win.outer_position(), win.outer_size()) {
                        let current = (pos.x, pos.y, size.width, size.height);
                        if Some(current) == last_seen_rect && Some(current) != last_saved_rect {
                            let cfg_state = follow_handle.state::<AppState>();
                            let mut cfg = cfg_state.config.lock();
                            save_monitor_rect_for(&follow_handle, &mut cfg, pos, size);
                            if let Ok(scale) = win.scale_factor() {
                                let logical = size.to_logical::<f64>(scale);
                                cfg.window_width = Some(logical.width.max(0.0) as u32);
                                cfg.window_height = Some(logical.height.max(0.0) as u32);
                            }
                            let _ = config::save(&cfg);
                            last_saved_rect = Some(current);
                        }
                        last_seen_rect = Some(current);
                    }

                    if !sticky {
                        last_monitor = None;
                        pending = None;
                        continue;
                    }
                    #[cfg(target_os = "macos")]
                    let monitor_opt = monitor_under_cursor(&follow_handle);
                    #[cfg(not(target_os = "macos"))]
                    let monitor_opt = follow_handle
                        .cursor_position()
                        .ok()
                        .and_then(|c| monitor_containing(&follow_handle, c.x as i32, c.y as i32));
                    let Some(monitor) = monitor_opt else { continue };
                    let key = monitor_key(&monitor, &follow_handle);

                    if last_monitor.as_deref() == Some(&key) {
                        pending = None;
                        continue;
                    }

                    let commit = match &pending {
                        Some((pkey, count)) if *pkey == key => {
                            let next = count.saturating_add(1);
                            if next >= DEBOUNCE_TICKS {
                                true
                            } else {
                                pending = Some((pkey.clone(), next));
                                false
                            }
                        }
                        _ => {
                            pending = Some((key.clone(), 1));
                            false
                        }
                    };

                    if commit {
                        let had_previous = last_monitor.is_some();
                        last_monitor = Some(key);
                        pending = None;
                        last_saved_rect = None;
                        last_seen_rect = None;

                        if had_previous {
                            #[cfg(target_os = "macos")]
                            fade_reposition(&follow_handle, monitor);
                            #[cfg(not(target_os = "macos"))]
                            position_on_monitor(&follow_handle, &monitor);
                        }
                    }
                }
            });

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
