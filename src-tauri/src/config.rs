// Where to look, and how to group what is found.
//
// gtrack never writes to a repository. This file is the only state it owns,
// and it holds nothing but paths and labels — there is no cache of scan
// results, deliberately: a stale cache of repo state is exactly the kind of
// confident wrong answer this tool exists to prevent.

use std::fs;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

/// A named grouping of repositories, matched by directory name. Anything not
/// claimed by a group falls back to the name of the root it was found under,
/// so a new checkout shows up somewhere sensible without configuration.
#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct Group {
    pub label: String,
    pub repos: Vec<String>,
}

/// A directory whose immediate children are checkouts.
///
/// The label is explicit rather than derived from the directory name, because
/// the same collection of repositories lives at different paths on different
/// machines. `~/code_upleb` here is something else on the Linux box, and a
/// group heading that changes name per install is not a heading — it is noise.
#[derive(Serialize, Clone, Debug, Deserialize)]
#[serde(from = "RootRepr")]
pub struct Root {
    /// `~` is expanded.
    pub path: String,
    /// Heading for repos in this root that no named group claims. Falls back
    /// to the directory name when absent.
    pub label: Option<String>,
}

/// Accepts either a bare path string — the shape before labels existed — or a
/// full object. A config written by an older install must keep working, and
/// silently resetting someone's roots would be worse than either.
#[derive(Deserialize)]
#[serde(untagged)]
enum RootRepr {
    Bare(String),
    Full {
        path: String,
        #[serde(default)]
        label: Option<String>,
    },
}

impl From<RootRepr> for Root {
    fn from(r: RootRepr) -> Self {
        match r {
            RootRepr::Bare(path) => Root { path, label: None },
            RootRepr::Full { path, label } => Root { path, label },
        }
    }
}

impl Root {
    /// The heading to file unclaimed repos under.
    pub fn heading(&self) -> String {
        self.label.clone().unwrap_or_else(|| {
            expand(&self.path)
                .file_name()
                .and_then(|s| s.to_str())
                .unwrap_or("?")
                .to_string()
        })
    }
}

/// A repository deleted on purpose, and what it was.
///
/// The only thing gtrack describes that it cannot scan. Every other row is a
/// measurement of something on disk; this is a note about something that is
/// deliberately not, and it exists because deletion alone does not answer the
/// question that made this tool — a dead end removed is cheaper to store but
/// no easier to identify six months later, when its name still appears in a
/// deploy note with nothing behind it.
///
/// Held here rather than in a file of its own because it is the same kind of
/// thing as `archived`: a decision that no local evidence could reveal. The
/// difference is only that one names a tree kept and the other a tree gone.
#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct Tombstone {
    /// The directory name it had, which is what a stale reference will say.
    pub name: String,
    /// ISO date the tree was removed. Optional: a tombstone written from
    /// memory is worth more than none, and refusing it would mean the
    /// backlog of already-deleted repos could never be recorded at all.
    #[serde(default)]
    pub removed: Option<String>,
    /// What it was, and where anything worth keeping survives. The whole
    /// value of the entry is in this line.
    #[serde(default)]
    pub note: Option<String>,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct Config {
    #[serde(default = "default_roots")]
    pub roots: Vec<Root>,
    #[serde(default = "default_groups")]
    pub groups: Vec<Group>,
    /// Repositories retired on purpose, by name.
    ///
    /// A repo with no remote at all is *derived* to be an archive — the
    /// evidence is on disk. This list is the other half: a repo whose remote
    /// still exists but has been retired, which no local evidence can show.
    /// GitHub's own archived flag is the authority, and asking it would mean
    /// a network call per repository on every scan for a fact that changes
    /// perhaps twice a year. Declaring it is cheaper, instant, offline, and
    /// says the true thing — that this is a decision, not a measurement.
    #[serde(default)]
    pub archived: Vec<String>,
    /// Repositories deleted on purpose, kept as notes rather than trees.
    ///
    /// Nothing here is ever scanned — by construction, the tree is gone. A
    /// name that turns up on disk anyway is a contradiction worth showing
    /// rather than resolving silently: either it was re-cloned, or the
    /// tombstone was written before the deletion happened.
    #[serde(default)]
    pub retired: Vec<Tombstone>,
}

