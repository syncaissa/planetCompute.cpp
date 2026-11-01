// The icon in the system tray (Windows notification area, macOS menu bar, Linux with an AppIndicator host): open the
// window, stop contributing, quit. The window's close button hides the window here, so the program keeps working
// (contributing, the queue); Quit in this menu ends it.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::OnceLock;
use tauri::menu::{Menu, MenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Manager};

static SHOWN: AtomicBool = AtomicBool::new(false);
static APP: OnceLock<AppHandle> = OnceLock::new();
/// The close button was pressed and the page is showing "keeps running in the background" (OK / Cancel, 10 s); the
/// number tells one press from the next, so a late fallback never hides a window reopened since.
static ASKING: AtomicBool = AtomicBool::new(false);
static ASK_NO: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

/// The icon is there (then the close button hides the window instead of closing the program).
pub fn shown() -> bool {
    SHOWN.load(Ordering::Relaxed)
}

/// Quit the program the way the menu does (the icon leaves the tray); without a window: at once.
pub fn quit() {
    crate::image::stop_engines();
    match APP.get() {
        Some(app) => app.exit(0),
        None => std::process::exit(0),
    }
}

fn show(app: &AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.show();
        let _ = w.unminimize();
        let _ = w.set_focus();
    }
}

fn hide_main() {
    if let Some(w) = APP.get().and_then(|a| a.get_webview_window("main")) {
        let _ = w.hide();
    }
}

/// The window's close button (user, 2026-10-31): the window stays and its page shows, for 10 seconds (user: first 5, then 10), that the program
/// keeps running in the background, with OK and Cancel. OK or no answer: the window hides (the program goes on in the
/// tray); Cancel: it stays. A second press while asking hides at once. If the page cannot ask (not loaded, another
/// page), the window hides after 13 seconds anyway, so the close button always does something.
pub fn close_pressed(w: &tauri::Window) {
    if ASKING.swap(true, Ordering::SeqCst) {
        ASKING.store(false, Ordering::SeqCst);
        let _ = w.hide();
        return;
    }
    let n = ASK_NO.fetch_add(1, Ordering::SeqCst) + 1;
    if let Some(wv) = APP.get().and_then(|a| a.get_webview_window("main")) {
        let _ = wv.eval("window.pcCloseAsk ? window.pcCloseAsk() : fetch('/local/close', {method: 'POST', headers: {'content-type': 'application/json'}, body: '{\"hide\":true}'})");
    }
    std::thread::spawn(move || {
        std::thread::sleep(std::time::Duration::from_secs(13));
        if ASK_NO.load(Ordering::SeqCst) == n && ASKING.swap(false, Ordering::SeqCst) {
            hide_main();
        }
    });
}

/// The page's answer (POST /local/close): hide = OK or the 10 seconds ran out; otherwise Cancel (keep the window).
pub fn close_answer(hide: bool) {
    ASKING.store(false, Ordering::SeqCst);
    if hide {
        hide_main();
    }
}

/// The website's console in the window does the contributing: press its own "Yes, stop" (as its Exit pop-up does).
fn stop_contributing(app: &AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.eval("(function(){var f=document.getElementById('consoleFrame'),d=f&&f.contentDocument,b=d&&d.getElementById('confirmYes');if(b)b.click();})()");
    }
}

/// Linux shows tray icons through libayatana-appindicator (or libappindicator); without it there is no icon, and the
/// close button closes the program as before.
#[cfg(target_os = "linux")]
fn possible() -> bool {
    let dirs = ["/usr/lib", "/usr/lib64", "/usr/lib/x86_64-linux-gnu", "/usr/lib/aarch64-linux-gnu", "/lib/x86_64-linux-gnu", "/lib/aarch64-linux-gnu"];
    let libs = ["libayatana-appindicator3.so.1", "libappindicator3.so.1"];
    dirs.iter().any(|d| libs.iter().any(|f| std::path::Path::new(d).join(f).exists()))
}
#[cfg(not(target_os = "linux"))]
fn possible() -> bool {
    true
}

pub fn add(app: &AppHandle) {
    let _ = APP.set(app.clone());
    if !possible() {
        return;
    }
    let made = (|| -> tauri::Result<()> {
        let open = MenuItem::with_id(app, "open", "Open planetCompute", true, None::<&str>)?;
        let stop = MenuItem::with_id(app, "stop", "Stop sharing", true, None::<&str>)?;
        let quit_item = MenuItem::with_id(app, "quit", "Quit planetCompute", true, None::<&str>)?;
        let menu = Menu::with_items(app, &[&open, &stop, &quit_item])?;
        let mut b = TrayIconBuilder::with_id("main")
            .tooltip("planetCompute")
            .menu(&menu)
            .show_menu_on_left_click(false)
            .on_menu_event(|app, e| match e.id().as_ref() {
                "open" => show(app),
                "stop" => stop_contributing(app),
                "quit" => quit(),
                _ => {}
            })
            .on_tray_icon_event(|t, e| {
                if let TrayIconEvent::Click { button: MouseButton::Left, button_state: MouseButtonState::Up, .. } = e {
                    show(t.app_handle());
                }
            });
        if let Some(i) = app.default_window_icon() {
            b = b.icon(i.clone());
        }
        b.build(app)?;
        Ok(())
    })();
    match made {
        Ok(()) => SHOWN.store(true, Ordering::Relaxed),
        Err(e) => eprintln!("planetCompute: no tray icon ({e})"),
    }
}
