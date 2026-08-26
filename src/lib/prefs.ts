// UI preferences, in the webview's localStorage.
//
// Not in gtrack.json: which sections you happen to have open is a per-screen
// display choice, not configuration, and routing it through Rust would mean
// IPC commands for no gain. Nothing here is sensitive — gtrack holds no
// secrets at all.

const KEY = "gtrack.ui";

export interface Prefs {
  /** Group labels that are collapsed. Absent = expanded. */
  collapsed: string[];
  /** Whether the first run has happened; drives the collapse-by-default. */
  seeded: boolean;
}

const DEFAULTS: Prefs = { collapsed: [], seeded: false };

export function loadPrefs(): Prefs {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return { ...DEFAULTS };
    const p = JSON.parse(raw) as Partial<Prefs>;
    return { collapsed: p.collapsed ?? [], seeded: p.seeded ?? false };
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
