// Reading the state of a working tree.
//
// Everything here shells out to `git` rather than linking libgit2, for one
// reason that matters: fetching uses the machine's own SSH config, including
// per-account host aliases. libgit2 would need its own credential plumbing to
// reach the same remotes, and would get it subtly wrong.
//
// gtrack NEVER writes to a repository. The only command here with any side
// effect at all is `git fetch`, which updates remote-tracking refs and nothing
// in the working tree, and it runs only when explicitly asked for.

use std::path::{Path, PathBuf};
use std::process::Command;

use serde::Serialize;

use crate::config::Config;

/// How reachable a remote URL is without interactive credentials. A
/// credential-less `https://` remote fails at push time with a 403 and looks
/// exactly like a healthy repo until then — a real trap, hit twice.
#[derive(Serialize, Clone, Copy, Debug, PartialEq)]
#[serde(rename_all = "kebab-case")]
pub enum RemoteKind {
    /// `alias:owner/repo.git` or `git@alias:owner/repo.git` — an SSH host alias.
    SshAlias,
    /// A plain `git@github.com:` remote.
    Ssh,
    /// `https://` — pushes need a credential helper or a token.
    Https,
    None,
}

#[derive(Serialize, Clone, Debug, Default)]
pub struct Versions {
    pub package: Option<String>,
    pub cargo: Option<String>,
    pub tauri: Option<String>,
    /// False when two files that both declare a version disagree. A release
    /// needs all three bumped together; missing files are not a disagreement.
    pub agree: bool,
}

#[derive(Serialize, Clone, Debug)]
pub struct RepoStatus {
    pub name: String,
    pub path: String,
    pub group: String,
    pub branch: Option<String>,
    pub upstream: Option<String>,
    pub remote: Option<String>,
    pub remote_kind: RemoteKind,
    pub ahead: u32,
    pub behind: u32,
    pub dirty: u32,
    /// Whether ahead/behind were computed against freshly fetched refs. When
    /// false the numbers are historical and may be confidently wrong — the
    /// single most important field here.
    pub fetched: bool,
    pub fetch_error: Option<String>,
    pub versions: Versions,
    pub latest_tag: Option<String>,
    pub tag_date: Option<String>,
    pub commits_since_tag: Option<u32>,
    /// Stale `*.lock` files under `.git`. A zero-byte lock with no git process
    /// running blocks every write while leaving refs valid, so the repo reads
    /// as healthy until something tries to pull.
    pub locks: Vec<String>,
    pub flags: Vec<String>,
}

fn git(dir: &Path, args: &[&str]) -> Option<String> {
    let out = Command::new("git").arg("-C").arg(dir).args(args).output().ok()?;
    if !out.status.success() {
        return None;
    }
    Some(String::from_utf8_lossy(&out.stdout).trim().to_string())
}

fn classify_remote(url: &str) -> RemoteKind {
    if url.starts_with("https://") || url.starts_with("http://") {
        RemoteKind::Https
    } else if url.starts_with("git@github.com:") || url.starts_with("ssh://") {
        RemoteKind::Ssh
    } else {
        // `alias:owner/repo.git` or `git@alias:owner/repo.git`.
        RemoteKind::SshAlias
    }
}

/// `version` from a JSON file, without pulling in a schema for the rest of it.
fn json_version(path: &Path) -> Option<String> {
    let raw = std::fs::read_to_string(path).ok()?;
    let v: serde_json::Value = serde_json::from_str(&raw).ok()?;
    v.get("version")?.as_str().map(|s| s.to_string())
}

/// `version = "..."` from the `[package]` table of a Cargo manifest. A line
/// scan rather than a TOML dependency: it stops at the first table boundary,
/// so a dependency's version is never mistaken for the crate's own.
fn cargo_version(path: &Path) -> Option<String> {
    let raw = std::fs::read_to_string(path).ok()?;
    let mut in_package = false;
    for line in raw.lines() {
        let t = line.trim();
        if t.starts_with('[') {
            in_package = t == "[package]";
            continue;
        }
        if in_package {
            if let Some(rest) = t.strip_prefix("version") {
                let rest = rest.trim_start();
                if let Some(rest) = rest.strip_prefix('=') {
                    return Some(rest.trim().trim_matches('"').to_string());
                }
            }
        }
    }
    None
}

