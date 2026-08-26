// gtrack — a read-only tracker for the git checkouts on this machine.
//
// It answers one question: what state is everything actually in? Versions
// declared, releases tagged, work unpushed, remotes that will fail when you
// try to push them, and locks that have been silently blocking writes for
// weeks. Every one of those was a real problem found by hand; this is that
// sweep, made repeatable.
//
// The whole app is a reader. No command mutates a working tree, and the only
// one with any side effect at all is an explicit fetch, which touches
// remote-tracking refs and nothing else.

pub mod config;
pub mod scan;

use std::path::PathBuf;

use tauri::{AppHandle, Manager};

use config::Config;
use scan::RepoStatus;

fn config_dir(app: &AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_config_dir()
        .map_err(|e| format!("no config directory available: {e}"))
}

#[tauri::command]
fn load_config(app: AppHandle) -> Result<Config, String> {
    config::load(&config_dir(&app)?)
}

#[tauri::command]
fn save_config(app: AppHandle, cfg: Config) -> Result<(), String> {
    config::save(&config_dir(&app)?, &cfg)
}

/// Scan every configured root.
///
/// `fetch` is the whole correctness question. Without it, ahead/behind are
/// computed against whatever the remote-tracking refs last knew, which can be
/// months stale and will report commits as unpushed that are already on the
/// remote — a confident wrong answer that costs a real investigation. Each
/// row carries `fetched` so the UI can say which it is rather than implying
/// freshness it does not have.
#[tauri::command]
async fn scan_repos(app: AppHandle, fetch: bool) -> Result<Vec<RepoStatus>, String> {
    let cfg = config::load(&config_dir(&app)?)?;
    // Blocking git invocations, off the webview thread.
    tauri::async_runtime::spawn_blocking(move || scan::scan(&cfg, fetch))
        .await
        .map_err(|e| format!("scan failed: {e}"))
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![load_config, save_config, scan_repos])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
