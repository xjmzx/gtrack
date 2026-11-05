// The upstream tab: other people's projects, cloned to follow.
//
// A tree here is expected to be a one-to-one copy of its upstream. Nothing is
// developed in it, so the questions the main scan asks — is the account
// pinned, is the work pushed, do the version files agree — have no answer
// worth showing. This asks three things instead:
//
//   - how far behind the upstream is it (a fast-forward away from current);
//   - does it still match the upstream exactly, so that fast-forward is
//     clean — no local commits, no edits, no stray files;
//   - is the project itself still moving, or has it gone quiet.
//
// Same rule as everywhere in gtrack: nothing here writes to a repository. The
// only side effect is `git fetch` of the tracked remote, and only on request.

use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use serde::Serialize;

use crate::config::{expand, Config};
use crate::scan::{classify_remote, fetch_failure, git, git_cmd, stale_locks, RemoteKind};

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct UpstreamStatus {
    /// Directory name — or `sub/name` for a clone one folder deeper inside its
    /// category, since a bare `sdk` says nothing about whose SDK it is.
    pub name: String,
    pub path: String,
    /// The category folder it sits in: `bitcoin`, `nostr`, …
    pub group: String,
    /// `None` when HEAD is detached — see `detached_at`.
    pub branch: Option<String>,
    /// The tag (or short hash) a detached HEAD sits on. A checkout pinned to a
    /// release is a choice, not a fault, and the tag is what says which one.
    pub detached_at: Option<String>,
    pub upstream: Option<String>,
    pub remote: Option<String>,
    pub ahead: u32,
    pub behind: u32,
    /// Tracked files whose *content* differs from HEAD. Permission bits are
    /// ignored: a tree copied between drives or machines comes back with every
    /// file's mode changed and nothing else, and counting those would mark
    /// almost every clone here as edited when not one byte differs.
    pub edited: u32,
    /// Files git does not track and is not told to ignore.
    pub untracked: u32,
    /// Date of the newest commit on the upstream (or on `origin/HEAD` for a
    /// detached checkout) — the project's last sign of life, as of the last
    /// fetch.
    pub upstream_date: Option<String>,
    /// Whole days since `upstream_date`.
    pub idle_days: Option<u32>,
    /// Whether `behind` and `upstream_date` were measured against freshly
    /// fetched refs. False means they are as old as the last fetch, whenever
    /// that was — the same caveat as the main tab, and stated the same way.
    pub fetched: bool,
    pub fetch_error: Option<String>,
    pub locks: Vec<String>,
    pub flags: Vec<String>,
}

/// What a scan measured, before it is read as flags. Split out so the reading
/// can be tested without a repository.
#[derive(Default)]
struct Measured {
    has_remote: bool,
    detached: bool,
    has_upstream: bool,
    fetch_flag: Option<&'static str>,
    ahead: u32,
    behind: u32,
    edited: u32,
    untracked: u32,
    idle_days: Option<u32>,
    stale_lock: bool,
}

/// The flags for a tracked clone, worst first.
///
/// Three tiers, by what each asks of you:
/// - **can't fast-forward** — something stops a plain update: a broken remote,
///   no upstream to follow, or local commits the upstream does not have;
/// - **differs or behind** — the update is available, or the tree has drifted
///   from the upstream in a way an update might trip over;
/// - **states** — `detached` and `inactive`, facts about the checkout or the
///   project that ask for nothing.
fn read_flags(m: &Measured, inactive_days: u32) -> Vec<String> {
    let mut flags = Vec::new();
    if m.stale_lock {
        flags.push("stale lock".into());
    }
    if !m.has_remote {
        flags.push("no remote".into());
    } else if !m.detached && !m.has_upstream {
        // A detached HEAD tracks nothing by definition, and is already said by
        // `detached` below; only a branch that tracks nothing is a fault.
        flags.push("no upstream".into());
    }
    if let Some(f) = m.fetch_flag {
        flags.push(f.into());
    }
    // Local commits beside upstream ones almost always means the upstream
    // rewrote its history — a force-push — rather than work done here. Either
    // way no fast-forward exists, which is the whole of what this tab needs to
    // say about it.
    if m.ahead > 0 && m.behind > 0 {
        flags.push("diverged".into());
    } else if m.ahead > 0 {
        flags.push(format!("{} local", m.ahead));
    } else if m.behind > 0 {
        flags.push(format!("{} behind", m.behind));
    }
    if m.edited > 0 {
        flags.push(format!("{} edited", m.edited));
    }
    if m.untracked > 0 {
        flags.push(format!("{} untracked", m.untracked));
    }
    if m.detached {
        flags.push("detached".into());
    }
    if m.idle_days.is_some_and(|d| d >= inactive_days) {
        flags.push("inactive".into());
    }
    flags
}

