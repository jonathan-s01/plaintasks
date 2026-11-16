# VoiceOver test script

Automated tests (jsdom and axe-core) cover structure and keyboard logic, but they cannot tell you how VoiceOver in Safari actually speaks the list. Please run through this and report anything odd. The UI may change based on what you find.

## Setup

1. Make a scratch folder with a copy of a few notes, or a small synthetic file such as:

   ```text
   Project Alpha
   @ write spec due:2026-12-01
   	@ draft outline
   	a note about the outline
   *@ important thing
   < reply to Sam
   > waiting on vendor
   + finished thing done:2026-11-02

   a loose thought that is not marked
   ```

2. `npm start`, then add that folder on the settings page.
3. In System Settings, turn VoiceOver on (Cmd+F5). In the VoiceOver Utility, you may find it easier to turn **Quick Nav off** while testing the list.

## What to check

**Page structure**
- Open the VoiceOver rotor (VO+U), Headings: "plaintasks", then the list title ("All open tasks"). Is the title announced when you land on the list?
- Tab from the page start: skip link, View, Search, Show completed, Keyboard shortcuts, Settings, then the list.

**The list (the main test)**
- Tab into the list. Does VoiceOver say it is a tree (or outline) and read the first item fully?
  - Expected: "Open. write spec. Due Tue Dec 1, in N days. Group Project Alpha. File ..., line 2." plus level and position, e.g. "level 1, 1 of 3, expanded".
- If VoiceOver says the tree is empty or does not read items, try **VO+Shift+Down** to interact with the tree first.
- Up/Down arrows: one item per press, full line read each time? Does it ever read twice or skip?
- Right/Left on a task with a subtask: says expanded or collapsed? Left on a subtask goes to its parent?
- Home/End and PageUp/PageDown.
- Rotor: does "Landmarks" and "Form controls" look sensible?

**Actions**
- `x` on a task: you should hear "Marked done: ..." and focus lands on the next task. Open the file in TextEdit and confirm the line starts with `+` and ends with `done:` and today's date. Only that line should differ.
- `u` undoes it ("Undid change"), and the file returns to the original.
- `m`, `w`, `i`, `p`, `b`: each says what was marked and toggles back.
- `d`: a dialog opens with focus in the date box. Type `fri` and press Enter. Next, try `nonsense`: you should hear an error and stay in the box.
- Enter on a task: actions menu opens as a dialog; Escape closes it and focus returns to the same task.
- `o`: opens the file in your text editor.

**Views and filtering**
- `5`: "Waiting on me" view is announced, with a count.
- `0`: Triage view lists the unmarked line under its file. `a` turns it into a `@` line.
- `v` jumps to the View menu; `c` toggles completed; `/` goes to search; Escape returns to the list.
- `?` opens the shortcuts table.

**Triage (initial review)**
- `0`, then Down: each unmarked line is read with "Line N. 3 of 12 to review in this file". Enter shows the nearby lines.
- `a` marks it as a to-do and focus lands on the next line. `s` skips. `n` jumps to the next file heading, Shift+`n` back. Shift+`r` marks the file reviewed. `f` toggles "new or changed files only"; confirm it is announced.

**My list and reordering**
- On any task press `l`: "Added to My list, position N of N". The task is then read with "On My list".
- `-` opens My list. Press `g` on a task: you should hear "Picked up: ... Position 2 of 5". Press Down: "Moved down to position 3 of 5" and focus stays on the same task. Press Enter: "Dropped at position 3 of 5".
- Also try Option+Up and Option+Down without picking up. Check that this does not clash with VoiceOver's own keys; tell me if it does.
- `u` undoes a move. The text files must not change when you reorder.

**Several lists**
- Shift+`m` (or the Manage lists button): create "Work", rename it, delete it. Check that errors ("already exists") are read out.
- With two or more lists, `l` on a task opens "Choose lists": a group of checkboxes (one per list) and a "new list" field. Tick two, press Save: you should hear "task is on My list and Work".
- `[` and `]` step through lists with the list name and count announced. Shift+`l` adds or removes the task from the list you are viewing.
- Tasks on lists read "On lists: My list, Work" in the other views.

**External edits**
- Edit the file in TextEdit and save. The list should refresh without losing your place. If your VoiceOver cursor was in the list, you may hear "The list was updated because a file changed".

**Conflict safety**
- Pick a task, change that same line in TextEdit and save, then press `x` in plaintasks before it refreshes (or press `x` quickly). You should get an error and the file must not be overwritten.

**Other settings**
- Zoom the page to 400 % (Cmd and plus): nothing should be cut off or need horizontal scrolling.
- System Settings, Accessibility, Display: Increase contrast, Reduce motion. The page should remain legible.

## If the tree is a problem

Open `http://localhost:4747/?ui=list`. This renders the same data as a plain list box (arrow keys only; levels are spoken as "Level 2" text). Tell me which one speaks better and I will make that the default.

## What to tell me

Exactly what VoiceOver says for the first list item, what happens on Left/Right, and anything that gets read twice, not at all, or in a confusing order.
