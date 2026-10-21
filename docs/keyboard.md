# Keyboard and focus model

S3 Viewer is meant to be usable end to end without a pointer. This document is
the contract: what the columns are, which key does what, where a shortcut must
not fire, and what is deliberately left to the operating system.

## Principles

1. **Every action has a keyboard path.** If a control exists, it is reachable
   with `Tab` and activated with `Enter`/`Space`; shortcuts are accelerators,
   never the only way in.
2. **Focus is visible and never dropped.** Closing a dialog, clearing the
   selection, closing the preview or collapsing the sidebar puts the keyboard
   back on a sensible control instead of `<body>`.
3. **Typing wins.** A text field keeps its arrows, `Enter` and `Escape`. Shell
   shortcuts that are safe in a field (`⌘R`, `⌘U`, `⌘N`, `⌘L`, `⌘F`, `⌘B`)
   still work there; list navigation does not.
4. **One owner per key.** Dialogs, menus, the PDF, native media and the resizer
   handle their keys first. A key that has been handled is not replayed against
   the list underneath.
5. **Mac first, Linux same.** Labels use `⌘` on macOS and `Ctrl+` elsewhere;
   `Delete` is `⌘⌫` on macOS and the forward-delete key on Linux.

## Columns

The shell has three focus columns, marked with `data-focus-zone`:

| Column | Root | What it owns |
| --- | --- | --- |
| Connections | `#sidebar` | the connection cards and the sidebar footer |
| Objects | the object browser root | the listing, its header, the truncation banner |
| Preview | `#preview` | the preview header and the rendered content |

`←` and `→` move between them:

```
sidebar  ←→  list  ←→  preview
```

- `←` from the list focuses the **open** connection card (or the first one),
  not an arbitrary first button.
- `→` from the sidebar returns to the list, or to the "No connection selected"
  action when there is no connection.
- `→` from the list focuses the preview's scrollable content; `←` returns to
  the list. If the preview is expanded, `←` gives the list back (like `Escape`).
- Inside the sidebar, `↑`/`↓` walk the connection cards, `Home`/`End` jump to
  the ends, and `Enter`/`Space` open the focused connection.
- `←` in a horizontally scrolled preview scrolls it back first; the column is
  left only at its left edge.

The column keys do not fire in a text field, in a dialog, in an open menu, on
the resizer, in the PDF viewer, on a native media element, or with `⌘`, `⌥` or
`⇧` held.

## Shortcuts

### Shell

| Action | Keys |
| --- | --- |
| Refresh the listing | `⌘R` |
| Upload files | `⌘U` |
| Upload a folder | `⌘⇧U` |
| New connection | `⌘N` |
| New folder | `⌘⇧N` |
| Edit the focused connection | `⌘I` |
| Address bar | `⌘L` |
| Filter, or find in the preview | `⌘F` |
| Toggle the sidebar | `⌘B` |
| Select all visible | `⌘A` |
| Download the selection or the cursor row | `⌘D` |
| Copy S3 URIs | `⌘⇧C` |
| Up one folder | `⌘↑` (macOS), `Backspace` (Linux) |
| Delete the selection or the cursor row | `⌘⌫` (macOS), `Delete` (Linux) |
| Open / preview | `Enter` |
| Toggle the cursor row in the selection | `Space` |
| Clear the selection | `Escape` |
| Open the row menu | `⇧F10`, the `ContextMenu` key, or right-click |

### Object list

| Action | Keys |
| --- | --- |
| Move the cursor | `↑` / `↓`, or a plain click |
| Extend the selection | `⇧↑` / `⇧↓`, `⇧PageUp` / `⇧PageDown`, `⇧Home` / `⇧End` |
| Move by a page | `PageUp` / `PageDown` (the visible row count) |
| First / last row | `Home` / `End`, `⌘↓` for the end |
| Add or remove one row | `⌘`/`Ctrl`-click, or `Space` on the cursor |
| Range selection | `⇧`-click, or `⇧`+arrows |
| Open the folder or preview the file | `Enter`, double-click |
| Type-ahead | printable characters |

A plain click is the pointer's arrow key: it moves the cursor and previews the
row without changing the selection. Select one row with `⌘`/`Ctrl`-click or
`Space`, and extend it with `⇧`-click or `⇧`+arrows; the checkboxes only appear
once something is selected. `Enter` or a double click on a file also brings a
hidden preview panel back. The selection and the cursor are separate states.
The cursor always has its own marker (bright left bar, hairline ring and a
stronger tint) so it stays visible inside a selected set. With no cursor the
list draws a quiet inset ring instead, so Tab never lands on an invisible pane.
A cursor the filter hides is inert: `Space`, `Delete` and the menu ignore it.

### Filter

`⌘F` focuses the filter field — except in a searchable preview, where it opens
find-in-file instead (see below). `↓` and `Enter` flush the debounce, move the
cursor to the first match and hand the keyboard to the list; `Enter` also opens
it. `Escape` clears the filter and returns to the list.

