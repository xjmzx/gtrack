// Which GitHub account a remote actually authenticates as.
//
// `unpinned` says a remote *could* land on the wrong identity. This answers
// the stronger question for the remotes that are pinned: does the one key the
// alias names belong to the account that owns the repository? A host alias
// fixes the key, not the account — an alias pointing at the wrong key is
// pinned, reliably, to the wrong identity, and nothing about its URL shows it.
//
// No credentials are involved. GitHub publishes every account's public keys at
// `github.com/<account>.keys`, and the local half is the `.pub` beside the
// private key `ssh -G` names. The private key is never read.
//
// Conservative in the same direction as `fetch_failure`: every step that
// cannot be sure answers "unknown", and unknown draws nothing.

use std::collections::HashMap;
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::sync::{Arc, Mutex, OnceLock};

/// Outcome of matching a remote's key against its owner's published keys.
#[derive(Clone, Debug, PartialEq)]
pub enum AccountMatch {
    /// The key is one the owning account publishes.
    Owner,
    /// The owner publishes keys and this is not among them. Carries the
    /// account that does publish it, when it is one seen in this scan.
    Other(Option<String>),
}

/// `ssh -G <host>` without connecting. `None` when ssh is missing or refuses.
pub fn ssh_config(host: &str) -> Option<String> {
    let mut cmd = Command::new("ssh");
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000);
    }
    let out = cmd.args(["-G", host]).stdin(Stdio::null()).output().ok()?;
    out.status.success().then(|| String::from_utf8_lossy(&out.stdout).into_owned())
}

/// The value of one `ssh -G` key, lower-cased keys as ssh prints them.
pub fn config_value<'a>(config: &'a str, key: &str) -> Option<&'a str> {
    config.lines().find_map(|l| l.strip_prefix(key).and_then(|r| r.strip_prefix(' ')).map(str::trim))
}

/// The single key a host is certain to authenticate with, or `None`.
///
/// Certain means `IdentitiesOnly yes` *and* exactly one `IdentityFile`.
/// Without the first, ssh-agent offers its own keys ahead of the file, which
/// is the unpinned hazard over again; with several files, whichever the server
/// accepts first wins. In either case naming one key would be a guess.
pub fn sole_identity(config: &str) -> Option<String> {
    if config_value(config, "identitiesonly") != Some("yes") {
        return None;
    }
    let mut files = config.lines().filter_map(|l| l.strip_prefix("identityfile ")).map(str::trim);
    let one = files.next()?;
    files.next().is_none().then(|| one.to_string())
}

/// The base64 blob of an OpenSSH public key line — the part that identifies
/// the key, without its type or comment.
pub fn key_blob(line: &str) -> Option<&str> {
    let mut parts = line.split_whitespace();
    let (_kind, blob) = (parts.next()?, parts.next()?);
    Some(blob)
}

/// The blob of the public key beside a private key path, if one is there.
fn local_blob(identity_file: &str) -> Option<String> {
    let path: PathBuf = crate::config::expand(identity_file);
    let mut pub_path = path.into_os_string();
    pub_path.push(".pub");
    let text = std::fs::read_to_string(pub_path).ok()?;
    key_blob(text.lines().next()?).map(str::to_string)
}

/// GitHub account names: alphanumerics and single hyphens. Checked before an
/// owner string is put in a URL, since it comes from a remote anyone can write.
pub fn valid_account(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= 39
        && name.chars().all(|c| c.is_ascii_alphanumeric() || c == '-')
        && !name.starts_with('-')
}

type Slot = Arc<OnceLock<Option<Vec<String>>>>;

/// Published keys per account, fetched at most once per scan however many
/// repositories and threads ask.
#[derive(Default)]
pub struct KeyBook {
    slots: Mutex<HashMap<String, Slot>>,
}

impl KeyBook {
    /// The blobs an account publishes. `None` when unknown — the request
    /// failed, or the account publishes nothing (an organisation, or a user
    /// with no keys), which is the absence of evidence and not a mismatch.
    fn keys(&self, account: &str) -> Option<Vec<String>> {
        let slot = {
            let mut slots = self.slots.lock().ok()?;
            slots.entry(account.to_string()).or_default().clone()
        };
        // The request runs outside the map lock, so lanes asking about other
        // accounts are not held up behind it.
        slot.get_or_init(|| fetch_keys(account)).clone()
    }

    /// Which already-fetched account publishes this blob, if any.
    fn owner_of(&self, blob: &str) -> Option<String> {
        let slots = self.slots.lock().ok()?;
        slots.iter().find_map(|(account, slot)| {
            slot.get()?.as_ref()?.iter().any(|k| k == blob).then(|| account.clone())
        })
    }

