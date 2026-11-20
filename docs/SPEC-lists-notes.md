# Spec: import, tasks, notes, lists, dates

This is the agreed design for the next round of work. It records what was asked, what was decided, and the assumptions made where a question was left open. The README describes what is built; this describes what and why.

## Principles

1. **Your text files are the truth.** Anything that changes a task (status, due date, a note, a subtask) is written to the original file. Only a few things live in `state.json`, and each is listed under "What is stored where".
2. **One set of commands everywhere.** The same key does the same job in triage and in any task view or list.
3. **Plain keys in lists, Option only inside text fields.** (Option plus a letter types special characters in Safari.) Option+n also opens "add task" from anywhere, as an alias.
4. **Every action is announced and undoable** with `u`.

## Import and triage

- Point the app at folders. It reads every `.txt`, `.md`, `.text` file inside.
- A line with a known marker (`@ + < > ~ • * %`, with or without a space after it) is a task and needs no review.
- Every other non-blank line goes to the triage list, grouped by file, in one long list. The whole file is shown in order so you can see context. Tasks and already-reviewed notes are shown but need no action.
- Per line: `a` or `@` marks it a to-do (writes `@` into the file). `s` marks it a note (stored in `state.json`, never in the file). A note attaches to the nearest task above it.
- Folder default for unmarked lines is "notes". A file legend (`nothing = to do`) is skipped as a line but does not override it.
- **Task to note** stays available from the Enter menu for lines that were imported as tasks by mistake.
- Lines the app writes itself (list notes, generated file headers) are marked as reviewed automatically, so they never show up in triage.

## Task status

Every status is a toggle. Pressing it again clears it. The key is the same as the symbol in the file.

| Key | Meaning | Written as |
| --- | --- | --- |
| `+` (or `x`) | done / not done | `+` marker and `done:` date |
| `>` (or `w`) | waiting on someone else | `>` |
| `<` | waiting on me | `<` |
| `%` (or `p`) | in progress | `%` |
| `*` (or `i`) | important | `*` |
| `b` or `~` | ongoing / major outcome | `~` |
| `@` or `a` | to-do (triage only) | `@` |

`>` and `<` replace each other. `%` and `*` combine with any other status. All of these work on tasks in any view and on unmarked lines in triage.

### Status notes

When `+ > < % *` turn a status on (tasks in any view, unmarked lines in triage), a dialog asks for an optional note. Enter with nothing typed sets the status without a note; Escape cancels and changes nothing. A typed note is written as a dated note under the task, prefixed with the status label (`[2026-11-18] Waiting on others: Sam`). The status is written first, then the note, as one undo step. If the note cannot be written the status is reverted. Turning a status off never asks. The letter keys (`x w i p b`) and the actions menu set the status without asking.

## Notes on tasks

- `s` on a task (any view): opens a text box. The note is inserted as an indented line directly below the task's last existing note, or directly below the task if it has none.
- By default the note is stamped: `[2026-11-18, Team sync] text`. The list name appears only when you add it from a list. There is a checkbox to turn the stamp off.
- A task shows every note it has, no matter which list or meeting added it.
- Notes cannot be added in a file where plain lines are tasks (the folder or file is set to "unmarked lines are tasks"), because the new line would become a task. The app says so.
- A plain line that starts with a marker symbol cannot be a note and is rejected.

## Delete and notes rows

- Delete or Backspace: in a list view it removes the item from that list only. In any other view, including triage, it writes `$ ` at the start of the line and of every subtask under it. The text stays in the file; the app no longer shows those lines anywhere, and they leave every list. No confirmation; `u` undoes it. `$` needs a following space so `$5` stays plain text.
- Option+`n` makes a new list (the Manage lists dialog with the name field focused). `n` stays Add a task.
- A task's notes appear as rows under it when it is expanded (Right arrow). A task that has notes starts collapsed the first time it shows; after that your choice sticks until you switch view. Adding a note expands the task.

## Subtasks

- `Tab` makes the task a subtask of the task directly above it (indents it one level, along with its own subtasks and notes). `Shift+Tab` moves it out one level.
- Stored as indentation in the file. Subtasks behave exactly like tasks: status, notes, due dates, more subtasks.
- If there is no task directly above, nothing changes and the app says why.
- Shift+Tab on a subtask that has later siblings makes those siblings its subtasks (that is how indented text works). The announcement says so.
- Tab is used here, so to leave the list use `v` (view menu) or `/` (search).

