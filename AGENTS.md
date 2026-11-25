# Instructions for AI agents

This file is for AI chats and coding agents opened in the plaintasks repository. It covers two kinds of work: managing the user's tasks with plaintasks, and changing plaintasks itself.

## 1. Read the local instructions first

Before you add, change or sync any task, read the user's local AI instructions and follow them:

- Path: the `aiInstructions` value in `~/.config/plaintasks/config.json` if it is set (`~` means the home folder), otherwise `~/.config/plaintasks/ai-instructions.md`. `PLAINTASKS_CONFIG_DIR` replaces `~/.config/plaintasks` when it is set.
- The file is on the user's computer only. It may name people, projects, Jira keys and folders. Never copy any of it into this repository, a commit, an issue or a pull request.
- The local file overrides the general guidance below when they conflict. If it is missing, use this file and ask the user about anything unclear.
- The user edits it with the **AI instructions** button in the plaintasks header. You may edit it when the user asks you to.

## 2. Managing tasks

You may add and manage tasks and run Jira sync for the user. Go through the running plaintasks server where you can, so the app's checks apply. They include safe writes that refuse to change a line someone else edited, undo with `u` in the app, and Jira sync that writes `jira:KEY` back to the line.

### The server

- Address: `http://localhost:4747`. Check that it is running with `curl -s -o /dev/null -w '%{http_code}' http://localhost:4747/`. If it isn't, start it from the plaintasks checkout the user runs (not a scratch worktree) with `node bin/plaintasks.js --no-open`, and leave it running.
- Every `/api/` call needs the header `x-plaintasks-token` set to the contents of `~/.config/plaintasks/session-token`. POST bodies must be JSON with `content-type: application/json`.
- Responses are JSON. On success, `message` is a plain sentence to pass on to the user. On failure, the reply is `{ "ok": false, "message": "..." }` with a 4xx status.

```sh
T=$(cat ~/.config/plaintasks/session-token)
pt() { curl -s -H "x-plaintasks-token: $T" -H 'content-type: application/json' "http://localhost:4747$@"; }
pt /api/summary                                   # lists (ids, names, files), views, counts
pt '/api/search?q=budget'                         # open tasks matching text: id, text, fileLabel, line
pt '/api/detail?id=ID'                            # everything about one task, including raw line and jira key
pt '/api/subtasks?id=ID'                          # a task's subtasks
pt /api/action -d '{"op":"newTask","value":{"text":"Draft the memo"},"list":"LIST_ID"}'
```

Task ids come from `/api/search`, `/api/subtasks` or `/api/view?view=open`. An id points at a line, so look it up again after any change, including your own.

### What you may do

Anything the user can do in the app, you can do through the API below: add tasks and subtasks anywhere, edit, move, mark, date, prioritise, bucket, block, note, answer questions, manage lists and My list, sync to Jira, and undo. When something can't be done through the API, you may edit the task files directly (see "Editing the files directly"). The file format is described in full in [docs/FORMAT.md](docs/FORMAT.md). Read it before you write any line by hand.

### Reading

| GET | Returns |
| --- | --- |
| `/api/summary` | Views with counts, lists (id, name, file, settings), files, problems, the default new-task file |
| `/api/view?view=VIEW&q=TEXT&completed=1` | The rows of a view, as in the app. `VIEW` is `open`, `file`, `group`, `myday`, `next`, `questions`, `buckets`, `schedule`, `due`, `waitingMe`, `waitingOthers`, `important`, `inProgress`, `completed`, `recent` (the last 15 tasks added, newest first), `triage`, `lists` or `list:LIST_ID`. `completed=1` includes done tasks |
| `/api/search?q=TEXT` | Up to 20 open tasks matching the text: id, text, fileLabel, line |
| `/api/detail?id=ID` | Everything about one task, including the raw line, notes and Jira key |
| `/api/subtasks?id=ID` | All subtasks of a task, nested |
| `/api/buckets?id=ID` or `?file=PATH` | Buckets and which are set on the task or file |
| `/api/blockers?id=ID` | Tasks that can block this one, and which do |
| `/api/newtask-options` | Buckets and open tasks for the new-task fields |
| `/api/config`, `/api/ai-instructions`, `/api/jira/issue?key=KEY` | Settings, the local instructions, one Jira issue |

