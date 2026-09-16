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

use std::ffi::{OsStr, OsString};
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::OnceLock;

use serde::Serialize;

use crate::account::{AccountMatch, KeyBook};
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
    /// `nostr://<npub>/<relay>/<repo>`, served by the `git-remote-nostr`
    /// helper. The npub names the repo, never the key that signs the push.
    Nostr,
    None,
}

/// Whether the host shows a repository to someone who is not signed in.
///
/// Nothing on disk records it, so it is asked of the host — and only after a
/// fetch has just succeeded, because only then does a refused anonymous read
/// mean *private* rather than *gone*. A choice, not a finding: it never
/// becomes a flag, since every flag is something to judge.
#[derive(Serialize, Clone, Copy, Debug, PartialEq)]
#[serde(rename_all = "kebab-case")]
pub enum Visibility {
    Public,
    Private,
}

/// The result of the account check, when one was made.
///
/// Serialised beside `authenticates_as` so a pass is visible and not merely
/// the absence of a flag — without it a verified row and a row never checked
/// looked identical, and the check's cost bought nothing anyone could see.
#[derive(Serialize, Clone, Copy, Debug, PartialEq)]
#[serde(rename_all = "kebab-case")]
pub enum AccountCheck {
    /// The alias's one key is published by the repository's owner.
    Owner,
    /// It is not. Always accompanied by the `other account` flag.
    Other,
}

#[derive(Serialize, Clone, Debug, Default)]
pub struct Versions {
    pub package: Option<String>,
    pub cargo: Option<String>,
    pub tauri: Option<String>,
    /// `package-lock.json`. Kept in step automatically by `npm version`, and
    /// not at all by a hand-edit — which is how v0.1.1 shipped with the other
    /// three bumped and this one behind.
    pub lock: Option<String>,
    /// False when two files that both declare a version disagree. A release
    /// needs all of them bumped together; missing files are not a disagreement.
    pub agree: bool,
}

#[derive(Serialize, Clone, Debug)]
// Without this the struct serialises as snake_case while the TypeScript reads
// camelCase, and the mismatched fields arrive as `undefined` — the row still
// renders, just silently missing its tag, its remote kind and its fetch error.
// Caught only by noticing every repo claimed to be untagged.
#[serde(rename_all = "camelCase")]
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
    /// `None` whenever it was not measured: no fetch, a failed fetch, a host
    /// other than GitHub, or a probe that failed for a reason it could not
    /// name. Unknown is never rendered as either answer.
    pub visibility: Option<Visibility>,
    pub versions: Versions,
    pub latest_tag: Option<String>,
    pub tag_date: Option<String>,
    pub commits_since_tag: Option<u32>,
    /// Stale `*.lock` files under `.git`. A zero-byte lock with no git process
    /// running blocks every write while leaving refs valid, so the repo reads
    /// as healthy until something tries to pull.
    pub locks: Vec<String>,
    /// Local tags the tracked remote does not have. Measured only after a
    /// successful fetch — empty otherwise, which means *not checked* as often
    /// as it means *none*.
    pub unpushed_tags: Vec<String>,
    /// `None` when no check was made: no fetch, a remote form whose key is
    /// not fixed, a host other than GitHub, or an owner publishing no keys.
    pub account: Option<AccountCheck>,
    /// The account the key belongs to, when known: the owner on a pass, and
    /// on a mismatch the other account if this scan saw its keys.
    pub authenticates_as: Option<String>,
    pub flags: Vec<String>,
}

/// A `git -C <dir>` invocation, ready for its arguments.
///
/// On Windows each of these would otherwise pop a console window in front of
/// the app for the few milliseconds it lives. A scan is roughly ten calls per
/// repository, so even a modest machine flashes a few hundred of them over the
/// window and takes focus with every one — the app appears to redraw itself in
/// a loop for the length of the scan. `CREATE_NO_WINDOW` is the whole fix.
///
/// It also carries the `PATH` from `child_path` below, which is what lets the
/// windowed app reach the remote helpers a terminal can already see.
fn git_cmd(dir: &Path) -> Command {
    let mut cmd = git_anywhere();
    cmd.arg("-C").arg(dir);
    cmd
}

/// `git_cmd` without a working tree — for the one call that must not read a
/// repository's config (`probe_visibility`).
fn git_anywhere() -> Command {
    let mut cmd = Command::new("git");
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    // Resolved once. It reads the filesystem, where a fetching scan is some
    // ten git invocations per repository across eight threads.
    static CHILD_PATH: OnceLock<Option<OsString>> = OnceLock::new();
    if let Some(path) = CHILD_PATH.get_or_init(child_path) {
        cmd.env("PATH", path);
    }
    cmd
}