## Lists

- Any number of lists. A list holds tasks and list notes. A task can be on many lists; its status, notes and dates are the same everywhere because they live in the file.
- A list is stored in `state.json` as an ordered list of references to tasks. Reordering is remembered.
- **List folders:** a list can be given a folder name (for example "Meetings"). The all-lists view and the view menu group lists by folder.
- **All lists view** (`=`): one row per list with its folder and counts. Enter opens it.
- **List notes** (a note that is not a task): `Shift+N` in a list view (Option+Shift+n works too). They are written to the list's own notes file and appear in the list, in order, with the tasks. `s` still adds a note to a task.
- **List notes file:** a list can have a notes file. When you create a list you can ask for one. It is created in a folder you choose (any watched folder, plus an optional subfolder you type) and named after the list. It contains a title and the creation date. Tasks are **not** copied into it, to avoid duplicates. List notes added later are appended to it. A list without a file can get one later from Manage lists.
- A notes file can only go in a folder where plain lines are notes.
- **Lists that keep their tasks in a file** (per-list setting `fileTasks`, off by default so existing notes-file lists are unchanged): the list shows every task in its file, nested as in the file, in file order. Membership is the file, not `state.json`.
  - Moving a task onto such a list (`l`, `listSet`, `listAdd`) moves its block: the task line, all its notes (including `&` notes anywhere below) and its subtasks, recursively. The block goes to the end of the target file with the head's indent removed and any leading `•` dropped, so it is a main task there. A blank line is added only if needed to keep the target's existing tasks as they were. Unmarked tasks get the to-do symbol if the target treats plain lines as notes; plain notes get `&` if the target treats plain lines as tasks.
  - Order of writes: target file first, then source; if the source write fails, the target is restored. Each write re-reads the file and refuses if it differs from what was shown. One `u` undoes both files and the list keys. List keys and "date added" follow the task to its new file.
  - Reordering moves the block among open sibling tasks (same parent) in the file. It is refused if the parent, any other task's text, parent or group, or the number of unmarked lines would change.
  - A task can be kept in only one file: ticking two such lists with different files is refused, and unticking the list whose file holds the task (without ticking another) is refused. Delete in such a list excludes the task (`$`).
  - Tasks from other files that were on the list before the setting was turned on stay on it until removed.

## Adding tasks

- `n` (outside triage) or Option+n: opens "Add task". Type to search existing open tasks. Results appear in a list. Enter adds the highlighted result to the chosen list. The last choice is always "Create new task: <what you typed>".
- `m`: opens "Add task" in create-only mode (no search).
- A new task is appended to the **master list file** as `@ text`, then added to the list. The master file is chosen on first use and can be changed from Settings. It must be inside a watched folder.
- The target list defaults to the current list, else the last list you used. Choosing "No list" only creates the task.

## Sorting a list

`Shift+O` opens the sort choice, remembered per list:

- **Manual** (default): your order. `g` and Option+Up/Down reorder. Disabled for other sorts.
- **Due date**, **Check-in date**: earliest first, undated last.
- **Created**: the date the app first saw the task (or created it). Oldest first. Tasks from before the app existed all show the day they were first scanned.
- **Type**: tasks first, list notes last.
- **Name**: alphabetical.

## Dates and times

- `d` opens one dialog with a **Due** field and a **Check-in** field. Both accept a date, a time, or both: `fri`, `nov 20 2pm`, `tomorrow 14:30`, `+3d`, `2026-11-20 09:00`. Empty clears.
- Written in the file as `due:2026-11-20 14:30` and `checkin:2026-11-20`. Time is optional.
- **Schedule view**: overdue, today, this week, later, grouped, including check-ins.
- The existing "Due soon and overdue" view remains.

## Showing completed

`c` or `h` shows or hides completed tasks in the current view.

## Goals