/// Whether a directory should be looked inside at all.
fn worth_entering(p: &Path) -> bool {
    match p.file_name().and_then(|s| s.to_str()) {
        // Dot-folders hold tooling, not clones; `node_modules` can hold
        // thousands of folders and never a checkout worth tracking.
        Some(n) => !n.starts_with('.') && n != "node_modules" && p.is_dir(),
        None => false,
    }
}

fn is_repo(p: &Path) -> bool {
    p.join(".git").is_dir()
}

fn subdirs(p: &Path) -> Vec<PathBuf> {
    let Ok(entries) = std::fs::read_dir(p) else { return Vec::new() };
    let mut out: Vec<PathBuf> = entries.flatten().map(|e| e.path()).filter(|p| worth_entering(p)).collect();
    out.sort();
    out
}

/// Every tracked clone, with its display name and category.
///
/// `root/category/clone`, the usual case; `root/clone`, filed under the root's
/// own name; and `root/category/sub/clone`, named `sub/clone`. Never deeper,
/// and never inside a clone — a repository's own subfolders are its business,
/// and a vendored checkout inside one is not a project being followed.
fn discover(cfg: &Config) -> Vec<(PathBuf, String, String)> {
    let mut found = Vec::new();
    for root in &cfg.upstream.roots {
        let root = expand(root);
        let root_label = root.file_name().and_then(|s| s.to_str()).unwrap_or("?").to_string();
        for top in subdirs(&root) {
            let top_name = top.file_name().and_then(|s| s.to_str()).unwrap_or("?").to_string();
            if is_repo(&top) {
                found.push((top, top_name, root_label.clone()));
                continue;
            }
            for mid in subdirs(&top) {
                let mid_name = mid.file_name().and_then(|s| s.to_str()).unwrap_or("?").to_string();
                if is_repo(&mid) {
                    found.push((mid, mid_name, top_name.clone()));
                    continue;
                }
                for leaf in subdirs(&mid) {
                    if is_repo(&leaf) {
                        let leaf_name = leaf.file_name().and_then(|s| s.to_str()).unwrap_or("?");
                        found.push((leaf.clone(), format!("{mid_name}/{leaf_name}"), top_name.clone()));
                    }
                }
            }
        }
    }
    found
}

/// `(tracked edits, untracked files)`, blind to permission bits.
///
/// `core.fileMode=false` for this one command only: git compares content and
/// nothing else, and the repository's own config is left exactly as it was.
fn changes(path: &Path) -> (u32, u32) {
    let Some(out) = git(path, &["-c", "core.fileMode=false", "status", "--porcelain"]) else {
        return (0, 0);
    };
    let (mut edited, mut untracked) = (0, 0);
    for line in out.lines().filter(|l| !l.trim().is_empty()) {
        if line.starts_with("??") {
            untracked += 1;
        } else {
            edited += 1;
        }
    }
    (edited, untracked)
}

fn now_secs() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0)
}