/// The `PATH` child `git` processes get: the inherited one, plus the user bin
/// directories a login shell has and a windowed launch does not.
///
/// A remote whose scheme git does not speak natively is served by a helper
/// binary — `git-remote-<scheme>` — which git looks for on `PATH` and nowhere
/// else. A windowed launch does not inherit the shell's: macOS hands an app
/// started from Finder launchd's `PATH`, `/usr/bin:/bin:/usr/sbin:/sbin` and
/// no more, and a Linux `.desktop` launch is the same story with a different
/// list. So `~/.local/bin/git-remote-nostr` can be installed, working, and on
/// `PATH` in every terminal on the machine while staying invisible to the
/// window — which is exactly what happened here: three `nostr://` remotes that
/// `git ls-remote` reached from a shell reported `unreachable` in the app, and
/// the headless scanner and the window disagreed about the same repositories
/// on the same disk. Nothing separated them but how each was started, and a
/// tool whose answer depends on that is a tool with no answer.
///
/// A missing helper reaches `fetch_failure` as `unable to find remote helper`
/// and lands, correctly by its rules, on `unreachable` — the conservative
/// default doing its job on a cause it has no category for. Local
/// misconfiguration is not a condition of the moment, and no wording of that
/// flag would have made the fix findable. The `PATH` is the fix.
///
/// Appended, never prepended, so a `PATH` set deliberately keeps its
/// precedence and this only adds places to look once those have missed.
/// Directories that do not exist are skipped, which makes the list a guess
/// about where helpers usually live rather than a claim about this machine —
/// and is why the Unix-shaped entries cost nothing on Windows.
fn child_path() -> Option<OsString> {
    const HELPER_DIRS: &[&str] =
        &["~/.local/bin", "~/.cargo/bin", "/opt/homebrew/bin", "/usr/local/bin"];
    let current = std::env::var_os("PATH").unwrap_or_default();
    let extra: Vec<PathBuf> = HELPER_DIRS
        .iter()
        .map(|d| crate::config::expand(d))
        .filter(|p| p.is_dir())
        .collect();
    extend_path(&current, &extra)
}

/// Append `extra` to a `PATH`, skipping what is already on it.
///
/// `None` means *leave the inherited `PATH` alone* — either there was nothing
/// to add, or a directory contained the separator character and the result
/// would not join. Both are the safe direction: the inherited `PATH` is the
/// one thing here known to be someone's actual intent.
fn extend_path(current: &OsStr, extra: &[PathBuf]) -> Option<OsString> {
    // An empty `PATH` splits into one *empty entry*, and an empty entry means
    // the current directory — which, mid-scan, is a working tree.
    let mut dirs: Vec<PathBuf> =
        if current.is_empty() { Vec::new() } else { std::env::split_paths(current).collect() };
    let mut added = false;
    for dir in extra {
        if !dirs.contains(dir) {
            dirs.push(dir.clone());
            added = true;
        }
    }
    added.then(|| std::env::join_paths(&dirs).ok()).flatten()
}

fn git(dir: &Path, args: &[&str]) -> Option<String> {
    let out = git_cmd(dir).args(args).output().ok()?;
    if !out.status.success() {
        return None;
    }
    Some(String::from_utf8_lossy(&out.stdout).trim().to_string())
}

/// Whether a remote pins the account it will authenticate as.
///
/// This, not the protocol, is the property worth flagging. An `https://`
/// remote resolves through whatever the credential helper hands over, and a
/// bare `git@github.com:` resolves through whichever key ssh-agent happens to
/// offer first — with several accounts on one machine, both can push as the
/// wrong identity, and neither says so until the commit is on the wrong
/// profile. A host alias names an `IdentityFile`, so it can only ever be one
/// account.
///
/// The flag used to be `https remote` and matched the protocol alone, which
/// left the bare-SSH half of the same hazard invisible. Its own tooltip had
/// always described pinning rather than protocol — the name and the match arm
/// were what lagged.
fn pins_account(kind: RemoteKind) -> bool {
    match kind {
        RemoteKind::SshAlias => true,
        // `None` has nothing to authenticate against; a repo with no remote is
        // an archive, and reporting it as unpinned would be noise on a state
        // that is already saying the true thing.
        RemoteKind::None => true,
        // `nostr://` is here for the reason the rest are, not for its scheme.
        // Its npub names the repository being announced; the key that signs
        // the push comes from `nostr.nsec` in git config, which ngit writes
        // globally unless told otherwise and which every repo on the machine
        // then shares. Resolved at push time from outside the URL, silent
        // until something is signed by the wrong identity — the same hazard
        // as an ssh-agent's key order, wearing a different protocol. A
        // per-repo `nostr.nsec` genuinely does pin it and is invisible from
        // here, so that case earns an amber it does not deserve; reading git
        // config to tell them apart is the price of removing it, and amber on
        // a remote that fetches perfectly well is the cheaper mistake.
        RemoteKind::Https | RemoteKind::Ssh | RemoteKind::Nostr => false,
    }
}

fn classify_remote(url: &str) -> RemoteKind {
    if url.starts_with("https://") || url.starts_with("http://") {
        RemoteKind::Https
    } else if url.starts_with("nostr://") {
        RemoteKind::Nostr
    } else if url.starts_with("git@github.com:") || url.starts_with("ssh://") {
        RemoteKind::Ssh
    } else {
        // `alias:owner/repo.git` or `git@alias:owner/repo.git`.
        RemoteKind::SshAlias
    }
}

/// Host and path of a remote URL, in whatever form git accepts it.
///
/// For the scp-like form the host is whatever sits before the colon, which on
/// this machine is usually an SSH alias rather than a hostname. That is
/// resolved separately (`resolve_ssh_host`); this function only splits.
fn split_remote(url: &str) -> Option<(String, String)> {
    if let Some((_, rest)) = url.split_once("://") {
        // `https://host/path`, `ssh://user@host:port/path`.
        let (authority, path) = rest.split_once('/')?;
        let host = authority.rsplit('@').next()?;
        let host = host.split(':').next()?;
        return Some((host.to_string(), path.to_string()));
    }
    // `[user@]host:path`. A local path has no colon before its first slash.
    let (head, path) = url.split_once(':')?;
    if head.contains('/') || head.is_empty() {
        return None;
    }
    let host = head.rsplit('@').next()?;
    Some((host.to_string(), path.to_string()))
}

