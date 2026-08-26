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

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct Config {
    #[serde(default = "default_roots")]
    pub roots: Vec<Root>,
    #[serde(default = "default_groups")]
    pub groups: Vec<Group>,
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
        }
    }
}

impl Config {
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
        Some(rest) => match std::env::var("HOME") {
            Ok(home) => Path::new(&home).join(rest),
            Err(_) => PathBuf::from(p),
        },
        None => PathBuf::from(p),
    }
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
        std::env::set_var("HOME", "/home/test");
        assert_eq!(expand("~/code"), PathBuf::from("/home/test/code"));
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
}