Task ids come from these replies. An id points at a line, so look it up again after any change, including your own.

### Changing: POST `/api/action` with `{ "id", "op", "value", "list" }`

Adding tasks:

| op | value | Effect |
| --- | --- | --- |
| `newTask` | `{ "text", "start", "due", "checkin", "today", "priority", "jira", "flags", "asks", "buckets", "blockedBy", "notes", "parent" \| "after" \| "before" }`, plus optional `"list": LIST_ID` | Creates a task. Only `text` is required, without a leading marker. `text` may use the quick-add shorthand (`"Call Sam; due fri; pri h; *"`, see FORMAT.md). Dates take `2026-12-01`, `fri`, `tomorrow` and the other forms the app accepts. `today: true` picks it for My Day. `priority` is `high`, `medium` or `low`. `jira` is `default`, `yes` or `skip`. `flags` lists any of `important`, `inProgress`, `ongoing`, `waitingOnOthers`, `waitingOnMe`, `question`, `done`. `asks` lists names for `ask:`. `buckets` and `blockedBy` take task ids (buckets also by name). `notes` lists note lines. Where it goes: with `parent: ID` it becomes the last subtask of that task, with `after: ID` or `before: ID` it goes next to that task at the same level. With none of these it goes at the end of the list's file, or of the default new-task file |

Changing one task (`id` required):

| op | value | Effect |
| --- | --- | --- |
| `done` / `toggleDone` | optional `{ "note" }` | Mark done with today's `done:` date. `toggleDone` reopens a done task |
| `todo` | | Make an unmarked line or a note an open to-do, and bring back a line dismissed in triage |
| `inProgress`, `ongoing`, `waitingOnOthers`, `waitingOnMe`, `important` | optional `{ "note" }` when turning on | Toggle that status. The note is saved dated under the task |
| `question` | on an open question: `{ "answer", "done" }` | Toggle the open-question marker, or answer it (writes a dated `Answer:` note and clears `?`; `done: true` completes it) |
| `edit` | `{ "text", "notes": [...] }` | Rename. `notes` rewrites the existing note lines in order. Tokens on the line are kept |
| `addNote` | `{ "text" }` | Add a dated note under the task |
| `dates` | `{ "due", "checkin" }` | Set both dates. `""` clears one. `due` and `checkin` (value: a string) set one each |
| `priority` | `high`, `medium`, `low`, or empty to cycle | Set the priority |
| `today` | | Pick for My Day, or unpick |
| `bucketSet` | `{ "ids": [...] }` | Set the task's buckets (bucket task ids). `[]` with nothing inherited clears them |
| `blockSet` | `{ "ids": [...] }` | Set which tasks block this one |
| `move` | `{ "parent": ID }`, `{ "after": ID }` or `{ "before": ID }` | Move the task with its notes and subtasks: under a task as its last subtask, or next to a task at the same level. Same file only; to move to another file, use a file-backed list with `listAdd`, or edit the files |
| `indent` / `outdent` | | Subtask of the task above / up a level |
| `jiraYes` | `true` / `false` | Send a main task to Jira on the next sync, or stop |
| `jiraSkip` | `true` / `false` | Keep the line and everything under it out of Jira, or stop |
| `jira` | `"ABC-123"` or `""` | Link the line to an existing issue, or remove the link |
| `exclude` | | Delete: the line stays in the file with `$` in front |
| `note` | | Turn the line into a note of the task above |
| `listAdd` / `listToggle` | `"list": LIST_ID` | Put the task on a list / on or off it |
| `listMove` | `up`, `down`, `top`, `bottom`, plus `"list"` | Reorder on a list |

Lists, files and other ops (no `id` unless shown):

| op | value | Effect |
| --- | --- | --- |
| `listCreate` | a name, or `{ "name", "folder", "notesFolder", "file", "fileTasks", "notActionable", "jiraSync", "jiraLabels", "jiraStatus" }` | New list |
| `listRename` / `listDelete` | new name / none, plus `"list"` | Rename or delete a list (tasks stay in their files) |
| `listEdit` | `{ "folder", "notesFolder", "file", "fileTasks", "notActionable", "jiraSync", "jiraLabels", "jiraStatus" }`, plus `"list"` | List settings |
| `listSort` | `manual`, `due`, `checkin`, `created`, `type` or `name`, plus `"list"` | Sort a list |
| `listNote` | `{ "text" }`, plus `"list"` | Add a line to a list that is not a task |
| `listBucketSet` | `{ "ids" }`, with `id` `f:FILE_PATH` | Default buckets for a whole file |
| `reviewFile` / `dismissFile` | with `id` `f:FILE_PATH` | Triage: mark a file reviewed / dismiss its unmarked lines |
| `mylistSetup` | `{ "folder" }` | Keep My list in mylist.txt in that folder |
| `refresh` | | Rescan the files now |