/// `owner/repo` from a remote path, or `None` if it is not that shape.
fn owner_repo(path: &str) -> Option<String> {
    let path = path.trim_matches('/');
    let path = path.strip_suffix(".git").unwrap_or(path);
    let mut parts = path.split('/');
    let (owner, repo) = (parts.next()?, parts.next()?);
    if parts.next().is_some() || owner.is_empty() || repo.is_empty() {
        return None;
    }
    Some(format!("{owner}/{repo}"))
}

/// The hostname an SSH host name resolves to under the machine's own config.
///
/// Alias names differ per machine — `github-xjmzx` here is `xjmzx` elsewhere —
/// so an alias is never recognised by its name. `ssh -G` prints the config it
/// would use without connecting, which is the machine's own answer.
fn resolve_ssh_host(host: &str) -> Option<String> {
    let config = crate::account::ssh_config(host)?;
    crate::account::config_value(&config, "hostname").map(str::to_ascii_lowercase)
}

/// `owner/repo` when a remote lives on github.com, however it is spelled.
fn github_repo(url: &str, kind: RemoteKind) -> Option<String> {
    let (host, path) = split_remote(url)?;
    let host = match kind {
        RemoteKind::SshAlias => resolve_ssh_host(&host)?,
        RemoteKind::Ssh | RemoteKind::Https => host.to_ascii_lowercase(),
        RemoteKind::Nostr | RemoteKind::None => return None,
    };
    (host == "github.com").then(|| owner_repo(&path)).flatten()
}

/// Read a probe's outcome, positively or not at all.
///
/// A readable repository is public. A refusal is private only when it is the
/// specific refusal of an anonymous request — git wanting a username it is not
/// allowed to ask for. Anything else (DNS, a timeout, a rate limit) says
/// nothing about visibility, and guessing either answer from it would be the
/// confident wrong answer `fetch_failure` is careful not to give.
fn visibility_from(success: bool, stderr: &str) -> Option<Visibility> {
    if success {
        return Some(Visibility::Public);
    }
    let s = stderr.to_ascii_lowercase();
    const ANONYMOUS_REFUSED: &[&str] = &["could not read username", "authentication failed"];
    ANONYMOUS_REFUSED.iter().any(|n| s.contains(n)).then_some(Visibility::Private)
}

