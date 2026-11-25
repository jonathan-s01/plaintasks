# Task file format

This is the reference for the plain-text files plaintasks reads. It is written for people and for AI agents that edit the files directly. It follows the code (`src/parser.js`, `src/ops.js`, `src/jirasync.js` and friends). All names in the examples are made up.

Contents:

1. Quick reference
2. File layout
3. Markers
4. Tokens
5. Notes
6. Mapping to Jira
7. Quick-add shorthand
8. Rules for editing files directly
9. Examples

## 1. Quick reference

- One task per line. A line is a task when it starts with a marker such as `@` (to do) or `+` (done).
- Indent with tabs to make subtasks. A line that starts with `•` is also a subtask.
- Plain indented lines under a task are notes. A line starting with `& ` is a note of the nearest task above it.
- Tokens such as `due:2026-12-01` or `p:high` sit at the end of the task line. They are hidden in the app.
- Delete a task by putting `$ ` in front of it. Never remove the line.
- The first plain line of a file is its title.

## 2. File layout

### Files that are read

| Item | Behaviour |
| --- | --- |
| Extensions read | `.txt`, `.md`, `.text`. `.rtf` files are only offered for conversion. |
| Skipped | Files and folders whose name starts with a dot, `node_modules`, files over 5 MB, files that are not UTF-8 or UTF-16, files containing NUL bytes. |
| Encodings kept | UTF-8, UTF-8 with BOM, UTF-16 little and big endian. |
| Line endings kept | LF, CRLF and CR, per line. |
| Writes | Only the one line being changed is rewritten. The app re-reads the file first and refuses if that line changed. The write goes to a temporary file that then replaces the original. |
| External edits | Picked up automatically (file watcher and a 15 second poll). The `u` undo in the app does not cover them. |

Lists, folders, ordering, dismissed notes and triage state are not in the text files. They are in `~/.config/plaintasks/state.json`.

### The title line

The first non-empty line is the file's title if it is not a marked task, not a `& ` note and not a deleted (`$`) line. It names the list. With no title line, the file name without its extension is used.

Only two tokens mean something on the title line. All other text is just the title.

| Token | Meaning |
| --- | --- |
| `goal:id` | A default bucket. Every task in the file with no `goal:` of its own and no bucket parent joins it. Several allowed. |
| `jira:skip` | The whole list stays out of Jira. |

Both tokens are hidden from the displayed title. In "plain lines are tasks" mode (below) the first line is itself a task, so there is no title and no defaults.

### Blank lines and indentation

- A blank line ends the current block. Indented lines after a blank line do not attach to a task above it.
- A tab counts as 4 columns. Any other character counts as 1. Mixed tabs and spaces work for reading, but the app refuses to re-indent a line with mixed indentation, so keep one style per file. New lines written by the app use one tab, or two spaces if the file uses spaces.
- A marked line is a subtask of the nearest task above it that is indented less. Depth is not limited.
- A line starting with `•` is a subtask at any indentation:
  - At the same indentation as the task above, it belongs to the nearest task above that is not itself a `•` subtask. A run of `•` lines are siblings.
  - Indented deeper than the line above, it nests under that line.
  - It combines with statuses: `•+` (done), `•%`, `•>`.
  - Shift+Tab on a `•` line at its parent's indentation removes the `•`.
- Group headings: an unmarked line that is followed within two lines (blank lines skipped) by a marked line can be a group name. In notes mode it is a group when no task is open above it, when it ends in `:`, or when the line before was a group. In tasks mode, only a line ending in `:` that has a non-blank line after it. Groups nest by indentation. The group name is shown without its colon.
- Legend lines such as `+ = done`, `nothing = to do` or `• and indenting = subtasks`, or a heading `legend:` or `key:`, are skipped. A legend can remap a symbol for that file, for example `X = done`, but only for the characters `+@<>•~*%?`.

### Plain lines: notes mode and tasks mode

What a line with no marker is depends on a per-folder setting called "plain lines". It can be set for a folder, a subfolder or one file. The most specific setting wins. A legend in the file never decides it.

| Mode | Plain line directly under a task | Plain line elsewhere |
| --- | --- | --- |
| Notes (default) | A note of that task | A group name if it qualifies, otherwise an "unmarked" item. Unmarked items appear in Triage until the user marks them as a task or a note. |
| Tasks | Not a note. It is a task. | A task. It counts as `@` (to do) without a marker being written. A group name only if it ends in `:` and has a line after it. |

