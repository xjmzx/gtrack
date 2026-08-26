//! gtrack's scan without the window — the same code the app calls, printed as
//! text. Useful for checking the scanner against a real machine, and for a
//! quick sweep over ssh where no GUI exists.
//!
//!   cargo run --release --example scan            # local refs only
//!   cargo run --release --example scan -- --fetch # fetch tracked remotes first
//!
//! Use `--release`. Without it this is a debug build, and the dev/release
//! split means a debug build reads `gtrack.dev.json` while the installed app
//! reads `gtrack.json` — so a plain `cargo run` quietly reports on a different
//! configuration than the window shows.

fn main() {
    let fetch = std::env::args().any(|a| a == "--fetch");
    // Read the same config the installed app reads, so this and the window
    // agree. Falls back to defaults when there is no config file, which is
    // also what the app does.
    let cfg = match gtrack_lib::config::platform_config_dir() {
        Some(dir) => match gtrack_lib::config::load(&dir) {
            Ok(c) => {
                println!("config: {}", dir.display());
                c
            }
            Err(e) => {
                eprintln!("config unreadable ({e}) — using defaults");
                gtrack_lib::config::Config::default()
            }
        },
        None => gtrack_lib::config::Config::default(),
    };
    let mut rows = gtrack_lib::scan::scan(&cfg, fetch);
    // Group contiguously, or a group's header prints once per run of rows.
    rows.sort_by(|a, b| (&a.group, &a.name).cmp(&(&b.group, &b.name)));

    let mut group = String::new();
    for r in &rows {
        if r.group != group {
            group = r.group.clone();
            println!("\n== {group}");
        }
        let v = [&r.versions.package, &r.versions.cargo, &r.versions.tauri]
            .into_iter()
            .flatten()
            .next()
            .cloned()
            .unwrap_or_else(|| "—".into());
        let tag = r.latest_tag.clone().unwrap_or_else(|| "untagged".into());
        let since = r.commits_since_tag.filter(|n| *n > 0).map(|n| format!("+{n}")).unwrap_or_default();
        println!(
            "  {:<24} {:<14} {:<18} {:<4} {}",
            r.name, v, tag, since,
            if r.flags.is_empty() { "clean".to_string() } else { r.flags.join(", ") }
        );
    }
    // An archive is a state, not a finding: counting it as one would report a
    // machine with nothing wrong as having something wrong, every single run.
    let findings = rows.iter().filter(|r| r.flags.iter().any(|f| f != "archive")).count();
    let archived = rows.iter().filter(|r| r.flags.iter().any(|f| f == "archive")).count();
    print!("\n{} repos, {findings} with findings", rows.len());
    if archived > 0 {
        print!(", {archived} archived");
    }
    println!();
}