/// Ask GitHub, without credentials, whether it will show this repository.
///
/// GitHub answers an anonymous read of a private repository exactly as it
/// answers one of a missing repository, so this is only meaningful after the
/// authenticated fetch has just succeeded — the caller guarantees that.
///
/// Every source of credentials is switched off, because one reaching the
/// request would make a private repository read as public:
/// - global and system config are replaced by nothing, which drops credential
///   helpers *and* any `url.*.insteadOf` that would quietly reroute the https
///   URL over an authenticated ssh connection;
/// - it runs outside the repository, so that repository's config is not read;
/// - prompts and askpass programs are disabled, so a refusal fails at once
///   rather than opening a dialog in front of the window.
///
/// `ls-remote` writes nothing anywhere, not even remote-tracking refs, so this
/// adds no side effect to the one `fetch` already has.
fn probe_visibility(repo: &str) -> Option<Visibility> {
    let empty = std::env::temp_dir().join("gtrack-no-such-gitconfig");
    let out = git_anywhere()
        .current_dir(std::env::temp_dir())
        .env("GIT_CONFIG_GLOBAL", &empty)
        .env("GIT_CONFIG_NOSYSTEM", "1")
        .env("GIT_TERMINAL_PROMPT", "0")
        .env_remove("GIT_ASKPASS")
        .env_remove("SSH_ASKPASS")
        .args([
            "-c", "credential.helper=",
            "-c", "core.askPass=",
            // A stalled transfer gives up instead of holding a scan lane.
            "-c", "http.lowSpeedLimit=1000",
            "-c", "http.lowSpeedTime=15",
            "ls-remote",
            &format!("https://github.com/{repo}.git"),
            "HEAD",
        ])
        .stdin(std::process::Stdio::null())
        .output()
        .ok()?;
    visibility_from(out.status.success(), &String::from_utf8_lossy(&out.stderr))
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

/// Every version a lockfile states — it carries one at the top level and
/// another under `packages[""]`, and a hand-edit can move one without the
/// other. Both are returned so an internal disagreement is caught by the same
/// comparison as a disagreement with the other files, rather than needing its
/// own special case.
fn lock_versions(path: &Path) -> Vec<String> {
    let Ok(raw) = std::fs::read_to_string(path) else { return Vec::new() };
    let Ok(v) = serde_json::from_str::<serde_json::Value>(&raw) else { return Vec::new() };

    let mut out = Vec::new();
    for found in [
        v.get("version").and_then(|x| x.as_str()),
        v.get("packages")
            .and_then(|p| p.get(""))
            .and_then(|r| r.get("version"))
            .and_then(|x| x.as_str()),
    ]
    .into_iter()
    .flatten()
    {
        if !out.iter().any(|e: &String| e == found) {
            out.push(found.to_string());
        }
    }
    out
}

fn read_versions(dir: &Path) -> Versions {
    let package = json_version(&dir.join("package.json"));
    let cargo = cargo_version(&dir.join("src-tauri/Cargo.toml"))
        .or_else(|| cargo_version(&dir.join("Cargo.toml")));
    let tauri = json_version(&dir.join("src-tauri/tauri.conf.json"));
    let locks = lock_versions(&dir.join("package-lock.json"));

    let mut present: Vec<&String> = [&package, &cargo, &tauri].into_iter().flatten().collect();
    present.extend(locks.iter());
    let agree = present.windows(2).all(|w| w[0] == w[1]);

    Versions { package, cargo, tauri, lock: locks.first().cloned(), agree }
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
        let root_path = crate::config::expand(&root.path);
        let label = root.heading();
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

/// Whether a repository is rooted anywhere, as a flag — or `None` when it is.
///
/// Two different things used to share the `no upstream` flag, and only one of
/// them is a fault. A repository with **no remote at all** is a deliberate
/// local archive: a tree kept on purpose after its remote went away, whose
/// contents live nowhere else. A branch that tracks nothing **while a remote
/// exists** is the alarming case — work with somewhere to go and no route to
/// it. Colouring the first red made a considered decision look like rot, and
/// buried the second among it.
fn rootedness(remote_kind: RemoteKind, has_upstream: bool) -> Option<&'static str> {
    match (remote_kind, has_upstream) {
        (RemoteKind::None, _) => Some("archive"),
        (_, false) => Some("no upstream"),
        (_, true) => None,
    }
}

/// Which of two very different things a failed fetch was.
///
/// `unreachable` used to carry both, and only one of them can be waited out. A
/// remote that answers *no such repository* is a durable fact about the world:
/// it was deleted, renamed, or belongs to an account this machine does not
/// authenticate as. Everything else — DNS, a refused connection, a key not
/// loaded — is a condition of the moment that looks different in an hour.
/// Sharing one flag between them is the mistake `rootedness` above exists to
/// undo, and it hid a real case: the one checkout here whose remote had been
/// deleted read as `1 behind`, indistinguishable from a repo owing a pull.
///
/// Conservative by construction. `unreachable` is the default and a failure is
/// promoted only on a positive match, because a blip mislabelled `orphan` is
/// the confident wrong answer this tool exists not to give, where an orphan
/// left as `unreachable` is merely the status quo. The generic
/// `could not read from remote repository` that git appends is deliberately
/// not a signal — it follows a refused key just as readily as a missing repo.
///
/// A remote that does not pin its account never reaches `orphan` at all. Hosts
/// answer *no such repository* to an account that cannot see a private one,
/// and an unpinned remote authenticates as whichever key or credential comes
/// first — so from it that answer means nothing about whether the repository
/// exists. This is the case that prompted the rule: a private repo on a bare
/// `git@github.com:` remote, fetched with another account's key, read as
/// deleted. It still reports `unreachable` and still carries `unpinned`,
/// whose fix is the one that actually makes the answer trustworthy.
///
/// `orphan` is unsettled on purpose, and there are exactly two ways out. Drop
/// the remote — `git remote remove origin` — and it becomes a derived
/// `archive`: kept deliberately, contents living nowhere else. Or delete the
/// tree and leave a tombstone in `gtrack.json`. It stays red until one of them
/// happens, because the missing thing is the decision.
fn fetch_failure(stderr: &str, kind: RemoteKind) -> &'static str {
    if pins_account(kind) && says_not_found(stderr) {
        "orphan"
    } else {
        "unreachable"
    }
}

/// Whether a failure is the host saying *no such repository*.
fn says_not_found(stderr: &str) -> bool {
    // Lower-cased once: GitHub capitalises "Repository", GitLab says "project",
    // and the wording drifts between git versions.
    let s = stderr.to_ascii_lowercase();
    const GONE: &[&str] = &[
        "repository not found",                              // GitHub
        "repository does not exist",                         // gitea, others
        "the project you were looking for could not be found", // GitLab
        "does not appear to be a git repository",             // path gone entirely
    ];
    GONE.iter().any(|needle| s.contains(needle))
}

/// The fetch-related flag, once the account check has had its say.
///
/// A pinned key that is not the owner's changes what *not found* means: GitHub
/// hides a private repository from any account without access, in the words
/// it uses for a deleted one. So a mismatch outranks `orphan` — the repository
/// is very likely fine, and the key is what is wrong. It does not outrank a
/// failure that never reached the repository (a refused key, DNS): those stay
/// `unreachable`, since nothing about the repository was learned.
///
/// After a *successful* fetch a mismatch is still worth saying. The key has
/// access — as a collaborator, say — so reads work and nothing looks wrong,
/// but every push lands on the other account's profile.
fn remote_flags(
    fetched: bool,
    fetch_error: Option<&str>,
    kind: RemoteKind,
    account: Option<&AccountMatch>,
) -> Vec<&'static str> {
    let other = matches!(account, Some(AccountMatch::Other(_)));
    match fetch_error {
        Some(msg) if other && says_not_found(msg) => vec!["other account"],
        Some(msg) => vec![fetch_failure(msg, kind)],
        None if fetched && other => vec!["other account"],
        None => vec![],
    }
}

