// gtrack — a read-only tracker for the git checkouts on this machine.
//
// It answers one question: what state is everything actually in? Versions
// declared, releases tagged, work unpushed, remotes that will fail when you
// try to push them, and locks that have been silently blocking writes for
// weeks. Every one of those was a real problem found by hand; this is that
// sweep, made repeatable.
//
// The whole app is a reader. No command mutates a working tree, and the only
// one with any side effect on a repository is an explicit fetch, which touches
// remote-tracking refs and nothing else. The one file the window writes is
// gtrack's own config, and only its `archived` list (`set_archived`).

pub mod account;
pub mod config;
pub mod scan;
pub mod upstream;

use std::path::PathBuf;

use serde::Serialize;
use tauri::{AppHandle, Manager};

use config::Config;
use scan::{RemoteKind, RepoStatus};
use upstream::UpstreamStatus;

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
    tauri::async_runtime::spawn_blocking(move || {
        scan::check_git()?;
        Ok(scan::scan(&cfg, fetch))
    })
    .await
    .map_err(|e| format!("scan failed: {e}"))?
}

/// Rescan one repository, fetching it first if asked.
///
/// Refused for any path the configured roots do not hold — see `scan_one`.
#[tauri::command]
async fn scan_repo(app: AppHandle, path: String, fetch: bool) -> Result<RepoStatus, String> {
    let cfg = config::load(&config_dir(&app)?)?;
    let target = PathBuf::from(&path);
    tauri::async_runtime::spawn_blocking(move || {
        scan::check_git()?;
        scan::scan_one(&cfg, &target, fetch)
            .ok_or_else(|| format!("not a repository under the configured roots: {path}"))
    })
    .await
    .map_err(|e| format!("scan failed: {e}"))?
}

/// Scan the upstream tab's clones — other people's projects, kept to follow.
/// The same contract as `scan_repos`: read-only, and `fetch` is the only side
/// effect, on the tracked remote and only when asked.
#[tauri::command]
async fn scan_upstream(app: AppHandle, fetch: bool) -> Result<Vec<UpstreamStatus>, String> {
    let cfg = config::load(&config_dir(&app)?)?;
    tauri::async_runtime::spawn_blocking(move || {
        scan::check_git()?;
        Ok(upstream::scan(&cfg, fetch))
    })
    .await
    .map_err(|e| format!("scan failed: {e}"))?
}

/// Rescan one upstream clone. Refused for any path the upstream roots do not
/// hold, for the reason `scan_repo` refuses one.
#[tauri::command]
async fn scan_upstream_repo(app: AppHandle, path: String, fetch: bool) -> Result<UpstreamStatus, String> {
    let cfg = config::load(&config_dir(&app)?)?;
    let target = PathBuf::from(&path);
    tauri::async_runtime::spawn_blocking(move || {
        scan::check_git()?;
        upstream::scan_one(&cfg, &target, fetch)
            .ok_or_else(|| format!("not a clone under the upstream roots: {path}"))
    })
    .await
    .map_err(|e| format!("scan failed: {e}"))?
}

/// What the archive toggle changed on a row: its declaration and the one flag
/// slot that depends on it.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ArchiveSlot {
    declared_archive: bool,
    flag: Option<String>,
}

/// Declare a repository archived in `gtrack.json`, or take it back.
///
/// Writes gtrack's own config, never the repository. The path is checked
/// against the configured roots the same way `scan_repo` checks it, and the
/// local reading (remote, upstream — no fetch) is what the returned flag is
/// worked out from. The window splices that one flag into the row it already
/// has, so what the last fetch measured is kept.
#[tauri::command]
async fn set_archived(app: AppHandle, path: String, archived: bool) -> Result<ArchiveSlot, String> {
    let dir = config_dir(&app)?;
    let cfg = config::load(&dir)?;
    let target = PathBuf::from(&path);
    tauri::async_runtime::spawn_blocking(move || {
        scan::check_git()?;
        let local = scan::scan_one(&cfg, &target, false)
            .ok_or_else(|| format!("not a repository under the configured roots: {path}"))?;
        if archived && local.remote_kind == RemoteKind::None {
            return Err(format!("{} has no remote, so it is already an archive", local.name));
        }
        config::set_archived(&dir, &local.name, archived)?;
        Ok(ArchiveSlot {
            declared_archive: archived,
            flag: scan::archive_slot(archived, local.remote_kind, local.upstream.is_some()).map(Into::into),
        })
    })
    .await
    .map_err(|e| format!("could not update the archive list: {e}"))?
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![
            load_config,
            save_config,
            scan_repos,
            scan_repo,
            scan_upstream,
            scan_upstream_repo,
            set_archived
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
