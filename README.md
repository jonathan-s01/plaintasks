# plaintasks

An accessible, screen-reader-first to-do manager for people who keep their tasks in plain-text notes.

plaintasks reads the text files in the folders you choose, shows every task in one keyboard-driven list, and writes changes (done, waiting, due dates) back into those same files. **Your text files are the only source of truth.** There is no task database. The app only keeps a throwaway in-memory index that is rebuilt from the files.

It runs as a small web app on `localhost`, designed for Safari with VoiceOver on macOS. No runtime dependencies. Needs Node 20 or newer.

## Start

```sh
npm start
```

This starts the server on `http://localhost:4747` and opens Safari. If no folders are set up yet it opens the settings page. Options: `--port 4748`, `--no-open`.

First run: on the settings page type a folder path (for example `~/Documents/notes`) or a single `.txt`/`.md` file, or pick them in the browser, then press Add. You can add as many folders and files as you like; each folder lets you tick which files and subfolders to include. Go back to the task list.

Your settings live outside the repo, in `~/.config/plaintasks/` (override with `PLAINTASKS_CONFIG_DIR`). They are never committed.

## How tasks are recognised

A marker is one or more of these symbols at the start of a line (after optional indentation). A space after it is normal, but `+Wayne thing` and `@call Sam` work too (not for `*` and `%` alone, and not when a digit follows, so `+1 for that` stays plain text). Markers combine, e.g. `+*` or `@%`.

| Symbol | Meaning |
| --- | --- |
| `@` | open to-do |
| `+` | done |
| `<` | waiting on me |
| `>` | waiting on someone else |
| `*` | important |
| `%` | in progress |
| `•` | ongoing / major outcome |

```text
Website relaunch
@ draft the announcement due:fri
	@ collect screenshots
	a note about screenshots, attached to the task above
+ book the venue done:2026-11-02
< send Sam the budget
> vendor to confirm date jira:ABC-123
```

- **Hierarchy.** An indented marked line is a subtask. Unmarked lines directly after a task are notes for it. A blank line ends the block.
- **Groups.** An unmarked line (or one ending in `:`) that is followed by tasks becomes a group or project name.
- **Dates.** `due:2026-11-20` is the stored form. When you set a date in the app, friendly input such as `fri`, `nov 20`, `+3d` or `in 2 weeks` is converted to that form. Completing a task adds `+` and `done:YYYY-MM-DD`.
- **Jira link.** `jira:ABC-123` ties a task to an issue.
- **Per-file legends.** A file can define its own symbols with lines like `+ = done`, `nothing = to do`, or `• and indenting = subtasks`. `nothing = to do` makes unmarked lines tasks in that file; `nothing = notes` makes them notes. Legend lines are not tasks.
- **Unmarked lines per folder.** Each watched folder has a setting: unmarked lines are *notes* (default) or *tasks*. Individual files can override it in the settings page. Precedence: file legend, then per-file setting, then folder setting.
- **Triage (initial review).** The Triage view shows every file that still has unmarked lines, newest file first, with the whole file in order. Lines that already have a marker are shown as "Already a task" and need nothing from you; unmarked lines are read with their position ("3 of 12 to review in this file") and Enter shows the lines around it. `a` makes the line a `@` to-do, `x`, `m`, `w`, `i`, `p` mark it done, waiting or important straight away, `s` marks it as a note: it is attached to the nearest task above it and the decision is kept in `~/.config/plaintasks/state.json`, never in your file. Shift+`s` marks every remaining line in the file as a note, `n` / Shift+`n` jump to the next / previous file, Shift+`r` marks a file as reviewed, and `f` shows only files that are new or changed since you reviewed them.
- **Lists (My list and your own).** Personal, reorderable working lists that are independent of which file a task lives in. You start with one, **My list**; make more in Manage lists (Shift+`m` or the Manage lists button) or from the chooser. A task can be on several lists. Press `l` on a task: with only My list it adds or removes straight away; with several lists a dialog shows a checkbox per list plus a field to create a new list and add the task to it. Shift+`l` adds or removes the task from the list you are viewing, or the one you used last. Press `-` for My list, `[` and `]` to step through lists, or use the View menu. Lists and their order are stored in `~/.config/plaintasks/state.json`, never in your text files, and tasks are matched by file and task text, so membership survives marking done or setting dates but resets if you reword the task. Deleting a list never touches your files (My list can be renamed, not deleted). Reorder with Option+Up / Option+Down, or press `g` to pick a task up, then Up, Down, Home and End move it and Enter or Escape drops it. Each move is announced ("Moved down to position 3 of 7"). `u` undoes list changes.

## Safe writing