/// Names from `git ls-remote --tags` output, peeled `^{}` lines dropped.
fn remote_tag_names(ls_remote: &str) -> std::collections::HashSet<&str> {
    ls_remote
        .lines()
        .filter_map(|l| l.split_whitespace().nth(1))
        .filter_map(|r| r.strip_prefix("refs/tags/"))
        .filter(|t| !t.ends_with("^{}"))
        .collect()
}

/// Local tags absent from the remote, in local order.
///
/// By name only. A tag that exists on both sides at different commits is a
/// different and rarer problem, and naming it `unpushed` would send someone to
/// push a tag that would be refused.
fn unpushed_tags(local: &str, ls_remote: &str) -> Vec<String> {
    let remote = remote_tag_names(ls_remote);
    local.lines().map(str::trim).filter(|t| !t.is_empty() && !remote.contains(t)).map(str::to_string).collect()
}

fn inspect(path: &Path, root_label: &str, cfg: &Config, fetch: bool, keys: &KeyBook) -> RepoStatus {
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
        match git_cmd(path).args(["fetch", "--quiet", &remote_name]).output() {
            Ok(o) if o.status.success() => fetched = true,
            Ok(o) => {
                let msg = String::from_utf8_lossy(&o.stderr).trim().to_string();
                fetch_error = Some(if msg.is_empty() { "fetch failed".into() } else { msg });
            }
            Err(e) => fetch_error = Some(e.to_string()),
        }
    }

    // Only after a successful fetch: that is what turns a refused anonymous
    // read into *private* rather than *gone or unreachable*.
    let visibility = if fetched {
        remote.as_deref().and_then(|u| github_repo(u, remote_kind)).and_then(|r| probe_visibility(&r))
    } else {
        None
    };

    // Asked whenever a fetch was attempted, failed ones included: a key that
    // is not the owner's is what turns a pinned *not found* from `orphan` into
    // `other account`. Pinned aliases only — for any other remote form the key
    // is not fixed, and `unpinned` already says so.
    let account = if fetch && remote_kind == RemoteKind::SshAlias && upstream.is_some() {
        remote.as_deref().and_then(|u| {
            let (host, path) = split_remote(u)?;
            let owner_repo = owner_repo(&path)?;
            let owner = owner_repo.split('/').next()?;
            (resolve_ssh_host(&host)? == "github.com").then_some(())?;
            keys.check(&host, owner).map(|m| (m, owner.to_string()))
        })
    } else {
        None
    };

    // Asked of the same remote, with the same authentication, that the fetch
    // just used — so it works for private repositories and needs no token.
    // Only after a successful fetch: an empty answer from a failed one would
    // read as *every tag unpushed*.
    //
    // Local tags are read first and the remote is asked only when there are
    // some. Each ask is a fresh SSH connection costing seconds, and most trees
    // here have no tags at all — 48 of 62 on the machine this was written on,
    // whose answers are known without asking.
    let local_tags = if fetched {
        git(path, &["for-each-ref", "refs/tags", "--format=%(refname:short)"]).unwrap_or_default()
    } else {
        String::new()
    };
    let unpushed_tags = if local_tags.trim().is_empty() {
        Vec::new()
    } else {
        git(path, &["ls-remote", "--tags", &remote_name])
            .map(|listing| unpushed_tags(&local_tags, &listing))
            .unwrap_or_default()
    };

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
    // First in the list, and deliberately ahead of the faults. Every other
    // flag reports something to judge; this one is an instruction, and it is
    // worth nothing if it is read after the row has already been acted on.
    if cfg.is_no_push(&name) {
        flags.push("no push".into());
    }
    if !locks.is_empty() {
        flags.push("stale lock".into());
    }
    // A declared retirement outranks the derived reading: the repo still has a
    // remote and a route out, so nothing on disk would ever reveal it.
    if cfg.is_archived(&name) {
        flags.push("archive".into());
    } else if let Some(f) = rootedness(remote_kind, upstream.is_some()) {
        flags.push(f.into());
    }
    for f in remote_flags(fetched, fetch_error.as_deref(), remote_kind, account.as_ref().map(|(m, _)| m)) {
        flags.push(f.into());
    }
    if !pins_account(remote_kind) {
        flags.push("unpinned".into());
    }
    if !versions.agree {
        flags.push("version mismatch".into());
    }
    if ahead > 0 {
        flags.push(format!("{ahead} unpushed"));
    }
    match unpushed_tags.len() {
        0 => {}
        1 => flags.push("1 unpushed tag".into()),
        n => flags.push(format!("{n} unpushed tags")),
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
        ahead, behind, dirty, fetched, fetch_error, visibility,
        versions, latest_tag, tag_date, commits_since_tag,
        locks, unpushed_tags,
        // A pass is reported only when the fetch succeeded. A key matching its
        // owner while the fetch failed says nothing reassuring about the repo,
        // and a green key beside a red `unreachable` would read as one.
        account: match &account {
            Some((AccountMatch::Owner, _)) if fetched => Some(AccountCheck::Owner),
            Some((AccountMatch::Other(_), _)) => Some(AccountCheck::Other),
            _ => None,
        },
        authenticates_as: match account {
            Some((AccountMatch::Owner, owner)) if fetched => Some(owner),
            Some((AccountMatch::Other(who), _)) => who,
            _ => None,
        },
        flags,
    }
}