### Find in file

`⌘F` inside the preview column opens find-in-file for the views that show the
file's text: `text`, `code` and `json`, plus Markdown in the **Raw** view.
Everywhere else it still focuses the filter, and an image, PDF, CSV, Parquet or
rendered-Markdown preview falls through to the filter too. The **Search** button
in the preview header is the mouse entry point.

| Action | Keys |
| --- | --- |
| Open find in the preview (header button: **Search**) | `⌘F` |
| Next match | `↩` |
| Previous match | `⇧↩` |
| Close and return to the text | `Esc` |
| Match Case | `⌥⌘C` |
| Match Whole Word | `⌥⌘W` |
| Use Regular Expression | `⌥⌘R` |

The search starts case-insensitive. `⌘F` while the bar's field has the keyboard
re-selects the old query; it never moves to the filter. Match Case, Whole Word
and Regular Expression survive closing the bar and opening another file, while
the query is cleared when the preview moves to a different object. Whole word is
unavailable in regular-expression mode, and switching a Markdown preview between
Rendered and Raw closes the bar.

### Menus

`↑`/`↓` wrap around runnable items, `Home`/`End` jump, type-ahead jumps by
label, `Enter`/`Space` run the item, `Escape` or `Tab` close. Closing restores
focus to whatever opened the menu.

Right-click and `⇧F10`/`ContextMenu` open the same row menu. On Apple
keyboards `F10` is a media key and there is no `ContextMenu` key, so the pointer
(right-click) is the equivalent entry point there.

The **Upload** button opens the same kind of menu (files or a folder), because a
native open panel cannot show both at once. It opens with `Enter`/`Space` on the
button and is navigated like any other menu; `⌘U` and `⌘⇧U` skip it.

### Dialogs

- Opening from the keyboard is always possible (`⌘N`, `⌘I`, the sidebar, the
  toolbar, a row action).
- The first sensible control takes focus; destructive confirmations focus the
  safe choice.
- `Tab`/`Shift+Tab` stay inside the dialog.
- `Escape` closes it; `Enter` submits the form unless the focused control has
  its own `Enter` (a button, a checkbox, a `<select>`, a disclosure).
- `⌘`/`Ctrl+Enter` submits from a textarea (`Import`, `New file` content).
- Closing restores focus to the opener, or to the list when the opener was
  removed with the dialog.

## Focus scopes

A `[data-keyscope]` region owns its keys before the shell sees them:

- the preview body (and each renderer's scroller) — arrows scroll it;
- the PDF viewer — arrows and `PageUp`/`PageDown` page, `Home`/`End` go to the
  first/last page, `⌘+`/`⌘-` zoom;
- native `<audio>`/`<video>` — arrows seek.

## Restoring focus

These actions move focus deliberately, because their trigger disappears:

| Action | Focus goes to |
| --- | --- |
| Close the preview | the object list |
| Clear the selection | the object list |
| Cancel the address editor | the pencil, or the list when it is gone |
| Open an address | the object list |
| Collapse the sidebar | the replacement collapse button |
| Clear the transfer panel | the object list |
| Remove a connection | the remaining open card, or New |
| Close a dialog | the opener (fallback: the list) |

## Not keyboard-operable by design

- The native file/folder picker (`⌘U`, `Upload folder`, `Choose a file…`): the
  OS dialog owns its own keyboard support.
- OS drag and drop (files onto the window).
- Window chrome: close, minimise, full screen — the OS owns those.
- The updater's install step: it relaunches the app when it completes.
- PDF horizontal panning while zoomed: `←`/`→` page the document and the arrows
  scroll it vertically; pan sideways with a trackpad. Page navigation, zoom,
  fit and first/last are all on the keyboard.

## Implementation map

| Piece | File |
| --- | --- |
| Shell keys, zones, page jumps, shortcuts | `src/App.vue` (`onKeydown`) |
| Zone markers and focus entry points | `AppSidebar.vue`, `ObjectList.vue`, `PreviewPanel.vue` |
| Editable-target rules | `src/lib/keyboard.ts` (`isEditableTarget`) |
| Cursor marker and list focus ring | `src/assets/main.css` |
| Menu keys and type-ahead | `src/components/ui/ContextMenu.vue` |
| Dialog focus trap, `Enter` conventions | `src/composables/useFocusTrap.ts`, `src/components/dialogs/*` |

## E2E coverage

`src-tauri/src/e2e/mod.rs` drives the real window. The keyboard checks cover:
type-ahead, arrows/Page/Home/End with and without Shift, `⌘A` with a surviving
cursor, Space and `⌘`-click, cursor-only `⌘D`/`⌘⇧C`, the filter handoff (`↓`,
`Enter`, `Escape`), the hidden-cursor cases, `⇧F10` menus (row and
connection), column transitions in both directions, the focus
rings, address editing (error alignment, draft sync, focus after close) and the
sidebar's card navigation. `docs/e2e-gui-testing.md` explains how
to run the suite.