In tasks mode, notes need `& ` in front. A plain line becomes a real marker only when an action needs one, for example marking it important writes `* text`.

When Triage marks an unmarked line as a note, it writes `& ` in front of the line if there is a task above it. Otherwise the choice is kept in `state.json` and the file is not changed.

### Deleted lines

`$` followed by a space marks a line as deleted. The line and everything nested under it are hidden everywhere in the app but stay in the file. Unmarked lines after a `$` line that are not indented under it are not its notes. A `$` without a space (`$5 lunch`) is plain text.

## 3. Markers

A line's marker is the run of symbol characters at the start of its body, after any indentation. Runs combine: `@*`, `+>`, `@%`, `@?`, `•+`.

| Marker | Name | Meaning |
| --- | --- | --- |
| `+` | done | Completed. The only marker that means done. |
| `@` | to do | An ordinary open task. |
| `<` | waiting on me | Open. Someone is waiting for the user. Cannot be combined with `>`. |
| `>` | waiting on others | Open. The user is waiting for someone else. Cannot be combined with `<`. |
| `•` | subtask | A subtask of the task above (see indentation). |
| `~` | ongoing | A continuing responsibility or major outcome. Open. |
| `*` | important | Open and flagged important. |
| `%` | in progress | Open and being worked on. |
| `?` | question | An open question. Answered with an `Answer:` note (see Notes). |
| `$` | deleted | Hidden from every view. Stays in the file. |

Rules:

- Open means not done. Every marker except `+` and `$` is open. `$` is excluded, not open.
- When the app writes a run, done goes first (`+@`) and other statuses follow (`@*`).
- A marker needs a space after the run, except the "strong" markers `+ @ < > •`. These work without one: `+Draft memo`, `@call Sam`. The markers `*`, `%`, `~`, `?` and `$` always need a space after them.
- None of these is a marker, and the line stays plain text:
  - a digit straight after the run (`+1 for that`, `~5 min`);
  - an HTML-like tag (`<div>`);
  - `~~` in the run (strikethrough);
  - `??` or `???` in the run;
  - a body with no letters or digits.
- Marking a task done adds `+` and appends `done:<today>`. Reopening removes `+` and the `done:` token. If nothing is left, the run becomes `@` (in tasks mode the line becomes plain).
- Completed tasks are hidden from every view except Completed.

## 4. Tokens

A token is `name:value` placed after the marker, preceded by whitespace or the start of the body. All tokens are hidden from the displayed task text. When the app adds a token it appends it to the end of the line. When it rewords a task it keeps the tokens, in their original order, after the new text. Tokens on a plain unmarked line are only read in tasks mode.

### Token list

| Token | Value | Meaning | Written by the app | Sent to Jira |
| --- | --- | --- | --- | --- |
| `start:` | date | When work starts. | Yes | Start date |
| `due:` | date, optional time | Due date. | Yes | Due date (date only) |
| `checkin:` | date, optional time | A date to look at the task again. | Yes | No |
| `done:` | date | Completion date. | Yes, on done | Due date of a resolved issue |
| `today:` | date | Picked for My Day. A pick from an earlier day still counts until removed. | Yes | No |
| `p:` | `high`, `medium`, `med`, `low` | Priority. No token means medium. | `p:high` or `p:low` only | Priority |
| `ask:` | name | Who a `?` question is for. Several allowed. | Yes | No |
| `goal:` | bucket id | Puts the task in a bucket. On a `jira:label` line, the bucket's own id. | Yes | Label |
| `goal:none` | none | No bucket, even if one would be inherited. | Yes | No |
| `jira:label` | none | Marks the line as a bucket. | Yes | Becomes labels |
| `jira:KEY` | issue key | Links the line to a Jira issue. | By sync | The link itself |
| `jira:yes` | none | Send this main task to Jira on the next sync. | Yes | Replaced by `jira:KEY` |
| `jira:skip` | none | Keep this line and everything under it out of Jira. | Yes | No |
| `id:` | slug | Names a task so others can wait for it. | Yes | No |
| `after:` | slug | This task waits for the task with that `id:`. Several allowed. | Yes | Blocks link |

Token names are case-insensitive. Invalid values are ignored and the text stays on the line as plain text. If the same date token appears twice, the earliest one wins.

### Dates

The parser reads these value forms in a file:

| Form | Example | Result |
| --- | --- | --- |
| ISO date | `due:2026-11-20` | That date. This is the form stored by the app. |
| Relative days or weeks | `due:+3d`, `due:+2w` | Today plus that many days or weeks. 1 to 3 digits. |
| Weekday | `due:fri`, `due:friday`, `due:thurs` | The next such weekday. |
| Single word | `due:today`, `due:tomorrow`, `due:yesterday` | As named. |
| Month and day | `due:nov 20`, `due:20 nov`, `due:nov 20 2027` | The next such date on or after today, unless a year is given. |

Not read inside a file token: `next fri`, `in 3 days`, `20nov`, `nov-20`, `2026-11-20T14:00`. The app's date dialogs accept some of these and write ISO.

A time of day may follow a date, separated by a space: `due:2026-11-20 14:30`, `checkin:fri 9:05`. The time is 24-hour `H:MM` or `HH:MM`. Words like `2pm` are only understood in the app's dialogs, which convert them to 24-hour before writing. Typing `due:fri 2pm` in a file sets the date and leaves `2pm` in the text. Jira receives only the date.

### Priority

`p:high`, `p:medium` (or `p:med`) and `p:low`, case-insensitive. Anything else after `p:` is ordinary text. `p:medium` is accepted but the app never writes it. Setting medium removes the token.

### Questions and `ask:`

`ask:name` records who a question is for. A name is letters and digits, with `.`, `_` or `-` inside. Duplicates are dropped ignoring case. `ask:` is normally used with `?` but is read on any task.

### Buckets and `goal:`

A bucket groups tasks, becomes a Jira label and is never an issue. A bucket is a task line with `jira:label`:

```
~ Content goal:content jira:label
```

- On a `jira:label` line the first `goal:` is the bucket's own id. Any further `goal:` tokens on that line are links to other buckets.
- Bucket ids are lowercase letters, digits and hyphens, starting with a letter or digit. The app makes the id from the bucket text: lowercase, accents removed, up to 32 characters, with `-2`, `-3` added if the id is taken (ids from `goal:`, `id:` and `after:` all count). A slug of `none` or empty becomes `bucket`.
- A bucket line without its own `goal:` id is not a bucket parent: tasks nested under it do not inherit anything from it.
- Which buckets a task is in, first match wins:
  1. Its own `goal:` tokens. This replaces anything inherited.
  2. Its parent's buckets. A task nested under a bucket line is in that bucket.
  3. The title line's `goal:` defaults.
  4. None.
- `goal:none` on a task means no bucket, whatever would be inherited.
- A `goal:` id that matches no bucket is left on the line and ignored.
- Buckets are not placed in other buckets.

### Jira tokens

- `jira:KEY` has the form letters, digits or underscores, a hyphen and digits (`ABC-123`). The app writes it in upper case.
- `jira:yes` marks a main task to be created. Its direct subtasks go with it. It does nothing on a subtask. After creation sync replaces it with `jira:KEY`.
- `jira:skip` excludes the line and everything nested under it. It wins over `jira:yes`. A skipped line that already has a key is reported as left in Jira and is not touched.
- `jira:label` is covered under buckets.

### Waiting on another task: `id:` and `after:`

```
@ Write the tests id:tests
@ Release the site after:tests
```

- `id:slug` gives a task a name. `after:slug` makes a task wait for it. The app writes `id:` as lowercase letters, digits and hyphens.
- A bucket's own `goal:` id is also a valid `after:` target.
- A task is blocked while any target is open. Done and deleted (`$`) targets do not block. An `after:` that matches nothing is left alone and does not block. A task never blocks itself.
- Blocked tasks are left out of My Day and Next actions.

### Start-date notes

A note that reads exactly `Started 2026-11-10` (optionally `Started:`) is treated as a start date by sync, and the sync dialog can convert it into a `start:` token. It is left out of the Jira description.

## 5. Notes

### Which lines are notes

| Form | Notes mode | Tasks mode |
| --- | --- | --- |
| Plain line indented under a task | Note of the task | Not a note. It is a task. |
| `& text` or `&text` | Note of the nearest task above, even across blank lines or other lines | Same |

Details:

- A plain note is attached to the nearest task above that is indented less than it. A note at the same indentation as its task attaches to that task's parent. Indent notes one level deeper than the task.
- `& ` notes are shown without the `&`. They need a letter or digit after the `&`. `&&` and entities such as `&amp;` stay plain text. With no task above, a `& ` line is an ordinary unmarked line.
- A note cannot start with a task symbol, or it would be read as a task.
- URLs in notes are links, and are copied as links into the Jira description.

### Dated notes