/// Inspect one repository, fetching it first if asked.
///
/// Only a tree the configured roots would find is inspected. The path comes
/// from the webview, and gtrack reading or fetching an arbitrary directory
/// because a string named it is not a door worth leaving open. `None` when the
/// path is not one of them.
pub fn scan_one(cfg: &Config, path: &Path, fetch: bool) -> Option<RepoStatus> {
    let (found, root_label) = discover(cfg).into_iter().find(|(p, _)| p == path)?;
    // A key book of its own: one owner's keys, fetched once, then dropped.
    Some(inspect(&found, &root_label, cfg, fetch, &KeyBook::default()))
}

/// Scan every configured root. Local inspection is cheap and runs in order;
/// fetching is not, so repositories are inspected across a small pool of
/// threads when a fetch is requested.
pub fn scan(cfg: &Config, fetch: bool) -> Vec<RepoStatus> {
    let repos = discover(cfg);
    // One per scan: an account's keys are fetched once however many of its
    // repositories are checked, and never carried over to the next scan.
    let keys = KeyBook::default();
    if !fetch {
        return repos.iter().map(|(p, r)| inspect(p, r, cfg, false, &keys)).collect();
    }

    const LANES: usize = 8;
    let mut out: Vec<RepoStatus> = Vec::with_capacity(repos.len());
    std::thread::scope(|s| {
        let keys = &keys;
        let mut handles = Vec::new();
        for chunk in repos.chunks(repos.len().div_ceil(LANES).max(1)) {
            handles.push(s.spawn(move || {
                chunk.iter().map(|(p, r)| inspect(p, r, cfg, true, keys)).collect::<Vec<_>>()
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
    fn a_scheme_git_cannot_speak_is_not_an_ssh_alias() {
        // Before it had an arm this fell through the `else` and read as an
        // alias — pinned by accident, which is the reading an alias earns by
        // naming an `IdentityFile` and this URL does nothing to earn.
        assert_eq!(classify_remote("nostr://npub1abc/git.example.com/repo"), RemoteKind::Nostr);
        assert!(!pins_account(RemoteKind::Nostr));
        // Rooted all the same: a helper-served remote is not an archive.
        assert_eq!(rootedness(RemoteKind::Nostr, true), None);
        assert_eq!(rootedness(RemoteKind::Nostr, false), Some("no upstream"));
    }

    #[test]
    fn helper_directories_are_appended_and_never_duplicated() {
        // Joined rather than written with a literal separator: `:` on Unix and
        // `;` on Windows, and a hardcoded one makes this a single entry there.
        let current = std::env::join_paths(["/usr/bin", "/bin"].map(PathBuf::from)).unwrap();
        let local = PathBuf::from("/home/x/.local/bin");
        let extended = extend_path(&current, std::slice::from_ref(&local)).unwrap();
        let dirs: Vec<PathBuf> = std::env::split_paths(&extended).collect();
        // Appended, so a deliberate `PATH` still wins every lookup it can.
        assert_eq!(dirs.first(), Some(&PathBuf::from("/usr/bin")));
        assert_eq!(dirs.last(), Some(&local));
        // Already present: nothing added, and the inherited `PATH` stands.
        assert!(extend_path(&extended, std::slice::from_ref(&local)).is_none());
    }

    #[test]
    fn an_empty_path_does_not_become_the_working_tree() {
        // `split_paths("")` yields one empty entry, and an empty entry is the
        // current directory — mid-scan, a repository gtrack is reading.
        let extended = extend_path(OsStr::new(""), &[PathBuf::from("/opt/x/bin")]).unwrap();
        assert_eq!(
            std::env::split_paths(&extended).collect::<Vec<_>>(),
            vec![PathBuf::from("/opt/x/bin")]
        );
    }

    #[test]
    fn both_halves_of_the_unpinned_hazard_are_caught() {
        // The protocol differs; the failure does not. Either can push as the
        // wrong account on a machine with more than one.
        assert!(!pins_account(RemoteKind::Https));
        assert!(!pins_account(RemoteKind::Ssh));
        // An alias names an IdentityFile, so it can only be one account.
        assert!(pins_account(RemoteKind::SshAlias));
        // No remote at all: already reported as `archive`, nothing to pin.
        assert!(pins_account(RemoteKind::None));
    }

    #[test]
    fn an_archive_is_not_a_broken_remote() {
        // No remote at all: kept on purpose, not a fault.
        assert_eq!(rootedness(RemoteKind::None, false), Some("archive"));
        // A remote exists but the branch tracks nothing — work with no route out.
        assert_eq!(rootedness(RemoteKind::SshAlias, false), Some("no upstream"));
        assert_eq!(rootedness(RemoteKind::Https, false), Some("no upstream"));
        // Rooted: no flag either way.
        assert_eq!(rootedness(RemoteKind::SshAlias, true), None);
        assert_eq!(rootedness(RemoteKind::Ssh, true), None);
    }

    const PINNED: RemoteKind = RemoteKind::SshAlias;

    #[test]
    fn a_deleted_remote_is_not_a_dropped_connection() {
        // The exact stderr from the case that prompted this: an SSH alias that
        // authenticated fine against an owner whose repo had been deleted.
        assert_eq!(
            fetch_failure(
                "ERROR: Repository not found.\nfatal: Could not read from remote repository.\n\n\
                 Please make sure you have the correct access rights\nand the repository exists.",
                PINNED
            ),
            "orphan"
        );
        assert_eq!(fetch_failure("remote: The project you were looking for could not be found.", PINNED), "orphan");
        assert_eq!(fetch_failure("fatal: '/srv/git/x.git' does not appear to be a git repository", PINNED), "orphan");
    }

    #[test]
    fn an_unpinned_remote_cannot_prove_a_repository_is_gone() {
        // psync: private, on a bare git@github.com remote, fetched with another
        // account's key. GitHub hides it from that account in the same words it
        // uses for a deleted repository.
        let hidden = "ERROR: Repository not found.\nfatal: Could not read from remote repository.";
        assert_eq!(fetch_failure(hidden, RemoteKind::Ssh), "unreachable");
        assert_eq!(fetch_failure(hidden, RemoteKind::Https), "unreachable");
        assert_eq!(fetch_failure(hidden, RemoteKind::Nostr), "unreachable");
        // Pinned, the same words are a fact about the remote.
        assert_eq!(fetch_failure(hidden, PINNED), "orphan");
    }

    #[test]
    fn a_key_that_is_not_the_owners_outranks_orphan_but_not_a_refusal() {
        let other = AccountMatch::Other(Some("adjmx".into()));
        let hidden = "ERROR: Repository not found.\nfatal: Could not read from remote repository.";
        // Hidden from the wrong account: the key is the finding, not the repo.
        assert_eq!(remote_flags(false, Some(hidden), PINNED, Some(&other)), vec!["other account"]);
        // Same words, right account: the repository really is gone.
        assert_eq!(remote_flags(false, Some(hidden), PINNED, Some(&AccountMatch::Owner)), vec!["orphan"]);
        // Unknown account: exactly the old behaviour.
        assert_eq!(remote_flags(false, Some(hidden), PINNED, None), vec!["orphan"]);
        // A refused key never reached a repository; nothing learned about it.
        let refused = "git@github.com: Permission denied (publickey).";
        assert_eq!(remote_flags(false, Some(refused), PINNED, Some(&other)), vec!["unreachable"]);
        // Fetching fine as a collaborator still pushes as someone else.
        assert_eq!(remote_flags(true, None, PINNED, Some(&other)), vec!["other account"]);
        assert!(remote_flags(true, None, PINNED, Some(&AccountMatch::Owner)).is_empty());
        // No fetch attempted: no claim at all.
        assert!(remote_flags(false, None, PINNED, Some(&other)).is_empty());
    }

    #[test]
    fn a_single_scan_refuses_anything_the_roots_do_not_hold() {
        let root = std::env::temp_dir().join("gtrack-test-scan-one");
        let repo = root.join("r");
        std::fs::create_dir_all(repo.join(".git")).unwrap();
        let cfg: Config = serde_json::from_value(serde_json::json!({
            "roots": [root.to_string_lossy()], "groups": []
        }))
        .unwrap();
        assert_eq!(scan_one(&cfg, &repo, false).map(|r| r.name), Some("r".into()));
        // A real directory, just not one the roots hold.
        assert!(scan_one(&cfg, &std::env::temp_dir(), false).is_none());
        assert!(scan_one(&cfg, &root, false).is_none());
        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn unpushed_tags_compare_names_and_ignore_peeled_lines() {
        let remote = "b2c1\trefs/tags/v0.1.1\n78ba\trefs/tags/v0.1.1^{}\nf875\trefs/tags/v0.1.10\n";
        assert_eq!(unpushed_tags("v0.1.1\nv0.1.10\nv0.1.12\n", remote), vec!["v0.1.12"]);
        assert!(unpushed_tags("v0.1.1\nv0.1.10\n", remote).is_empty());
        // No tags anywhere, and a remote with none: every local tag is unpushed.
        assert!(unpushed_tags("", "").is_empty());
        assert_eq!(unpushed_tags("v1\n", ""), vec!["v1"]);
        // A name that is only a prefix of a remote tag is still missing.
        assert_eq!(unpushed_tags("v0.1\n", remote), vec!["v0.1"]);
    }

    #[test]
    fn remotes_split_into_host_and_path_in_every_form() {
        let sp = |u: &str| split_remote(u).map(|(h, p)| (h, owner_repo(&p)));
        let gh = |h: &str| Some((h.to_string(), Some("xjmzx/psync".to_string())));
        assert_eq!(sp("git@github.com:xjmzx/psync.git"), gh("github.com"));
        assert_eq!(sp("https://github.com/xjmzx/psync"), gh("github.com"));
        assert_eq!(sp("https://github.com/xjmzx/psync.git/"), gh("github.com"));
        assert_eq!(sp("ssh://git@github.com:22/xjmzx/psync.git"), gh("github.com"));
        // An alias splits to the alias; resolving it is ssh's job, not ours.
        assert_eq!(sp("github-xjmzx:xjmzx/psync.git"), gh("github-xjmzx"));
        assert_eq!(sp("git@xjmzx:xjmzx/psync.git"), gh("xjmzx"));
        // A local path is not a host.
        assert_eq!(split_remote("/srv/git/x.git"), None);
        // Not owner/repo: no probe.
        assert_eq!(owner_repo("group/sub/repo.git"), None);
        assert_eq!(owner_repo("repo.git"), None);
    }

    #[test]
    fn github_is_recognised_by_host_and_nothing_else_is_probed() {
        assert_eq!(github_repo("https://github.com/o/r.git", RemoteKind::Https).as_deref(), Some("o/r"));
        assert_eq!(github_repo("git@github.com:o/r.git", RemoteKind::Ssh).as_deref(), Some("o/r"));
        assert_eq!(github_repo("https://gitlab.com/o/r.git", RemoteKind::Https), None);
        assert_eq!(github_repo("nostr://npub1abc/relay/r", RemoteKind::Nostr), None);
    }

    #[test]
    fn visibility_is_read_positively_or_left_unknown() {
        assert_eq!(visibility_from(true, ""), Some(Visibility::Public));
        // The exact refusal of an anonymous read, captured from GitHub.
        assert_eq!(
            visibility_from(false, "fatal: could not read Username for 'https://github.com': terminal prompts disabled"),
            Some(Visibility::Private)
        );
        // Failures that say nothing about who may read it stay unknown.
        assert_eq!(visibility_from(false, "fatal: unable to access 'https://github.com/o/r.git/': Could not resolve host: github.com"), None);
        assert_eq!(visibility_from(false, ""), None);
    }

    #[test]
    fn a_failure_that_will_look_different_in_an_hour_stays_unreachable() {
        assert_eq!(fetch_failure("ssh: Could not resolve hostname github.com", PINNED), "unreachable");
        assert_eq!(fetch_failure("ssh: connect to host github.com port 22: Operation timed out", PINNED), "unreachable");
        // A refused key carries the same generic second line as a missing repo.
        // Matching on that line would turn every unloaded agent into an orphan.
        assert_eq!(
            fetch_failure("git@github.com: Permission denied (publickey).\nfatal: Could not read from remote repository.", PINNED),
            "unreachable"
        );
        // Nothing recognised at all: the conservative direction, not a guess.
        assert_eq!(fetch_failure("fetch failed", PINNED), "unreachable");
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
        let v = Versions { package: Some("1.0".into()), cargo: None, tauri: Some("1.0".into()), lock: None, agree: true };
        assert!(v.agree);
        let present: Vec<&String> = [&v.package, &v.cargo, &v.tauri, &v.lock].into_iter().flatten().collect();
        assert!(present.windows(2).all(|w| w[0] == w[1]));

        let bad = [Some("1.0".to_string()), Some("1.1".to_string())];
        let present: Vec<&String> = bad.iter().flatten().collect();
        assert!(!present.windows(2).all(|w| w[0] == w[1]));
    }

    /// The webview reads camelCase. A missing rename attribute does not fail
    /// to compile, does not fail to serialise, and does not error at runtime —
    /// it just delivers `undefined` for every multi-word field. Assert the
    /// wire names directly.
    #[test]
    fn repo_status_serialises_the_names_the_webview_reads() {
        let r = RepoStatus {
            name: "x".into(), path: "/x".into(), group: "g".into(),
            branch: None, upstream: None, remote: None, remote_kind: RemoteKind::None,
            ahead: 0, behind: 0, dirty: 0, fetched: false, fetch_error: None,
            visibility: Some(Visibility::Private), account: Some(AccountCheck::Owner),
            versions: Versions::default(),
            latest_tag: Some("v1".into()), tag_date: None, commits_since_tag: None,
            locks: vec![], unpushed_tags: vec!["v1".into()], authenticates_as: Some("adjmx".into()),
            flags: vec![],
        };
        let j = serde_json::to_value(&r).unwrap();
        for key in ["latestTag", "tagDate", "commitsSinceTag", "remoteKind", "fetchError", "unpushedTags", "authenticatesAs"] {
            assert!(j.get(key).is_some(), "missing camelCase key `{key}` — the webview would read undefined");
        }
        assert!(j.get("latest_tag").is_none(), "snake_case key leaked through");
        assert_eq!(j["visibility"], "private");
        assert_eq!(j["account"], "owner");
    }

    #[test]
    fn a_lockfile_states_its_version_twice_and_both_count() {
        let dir = std::env::temp_dir().join("gtrack-test-lock");
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("package.json"), r#"{"version":"0.1.1"}"#).unwrap();

        // In step: no disagreement.
        std::fs::write(
            dir.join("package-lock.json"),
            r#"{"version":"0.1.1","packages":{"":{"version":"0.1.1"}}}"#,
        ).unwrap();
        let v = read_versions(&dir);
        assert_eq!(v.lock.as_deref(), Some("0.1.1"));
        assert!(v.agree);

        // Behind the others — the v0.1.1 release did exactly this.
        std::fs::write(
            dir.join("package-lock.json"),
            r#"{"version":"0.1.0","packages":{"":{"version":"0.1.0"}}}"#,
        ).unwrap();
        assert!(!read_versions(&dir).agree, "a lockfile behind package.json must not read as agreement");

        // Disagreeing with ITSELF: caught by the same comparison, no special case.
        std::fs::write(
            dir.join("package-lock.json"),
            r#"{"version":"0.1.1","packages":{"":{"version":"0.1.0"}}}"#,
        ).unwrap();
        assert!(!read_versions(&dir).agree, "a lockfile disagreeing with itself must not read as agreement");

        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn a_repo_with_no_lockfile_is_not_a_disagreement() {
        let dir = std::env::temp_dir().join("gtrack-test-nolock");
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("package.json"), r#"{"version":"1.0.0"}"#).unwrap();
        let v = read_versions(&dir);
        assert_eq!(v.lock, None);
        assert!(v.agree, "absent files are not disagreement");
        std::fs::remove_dir_all(&dir).ok();
    }
}
