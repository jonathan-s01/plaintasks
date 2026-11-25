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

### Actions: POST `/api/action` with `{ "id", "op", "value", "list" }`

| op | value | Effect |
| --- | --- | --- |
| `newTask` | `{ "text": "..." }`, plus `"list": LIST_ID` | New to-do at the end of the list's file (or the default new-task file). Type the text without a leading marker. |
| `done` / `toggleDone` | optional `{ "note": "..." }` | Mark done with today's `done:` date. `toggleDone` reopens a done task. |
| `todo` | | Mark an unmarked line or note as a to-do. |
| `inProgress`, `ongoing`, `waitingOnOthers`, `waitingOnMe`, `important` | optional `{ "note": "..." }` when turning on | Toggle that status. |
| `question` | `{ "answer": "..." }` on an open question | Toggle an open question, or answer one. |
| `edit` | `{ "text": "...", "notes": ["..."] }` | Rename the task. `notes` rewrites its existing note lines, in order. Tokens on the line are kept. |
| `addNote` | `{ "text": "..." }` | Add a note under the task. |
| `dates` | `{ "due": "2026-12-01", "checkin": "fri" }` | Set due and check-in dates. `""` clears one. `due` and `checkin` set one each. |
| `priority` | `"high"`, `"medium"` or `"low"` | Set the priority. |
| `indent` / `outdent` | | Make it a subtask of the task above it, or move it up a level. |
| `jiraYes` | `true` / `false` | Mark a main task to go to Jira on the next sync, or unmark it. |
| `jiraSkip` | `true` / `false` | Keep the line and everything under it out of Jira, or stop doing that. |
| `jira` | `"ABC-123"` or `""` | Link the line to an existing issue, or remove the link. |
| `exclude` | | Delete: the line stays in the file with `$` in front, so it can be undone. |
| `listAdd` | `"list": LIST_ID` | Put the task on a list. |

`/api/undo` (POST `{}`) undoes the last change, the same as `u` in the app.

### Editing the files directly

The task files are plain text, and plaintasks picks up edits on its own. Edit a file directly only for things the API can't do. Examples: adding a subtask under a particular task (`newTask` always adds at the end of the file), a `start:` date, or moving lines between tasks. When you do:

- Read the file's format first (markers, tokens, tab indentation for subtasks; see README.md, "How tasks are recognised").
- Never change, invent or remove a `jira:KEY` token. Never delete lines unless the user asked. Use `exclude` or the `$` marker instead.
- Change only the lines you mean to, keep the file's line endings, and back up the folder first for anything larger than a few lines.
- Undo in the app does not cover your direct edits, so tell the user exactly what you changed.

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

New issues are created with the file's status, including done. Creating an issue for a task that is already done is not preselected, so choose `apply` for it only when the user or the local instructions want done work in Jira. For an issue plaintasks created, a first-sync status conflict is preselected to keep the file. Use the Jira REST API directly only for what sync can't do, and only as the local instructions allow.

### Ask the user first

- Before deleting or closing Jira issues, merging tasks, or changing more than a few lines.
- When it's unclear which task something belongs to, or what its status or dates are. Ask all your questions together, in chat.

## 3. Changing plaintasks itself

- Node 20 or later, no runtime dependencies. Run `npm install` (dev only: jsdom, axe-core), then `npm test`.
- The UI must work fully with the keyboard and VoiceOver. Follow the existing patterns: native `<dialog>` with a heading, labelled fields, `role="alert"` errors, and announcements through `PT.announce`. Add an axe check in `test/ui.test.js` for any new dialog.
- Tests use synthetic fixtures only. Never put real task files, names or Jira data in the repository.
- When behaviour changes, update the README, `docs/COMMANDS.txt` and the in-app help (`public/index.html`).