- Only the one targeted line is rewritten. Every other byte, including line endings (LF/CRLF/CR) and BOM or UTF-16 encoding, is preserved.
- Before each write the file is re-read. If the line changed since the app last saw it, nothing is written and you are told so.
- Writes are atomic (temp file in the same folder, then rename), so a crash cannot leave a half-written note.
- Files edited elsewhere (TextEdit, OneDrive sync) are picked up automatically through a file watcher plus a periodic rescan.
- `u` undoes the last change, as long as the line has not changed since.
- Files that are not valid text, or are larger than 5 MB, are skipped and listed under "Skipped files" in settings.

## Views

All open, by file, by group or project, due soon and overdue, waiting on me, waiting on others, important, in progress, completed, triage, and My list. Completed tasks are hidden everywhere except the Completed view; `c` shows them in the others. Search filters the current view.

## Keyboard

Press `?` in the app for the list. The short version:

| Key | Action |
| --- | --- |
| Up / Down, Home / End, PageUp / PageDown | move through the list |
| Right / Left | expand / collapse subtasks, move to first child / parent |
| Enter | actions menu for the item |
| `x` | done / reopen |
| `m` / `w` | toggle waiting on me / waiting on someone else |
| `i` / `p` / `b` | toggle important / in progress / ongoing |
| `d` | set or clear due date |
| `j` | Jira |
| `o` | open the source file in your editor |
| `u` | undo |
| `a` / `s` / Shift+`s` | triage: mark as to-do / skip / skip the whole file |
| `n` / Shift+`n`, Shift+`r`, `f` | triage: next / previous file, mark file reviewed, only new or changed files |
| `l` / Shift+`l` | choose lists for the task / quick add or remove on the current or last-used list |
| `[` / `]`, Shift+`m` | previous / next list, manage lists |
| `g`, Option+Up / Down | in a list: pick up and reorder with arrows, or move one place |
| `1`–`9`, `0`, `-` | switch view (1 open, 2 file, 3 group, 4 due, 5 waiting on me, 6 waiting on others, 7 important, 8 in progress, 9 completed, 0 triage, minus My list; other lists via `[` `]` or the View menu) |
| `v` | jump to the view menu |
| `c` | show / hide completed |
| `/` | search |
| `r` | rescan now |

Every action is confirmed in a polite live region ("Marked done: …"); errors use an alert region.

## RTF files

When you add a folder that contains `.rtf` files, plaintasks offers to convert them to `.txt`. A dialog lists exactly which files will be converted and nothing happens until you confirm. Conversion uses macOS `textutil`; the `.txt` is written next to the original, and the original `.rtf` is then moved to the Trash (recoverable). An existing `.txt` with the same name is never overwritten. This only ever touches folders you added. You can also trigger it later with "Convert .rtf files" on a folder card.

## Jira (optional)

Everything works without Jira. In settings you can add:

- **Jira Cloud**: site URL, account email, and an API token.
- **Jira Data Center / Server**: base URL and a personal access token.

The token is stored in the macOS Keychain (service `plaintasks-jira`) or taken from the `PLAINTASKS_JIRA_TOKEN` environment variable. It is never written to the config file or the repo. Note: when saving to the Keychain, the `security` command receives the token as an argument, so it is briefly visible to other processes running as your user. Use the environment variable if that matters to you.

With Jira set up, `j` on a task lets you link an issue key, show the issue's status, or create a new issue from the task and link it back. Jira URLs must be `https://`.

## Security

The server binds to `127.0.0.1` only, checks the Host and Origin headers, requires a random per-run token on every API call, accepts only JSON posts, and sends a strict Content-Security-Policy (no inline scripts or styles). It can only read and write files inside folders you added.

## Accessibility notes

Semantic HTML first. The list is an ARIA tree (flat, with `aria-level`, `aria-posinset`, `aria-setsize`, `aria-expanded`, roving tabindex) so arrow keys behave like moving through a text file. `?ui=list` loads the same list as a plain listbox in case the tree behaves badly with your VoiceOver setup. Text sizes use relative units and reflow down to 400 % zoom; the design honours dark mode, forced colours/high contrast, and reduced motion. See [docs/VOICEOVER.md](docs/VOICEOVER.md) for a manual test script.

Background, design decisions and the roadmap are in [docs/PLAN.md](docs/PLAN.md).

## Development

```sh
npm install      # dev dependencies only (jsdom, axe-core)
npm test
```

Tests use synthetic fixtures only. Layout: `src/parser.js` (line parsing), `src/ops.js` (what gets written), `src/writer.js` (safe atomic writes), `src/indexer.js`, `src/views.js`, `src/app.js` (controller), `src/server.js`, `public/` (front end).

## License

MIT
