// UI preferences, in the webview's localStorage.
//
// Not in gtrack.json: which sections you happen to have open is a per-screen
// display choice, not configuration, and routing it through Rust would mean
// IPC commands for no gain. Nothing here is sensitive — gtrack holds no
// secrets at all.

const KEY = "gtrack.ui";

/** Your own repos, or the clones kept to follow upstream projects. */
export type Tab = "mine" | "upstream";

export interface Prefs {
  /** Group labels that are collapsed. Absent = expanded. */
  collapsed: string[];
  /** Whether the first run has happened; drives the collapse-by-default. */
  seeded: boolean;
  /** Whether the retired section is open. Closed by default and tracked
   *  separately from `collapsed`, which holds group labels read from the
   *  config — a reserved name in that list could collide with a real group. */
  retiredOpen: boolean;
  /** The tab last shown, so the window reopens where it was left. */
  tab: Tab;
  /** The upstream tab's own collapsed categories. Separate from `collapsed`
   *  because a category folder may share a name with one of your groups, and
   *  closing one must not close the other. */
  upstreamCollapsed: string[];
  /** The upstream tab's first-run collapse, done once like `seeded`. */
  upstreamSeeded: boolean;
}

const DEFAULTS: Prefs = {
  collapsed: [],
  seeded: false,
  retiredOpen: false,
  tab: "mine",
  upstreamCollapsed: [],
  upstreamSeeded: false,
};

export function loadPrefs(): Prefs {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return { ...DEFAULTS };
    const p = JSON.parse(raw) as Partial<Prefs>;
    return {
      collapsed: p.collapsed ?? [],
      seeded: p.seeded ?? false,
      retiredOpen: p.retiredOpen ?? false,
      // Anything unrecognised falls back rather than leaving no tab shown.
      tab: p.tab === "upstream" ? "upstream" : "mine",
      upstreamCollapsed: p.upstreamCollapsed ?? [],
      upstreamSeeded: p.upstreamSeeded ?? false,
    };
  } catch {
    return { ...DEFAULTS };
  }
}

export function savePrefs(p: Prefs): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(p));
  } catch {
    /* Storage unavailable — the app works, the choice just won't stick. */
  }
}