The app stamps notes it adds: `[2026-11-16] text`, or `[2026-11-16, Website refresh] text` when the list name is included. The date is the day the note was added. The stamp is optional, and the user can turn it off. When the app adds a note it places it after the task's last plain note, or directly under the task, indented like the last note or one level deeper than the task.

### Status notes

When a status is switched on with the optional note box, the app writes a note beginning with a label:

`Done:`, `Waiting on others:`, `Waiting on me:`, `Important:`, `In progress:`, `Ongoing:`

Example: `Waiting on others: Sam for the logo files`. These are ordinary notes.

### Answers to questions

Answering a `?` question removes the `?` and adds a note `[date] Answer: text`. In a tasks-mode file the note is written as `& [date] Answer: text`.

- A line that was only `?` becomes `@`. Other markers stay (`@?` becomes `@`).
- If the user ticks "Mark as done", the task is completed instead: `+@ text done:date`.

### Jira description

The Jira description is the task's notes, one paragraph per note, stamps included, with `Started` notes left out. Notes do not become comments.

## 6. Mapping to Jira

Sync runs only for lists with "Sync to Jira" ticked, only when asked (Shift+J), and shows a preview first. Nothing changes until the user applies it. Jira Cloud only. Names in this section are the defaults, and the status, transition, resolution, label and priority names are settings.

### File state to Jira

The file state is the first match of: deleted, done, ongoing, in progress, otherwise open.

| File | Jira status | Extra |
| --- | --- | --- |
| `@`, plain, `<`, `*`, `?` (open) | To Do. A list can set its own status for open tasks (for example In Discovery). | None |
| `%` in progress | In Progress | None |
| `~` ongoing | In Progress | Label `ongoing` |
| `>` waiting on others | To Do | Label `waiting` and the Flagged field set to Impediment, when the Flagged field is known |
| `+` done | Resolved, resolution Done | The `done:` date, or else `due:`, goes to the due date |
| `$` on a linked line | Resolved, resolution Won't Do | Reported as "Close as Won't Do: the line is deleted ($)" |

A Jira status in the same status category counts as in sync. For example any in-progress-type status such as In Review matches `%` and `~`. Pulled changes: Jira status, summary and priority are written back to the file as a marker, a `done:` date from the resolution date, new line text, and a `p:` token.

### Fields

| Task | Jira |
| --- | --- |
| Task text without tokens | Summary, up to 250 characters |
| Notes (and the checklist, below) | Description |
| `p:high`, `p:low`, none | Priority High, Low, Medium (Medium is not sent on create) |
| `due:` | Due date, date only. A done task sends its `done:` date or else its due date. |
| `start:` | Start date |
| Buckets | Labels `bucket-<id>` (the prefix is a setting) |
| `>` and `~` | Labels `waiting` and `ongoing` |
| `after:` that resolves to a task in Jira | A Blocks link (blocker blocks dependent), made once both issues exist |

Labels that start with the bucket prefix are managed by sync: they are removed from an issue when no longer wanted. Other labels are left alone. A link is removed only if plaintasks made it and the `after:` token is gone.

### Levels

Buckets are not levels, so a task under a bucket line is a main task.

| Position in the file | In Jira |
| --- | --- |
| Main task (level 0) | Task, in the epic if one is configured |
| Direct subtask (level 1) | Sub-task of that Task |
| Level 2 or deeper | Not an issue. Listed as a checklist in the Sub-task description, done items ticked, nested as in the file, without tokens. |

A deeper line that already has a `jira:KEY` keeps syncing as its own issue.

### What gets created

- A main task is created only when it has `jira:yes`. Its direct subtasks are created with it. A subtask is also created when its main task already has a `jira:KEY`. Main tasks without `jira:yes` are quietly left out.
- `jira:skip` anywhere above a line, or on the title line, stops creation.
- An open question (`?`) without a key is not created, and neither are its subtasks. It is listed as "Not synced: open question". A question that is already linked keeps syncing. Once the `?` is removed it syncs normally.
- A subtask whose main task is done and not in Jira is not created.
- New issues are created first and then moved to the file's status. A done task is created and then resolved. Creating issues for already-done tasks is ticked by default in the preview, so untick it to keep old finished work out of Jira.
- After creation sync writes `jira:KEY` on the line and removes `jira:yes`.
- A deleted `$` line with a key closes its issue as Won't Do.

### Conflicts and defaults

