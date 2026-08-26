//! gtrack's scan without the window — the same code the app calls, printed as
//! text. Useful for checking the scanner against a real machine, and for a
//! quick sweep over ssh where no GUI exists.
//!
//!   cargo run --example scan            # local refs only
//!   cargo run --example scan -- --fetch # fetch tracked remotes first

fn main() {
    let fetch = std::env::args().any(|a| a == "--fetch");
    let cfg = gtrack_lib::config::Config::default();
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
    println!("\n{} repos, {} with findings", rows.len(), rows.iter().filter(|r| !r.flags.is_empty()).count());
}