    /// Match a pinned host's key against the owning account's keys.
    pub fn check(&self, ssh_host: &str, owner: &str) -> Option<AccountMatch> {
        if !valid_account(owner) {
            return None;
        }
        let config = ssh_config(ssh_host)?;
        let blob = local_blob(&sole_identity(&config)?)?;
        Some(judge(&blob, &self.keys(owner)?, || self.owner_of(&blob)))
    }
}

/// The comparison itself, separated from the network for testing.
pub fn judge(blob: &str, owner_keys: &[String], other: impl FnOnce() -> Option<String>) -> AccountMatch {
    if owner_keys.iter().any(|k| k == blob) {
        AccountMatch::Owner
    } else {
        AccountMatch::Other(other())
    }
}

/// Parse a `.keys` response into blobs; empty means nothing published.
pub fn parse_keys(body: &str) -> Option<Vec<String>> {
    let keys: Vec<String> = body.lines().filter_map(key_blob).map(str::to_string).collect();
    (!keys.is_empty()).then_some(keys)
}

/// `curl` rather than an HTTP crate, for the reason the rest of the scanner
/// shells out: it is already on every platform gtrack builds for, and brings
/// the machine's own proxy and CA settings with it. Anonymous, no config.
fn fetch_keys(account: &str) -> Option<Vec<String>> {
    let mut cmd = Command::new("curl");
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000);
    }
    let out = cmd
        .args(["--fail", "--silent", "--show-error", "--max-time", "15", "--proto", "=https"])
        .arg(format!("https://github.com/{account}.keys"))
        .stdin(Stdio::null())
        .output()
        .ok()?;
    if !out.status.success() {
        return None;
    }
    parse_keys(&String::from_utf8_lossy(&out.stdout))
}

#[cfg(test)]
mod tests {
    use super::*;

    const ALIAS: &str = "user git\nhostname github.com\nidentitiesonly yes\nidentityfile ~/.ssh/id_ed25519_xjmzx-x22\n";
    const BARE: &str = "identitiesonly no\nidentityfile ~/.ssh/id_rsa\nidentityfile ~/.ssh/id_ed25519\n";

    #[test]
    fn only_a_fixed_single_key_is_named() {
        assert_eq!(sole_identity(ALIAS).as_deref(), Some("~/.ssh/id_ed25519_xjmzx-x22"));
        // ssh-agent may go first: no claim.
        assert_eq!(sole_identity(BARE), None);
        let two = "identitiesonly yes\nidentityfile ~/.ssh/a\nidentityfile ~/.ssh/b\n";
        assert_eq!(sole_identity(two), None);
        assert_eq!(config_value(ALIAS, "hostname"), Some("github.com"));
    }

    #[test]
    fn keys_compare_by_blob_not_by_comment() {
        assert_eq!(key_blob("ssh-ed25519 AAAAC3Nza x22@mac"), Some("AAAAC3Nza"));
        assert_eq!(key_blob("ssh-ed25519 AAAAC3Nza"), Some("AAAAC3Nza"));
        assert_eq!(key_blob(""), None);
        // GitHub's response carries no comments; the local .pub does.
        assert_eq!(parse_keys("ssh-ed25519 AAAA1\nssh-rsa BBBB2\n"), Some(vec!["AAAA1".into(), "BBBB2".into()]));
    }

    #[test]
    fn an_account_with_no_published_keys_is_not_evidence() {
        // Organisations publish none, and neither does a user who never added
        // one. Treating that as a mismatch would flag every org repository.
        assert_eq!(parse_keys(""), None);
        assert_eq!(parse_keys("\n"), None);
    }

    #[test]
    fn judging_names_the_other_account_when_it_can() {
        let owner = vec!["AAAA1".to_string()];
        assert_eq!(judge("AAAA1", &owner, || None), AccountMatch::Owner);
        assert_eq!(judge("BBBB2", &owner, || Some("adjmx".into())), AccountMatch::Other(Some("adjmx".into())));
        assert_eq!(judge("BBBB2", &owner, || None), AccountMatch::Other(None));
    }

    #[test]
    fn an_owner_from_a_remote_url_is_checked_before_it_reaches_a_url() {
        assert!(valid_account("xjmzx"));
        assert!(valid_account("macos-node"));
        assert!(!valid_account(""));
        assert!(!valid_account("-x"));
        assert!(!valid_account("x/../y"));
        assert!(!valid_account("x?y=1"));
    }
}