- A goal is any ongoing task (`~`). A task links to goals with `goal:<id>` tokens on its own line; there can be several. On a `~` line the first `goal:` token is that goal's own id and the rest link it to other goals.
- `y` on a task opens a checkbox dialog of goals (open goals, plus done goals the task already links to). Saving writes the task's tokens (`goalSet`, value `{ ids: [goal task ids] }`). A goal without an id gets one first: a slug of its text, at most 32 characters, with `-2`, `-3` added if taken by any id or link. All writes from one save are one undo step; if a write fails, the ones already made are rolled back.
- Links use the id, so rewording a goal keeps them. Tokens that match no indexed goal are kept on the line. A goal cannot link to itself.
- Tokens are stripped from displayed text, like `jira:` and dates. Task details begin with "Goal: …" (or "Goals: …"); goals elsewhere get "N linked tasks".
- Goals view (Shift+`g`, view id `goals`): each goal, "N open, M done linked tasks", then its linked tasks from any file at level 2. A task on two goals appears under each, with row id `taskId@goalId`; actions on either row act on the task. Done goals and done tasks show only with `c`.

## Jira sync

- Only on press (Shift+`j` or the toolbar button); Jira Cloud only. Endpoints: `POST /api/jira/sync/preview`, `/api/jira/sync/apply` (`{ choices: { itemId: { choice: 'apply'|'file'|'jira'|'skip', sig } } }`), `/api/jira/sync/started`.
- Covers files of lists with `jiraSync` (needs a file). Per-list `jiraLabels` (extra labels) and `jiraStatus` (status for open tasks).
- Items have stable ids (`create:<taskId>`, `KEY:<field>`, `link:<taskId>:<goalId>`) and a signature. Apply rebuilds the plan and skips any item whose signature changed since the preview.
- Three-way rule for status and summary: the last synced value of both sides is stored. Only Jira changed → pull (ticked); only the file changed → push; both, or no snapshot → conflict (default skip). Pulling ongoing (`~`) back to open is unticked, because it stops the task being a goal.
- Push-only fields: description (notes in ADF, `& Started` notes excluded), due date (the done date for done tasks), start date (`start:`), Flagged (for `>`), labels. A Jira value plaintasks didn't set is never cleared. Labels removed are only ones plaintasks added.
- Summary and description pushes are unticked for issues plaintasks didn't create.
- Order on apply: creates (main tasks, then subtasks), field updates and transitions, links, then file writes. File writes are one undo step; Jira changes can't be undone.
- `start:YYYY-MM-DD` is a token like `due:`: hidden from text, spoken "Started …".
- Label goals: a `~` line with `jira:label` (case-insensitive, hidden like `jira:`; `text` keeps it). Excluded from sync entries, so never created, updated, closed or linked. Tasks linking to one directly via `goal:` want label `<labelPrefix><goalId>` (setting `jira.sync.labelPrefix`, default `bucket-`); it is added on create and in the labels push item. Any label on the issue starting with the prefix that is not wanted is removed. Children of a label goal have no syncing parent, so they become Tasks.

## What is stored where

| Data | Location |
| --- | --- |
| Tasks, status, due, check-in, notes under a task, subtasks, goal links and goal ids | the original text file |
| To-do marker `@`, deleted marker `$` | the original text file |
| Marked as a note in triage, attached-to link | `state.json` (keyed by line text) |
| Lists, order, sort, folder, notes-file path | `state.json` |
| Created date | `state.json` |
| Master file, watched folders | `config.json` |
| Jira sync settings | `config.json` (`jira.sync`); token in the Keychain |
| Per-list sync settings (`jiraSync`, `jiraLabels`, `jiraStatus`) | `state.json` |
| Issues plaintasks created, last synced values | `state.json` (`jira.created`, `jira.synced`) |
| Start date | the original text file (`start:`) |

If you reword a line in an editor, its list membership and triage decisions are lost. Status changes (the thing you said you do most) do not reword the line.

## Assumptions made without an explicit answer

1. List notes go to the list's own file; a list without one is offered a file.
2. The generated file has only a title and date, and no tasks.
3. App-written lines are auto-reviewed.
4. "Folders" means grouping lists in the app and choosing the disk folder for the file.
5. The disk folder is chosen from watched folders plus a typed subfolder (a browser cannot give a native folder path).
6. A check-in date is a second date written as `checkin:`. Both dates take an optional time.
7. Option+key is not used for core commands.

## Build order

1. Status toggle keys; notes on tasks.
2. Subtasks (Tab).
3. Add task with search; master file.
4. Sorting.
5. List folders, all-lists view, list notes, generated files.
6. Dates and times, schedule view.
7. Reset of triage state (there was none saved) and docs.