Changes are compared per field with the last synced values. Conflicts default to skip, except a first-sync status conflict on an issue plaintasks created, which defaults to keeping the file. Summary and description changes on issues plaintasks did not create start unticked in the preview.

### Never sent to Jira

`today:`, `checkin:`, `ask:`, `id:`, times of day, the markers `<` and `*`, the tokens `jira:skip`, `jira:yes` and `jira:label`, and bucket lines themselves.

## 7. Quick-add shorthand

The new-task box splits what is typed at each `;`. The first part is the task name. It cannot start with a task symbol or contain `;`. Each later part is a symbol part or a keyword part. An unknown part stops the task from being created and shows an error.

Keywords can be written in full or abbreviated to at least their first three letters, in any case. Examples: `due`, `sta` for start, `pri` for priority.

### Symbol parts

A part that starts with one of these symbols. Text after the symbol becomes a note labelled with the status (`Waiting on others: wayne`), except for `?`.

| Symbol | Effect |
| --- | --- |
| `*` | Important |
| `+` | Done |
| `<` | Waiting on me |
| `>` | Waiting on others |
| `~` | Ongoing |
| `%` | In progress |
| `?` | Question. Text after it is names to ask, split on commas and spaces, with "and" dropped. |

`@` and `$` are not available. Waiting on me and waiting on others exclude each other. The last one typed wins.

### Keyword parts

| Keyword | Meaning |
| --- | --- |
| `start <date>` | Start date |
| `due <date>`, `end <date>` | Due date |
| `checkin <date>`, `check-in <date>`, `check in <date>` | Check-in date |
| `today`, `my day`, `myday` | Pick for My Day. No value. |
| `priority <value>` | `h`, `hi`, `high`, or `m`, `med`, `medium`, `normal`, or `l`, `lo`, `low` |
| `important`, `inprogress`, `in progress`, `progress`, `ongoing` | The status. Text after `:` becomes a labelled note. |
| `waiting on others`, `waiting others`, `waitingonothers` | Waiting on others |
| `waiting on me`, `waiting me`, `waitingonme` | Waiting on me |
| `question [names]` | Question, with optional names |
| `ask <names>` | Names to ask. Also makes it a question. |
| `done` | Done |
| `jira yes` (also `y`, `send`, `go`) | `jira:yes` |
| `jira skip` (also `s`, `n`, `no`, `never`) | `jira:skip` |
| `jira default` (also `d`, `auto`, or nothing) | No Jira token |
| `bucket <names>`, `goal <names>` | Buckets, by name or id, comma separated |
| `blocked by <task>`, `blocked <task>`, `after <task>` | Waits for another task, by id or name |
| `note <text>` | A stamped note |

Dates in quick-add use the friendly forms of the app's date dialogs (`oct 14`, `fri`, `+3d`, `2026-10-14`), and a time such as `fri 2pm` is accepted.

### What gets written

The line starts as `@ name`. Then, in this order: statuses, dates (start, due, checkin, today), priority, `ask:` tokens, the Jira token, `goal:` tokens, the blocker links, notes. A blocker gets an `id:` and the new task gets `after:`. In a tasks-mode file notes are written with `& `. The new line goes at the end of the target file, or under or beside a given task. A done parent cannot get a new subtask.

Example:

```
call sam; > wayne; due oct 14 2027; sta nov 10 2026; pri h; *; +; <; inprogress
```

## 8. Rules for editing files directly

For AI agents and scripts. Use the app's API where you can. Edit the file only for things it cannot do.