fn read_versions(dir: &Path) -> Versions {
    let package = json_version(&dir.join("package.json"));
    let cargo = cargo_version(&dir.join("src-tauri/Cargo.toml"))
        .or_else(|| cargo_version(&dir.join("Cargo.toml")));
    let tauri = json_version(&dir.join("src-tauri/tauri.conf.json"));

    let present: Vec<&String> = [&package, &cargo, &tauri].into_iter().flatten().collect();
    let agree = present.windows(2).all(|w| w[0] == w[1]);
    Versions { package, cargo, tauri, agree }
}

/// Stale locks under `.git`. Only zero-byte ones are reported: a lock with
/// content may belong to a live operation, and guessing wrong there would mean
/// telling someone to delete a file a running git is using.
fn stale_locks(git_dir: &Path, depth: usize, out: &mut Vec<String>) {
    if depth == 0 {
        return;
    }
    let Ok(entries) = std::fs::read_dir(git_dir) else { return };
    for e in entries.flatten() {
        let p = e.path();
        if p.is_dir() {
            // Objects and modules are large and hold no locks worth finding.
            let skip = matches!(p.file_name().and_then(|s| s.to_str()), Some("objects") | Some("modules"));
            if !skip {
                stale_locks(&p, depth - 1, out);
            }
        } else if p.extension().and_then(|s| s.to_str()) == Some("lock") {
            if e.metadata().map(|m| m.len() == 0).unwrap_or(false) {
                if let Some(rel) = p.strip_prefix(git_dir).ok().and_then(|r| r.to_str()) {
                    out.push(rel.to_string());
                } else if let Some(n) = p.file_name().and_then(|s| s.to_str()) {
                    out.push(n.to_string());
                }
            }
        }
    }
}

fn discover(cfg: &Config) -> Vec<(PathBuf, String)> {
    let mut found = Vec::new();
    for root in &cfg.roots {
        let root_path = crate::config::expand(root);
        let label = root_path
            .file_name()
            .and_then(|s| s.to_str())
            .unwrap_or("?")
            .to_string();
        let Ok(entries) = std::fs::read_dir(&root_path) else { continue };
        for e in entries.flatten() {
            let p = e.path();
            if p.join(".git").is_dir() {
                found.push((p, label.clone()));
            }
        }
    }
    found.sort_by(|a, b| a.0.cmp(&b.0));
    found
}

fn inspect(path: &Path, root_label: &str, cfg: &Config, fetch: bool) -> RepoStatus {
    let name = path.file_name().and_then(|s| s.to_str()).unwrap_or("?").to_string();
    let group = cfg.group_for(&name).unwrap_or(root_label).to_string();

    let branch = git(path, &["rev-parse", "--abbrev-ref", "HEAD"]);
    let upstream = git(path, &["rev-parse", "--abbrev-ref", "@{u}"]);
    let remote_name = upstream
        .as_deref()
        .and_then(|u| u.split('/').next())
        .unwrap_or("origin")
        .to_string();
    let remote = git(path, &["remote", "get-url", &remote_name]);
    let remote_kind = remote.as_deref().map(classify_remote).unwrap_or(RemoteKind::None);

    // Fetch the TRACKED remote only. `fetch --all` fails outright when any
    // auxiliary remote is broken, which silently turns healthy repos into
    // "unreachable" — a mistake made for real before this was written.
    let mut fetched = false;
    let mut fetch_error = None;
    if fetch && upstream.is_some() {
        match Command::new("git").arg("-C").arg(path).args(["fetch", "--quiet", &remote_name]).output() {
            Ok(o) if o.status.success() => fetched = true,
            Ok(o) => {
                let msg = String::from_utf8_lossy(&o.stderr).trim().to_string();
                fetch_error = Some(if msg.is_empty() { "fetch failed".into() } else { msg });
            }
            Err(e) => fetch_error = Some(e.to_string()),
        }
    }

    let (mut ahead, mut behind) = (0u32, 0u32);
    if let Some(up) = upstream.as_deref() {
        // `--left-right --count` gives "behind<TAB>ahead" for upstream...HEAD.
        if let Some(counts) = git(path, &["rev-list", "--left-right", "--count", &format!("{up}...HEAD")]) {
            let mut it = counts.split_whitespace();
            behind = it.next().and_then(|s| s.parse().ok()).unwrap_or(0);
            ahead = it.next().and_then(|s| s.parse().ok()).unwrap_or(0);
        }
    }

    let dirty = git(path, &["status", "--porcelain"])
        .map(|s| s.lines().filter(|l| !l.trim().is_empty()).count() as u32)
        .unwrap_or(0);

    let latest_tag = git(path, &["describe", "--tags", "--abbrev=0"]);
    let tag_date = latest_tag
        .as_deref()
        .and_then(|t| git(path, &["log", "-1", "--format=%ad", "--date=short", t]));
    let commits_since_tag = latest_tag
        .as_deref()
        .and_then(|t| git(path, &["rev-list", "--count", &format!("{t}..HEAD")]))
        .and_then(|s| s.parse().ok());

    let mut locks = Vec::new();
    stale_locks(&path.join(".git"), 3, &mut locks);
    locks.sort();

    let versions = read_versions(path);

    let mut flags = Vec::new();
    if !locks.is_empty() {
        flags.push("stale lock".into());
    }
    if upstream.is_none() {
        flags.push("no upstream".into());
    }
    if fetch_error.is_some() {
        flags.push("unreachable".into());
    }
    if remote_kind == RemoteKind::Https {
        flags.push("https remote".into());
    }
    if !versions.agree {
        flags.push("version mismatch".into());
    }
    if ahead > 0 {
        flags.push(format!("{ahead} unpushed"));
    }
    if behind > 0 {
        flags.push(format!("{behind} behind"));
    }
    if dirty > 0 {
        flags.push(format!("{dirty} dirty"));
    }

    RepoStatus {
        name, path: path.display().to_string(), group,
        branch, upstream, remote, remote_kind,
        ahead, behind, dirty, fetched, fetch_error,
        versions, latest_tag, tag_date, commits_since_tag,
        locks, flags,
    }
}