fn default_roots() -> Vec<Root> {
    // Labels chosen for what the directory *is*, not what it is called: the
    // website trees read better as their domains than as their checkout paths.
    [
        ("~/code_gh/xjmzx", "xjmzx"),
        ("~/code_gh/macos-node", "macos-node"),
        ("~/code_gh/adjmx", "adjmx"),
        ("~/code_upleb", "upleb.uk"),
        ("~/code_vibe", "fizx.uk"),
    ]
    .into_iter()
    .map(|(path, label)| Root { path: path.into(), label: Some(label.into()) })
    .collect()
}

fn default_groups() -> Vec<Group> {
    vec![
        Group {
            label: "n-suite".into(),
            repos: [
                "ndisc", "nchat", "nplay", "ntree", "nsmpl", "nping", "nview", "ncover",
            ]
            .iter()
            .map(|s| s.to_string())
            .collect(),
        },
        Group {
            label: "ledger".into(),
            repos: ["nledger", "xledger", "vledger", "bledger", "aledger"]
                .iter()
                .map(|s| s.to_string())
                .collect(),
        },
    ]
}

impl Default for Config {
    fn default() -> Self {
        Self {
            roots: default_roots(),
            groups: default_groups(),
            archived: Vec::new(),
            retired: Vec::new(),
        }
    }
}

impl Config {
    /// Whether this repo has been declared retired.
    pub fn is_archived(&self, repo_name: &str) -> bool {
        self.archived.iter().any(|a| a == repo_name)
    }

    /// The tombstone for a name, if one was left. Used to mark the
    /// contradiction when a supposedly deleted tree is found on disk.
    pub fn tombstone(&self, repo_name: &str) -> Option<&Tombstone> {
        self.retired.iter().find(|t| t.name == repo_name)
    }

    /// Group label for a repo directory name, or `None` to fall back to its root.
    pub fn group_for(&self, repo_name: &str) -> Option<&str> {
        self.groups
            .iter()
            .find(|g| g.repos.iter().any(|r| r == repo_name))
            .map(|g| g.label.as_str())
    }
}

/// `~` is expanded here rather than at the edges so a config written by hand
/// behaves the same as one written by the app.
pub fn expand(p: &str) -> PathBuf {
    match p.strip_prefix("~/") {
        Some(rest) => match home() {
            Some(home) => home.join(rest),
            None => PathBuf::from(p),
        },
        None => PathBuf::from(p),
    }
}

/// The directory `~` stands for.
///
/// `HOME` is the Unix answer and leads there. Windows does not set it for a
/// process launched from Explorer, so a default config's roots would expand to
/// nothing and the window would come up empty; and where a POSIX shell like Git
/// Bash does set it, it holds a `/c/...` path that no Windows API can open.
/// `USERPROFILE` is the one that is both present and openable, so it leads there.
fn home() -> Option<PathBuf> {
    const KEYS: &[&str] = if cfg!(windows) { &["USERPROFILE", "HOME"] } else { &["HOME"] };
    KEYS.iter()
        .filter_map(std::env::var_os)
        .find(|v| !v.is_empty())
        .map(PathBuf::from)
}

/// Where the installed app keeps its config, resolved without Tauri.
///
/// The app itself asks Tauri for this and that stays authoritative; this
/// mirrors the same rule so the headless scanner reads what the window reads.
/// A scanner that silently used built-in defaults while the app used a config
/// file would be a second tool wearing the first one's name — which it was,
/// until this existed.
pub fn platform_config_dir() -> Option<PathBuf> {
    const IDENT: &str = "uk.fizx.gtrack";
    let home = home()?;
    let base = if cfg!(target_os = "macos") {
        home.join("Library/Application Support")
    } else if cfg!(windows) {
        std::env::var_os("APPDATA").map(PathBuf::from)?
    } else {
        std::env::var_os("XDG_CONFIG_HOME")
            .map(PathBuf::from)
            .unwrap_or_else(|| home.join(".config"))
    };
    Some(base.join(IDENT))
}

/// Debug builds keep their own config, per the suite convention, so a dev run
/// never rewrites the installed app's roots.
fn config_path(dir: &Path) -> PathBuf {
    dir.join(if cfg!(debug_assertions) {
        "gtrack.dev.json"
    } else {
        "gtrack.json"
    })
}

pub fn load(dir: &Path) -> Result<Config, String> {
    let path = config_path(dir);
    if !path.exists() {
        return Ok(Config::default());
    }
    let raw = fs::read_to_string(&path).map_err(|e| format!("could not read {}: {e}", path.display()))?;
    serde_json::from_str(&raw).map_err(|e| format!("{} is malformed: {e}", path.display()))
}