/// Whole days between a commit time and now. A commit dated in the future (a
/// skewed clock somewhere) is zero days old, not a wrapped-around huge number.
fn days_since(commit_secs: u64, now: u64) -> u32 {
    (now.saturating_sub(commit_secs) / 86_400) as u32
}

fn inspect(path: &Path, name: &str, group: &str, cfg: &Config, fetch: bool) -> UpstreamStatus {
    let branch = git(path, &["symbolic-ref", "-q", "--short", "HEAD"]);
    let detached = branch.is_none();
    let detached_at = if detached {
        git(path, &["describe", "--tags", "--exact-match", "HEAD"])
            .or_else(|| git(path, &["rev-parse", "--short", "HEAD"]))
    } else {
        None
    };
    let upstream = if detached { None } else { git(path, &["rev-parse", "--abbrev-ref", "@{u}"]) };
    let remote_name = upstream
        .as_deref()
        .and_then(|u| u.split('/').next())
        .unwrap_or("origin")
        .to_string();
    let remote = git(path, &["remote", "get-url", &remote_name]);
    let kind = remote.as_deref().map(classify_remote).unwrap_or(RemoteKind::None);

    // The tracked remote only, never `--all` — one broken extra remote would
    // fail the fetch and mark a healthy clone unreachable. With no upstream
    // (detached, or a branch tracking nothing) `origin` is fetched instead:
    // the project's activity stays current, and a deleted remote still says
    // so rather than hiding behind `no upstream`.
    let mut fetched = false;
    let mut fetch_error = None;
    if fetch && remote.is_some() {
        match git_cmd(path).args(["fetch", "--quiet", &remote_name]).output() {
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
        // "behind<TAB>ahead" for upstream...HEAD.
        if let Some(counts) = git(path, &["rev-list", "--left-right", "--count", &format!("{up}...HEAD")]) {
            let mut it = counts.split_whitespace();
            behind = it.next().and_then(|s| s.parse().ok()).unwrap_or(0);
            ahead = it.next().and_then(|s| s.parse().ok()).unwrap_or(0);
        }
    }

    let (edited, untracked) = changes(path);

    // The project's activity is read off the upstream, not HEAD: a clone that
    // is 900 commits behind has a stale HEAD and a very live project. For a
    // detached checkout, the remote's default branch stands in.
    let activity_ref = upstream.clone().or_else(|| {
        detached
            .then(|| git(path, &["rev-parse", "--abbrev-ref", &format!("{remote_name}/HEAD")]))
            .flatten()
    });
    let (upstream_date, idle_days) = activity_ref
        .as_deref()
        .and_then(|r| git(path, &["log", "-1", "--format=%cs %ct", r]))
        .and_then(|s| {
            let (date, secs) = s.split_once(' ')?;
            Some((date.to_string(), days_since(secs.trim().parse().ok()?, now_secs())))
        })
        .map(|(d, n)| (Some(d), Some(n)))
        .unwrap_or((None, None));

    let mut locks = Vec::new();
    stale_locks(&path.join(".git"), 3, &mut locks);
    locks.sort();

    let flags = read_flags(
        &Measured {
            has_remote: remote.is_some(),
            detached,
            has_upstream: upstream.is_some(),
            fetch_flag: fetch_error.as_deref().map(|e| fetch_failure(e, kind)),
            ahead,
            behind,
            edited,
            untracked,
            idle_days,
            stale_lock: !locks.is_empty(),
        },
        cfg.upstream.inactive_days,
    );

    UpstreamStatus {
        name: name.to_string(),
        path: path.display().to_string(),
        group: group.to_string(),
        branch,
        detached_at,
        upstream,
        remote,
        ahead,
        behind,
        edited,
        untracked,
        upstream_date,
        idle_days,
        fetched,
        fetch_error,
        locks,
        flags,
    }
}

/// Scan every tracked clone. Fetching runs across a small pool of threads, as
/// in the main scan; a local scan runs in order.
pub fn scan(cfg: &Config, fetch: bool) -> Vec<UpstreamStatus> {
    let repos = discover(cfg);
    let mut out: Vec<UpstreamStatus> = if !fetch {
        repos.iter().map(|(p, n, g)| inspect(p, n, g, cfg, false)).collect()
    } else {
        const LANES: usize = 8;
        let mut out = Vec::with_capacity(repos.len());
        std::thread::scope(|s| {
            let mut handles = Vec::new();
            for chunk in repos.chunks(repos.len().div_ceil(LANES).max(1)) {
                handles.push(s.spawn(move || {
                    chunk.iter().map(|(p, n, g)| inspect(p, n, g, cfg, true)).collect::<Vec<_>>()
                }));
            }
            for h in handles {
                if let Ok(part) = h.join() {
                    out.extend(part);
                }
            }
        });
        out
    };
    out.sort_by(|a, b| (&a.group, &a.name).cmp(&(&b.group, &b.name)));
    out
}

/// One tracked clone, fetched first if asked. `None` for any path discovery
/// would not find — the path comes from the webview, and a string must not be
/// able to point gtrack at an arbitrary directory.
pub fn scan_one(cfg: &Config, path: &Path, fetch: bool) -> Option<UpstreamStatus> {
    let (p, name, group) = discover(cfg).into_iter().find(|(p, _, _)| p == path)?;
    Some(inspect(&p, &name, &group, cfg, fetch))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn clean() -> Measured {
        Measured { has_remote: true, has_upstream: true, ..Default::default() }
    }

    #[test]
    fn an_identical_clone_has_nothing_to_say() {
        assert!(read_flags(&clean(), 365).is_empty());
    }

    #[test]
    fn behind_is_the_one_number_that_matters() {
        let m = Measured { behind: 633, ..clean() };
        assert_eq!(read_flags(&m, 365), ["633 behind"]);
    }

    #[test]
    fn local_commits_beside_upstream_ones_read_as_diverged() {
        // The force-pushed upstream case: hundreds each way, and the counts
        // say nothing more useful than that no fast-forward exists.
        let m = Measured { ahead: 616, behind: 882, ..clean() };
        assert_eq!(read_flags(&m, 365), ["diverged"]);
        let m = Measured { ahead: 2, ..clean() };
        assert_eq!(read_flags(&m, 365), ["2 local"]);
    }

    #[test]
    fn a_detached_checkout_is_a_state_not_a_missing_upstream() {
        // bitcoin at v32.1: deliberately pinned, tracking nothing.
        let m = Measured { detached: true, has_upstream: false, ..clean() };
        assert_eq!(read_flags(&m, 365), ["detached"]);
        // A branch that tracks nothing is the fault.
        let m = Measured { has_upstream: false, ..clean() };
        assert_eq!(read_flags(&m, 365), ["no upstream"]);
    }

    #[test]
    fn inactive_is_measured_against_the_configured_threshold() {
        let m = Measured { idle_days: Some(400), ..clean() };
        assert_eq!(read_flags(&m, 365), ["inactive"]);
        assert!(read_flags(&m, 500).is_empty());
        // Exactly at the threshold counts.
        let m = Measured { idle_days: Some(365), ..clean() };
        assert_eq!(read_flags(&m, 365), ["inactive"]);
        // Never measured is not inactive.
        assert!(read_flags(&Measured { idle_days: None, ..clean() }, 0).is_empty());
    }

    #[test]
    fn faults_come_before_states() {
        let m = Measured {
            stale_lock: true,
            fetch_flag: Some("unreachable"),
            behind: 3,
            edited: 2,
            untracked: 1,
            idle_days: Some(9999),
            ..clean()
        };
        assert_eq!(
            read_flags(&m, 365),
            ["stale lock", "unreachable", "3 behind", "2 edited", "1 untracked", "inactive"]
        );
    }

    #[test]
    fn no_remote_is_said_once() {
        let m = Measured { has_remote: false, has_upstream: false, ..Default::default() };
        assert_eq!(read_flags(&m, 365), ["no remote"]);
    }

    #[test]
    fn a_future_commit_is_not_ancient() {
        assert_eq!(days_since(2_000, 1_000), 0);
        assert_eq!(days_since(0, 86_400 * 3 + 5), 3);
    }

    fn scratch(tag: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("gtrack-test-up-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    fn cfg_for(root: &Path) -> Config {
        serde_json::from_value(serde_json::json!({ "upstream": { "roots": [root.to_string_lossy()] } })).unwrap()
    }

    #[test]
    fn discovery_reads_categories_and_one_folder_deeper() {
        let root = scratch("disc");
        for p in [
            "bitcoin/lnd/.git",
            "bitcoin/blockstream/Jade/.git",
            "nostr/nips/.git",
            "loose/.git",
            // Not followed: inside a clone, in a dot-folder, too deep.
            "bitcoin/lnd/vendor/x/.git",
            ".hidden/r/.git",
            "a/b/c/d/.git",
        ] {
            std::fs::create_dir_all(root.join(p)).unwrap();
        }
        let root_label = root.file_name().unwrap().to_str().unwrap().to_string();
        let mut got: Vec<(String, String)> =
            discover(&cfg_for(&root)).into_iter().map(|(_, n, g)| (g, n)).collect();
        got.sort();
        let mut want = vec![
            ("bitcoin".to_string(), "blockstream/Jade".to_string()),
            ("bitcoin".into(), "lnd".into()),
            ("nostr".into(), "nips".into()),
            (root_label, "loose".into()),
        ];
        want.sort();
        assert_eq!(got, want);
        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn a_single_scan_refuses_anything_discovery_would_not_find() {
        let root = scratch("one");
        std::fs::create_dir_all(root.join("cat/r/.git")).unwrap();
        let cfg = cfg_for(&root);
        assert_eq!(scan_one(&cfg, &root.join("cat/r"), false).map(|r| r.name), Some("r".into()));
        assert!(scan_one(&cfg, &root.join("cat"), false).is_none());
        assert!(scan_one(&cfg, &std::env::temp_dir(), false).is_none());
        std::fs::remove_dir_all(&root).ok();
    }

    /// A real repository, for the one property that needs git to prove.
    #[cfg(unix)]
    #[test]
    fn a_permission_change_alone_is_not_an_edit() {
        use std::os::unix::fs::PermissionsExt;
        let root = scratch("mode");
        let repo = root.join("cat/r");
        std::fs::create_dir_all(&repo).unwrap();
        let run = |args: &[&str]| {
            let ok = std::process::Command::new("git").arg("-C").arg(&repo).args(args).output().unwrap();
            assert!(ok.status.success(), "git {args:?}: {}", String::from_utf8_lossy(&ok.stderr));
        };
        run(&["init", "-q"]);
        std::fs::write(repo.join("a.txt"), "one\n").unwrap();
        std::fs::write(repo.join("b.txt"), "two\n").unwrap();
        run(&["add", "."]);
        run(&["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "init"]);

        // What a copy between drives does: every mode changed, no content.
        for f in ["a.txt", "b.txt"] {
            std::fs::set_permissions(repo.join(f), std::fs::Permissions::from_mode(0o755)).unwrap();
        }
        assert_eq!(changes(&repo), (0, 0));

        // A real edit and a stray file still count.
        std::fs::write(repo.join("a.txt"), "changed\n").unwrap();
        std::fs::write(repo.join("c.txt"), "new\n").unwrap();
        assert_eq!(changes(&repo), (1, 1));

        // And the repository's own config was never touched.
        let out = std::process::Command::new("git")
            .arg("-C").arg(&repo).args(["config", "--local", "--get", "core.fileMode"])
            .output().unwrap();
        assert_eq!(String::from_utf8_lossy(&out.stdout).trim(), "true");
        std::fs::remove_dir_all(&root).ok();
    }
}
