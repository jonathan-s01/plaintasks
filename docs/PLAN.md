# plaintasks: plan, decisions and roadmap

This is the background for the project: what problem it solves, what was decided and why, and what is still open. For how to use the app, see the [README](../README.md).

## The problem

To-dos live in many plain-text note files: meeting notes, project notes, a running scratch pad, and small per-project lists. They are spread over several folders (Desktop, synced cloud folders, subfolders of meeting notes). The files keep growing, finished items pile up, and there is no single place to see what is open, what is due, or what is waiting on someone.

Existing tools did not fit:

- **Apple Reminders**: too slow to work with, and tasks would have to be retyped out of the notes.
- **Obsidian + Tasks plugin**: good query model and date syntax (borrowed here), but only reads `.md` files inside one vault, and VoiceOver support is weak.
- **todo.txt**: plain text and screen-reader friendly, but one flat file with no interface for grouping, layers or scattered sources.

## Requirements

From the original request:

1. One place that sees tasks from all chosen files and folders.
2. Different lists, with grouping and layers (subtasks).
3. Due dates and completion dates.
4. Extract tasks from existing notes, using the symbols already in use (`+` for done and others).
5. Works perfectly with a screen reader (VoiceOver on macOS), and navigates like a text file.
6. Pulls from folders and updates the files as things are finished.
7. Completed items are hidden from lists.
8. Optional Jira sync.
9. Really easy to use.

## Decisions

| Topic | Decision | Why |
| --- | --- | --- |
| Source of truth | The text files. No task database; the in-memory index is rebuilt from files. | Nothing can drift out of sync; notes stay usable in any editor. |
| Writing back | Only the targeted line is rewritten; file re-read and line verified first; atomic temp-file rename; encoding and line endings preserved; in-app undo. No backup copies. | Files live in a synced cloud folder and are edited in TextEdit at the same time. Cloud version history covers disasters. |
| Markers | `+` done, `@` open to-do, `<` waiting on me, `>` waiting on someone else, `~` ongoing / major outcome, `•` subtask of the task above, `*` important, `%` in progress. Combinable (`+*`, `•+`). | Matches symbols already used in existing notes. `@` is what triage writes to turn a line into a to-do. |
| Unmarked lines | Default: notes, surfaced in Triage. Per-folder and per-file setting can make them tasks. A legend block in a file (`nothing = to do`) wins. | Existing files disagree: some treat unmarked lines as tasks, most treat them as notes. |
| `•` with no legend | Subtask of the nearest task above at the same indentation (a run of `•` lines are siblings); indenting nests deeper. A file legend can redefine it (for example `• = ongoing`). `~` is ongoing and needs a space unless joined to a strong marker, so `~/path`, `~5 min` and `~~strike~~` stay plain text. | Matches how the user reads `•` and Tab: both mean subtask. |
| Note vs. task lines | Unmarked lines right after a task are its notes; a blank line ends the block; consecutive marked lines are separate tasks. | Several to-dos are often written on back-to-back lines. |
| Dates | `due:YYYY-MM-DD` stored; friendly input (`fri`, `nov 20`, `+3d`) converted on entry. Completing adds `done:YYYY-MM-DD`. | Readable in plain text and close to Obsidian Tasks syntax. |
| RTF | Convert `.rtf` to `.txt` in place with `textutil`, only in folders the user adds, after a confirmation listing the files. Original goes to the Trash. | RTF is hard to write back to safely and the user prefers plain text. |
| Interface | Local web app on `localhost`, used in Safari. Keyboard first: arrows move one task at a time, single-key commands, live-region confirmations. ARIA tree with a plain listbox fallback (`?ui=list`). | Native HTML controls give the most predictable VoiceOver behaviour without building a native app. To be confirmed by testing. |
| Folder picking | Type or paste a path, or browse inside the app, then tick which files and subfolders to include. | A web page cannot open the native folder picker with real paths. |
| Personal lists | "My list" plus any number of named, reorderable lists, stored in `~/.config/plaintasks/state.json`, not in the notes. A task can be on several lists. | Working order and focus lists are personal and should not clutter the notes. |
| Jira | Generic adapter for Jira Cloud (email + API token) and Data Center/Server (PAT). Token in macOS Keychain or an environment variable, never in the repo or config file. Link a key, show status, create an issue from a task. | The repo is public and generic; credentials stay on the local machine. |
| Stack | Node 20+, no runtime dependencies. Dev-only: jsdom and axe-core for automated accessibility checks. | Easy to start (`npm start`), little to maintain. |
| Security | Binds to `127.0.0.1`, Host/Origin checks, per-run token, strict CSP, file access limited to added folders. | The app can write to personal files. |
| Repo | Public, MIT, generic. No personal or employer paths, names or credentials in code, tests or docs. Test fixtures are synthetic. | Useful to others without exposing private data. |

## Status

Done (v1, merged to `main`):

- Parser with per-file legends, hierarchy, groups, notes, dates and Jira keys.
- Safe line-targeted writer with undo.
- Folder and single-file sources, include/exclude, live file watching.
- Views: all open, by file, by group, due, waiting on me, waiting on others, important, in progress, completed, triage, and personal lists.
- Triage review with per-file progress and "new or changed" filter.
- Named, reorderable lists.
- RTF conversion flow.
- Jira adapter (link, status, create).
- 40+ automated tests, including axe-core checks.

## Open items and roadmap

1. **VoiceOver test in Safari** (highest priority). Run [VOICEOVER.md](VOICEOVER.md). Decide between the tree and the plain list (`?ui=list`) based on what is actually announced.
2. **Try it on real notes.** Start with one folder, run triage, check that existing legends and symbols are read correctly, then add the remaining folders and convert their RTF files.
3. **Jira against a real instance.** Not yet tested beyond mocked tests.
4. Fixes from the above.

Ideas, not committed to:

- Quick capture: add a task to a chosen file without leaving the app.
- Recurring tasks.
- Two-way Jira status sync (close the task when the issue closes).
- "Navigate like a text file" alternative: generated plain-text view files that sync back, if the web UI does not work well enough with VoiceOver.
- Native macOS wrapper, only if the web app falls short.
