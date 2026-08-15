# Visual Notes

**Visual notes, planning and organisation.**

Boards that live in your [Obsidian](https://obsidian.md) vault as real Canvas files — so they open in Obsidian's own Canvas view, nest inside each other, and outlast the plugin that made them.

A place to think in space rather than in a list, the way you would in Milanote, Notion or Trello: plan a project across a wall of sticky notes, keep a reading list as icon tiles, run a kanban board, draw over the top of it, and connect the pieces with labelled lines.

**How is this different from Obsidian's Canvas?** It *is* Canvas — the same spec-compliant `.canvas` file, sitting in your vault, openable in the native view. Visual Notes adds what Canvas leaves out: storyboards, kanban boards, tables, checklists, calendars, columns, group frames, pen and highlighter drawing, and boards that nest inside one another.

---

## Features

### Grid Mode
- **Tiles** that open folders, notes, canvases, kanban files, or nested boards
- Customise each tile's Lucide icon or emoji, background colour, label, and subtitle
- Optionally replace the icon with a cover image (Milanote-style tile thumbnail) from your vault or a URL
- Drag to reorder; right-click to edit

### Templates
- **17 bundled starter templates** (Brainstorm, Project Roadmap, Weekly Planner, Study Hub, Travel Planner, Screenwriting, and more) — pick one from **New board from template** to start with a populated board instead of a blank one
- **Save any board as your own template** via the toolbar's "···" menu or the **Save current board as template** command, then reuse it the same way as a bundled one
- **Group templates** — select any cluster of cards, right-click → **Create template…**, give it a name, and it becomes a reusable build you can drop onto any board from the canvas right-click menu's **Templates** entry. Anything can be templated: a styled header row, a meeting-notes layout, a connected diagram, a set of kanban columns
- Your own templates live in `_Templates/` in the vault (group templates in `_Templates/Groups/`), as plain `.canvas` files you can inspect, rename, edit, or delete directly

### Freeform Canvas
- Edge-to-edge canvas, same as Obsidian's native Canvas — no wasted border, with the board-name/back-navigation bar floating as a small pill over the canvas instead of a full-width header
- A right-click "Add" menu and a left-hand toolbar cover every card type below, grouped into Write / Media & links / Organize
- A **slash-command quick-add** (`/`) drops a new card of any type at the cursor without leaving the keyboard
- **Connections** between any two cards — straight or elbow-routed, with colour, thickness, line style, arrowhead, and inline label
- **Multi-select** via marquee or Shift-click; group drag, alignment bar, and even distribution
- **Copy/cut/paste groups** with **⌘/Ctrl C**, **X**, and **V** — the connections between the copied cards come with them, a selected group frame brings its contents along, and paste lands on the pointer. Works across boards, and across Obsidian windows
- **Group frames** — select 2+ cards and press **⌘/Ctrl G** to wrap them in a native-Canvas-style labelled frame. Purely spatial (no membership list, exactly like Obsidian's own Canvas groups): drag the frame to move everything inside it, resize or delete the frame without ever touching its contents
- **Resize** any card by dragging any of its four corners
- **Pan** with middle-click (or Space + drag), **zoom** with the scroll wheel
- **Minimap** with click-to-jump and zoom-to-fit, collapsible to a floating widget
- **Board-level search** and a **tag/type filter** panel to narrow a busy board down
- **Archive** cards you're not using instead of deleting them, and browse/restore from the archive any time
- Drag notes, canvases, and folders straight from the file explorer onto the canvas to create tiles — dragging another Visual Notes file in creates a nested board, exactly like nesting boards in Milanote

### Storyboards
A Storyboard is one canvas card containing an entire visual sequence, so planning a scene does not add dozens of specialist cards to the main board. Add one from the toolbar's **···** menu, the `/` quick-add palette, or the canvas right-click menu, then use its expand button or double-click its preview to enter the focused editor.

- Organise the overall scene into **scene sections**, with a draggable **shot** filmstrip along the bottom
- Add, duplicate, delete and reorder shots, or move a shot to another scene section; set each shot's number, title, duration and notes
- Frame shots as **16:9, 4:3, 1:1 or 9:16**, and add a background image from the vault
- **Import an image folder** to create one named shot per image in a single action
- Draw directly on a shot with pressure-aware Pen, Marker, Highlighter and textured Pencil presets; adjust size, colour, opacity and smoothing, or disable variable pressure for a uniform line
- Toggle **onion skinning** to ghost the previous shot beneath the current frame while drawing
- Select annotations to move, resize, reshape, recolour, copy between shots or delete with Delete/Backspace; selected arrows have endpoint and bend handles using the same trimmed curve geometry as canvas connections
- Edit selected text in the inspector's Text field; newly placed text focuses that field automatically
- Storyboard-local **Undo/Redo** treats a complete draw or drag gesture as one action (`⌘/Ctrl Z`, `⌘/Ctrl Shift Z`, or `⌘/Ctrl Y`)
- See the running shot count and sequence duration, play using each shot's timing in the editor or directly inside the canvas card, export a Markdown shot list, or export the whole Storyboard as a PNG contact sheet
- Switch the card's normal canvas preview between a horizontal filmstrip and a grid, and cycle its shot previews through Small, Medium and Large; shot notes appear beneath their frames as readable descriptions without opening the editor
- Open the bundled **Screenwriting** template for a working four-shot example

The Storyboard remains one normal, movable and resizable JSON Canvas node. Obsidian's native Canvas shows a readable Markdown shot list, while Visual Notes stores the full scene sections, shots, annotations and shot-relative ink in the node's `vn` metadata.

### Locking
Kanban boards, kanban columns, and generic Columns each have a padlock toggle: a locked container can't have items dragged into or out of it, but its own cards can still be freely dragged and repositioned.

### Kanban
- **Multi-column boards** (drag items between columns, per-column WIP limits) and legacy single-column cards
- Rich-text formatting in items (bold, italic, strikethrough, colour, highlight)
- **Due dates** — an amber badge when due soon, red when overdue, muted once done
- **Sub-checklists** inside any item
- Link items to vault notes or an external URL (a YouTube link gets an inline video-thumbnail preview); add tag pills
- Optional per-item icon/emoji badge or cover thumbnail, and a per-item background colour (Trello-label style)
- Drop images or audio files directly into a column
- Toggle the column title; set background and accent-strip colours

### Tables
- Insert rows/columns anywhere; drag to reorder
- **Typed columns**, Notion-style: text, number, checkbox, date, or select (with coloured options)
- Column alignment and click-to-sort
- **Paste from a spreadsheet** — either merge into the existing grid, or use the footer's Paste button to replace the table outright (first row becomes headers, so headers never misalign)
- Google-Sheets-style cell interaction: click/drag to select a range, double-click to edit, right-click to colour a cell or range
- A zoom slider that scales cell content without resizing the card itself
- Sticky header row and virtualized rows so large pasted tables stay smooth

### Sticky Notes, Checklists & Comments
- Inline rich-text editing with **⌘ B / I / U** and **⌘ ⇧ S** shortcuts
- Checklists support header rows to group items into sections
- Background colour and top-strip accent via the context bar colour picker

### Callouts
Notion/Obsidian-style callout cards with a full emoji picker (or free-text emoji) for the icon, plus title and body text.

### Columns
A generic, lockable container card for freeform grouping of tiles, sticky notes, checklists, tables, images, audio, note links, bookmarks, swatches, files, and callouts — distinct from a Group frame in that it holds an explicit list of children rather than being purely spatial.

### Images, Audio & Files
- Paste images from the clipboard; drag from the file explorer or OS onto the canvas or into a kanban column
- Add from the vault or upload from disk via the toolbar
- Images display at their natural aspect ratio; toggle captions with **⌘ ⇧ C** / **Ctrl ⇧ C**
- A generic **File card** for PDFs and other vault documents
- All imported files are automatically sorted into `_Assets/` subfolders (see Asset Management below)

### Bookmarks
Paste any URL for a link-preview card (title, description, favicon, image) fetched automatically. YouTube links get a native-style embed with a working inline play button instead of a plain preview.

### Maps
Paste a Google Maps link to get a live, fully interactive embed that matches the exact view you copied — including satellite/hybrid layer and zoom level derived from the link's altitude.

### Swatches
A colour swatch card showing the hex value and a nearest named-colour label. Double-click (or use the pipette button) to open the native colour picker, or right-click for a menu of approximate named palettes (Muted, Vivid, Pastel, Earth Tones, Grayscale) to generate a grid from. A reroll button in the name bar picks a new random colour.

### Text
Press `T` (or pick **Text**) and click anywhere to drop bare text on the canvas — no card, border or background.

- **Drag to resize the type.** Text cards never wrap, so the box is exactly as wide as its longest line and dragging a corner scales the words themselves, the way resizing a drawing scales the strokes. Press Enter for a new line. There's no width limit — drag it as large as you like.
- **Exact sizes** on the **Size** button (16 / 24 / 32 / 48 / 64 / 96 / 128 px). These are the same px value a drag sets, so picking one never fights what you dragged.
- **Fonts** — Obsidian's Text, Interface and Monospace, so text follows whatever you've configured under Appearance → Font.
- **Colour**, plus the usual bold/italic/underline/highlight on any selection.

Notes are still the card for longer writing, and they gained two things of their own:

- **No background** — a toggle in any note's **Colour** panel strips its fill.
- **Fonts and sizes** — the same **Font** picker, plus eight per-card sizes (XS–4X) and per-selection sizing, so one note can carry a big heading above ordinary body text.
- **Bullets** — the **Bullet** button, or type `- ` at the start of a line.

### Text Formatting
Select any text in a sticky note, checklist, kanban item, or image caption to reveal a floating toolbar: bold, italic, underline, strikethrough, text colour (preset + colour picker), and highlight colour.

### Drawing
- Freehand **pen** and **highlighter** strokes directly on the canvas, layered above cards
- Pen strokes are rendered with [perfect-freehand](https://github.com/steveruizok/perfect-freehand), giving genuine pressure-sensitive tapering on a stylus/tablet (simulated from drawing speed for mouse input)
- Nearby strokes drawn in the same session are grouped into one sketch automatically; a doodle started elsewhere on the canvas gets its own group instead of merging in
- **Multi-select** strokes via marquee or Shift/Ctrl-click, then move, resize, recolor, or delete them as a group
- **Eraser** detects your swipe crossing a stroke's actual line, not just proximity to its sample points — works cleanly on straight lines, not just wobbly ones
- Full **undo/redo** support for every drawing action
- **iPad + Apple Pencil note:** if quick, small strokes (like a fast "s" or "e") intermittently fail to appear, turn off **Scribble** in iPad Settings → Apple Pencil. Scribble intercepts fast Pencil strokes for handwriting-to-text before they ever reach the canvas — this is a system feature web-based apps cannot override.

### Asset Management
- **Auto-sort:** every image, audio clip, video, or document imported into a board is automatically moved to the correct subfolder in the vault root:
  - `_Assets/Images/` — jpg, png, gif, webp, svg, …
  - `_Assets/Audio/` — mp3, wav, ogg, flac, …
  - `_Assets/Video/` — mp4, mov, mkv, …
  - `_Assets/Documents/` — pdf
- **Auto-relink:** scan all boards and fix broken file paths when a unique filename match is found in the vault. Three ways to run it:
  - **On open** — toggle *Auto-relink on board open* in Settings to fix links silently every time a board loads
  - **Settings button** — Settings → Assets → *Relink now*
  - **Command palette** — `Visual Notes: Relink all board assets`

### Keyboard Shortcuts
| Action | Shortcut |
|---|---|
| Delete selected | Delete / Backspace |
| Select all | ⌘ A |
| Copy selection | ⌘ C / Ctrl C |
| Cut selection | ⌘ X / Ctrl X |
| Paste | ⌘ V / Ctrl V |
| Duplicate | ⌘ D |
| Group selection | ⌘ G / Ctrl G |
| Undo | ⌘ Z |
| Redo | ⌘ ⇧ Z |
| Toggle image caption | ⌘ ⇧ C |
| Bold (sticky editor) | ⌘ B |
| Italic (sticky editor) | ⌘ I |
| Underline (sticky editor) | ⌘ U |
| Strikethrough (sticky editor) | ⌘ ⇧ S |
| Quick-add card | / |
| Text tool | T |

---

## Installation

### Community Plugin Browser
1. Open **Settings → Community plugins → Browse**
2. Search for **Visual Notes**
3. Click **Install**, then **Enable**

### Manual Installation *(for beta testers)*
1. Download `main.js`, `manifest.json`, and `styles.css` from this plugin's latest release
2. In your vault, create the folder `.obsidian/plugins/visual-notes/`
3. Copy the three files into that folder
4. Open Obsidian, go to **Settings → Community plugins**, and enable **Visual Notes**

---

## Usage

### Opening a board
- Run **Visual Notes: Open** from the command palette
- Or click the layout-dashboard icon in the left ribbon

### Creating your first board
1. Run **Visual Notes: Create new board** (or click **+ New board** on the empty home screen)
2. A `.canvas` file is created in your vault root (you can move it later)
3. The board opens in grid mode — click the **+** button to add your first icon tile

### Grid mode
- **Click** a tile to open its target
- **Right-click** a tile to edit, change icon, change colour, or delete
- **Drag** tiles to reorder them

### Freeform canvas
- Switch to canvas mode with the toggle in the top-right corner of any board
- **Right-click** the canvas background to add a card, grouped into Write / Media & links / Organize
- Type **/** to quick-add a card at the cursor
- **Pan** by dragging the background, middle-clicking anywhere, or holding Space and dragging; **zoom** with the scroll wheel
- **Right-click** a card for options (edit, style, connect, lock, archive, delete)
- The **toolbar** on the left has one button per card type; click it or drag it onto the canvas
- Use the **search** and **filter** widgets to jump to or narrow down cards on a busy board
- Toggle the **minimap** to see and jump around the whole board at a glance

### Connections
- Right-click a card → **Connect** to enter connection mode, then click a second card
- Click a connection to select it; right-click for colour, thickness, and style options

### Fixing broken asset links
If you move files in the vault and board assets stop loading, run **Visual Notes: Relink all board assets** from the command palette. For automatic fixing every time you open a board, enable *Auto-relink on board open* in Settings.

### Saving
Boards save automatically as you work. All data lives in the `.canvas` file — no external database or sync service is required.

---

## Permissions & data access

Visual Notes only reads and writes files inside your own vault — it makes no network requests and sends no data anywhere. Two vault-wide capabilities it uses, and why:

- **Vault file listing** (`vault.getFiles`, `getMarkdownFiles`): needed to power the note/image/audio/file pickers (e.g. linking a note to a kanban item, choosing a cover image, auto-relinking moved assets). Nothing is read or transmitted beyond the file list itself until you pick a specific file.
- **Clipboard access**: used to paste images directly onto a board (Ctrl/Cmd+V) and to copy/paste cards between boards. It only reads the clipboard when you trigger a paste action inside the plugin.

---

## Compatibility

| Platform | Status |
|---|---|
| Obsidian desktop (Mac, Windows, Linux) | ✅ Supported |
| Obsidian mobile (iOS, iPadOS) | ✅ Supported |
| Minimum Obsidian version | 1.7.2 |

---

## Reporting bugs & requesting features

Found something broken, or want the plugin to do something it doesn't?

- **[Report a bug](https://github.com/dandersondev/visual-notes/issues/new?template=bug_report.yml)** — the form asks for your Obsidian version, plugin version, and platform, which is usually what decides whether I can reproduce it.
- **[Request a feature](https://github.com/dandersondev/visual-notes/issues/new?template=feature_request.yml)** — a good part of what's in the plugin started as somebody else's suggestion.
- **[Browse open issues](https://github.com/dandersondev/visual-notes/issues)** to see what's already known or being worked on.

Two things worth checking before you file:

- **Toggle the plugin off and on after an update.** Obsidian doesn't always load a new version straight away, so an already-fixed bug can look like it's still there.
- **On iPad, if Apple Pencil strokes vanish**, check whether iPadOS **Scribble** is enabled (Settings → Apple Pencil → Scribble). It intercepts fast strokes before the plugin sees them.

---

## How this is built

Visual Notes is built with heavy AI assistance. Most of the code is written by Claude; I direct it, test it, and decide what ships.

I'm saying so up front because "who actually maintains this, and will it still work in six months" is a fair question to ask of any plugin, and a fairer one when AI is involved. The honest answers:

- **Every release is tested in my own vault** — desktop and iPad — before it goes out.
- **The test suite runs on every build**: more than 770 tests, including regressions written for specific bugs people reported, each verified by reintroducing the bug and confirming the test catches it.
- **The [changelog](CHANGELOG.md) records every release and what prompted it.** Most entries started as a user report.
- **Bugs get fixed.** [Open an issue](https://github.com/dandersondev/visual-notes/issues) and you'll get a reply.

And the part that matters most if you're weighing the risk: **your boards are plain `.canvas` files** in your own vault, in Obsidian's own spec-compliant format. They open in the built-in Canvas view whether this plugin is installed or not. If it were abandoned tomorrow, nothing you built with it would be locked up or lost — which is a deliberate design decision, not a happy accident.

---

## Development

```bash
git clone https://github.com/dandersondev/visual-notes.git
cd visual-notes
npm install
npm run dev        # watch mode — rebuilds on save
npm run build      # production build
npm run generate-benchmarks # realistic large-board and 40-shot Storyboard fixtures
```

Copy or symlink the folder into `<vault>/.obsidian/plugins/visual-notes/`, then enable the plugin in Obsidian.

---

## Credits

Visual Notes began as a fork of **[Icon Board](https://github.com/RK-Admin-01/obsidian-icon-board)** by **RK-Media**, used under the MIT licence. Thanks to them — the icon-tile board it started from is still the idea at the centre of this plugin.

It has diverged substantially since. The largest change is the storage format: Icon Board keeps a board in its own `.iboard` file, while Visual Notes writes Obsidian's spec-compliant `.canvas` format, so boards open in the built-in Canvas view and nest inside each other. Most of what's listed above — tables, columns, group frames, calendars, connections, pen and highlighter drawing, templates, and export — was written for this plugin. If you want the original, simpler icon-tile board, [Icon Board](https://github.com/RK-Admin-01/obsidian-icon-board) is still there and worth a look.

---

## License

[MIT](LICENSE) — © 2025 RK-Media and © 2025 Daniel Anderson

Pen strokes are rendered with [perfect-freehand](https://github.com/steveruizok/perfect-freehand) by Steve Ruiz (MIT license).