pub fn save(dir: &Path, cfg: &Config) -> Result<(), String> {
    fs::create_dir_all(dir).map_err(|e| format!("could not create {}: {e}", dir.display()))?;
    let path = config_path(dir);
    let body = serde_json::to_string_pretty(cfg).map_err(|e| format!("could not serialise: {e}"))?;
    fs::write(&path, body).map_err(|e| format!("could not write {}: {e}", path.display()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn debug_builds_use_a_separate_config_file() {
        let p = config_path(Path::new("/tmp"));
        assert_eq!(p.file_name().unwrap(), "gtrack.dev.json");
    }

    #[test]
    fn groups_claim_their_repos_and_ignore_the_rest() {
        let c = Config::default();
        assert_eq!(c.group_for("nchat"), Some("n-suite"));
        assert_eq!(c.group_for("xledger"), Some("ledger"));
        assert_eq!(c.group_for("some-random-checkout"), None);
    }

    #[test]
    fn tilde_expands_from_home() {
        // Which variable carries it is the part that differs by platform.
        let (key, dir) = if cfg!(windows) {
            ("USERPROFILE", r"C:\home\test")
        } else {
            ("HOME", "/home/test")
        };
        std::env::set_var(key, dir);
        assert_eq!(expand("~/code"), PathBuf::from(dir).join("code"));
        assert_eq!(expand("/abs/path"), PathBuf::from("/abs/path"));
    }

    #[test]
    fn a_bare_string_root_still_parses() {
        // The shape written before labels existed.
        let cfg: Config = serde_json::from_str(r#"{"roots":["~/code_gh/xjmzx"],"groups":[]}"#).unwrap();
        assert_eq!(cfg.roots.len(), 1);
        assert_eq!(cfg.roots[0].path, "~/code_gh/xjmzx");
        assert_eq!(cfg.roots[0].label, None);
        // With no label it falls back to the directory name.
        assert_eq!(cfg.roots[0].heading(), "xjmzx");
    }

    #[test]
    fn a_labelled_root_uses_its_label() {
        let cfg: Config =
            serde_json::from_str(r#"{"roots":[{"path":"~/code_upleb","label":"upleb.uk"}],"groups":[]}"#).unwrap();
        assert_eq!(cfg.roots[0].heading(), "upleb.uk");
    }

    #[test]
    fn defaults_label_the_website_trees_by_domain() {
        let c = Config::default();
        let headings: Vec<String> = c.roots.iter().map(|r| r.heading()).collect();
        assert!(headings.contains(&"upleb.uk".to_string()));
        assert!(headings.contains(&"fizx.uk".to_string()));
    }

    #[test]
    fn a_declared_archive_is_recognised_by_name() {
        let mut c = Config::default();
        assert!(!c.is_archived("LRCVZX"));
        c.archived.push("LRCVZX".into());
        assert!(c.is_archived("LRCVZX"));
        assert!(!c.is_archived("LRNS"));
    }

    #[test]
    fn a_config_without_the_field_still_parses() {
        // Every config written before `archived` and `retired` existed.
        let c: Config = serde_json::from_str(r#"{"roots":[],"groups":[]}"#).unwrap();
        assert!(c.archived.is_empty());
        assert!(c.retired.is_empty());
    }

    #[test]
    fn a_tombstone_needs_only_a_name() {
        // A repo deleted before this field existed can still be recorded from
        // memory; demanding a date would mean the backlog stays unwritten.
        let c: Config =
            serde_json::from_str(r#"{"roots":[],"groups":[],"retired":[{"name":"sonic.fizx.uk"}]}"#).unwrap();
        assert_eq!(c.retired.len(), 1);
        assert_eq!(c.retired[0].removed, None);
        assert_eq!(c.retired[0].note, None);
        assert!(c.tombstone("sonic.fizx.uk").is_some());
        assert!(c.tombstone("gtrack").is_none());
    }

    #[test]
    fn a_full_tombstone_round_trips() {
        let mut c = Config::default();
        c.retired.push(Tombstone {
            name: "svelte-static".into(),
            removed: Some("2026-08-27".into()),
            note: Some("Scaffold; nothing unique.".into()),
        });
        let back: Config = serde_json::from_str(&serde_json::to_string(&c).unwrap()).unwrap();
        assert_eq!(back.retired[0].name, "svelte-static");
        assert_eq!(back.retired[0].removed.as_deref(), Some("2026-08-27"));
    }
}