/// Scan every configured root. Local inspection is cheap and runs in order;
/// fetching is not, so repositories are inspected across a small pool of
/// threads when a fetch is requested.
pub fn scan(cfg: &Config, fetch: bool) -> Vec<RepoStatus> {
    let repos = discover(cfg);
    if !fetch {
        return repos.iter().map(|(p, r)| inspect(p, r, cfg, false)).collect();
    }

    const LANES: usize = 8;
    let mut out: Vec<RepoStatus> = Vec::with_capacity(repos.len());
    std::thread::scope(|s| {
        let mut handles = Vec::new();
        for chunk in repos.chunks(repos.len().div_ceil(LANES).max(1)) {
            handles.push(s.spawn(move || {
                chunk.iter().map(|(p, r)| inspect(p, r, cfg, true)).collect::<Vec<_>>()
            }));
        }
        for h in handles {
            if let Ok(part) = h.join() {
                out.extend(part);
            }
        }
    });
    out.sort_by(|a, b| a.name.cmp(&b.name));
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn remote_classification_separates_the_one_that_bites() {
        assert_eq!(classify_remote("https://github.com/x/y"), RemoteKind::Https);
        assert_eq!(classify_remote("git@github.com:x/y.git"), RemoteKind::Ssh);
        assert_eq!(classify_remote("github-xjmzx:xjmzx/y.git"), RemoteKind::SshAlias);
        assert_eq!(classify_remote("git@adjmx:adjmx/y.git"), RemoteKind::SshAlias);
    }

    #[test]
    fn cargo_version_stops_at_the_package_table() {
        let dir = std::env::temp_dir().join("gtrack-test-cargo");
        std::fs::create_dir_all(&dir).unwrap();
        let p = dir.join("Cargo.toml");
        std::fs::write(&p, "[package]\nname = \"x\"\nversion = \"0.1.0-beta.2\"\n\n[dependencies]\nserde = { version = \"1\" }\n").unwrap();
        assert_eq!(cargo_version(&p).as_deref(), Some("0.1.0-beta.2"));
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn a_dependency_version_is_not_the_crate_version() {
        let dir = std::env::temp_dir().join("gtrack-test-cargo2");
        std::fs::create_dir_all(&dir).unwrap();
        let p = dir.join("Cargo.toml");
        // No version in [package] at all — the one under [dependencies] must
        // not be picked up as the crate's.
        std::fs::write(&p, "[package]\nname = \"x\"\n\n[dependencies]\nversion = \"9.9.9\"\n").unwrap();
        assert_eq!(cargo_version(&p), None);
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn versions_agree_when_files_are_missing_but_not_when_they_differ() {
        let v = Versions { package: Some("1.0".into()), cargo: None, tauri: Some("1.0".into()), agree: true };
        assert!(v.agree);
        let present: Vec<&String> = [&v.package, &v.cargo, &v.tauri].into_iter().flatten().collect();
        assert!(present.windows(2).all(|w| w[0] == w[1]));

        let bad = [Some("1.0".to_string()), Some("1.1".to_string())];
        let present: Vec<&String> = bad.iter().flatten().collect();
        assert!(!present.windows(2).all(|w| w[0] == w[1]));
    }
}
