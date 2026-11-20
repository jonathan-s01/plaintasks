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

A marker is one or more of these symbols at the start of a line (after optional indentation). A space after it is normal, but `+Wayne thing` and `@call Sam` work too (not for `*`, `%` and `~` alone, and not when a digit follows, so `+1 for that`, `~/Documents` and `~5 min` stay plain text; `~~` is always strikethrough). Markers combine, e.g. `+*` or `@%`. A `$` at the start of a line (`$ old thing`, always with a space, so `$5 lunch` stays plain text) means deleted: the app hides the line and everything nested under it, and leaves the text in your file.

| Symbol | Meaning |
| --- | --- |
| `@` | open to-do |
| `+` | done |
| `<` | waiting on me |
| `>` | waiting on someone else |
| `*` | important |
| `%` | in progress |
| `~` | ongoing / major outcome |
| `•` | subtask of the task above |

```text
Website relaunch
@ draft the announcement due:fri
	@ collect screenshots
	a note about screenshots, attached to the task above
+ book the venue done:2026-11-02
< send Sam the budget
> vendor to confirm date jira:ABC-123
```

- **Hierarchy.** An indented marked line is a subtask. So is a line starting with `•`, with or without indenting: `• call Sam` is an open to-do under the task above, and it combines with statuses (`•+ done thing`, `•% doing`, `•> waiting`). A `•` line belongs to the nearest task above it at the same indentation that is not itself a `•` subtask, so a run of `•` lines are siblings; indent a `•` line to nest it one level deeper under the line above. Unmarked lines directly after a task are notes for it. A blank line ends the block.
- **Groups.** An unmarked line (or one ending in `:`) that is followed by tasks becomes a group or project name.
- **Dates.** `due:2026-11-20` is the stored form. When you set a date in the app, friendly input such as `fri`, `nov 20`, `+3d` or `in 2 weeks` is converted to that form. Completing a task adds `+` and `done:YYYY-MM-DD`.
- **Jira link.** `jira:ABC-123` ties a task to an issue.
- **Start date.** `start:2026-11-02` records when work began. It is hidden from the displayed text and spoken as "Started …". Sync with Jira sends it to the start-date field.
- **Goal link.** `goal:partner-network` ties a task to a goal (see Goals below). A task can carry several.
- **Label goal.** `jira:label` on a goal's line makes it a Jira label (bucket) instead of an issue; see Sync with Jira.
- **Per-file legends.** A file can define its own symbols with lines like `+ = done`, `nothing = to do`, or `• and indenting = subtasks`. Lines such as `nothing = to do` are recognised and skipped (never shown as tasks) but do not change how unmarked lines are treated; that is decided only by the folder and per-file settings. Legend lines are not tasks.
- **Unmarked lines per folder.** Each watched folder has a setting: unmarked lines are *notes* (default) or *tasks*. Individual files can override it in the settings page. Precedence: per-file setting, then folder setting. A file's own legend does not override either.
- **Triage (initial review).** The Triage view shows every file that still has unmarked lines, newest file first, with the whole file in order. Lines that already have a marker are read with just their status and text (the details, starting "Already a task", are on screen and in the Enter menu) and need nothing from you; unmarked lines are read with their position ("3 of 12 to review in this file") and Enter shows the lines around it. `a` or `@` makes the line a `@` to-do; `+`, `<`, `>`, `%` and `*` (or `x`, `w`, `i`, `p`) make it a to-do with that status straight away; `s` or `&` marks it as a note: `& ` is written in front of the line in your file, which attaches it to the nearest task above it (a line with no task above is remembered as a note in `~/.config/plaintasks/state.json` instead). Shift+`s` marks every remaining line in the file as a note, `n` / Shift+`n` jump to the next / previous file, Shift+`r` marks a file as reviewed, and `f` shows only files that are new or changed since you reviewed them.
- **Lists (My list and your own).** Personal, reorderable working lists that are independent of which file a task lives in. You start with one, **My list**; make more in Manage lists (Shift+`m` or the Manage lists button) or from the chooser. A task can be on several lists. Press `l` on a task: with only My list it adds or removes straight away; with several lists a dialog shows a checkbox per list plus a field to create a new list and add the task to it. In triage, `l` marks the unmarked line as a to-do and opens the same dialog: Up and Down move through the lists, Space ticks one, Enter saves and moves to the next line. Shift+`l` adds or removes the task from the list you are viewing, or the one you used last. Press `-` for My list, `[` and `]` to step through lists, or use the View menu. Lists and their order are stored in `~/.config/plaintasks/state.json`, never in your text files, and tasks are matched by file and task text, so membership survives marking done or setting dates but resets if you reword the task. Deleting a list never touches your files (My list can be renamed, not deleted). Reorder with Option+Up / Option+Down, or press `g` to pick a task up, then Up, Down, Home and End move it and Enter or Escape drops it. Each move is announced ("Moved down to position 3 of 7"). `u` undoes list changes.