1. Back up first: copy the file next to itself (for example `Work.txt.bak-20261116-0930`) before editing it, and say where the copy is.
2. Change only the lines you mean to change. Keep each line's ending and the file's encoding. Do not re-save the whole file through a tool that normalises line endings or drops a BOM.
3. One task per line. Never put two tasks on one line or split a task over two lines.
4. Keep indentation consistent with the file: tabs if it uses tabs, otherwise spaces. Put a subtask directly below its parent (or below the parent's earlier subtasks, or notes), indented one level deeper. Put notes directly below their task, indented one level deeper. Do not put a blank line between a task and its subtasks or notes.
5. In a tasks-mode file, notes need `& ` in front, because every plain line is a task.
6. Never change, invent or remove a `jira:KEY` token. Use `jira:yes` or `jira:skip` to control sync, and the app's `jira` action to link an existing issue.
7. Never change or remove a bucket's own `goal:` id. Other tasks refer to it.
8. Do not delete lines. Put `$ ` in front of the line instead. Deleted lines with a Jira key close their issue as Won't Do on the next sync.
9. Put tokens at the end of the task line, separated by spaces. Use ISO dates (`due:2026-12-01`). Do not put `jira:`, `goal:` or `id:` tokens on a note line.
10. When completing a task, change the marker to `+` and add `done:` with today's date, as the app does.
11. Do not use `$`, `*`, `%`, `~` or `?` without a following space.
12. Changes are picked up automatically, but `u` in the app cannot undo them. Tell the user exactly what you changed.
13. New task lines you add show in the app's Recently added view (Shift+`d`) while plaintasks is running. The times are kept in `state.json`, not in the file, so do not add a date token for that.

## 9. Examples

### A notes-mode file

```
Website refresh goal:web-work

~ Content goal:content jira:label
	@ Write home page copy jira:yes p:high due:2026-12-01
		@ Draft headline
			[2026-11-16, Website refresh] Sam wants it under ten words.
		@ Review with Cory
			@ Book a room
	• Send to legal
	@ Pick photos goal:none start:2026-11-25

@> Waiting for the logo files from Sam jira:ABC-123 checkin:2026-11-27
	Sam said Friday.
& Cory has the old logos too
@? Which hosting plan? ask:cory ask:sam
	Starter or Standard.
@ Write the tests id:tests
@ Release the site after:tests
+@ Buy the domain done:2026-11-10
	Done: bought for two years.
$ Old idea we dropped
```

Line by line:

| Line | What it is |
| --- | --- |
| `Website refresh goal:web-work` | The title line. The list is "Website refresh". Tasks with no bucket of their own join `web-work`. |
| `~ Content goal:content jira:label` | A bucket named Content with id `content`. It becomes a Jira label, never an issue. |
| `@ Write home page copy ...` | A main task inside the Content bucket. High priority, due 1 December 2026. `jira:yes` sends it to Jira on the next sync. |
| `@ Draft headline` | A subtask, one tab deeper. It becomes a Jira Sub-task. |
| `[2026-11-16, Website refresh] ...` | A dated note on Draft headline. It becomes part of the description of that Sub-task. |
| `@ Review with Cory` | A second subtask. |
| `@ Book a room` | Two levels down. It is not an issue. It becomes a checklist item in the description of Review with Cory. |
| `• Send to legal` | A subtask of Write home page copy, written with `•` at the same indentation as its parent instead of a deeper indent. Sibling of the two subtasks above. |
| `@ Pick photos goal:none start:2026-11-25` | In the bucket by position, but `goal:none` takes it out. Starts 25 November. |
| `@> Waiting for ... jira:ABC-123 checkin:2026-11-27` | Waiting on others, already linked to ABC-123. Sync sets the label `waiting` and the Flagged field. Check-in date is only local. |
| `Sam said Friday.` | A plain note, because it is indented under the task. |
| `& Cory has the old logos too` | A second note on the same task, written with `&`. |
| `@? Which hosting plan? ask:cory ask:sam` | An open question for Cory and Sam. Without a key it is not created in Jira. |
| `@ Write the tests id:tests` | Names this task `tests`. |
| `@ Release the site after:tests` | Blocked until `tests` is done. Sync makes a Blocks link. |
| `+@ Buy the domain done:2026-11-10` | Done on 10 November 2026. With `jira:yes` it would be created and then resolved. |
| `Done: bought for two years.` | A status note. |
| `$ Old idea we dropped` | Deleted. Hidden in the app, kept in the file. |

### Answering the question

Before:

```
@? Which hosting plan? ask:cory ask:sam
	Starter or Standard.
```

After the user answers "Standard" on 2026-11-20:

```
@ Which hosting plan? ask:cory ask:sam
	Starter or Standard.
	[2026-11-20] Answer: Standard
```

### A tasks-mode file

When the folder or file is set so that plain lines are tasks:

```
Call the printer
Order business cards due:fri
	Check the proof first
	& Sam has the design file
* Renew the licence
Errands:
Pick up the parcel
```

| Line | What it is |
| --- | --- |
| `Call the printer` | A to-do task. There is no title line. |
| `Order business cards due:fri` | A to-do task due next Friday. |
| `Check the proof first` | A subtask, because it is indented under a task. It is not a note. |
| `& Sam has the design file` | A note on the nearest task above, which is `Check the proof first`. |
| `* Renew the licence` | An important task. |
| `Errands:` | A group name, because it ends in a colon and has a line after it. |
| `Pick up the parcel` | A to-do task in the Errands group. |