Other POST routes: `/api/undo` with `{}` undoes the last change, as `u` does in the app. `/api/master` with `{ "path" }` sets the default new-task file. `/api/folders` with `{ "folders": [{ "path" }] }` sets the watched folders (send the whole list). `/api/ai-instructions` with `{ "text" }` saves the local instructions.

### Editing the files directly

You may edit the task files directly when the API can't do what the user wants: moving tasks between files, restructuring many lines at once, setting `start:` on an existing task, fixing a malformed line. plaintasks picks the change up within a second or two. Follow [docs/FORMAT.md](docs/FORMAT.md) exactly, and:

- Back up first: copy the file next to itself (for example `cp Work.txt Work.txt.bak-$(date +%Y%m%d-%H%M%S)`) and tell the user where the copy is. Remove the copy only if the user says so.
- Keep every `jira:KEY` token exactly as it is, on the same task. Never invent one. Never change a bucket's `goal:` id.
- Preserve indentation: use tabs where the file uses tabs, one per level, and keep the file's line endings (CRLF or LF) and encoding.
- Don't delete lines unless the user asked. Mark them deleted with `$` instead (op `exclude`), so they can be restored. Jira sync resolves a deleted task's issue as Won't Do.
- Change only the lines you mean to. Re-read the file just before writing, because the user or the app may have changed it.
- Undo in the app (`u`) does not cover direct edits. Tell the user exactly what you changed, file by file.

### Jira sync

1. POST `/api/jira/sync/preview` with `{}`. The reply has `items`. Each item has `id`, `sig`, `group` (`conflict`, `create`, `push`, `pull`), `label`, `task`, `file`, `line`, plus `checked` (or `choice` for conflicts), which is what the app would preselect. `info` lists things that won't sync and why.
2. Read every item. Decide each one, using the local instructions where they say what is right.
3. POST `/api/jira/sync/apply` with `{ "choices": { "<id>": { "choice": "apply" | "file" | "jira" | "skip", "sig": "<sig from the preview>" } } }`. Use `apply` for `create`, `push` and `pull` items. Use `file` or `jira` for conflicts. An item whose `sig` changed since the preview is skipped and reported.
4. Report `message` and any `results` with `ok: false` to the user.

This builds choices that match the app's own preselection. Change entries before applying them:

```sh
pt /api/jira/sync/preview -d '{}' > /tmp/pt-preview.json
node -e 'const p=require("/tmp/pt-preview.json");const c={};for(const i of p.items)c[i.id]={sig:i.sig,choice:i.group==="conflict"?i.choice:i.checked?"apply":"skip"};console.log(JSON.stringify({choices:c}))' > /tmp/pt-choices.json
pt /api/jira/sync/apply -d @/tmp/pt-choices.json
```

New issues are created with the file's status, including done (done tasks are created and then resolved, and are ticked by default like any other create). For an issue plaintasks created, a first-sync status conflict is preselected to keep the file. Use the Jira REST API directly only for what sync can't do, and only as the local instructions allow.

### Ask the user first

- Before deleting or closing Jira issues, merging tasks, or changing more than a few lines.
- When it's unclear which task something belongs to, or what its status or dates are. Ask all your questions together, in chat.

## 3. Changing plaintasks itself

- Node 20 or later, no runtime dependencies. Run `npm install` (dev only: jsdom, axe-core), then `npm test`.
- The UI must work fully with the keyboard and VoiceOver. Follow the existing patterns: native `<dialog>` with a heading, labelled fields, `role="alert"` errors, and announcements through `PT.announce`. Add an axe check in `test/ui.test.js` for any new dialog.
- Tests use synthetic fixtures only. Never put real task files, names or Jira data in the repository.
- When behaviour changes, update the README, `docs/COMMANDS.txt` and the in-app help (`public/index.html`).