- **Notes on tasks.** `s` on a task opens Add a note. The note is written into the file under the task, after its other notes, as `[2026-11-16, ListName] text` (the date stamp can be switched off). The task shows all its notes whichever list they were added from. To turn a task into a note, use Enter, then Convert to a note.
- **Notes with `&`.** A line starting with `&` (`& call back` or `&call back`) is a note of the nearest task above it, however many blank or other lines are between. It shows without the `&`, under the task. With no task above it, it stays an ordinary unmarked line.
- **Subtasks.** Tab makes the task a subtask of the task above it, with its notes and subtasks. Shift+Tab moves it up a level (a `•` subtask at its parent's indentation loses its `•` instead), and tasks right after it at the old level become its subtasks. On an unmarked line in triage Tab also marks it as a to-do; if other lines sit between it and the task above, the line is moved to the end of that task's block (u undoes the move). The file is re-indented.
- **Delete.** Delete or Backspace on a task in a list takes it off that list. In any other view, including triage, it marks the line and its subtasks with `$` in the file and the app stops showing them; the text stays in the file. `u` undoes it. Option+`n` makes a new list.
- **Notes under a task.** A task with notes can be expanded (Right arrow) to show them as rows under it. Tasks with notes start collapsed.
- **Adding tasks.** `n` opens Add a task: type to search your tasks, Down to a match to put it on a list, or choose the last option to create a new task. `m` creates a task straight away without searching. New tasks are written as `@ text` at the end of the master file, which you choose the first time and can change in Settings. If a list is open the task goes on it.
- **List sorting.** Shift+`o` in a list sorts it by manual order (remembered, the default), due date, check-in date, date added, type (notes last) or name. Reordering only works in manual order.
- **Goals.** A goal is any ongoing task (`~`). Press `y` on a task to open a checkbox list of goals: Up and Down move, Space ticks or unticks, Enter saves. Ticking a goal writes a `goal:` token on the task's own line in its file, and unticking removes it; a task can belong to several goals. The first time anything links to a goal, the goal's line gets its own id, made from its text (`~ Building partner network goal:building-partner-network`; `-2`, `-3` are added if that id is taken). Tasks point at that id, so rewording the goal keeps the links, but don't change or delete the goal's own `goal:` token. On a `~` line the first `goal:` token is the goal's id and any others link it to bigger goals. The tokens are hidden from the task text; linked goals are read out in the task's details ("Goal: …"). Press Shift+`g` (or use the View menu) for the Goals view: each goal with "N open, M done linked tasks", then its linked tasks from any file. A task on two goals shows under both. The chooser lists open goals, plus done ones the task is already linked to. Tokens that match no goal are left on the line. All writes in one save are undone together with `u`.
- **List folders, notes files and list notes.** Manage lists lets a list have a folder (a label that groups lists in the All lists view, `=`) and a notes file. A notes file is created as `<List name>.txt` in a folder you pick inside a watched folder, and is skipped by triage. Shift+`n` in a list adds a note that is not a task to that file, stamped with the date.
- **Lists that keep their tasks in a file.** In Manage lists, pick a file for a list and tick "Keep tasks in this file". The list then shows every task in that file, main tasks and subtasks, indented as in the file and in file order; you don't add them by hand. Putting a task on another such list (`l`, or the list chooser) moves the task line, its notes (including `&` notes further down) and its subtasks to the end of that list's file, as a main task, and takes them out of the old file. Both files are re-read before writing and written atomically; if either changed, nothing is written. `u` undoes the move in both files. Reordering (`g`, Option+Up/Down) moves the lines within the file, among tasks at the same level, and is refused if it would cross a blank line or heading and change other tasks. Delete in such a list deletes the task (`$`), because the list always shows its whole file. New tasks made in the list go to the end of its file. A task can be kept in only one file, so ticking two such lists with different files is refused. Lists that use a file only for notes are unchanged.
- **Due and check-in dates with times.** `d` sets the due date and a check-in date: `fri 2pm`, `nov 20 14:30`, `+3d 9am`. Stored as `due:2026-11-20 14:30` and `checkin:...`. `k` opens the same dialog on the check-in field. The Schedule view (`4`) groups tasks as Overdue, Today, This week and Later.

The full design, including assumptions, is in [docs/SPEC-lists-notes.md](docs/SPEC-lists-notes.md).

## Safe writing

- Only the one targeted line is rewritten. Every other byte, including line endings (LF/CRLF/CR) and BOM or UTF-16 encoding, is preserved.
- Before each write the file is re-read. If the line changed since the app last saw it, nothing is written and you are told so.
- Writes are atomic (temp file in the same folder, then rename), so a crash cannot leave a half-written note.
- Files edited elsewhere (TextEdit, OneDrive sync) are picked up automatically through a file watcher plus a periodic rescan.
- `u` undoes the last change, as long as the line has not changed since.
- Files that are not valid text, or are larger than 5 MB, are skipped and listed under "Skipped files" in settings.

## Views

All open, by file, by group or project, goals and their tasks, schedule (overdue, today, this week, later), due soon and overdue, waiting on me, waiting on others, important, in progress, completed, triage, All lists, and each list. Completed tasks are hidden everywhere except the Completed view; `c` shows them in the others. Search filters the current view.

## Keyboard

Press `?` in the app for the list (Escape closes it). Every command is also written out in plain text in [docs/COMMANDS.txt](docs/COMMANDS.txt). The short version:

| Key | Action |
| --- | --- |
| Up / Down, Home / End, PageUp / PageDown | move through the list |
| Right / Left | expand / collapse subtasks, move to first child / parent |
| Enter | actions menu for the item, with its full details (dates, file, notes, Jira, goals) |
| `+` (or `x`) | done / reopen |
| `<` / `>` | toggle waiting on me / waiting on someone else |
| `*` / `%` (or `i` / `p`), `b` or `~` | toggle important / in progress; ongoing (`~`) |
| (status symbols) | `+ > < % *` turning a status on opens a box for an optional note (who you are waiting on, why it matters). Enter with nothing typed skips it; Escape cancels. The note is saved dated under the task, for example `[2026-11-18] Waiting on others: Sam`, and one `u` undoes both. The letters `x w i p b` skip the box |
| `s` or `&` | on a task: add a note; in triage, on an unmarked line: mark as a note |
| Tab / Shift+Tab | make a subtask of the task above / move up a level (on a `•` subtask already at its parent's indentation, Shift+Tab removes the `•`) |
| `n`, `m` | add a task (search first) / create a task straight away |
| Option+`n` | make a new list |
| Delete / Backspace | in a list: off the list; in a list that keeps its tasks in a file, or elsewhere: delete the task (`$` in the file) |
| Shift+`n` | in a list: add a note that is not a task |
| Shift+`o` | in a list: sort |
| `d`, `k` | due and check-in dates with times (`k` starts on check-in) |
| `j` | Jira |
| Shift+`j` | Sync with Jira (preview, then apply what you tick) |
| `y` | link to goals (checkbox list) |
| `o` | open the source file in your editor |
| `u` | undo |
| `a` or `@` / Shift+`s` | triage: mark as to-do / mark the whole file as notes |
| `n` / Shift+`n`, Shift+`r`, `f` | triage (`n` elsewhere adds a task): next / previous file, mark file reviewed, only new or changed files |
| `l` / Shift+`l` | choose lists for the task / quick add or remove on the current or last-used list |
| `[` / `]`, Shift+`m` | previous / next list, manage lists |
| Shift+`g` | Goals view |
| `g`, Option+Up / Down | in a list: pick up and reorder with arrows, or move one place |
| `1`–`9`, `0`, `-`, `=` | switch view (1 open, 2 file, 3 group, 4 schedule, 5 waiting on me, 6 waiting on others, 7 important, 8 in progress, 9 completed, 0 triage, minus My list, equals All lists; other lists via `[` `]` or the View menu) |
| `v` | jump to the view menu |
| `c` or `h` | show / hide completed |
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

### Sync with Jira (Jira Cloud)

Sync runs only when you press Shift+`j` or the Sync with Jira button. It covers only lists with **Sync to Jira** ticked (in Manage lists or the New list form; off by default; the list needs a file, and sync is per file). It first shows a preview of every change in both directions. Nothing is sent or written until you choose Apply.

- **Preview.** Changes are grouped in fieldsets with counts: Conflicts, Create in Jira, Update Jira, Update files from Jira. Each item is labelled with its position ("2 of 5"), the task, the issue key, and the file and line. Conflicts have three radio buttons (keep file, take Jira, skip), and each group has apply-all buttons. A live line says how many changes are chosen. Items that can't sync (for example a subtask whose main task is done and was never in Jira) are listed under Not synced.
- **Push.** A main task becomes a Task in the epic (unless it already has `jira:`); an indented task at any depth becomes a Sub-task of its main task, because Jira can't nest deeper. The summary is the task text without tokens. The description is the task's notes, with web addresses as links. After a create, `jira:KEY` is written onto the task's line. A task that already has a key is updated, never re-created. For issues plaintasks didn't create, summary and description changes start unticked.
- **Pull.** For linked issues, Jira-side changes to status, summary and resolution are offered and, if ticked, written to the file (marker and `done:` date).
- **Which side changed.** After each sync the app remembers both values. Next time, a change on one side is offered in that direction; a change on both sides, or a difference on the first sync, is a conflict (default skip).
- **Status mapping** (configurable in settings):

  | Marker | Jira |
  | --- | --- |
  | `+` | Resolved, resolution Done; the `done:` date is sent as the due date |
  | `%` | In Progress |
  | `@` or unmarked | To Do, or the list's own status for open tasks (for example In Discovery) |
  | `>` | Flagged, plus label `waiting` |
  | `~` | In Progress, plus label `ongoing` |
  | `$` on a linked task | Resolved with resolution Won't Do, so statuses don't get mixed up |

  A Jira status in the same category counts as in sync (In Review matches `%`).
- **Goals.** `goal:` links become Jira "Relates" links between the task's issue and the goal's issue.
- **Label goals (buckets).** Put `jira:label` on a goal's line, for example `~ Advisory services goal:advisory-services jira:label`. That goal is never created, updated or closed in Jira and gets no Relates links. Instead every synced task that links to it directly (open or done) gets the label prefix plus the goal id, `bucket-advisory-services` by default; unlinking removes it. Labels starting with the prefix are managed by sync (one no longer wanted is removed even if added in Jira); other labels are left alone. Label updates are ticked even on issues plaintasks didn't create. Tasks indented under a label goal sync as main tasks. The prefix is a setting (default `bucket-`). The token is hidden from the text, and the goal's details say "Jira label goal".
- **Per list:** extra labels, and an optional status for open tasks.
- **Started notes.** If tasks have `& Started 2026-11-02` notes, the dialog offers a one-time button that turns them into `start:` tokens on the task line (all indexed files; `u` undoes).
- **Undo.** `u` undoes the file changes from one sync. Changes already sent to Jira stay.

Settings (on the settings page, under Jira sync; nothing is hard-coded): label goal prefix, project key, epic key, Task and Sub-task issue type ids, start-date and due-date field ids, Flagged field id (found by name if empty), assignee and reporter accountId, transition ids, status names per marker, resolution names or ids, and the waiting/ongoing labels. Example for a site like alberta.atlassian.net:

| Setting | Example |
| --- | --- |
| Project, epic | `A11Y`, `A11Y-2108` |
| Task, Sub-task issue type ids | `10002`, `10003` |
| Start date, due date fields | `customfield_10035`, `duedate` |
| Reporter accountId | needed if the project requires a reporter |
| Transition ids | `In Discovery=3, To Do=11, In Progress=31, In Review=41, Resolved=61, Reopen=2` |
| Resolutions | Done `10000`, Won't Do `10001` |

The token stays in the Keychain as above.

## Security

The server binds to `127.0.0.1` only, checks the Host and Origin headers, requires a random per-run token on every API call, accepts only JSON posts, and sends a strict Content-Security-Policy (no inline scripts or styles). It can only read and write files inside folders you added.

## Accessibility notes

Semantic HTML first. The list is a plain listbox with roving tabindex, so arrow keys behave like moving through a text file. Subtasks say "Level 2" and only rows that can open say "Collapsed" or "Expanded". It is not an ARIA tree because Chrome and Safari give every tree row an expanded or collapsed state, so VoiceOver said "collapsed" on rows with nothing to open. `?ui=tree` loads the same list as an ARIA tree (`aria-level`, `aria-posinset`, `aria-setsize`, `aria-expanded`). Text sizes use relative units and reflow down to 400 % zoom; the design honours dark mode, forced colours/high contrast, and reduced motion. See [docs/VOICEOVER.md](docs/VOICEOVER.md) for a manual test script.

Task rows are read with just their status and name, for example "Open. Call Sam.", plus the level and Collapsed or Expanded where that applies. Due dates, file and line, notes and the rest stay visible on screen but are hidden from screen readers; press Enter on the task to hear them. Group and list rows still read their counts.

Background, design decisions and the roadmap are in [docs/PLAN.md](docs/PLAN.md).

## Development

```sh
npm install      # dev dependencies only (jsdom, axe-core)
npm test
```

Tests use synthetic fixtures only. Layout: `src/parser.js` (line parsing), `src/ops.js` (what gets written), `src/writer.js` (safe atomic writes), `src/indexer.js`, `src/views.js`, `src/app.js` (controller), `src/server.js`, `public/` (front end).

## License

MIT
