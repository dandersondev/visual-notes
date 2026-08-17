# Changelog

All notable user-facing changes to Visual Notes.

## 1.3.0

### Added
- **Experimental private-network collaboration.** A desktop Visual Notes installation can host a live room over a trusted LAN or user-provided virtual network, while desktop and mobile collaborators join by invitation. Ordinary cards, Kanban boards, drawings, connections, nested boards, cursors, selections, images, and supported videos synchronize while every participant retains a local `.canvas` file.
- **Room roles and controls.** Rooms support owner, editor, and viewer access, separate editor/viewer invitations, invitation rotation, member removal, room-tree export and deletion, shared-media accounting, and delayed cleanup of orphaned media.
- **Automatic desktop hosting.** The production plugin bundle contains the private-room server, so the host does not need Node, Docker, or a terminal. The host chooses a detected LAN/VPN interface and keeps Obsidian open; mobile remains join-only.

### Security and privacy
- Collaboration is opt-in and private-network-only. Visual Notes operates no collaboration cloud, receives no room data, creates no accounts, and adds no telemetry.
- The active server credential is held in Obsidian SecretStorage. Older plaintext development/Auth0 fields and OAuth sessions are removed automatically on load.
- Runtime room databases, transferred assets, generated server files, and plugin data are excluded from Git. Invitations contain credentials and are explicitly treated as passwords.
- Hosted-development and Auth0 controls remain unavailable in the release UI.
- **Collaboration requires Obsidian 1.11.4 or newer**, which is where Obsidian added the secure storage the server secret is kept in. Rather than raise the plugin's minimum Obsidian version for one opt-in feature, Visual Notes checks for that storage at runtime: on Obsidian 1.7.2 through 1.11.3 the collaboration setting explains that it needs a newer Obsidian, and **every other feature — and every future update — works exactly as before**.
- The room server binds only to the private network interface chosen when hosting starts, never to every interface, and refuses to start beyond loopback without a strong secret. The shared secret is compared in constant time.

### Fixed
- Undo now synchronizes to collaborators without creating a non-JSON optional field or disrupting the session.
- A normal Kanban reorder publishes one stable-ID move instead of one move per surviving item, substantially reducing remote latency and host disk writes.

## 1.2.4

### Fixed
- **Dragging a Storyboard by its body no longer throws it across the board.** On iPad, grabbing a Storyboard anywhere below its title sent it flying to a distant spot, while grabbing the title dragged it normally. The body is the scrolling shot strip, and a touch that starts in a scrolling area is taken over by the browser part-way through — which left the drag resolving against a position of nowhere. Any card whose drag is interrupted this way now simply returns to where it started, undisturbed, and the interrupted drag no longer leaves an undo step that restores nothing.
- **Storyboard shot strips can still be scrolled with a finger, and the card still dragged.** A filmstrip scrolls sideways, so dragging its body downwards moves the card; a grid scrolls downwards, so dragging sideways moves the card. Neither view puts a shot out of reach on a tablet.
- **A pinch that begins on a card now leaves the card exactly where it was.** 1.2.3 stood the drag down for the zoom but left the card wherever the pinch had started from; the zoom is now the only thing that happens.

## 1.2.3

### Fixed
- **Cards no longer jump across the board when a second finger touches them.** Dragging a card on a touch screen and then resting or landing another finger anywhere on it threw the card to a distant, apparently random position. Only the finger that began a drag now moves it, and a second finger lifting no longer ends the drag early. Reported on iPad against Storyboards, which suffer most simply by being the largest cards — a stray finger lands on one far more easily.
- **Pinch-zooming while touching a card now zooms.** A second finger already stood the box-select and one-finger pan down; a card drag kept running and fought the zoom. It now steps aside like the others, leaving the card where you had dragged it to.

## 1.2.2

### Fixed
- **Exports now arrive somewhere on iPhone and iPad.** Exporting a board as PNG or PDF, or a Storyboard as a contact sheet or shot list, appeared to work on mobile and then produced no file at all — no error, nothing saved, nowhere to look. Every export was handed over as a browser download, which the desktop app performs and the mobile app cannot. On mobile the file is now written into an **`_Exports`** folder in your vault and a message tells you the exact path, so it can be opened in Obsidian, found in the Files app, or picked up by whatever syncs your vault. Repeated exports of the same board are numbered rather than overwriting one another. Desktop is unchanged and still downloads as before.

## 1.2.1

No behaviour changes — this clears every warning Obsidian's plugin health check
raised against the Storyboard code that shipped in 1.2.0.

### Technical
- Storyboard SVG is built through Obsidian's `createSvg` helper rather than raw `document.createElementNS`, covering the container, paths, polygons and the pencil texture's filter, turbulence and displacement nodes.
- The Canvas serializer's Storyboard projection moved into a dedicated `storyboardToMarkdown` helper with an explicit card type, replacing two chained `flatMap` calls with plainly typed loops.
- Dropped `break-inside` from the contact-sheet cell. The health check flags it as only partially supported, and it was doing nothing: the sheet is rasterised from a single CSS grid, never printed or paginated, so there was no fragmentation context for it to affect. The stylesheet test now refuses its return.

## 1.2.0

### Added
- **Storyboard cards turn a board into a shot-planning workspace without filling it with new card types.** Add one from the toolbar's **···** menu, the `/` quick-add palette, or the canvas right-click menu. A Storyboard stays one movable, resizable Canvas card; open it to work in a focused editor with scene sections on the left, the current shot in the middle, its inspector on the right, and a draggable filmstrip below.
- **Build and arrange shots inside a Storyboard.** Add, duplicate, delete and drag shots into order, or move them between scene sections; give each one a number, title, duration and notes; choose 16:9, 4:3, square or vertical framing; and use an image from the vault as its background. Importing an image folder creates one named shot per image in a single action. The card itself can show either a filmstrip or grid preview.
- **Draw and annotate directly on a shot.** The focused editor has select, pen, eraser, text and arrow tools. Text, arrows and individual ink strokes can be selected, moved or reshaped, recoloured, resized, copied between shots and removed with Delete/Backspace. Selecting text opens a normal inspector field that updates the shot live. Storyboard-local Undo/Redo covers drawing, dragging, editing, styling, shot changes and reordering as complete actions rather than saving every pointer movement separately.
- **Animate, time and export a Storyboard.** Onion skinning ghosts the previous shot under the current frame. The editor reports the running shot count and total duration; playback advances through every shot using its timing, with a 300 ms floor for zero-length entries. Export either a Markdown shot list or a PNG contact sheet containing section headings, shot images, annotations, numbers and titles. Temporary contact-sheet content is always removed again, including after a failed export.
- **The Screenwriting starter template now includes a working Storyboard.** Its four-shot rooftop scene demonstrates shot metadata, text, an arrow, ink and mixed aspect ratios rather than describing storyboarding with ordinary placeholder cards.
- **Shot notes remain visible on the canvas.** A shot with notes displays them as a description directly beneath its frame in the Storyboard card's filmstrip or grid preview, without requiring the focused editor to be open.
- **Storyboard previews can be resized.** The S/M/L control in the card header cycles every shot between compact, standard and large previews in both filmstrip and grid layouts, keeping the sequence consistent while allowing more visual detail when the card has room.
- **Play a Storyboard directly on the canvas.** The card's Play button replaces its filmstrip or grid with a large single-shot player, advances through every scene section using each shot's duration, displays shot progress and restores the normal preview when playback finishes or is stopped.
- **Empty Storyboard frames follow the active theme.** Their image-placeholder pattern and text now use Obsidian's theme colours, remaining dark in dark mode and becoming a softer light-grey treatment in light mode.
- **Storyboard drawing now has a real brush engine.** Choose Pen, Marker, Highlighter or textured Pencil, then adjust size, colour, opacity and smoothing from the live brush bar. Apple Pencil and compatible styluses use their reported pressure; mouse drawing receives simulated pressure, and pressure can be disabled for a uniform-width stroke. Coalesced pointer samples preserve fast stylus movement, while the same deterministic renderer is used in the editor, onion skin, canvas preview, playback and exports.
- **Storyboard arrows use the canvas connection geometry.** Their shafts can bend through a draggable center handle, arrowheads follow the curve's arrival tangent, and the visible shaft is trimmed by the exact tip length so no rectangular line cap protrudes through the arrowhead.
- **The focused Storyboard editor remains complete on iPad-sized screens.** Scenes, Stage and Shot Inspector are now switchable drawers instead of hiding both metadata panes. The brush bar scrolls horizontally, toolbar actions are grouped, safe-area padding is respected, and choosing a scene or filmstrip shot returns directly to the Stage.

### Fixed
- **Boards containing a link card can be exported again.** Exporting to PNG or PDF failed outright as soon as a board held a link — reported as working "with many features, but as soon as I add a link I can't export". A link card shows a preview image and favicon fetched from the site itself, and the export had to re-request those pictures while rasterising the board. Most sites refuse that second request, and a single refused picture stopped the entire export with no file produced. Preview images are now fetched the same way the rest of the plugin fetches remote content, so they are reachable and **appear in the export** rather than merely failing quietly; anything genuinely unavailable is left as a blank space, which can no longer take the export down with it. The same applies to note-link covers, external image cards and the Storyboard contact sheet. Reported with a console trace that identified the cause exactly — thank you.

### Technical
- A Storyboard is stored as one spec-compliant JSON Canvas node. Its `sections`, `shots`, annotations and shot-relative ink live in the node's `vn` metadata, while native Obsidian Canvas receives a readable Markdown shot list.
- Interrupted touch/stylus gestures clean up on `pointercancel` as well as `pointerup`, preventing cancelled iPad gestures from continuing on a later hover. Cross-window hit testing uses Obsidian's safe `instanceOf` helper.
- Opening and closing a Storyboard without changing it no longer schedules a board write. Keyboard events inside the focused editor are isolated from the board underneath, so Escape cannot be swallowed by the board's pen mode.
- Storyboard data has dedicated JSON Canvas round-trip coverage, real starter-template corpus coverage, and pointer release/cancellation regression tests.
- Normalized ink samples are rounded to four decimal places (0.1 px at a 1000 px frame), substantially reducing board writes without visible drawing loss. The frame renderer remains independent of modal state so its annotation layer can be reused by other image-based cards later.

## 1.1.34

### Fixed
- **Dragging a card off the toolbar no longer opens Obsidian's sidebar.** On iPad the sidebar slid open mid-drag, because dragging left-to-right off a left-hand toolbar is the same gesture Obsidian uses to open one. Touches that begin on the toolbar now stay there. Swiping in from the edge of the screen still opens the sidebar exactly as before — that is where the gesture is meant to be made, and the canvas already leaves that strip alone.

  1.1.31 fixed the other half of this, where the drag could not start at all; this is the part that remained.

## 1.1.33

Contains everything in 1.1.32, which failed to build and was never released.

### Fixed
- **A file that can't be added to a board now says so.** Dropping or dragging a file in moves it into your `_Assets` folder first, and that can fail for ordinary reasons — the file was renamed or deleted mid-drag, the name is already taken, permissions. On the touch path that failure was silent. It now reports what went wrong, instead of the card simply never appearing.

## 1.1.32

### Added
- **Dragging a file onto a board now works on iPad.** Long-press a file in Obsidian's file explorer, drag it over a board and let go: it becomes a card, exactly as it does on a desktop. Images, videos, audio, notes, canvases and folders all arrive as the card they should. The long press is Obsidian's own way of picking a file up on a touch screen — it has to be, so the file list can still be scrolled — and only the release needed handling here.

  This supersedes the known limitation noted in 1.1.31. That note was written on the understanding that Obsidian could not start such a drag on iPad at all. It can: it just completes the drag in a way that a plugin has to listen for differently, and once that was clear the rest followed.

## 1.1.31

Three iPad fixes, all reported together.

### Fixed
- **Swiping in from the edge opens Obsidian's sidebar again.** On iPad the swipe did nothing except slide the canvas sideways — a one-finger pan and Obsidian's sidebar swipe are the same gesture, and the board took it every time. A touch starting within a short distance of either screen edge is now left to Obsidian. Panning is unaffected everywhere else, and nothing changes when a sidebar is already open, since the board no longer reaches the edge.
- **Dragging a card out of the toolbar works on iPad.** Nothing could be dragged onto the canvas from the toolbar — not a note, not a sticky, not an image — while the same gesture worked on desktop. iPadOS treats a touch as its own scrolling gesture unless an element opts out, and the toolbar buttons never did, so the drag was taken away the moment your finger moved. On phones the toolbar panel scrolls, so there it keeps scrolling and cards are placed by tapping, as before.
- **The toolbar no longer sits under Obsidian's edge-swipe strip on touch devices.** Its outer edge overlapped by a few pixels, so starting a drag from the very edge of a button sometimes slid the sidebar open mid-drag instead. The side toolbars now sit further in on touch devices.

### Added
- **Video is in the canvas right-click menu**, beside Image and Audio. It had been reachable only from the toolbar's **···** menu and the `/` palette since video cards arrived in 1.1.27. This matters most on a tablet, where the long-press menu is the usual way to add a card — and where, as it turns out, Obsidian itself does not support dragging a file out of the file explorer, so there had been no way to place a video at a chosen spot at all.

### Known limitation
- **Files cannot be dragged from Obsidian's file explorer onto a board on iPad.** Obsidian does not support that drag on iPad in any view, not only on a canvas, so there is nothing Visual Notes can do about it. On iPad, add media from the toolbar or by long-pressing the canvas.

## 1.1.30

### Fixed
- **Dragging a video in from the file explorer now works.** It did nothing at all — no card, no error, the file simply refused to drop — while dragging the very same file in from your desktop worked. A board checks what it will accept while a drag is still moving over it, and video was never added to that list when video cards were introduced in 1.1.27, so the drop was refused before the code that builds the card could run. A drag from outside Obsidian took a different route and never reached the list, which is why one worked and the other didn't. Affects every video format, not only `.mp4`.
- **The video controls now work on a trackpad.** Play, pause, the scrubber, volume and fullscreen worked with a mouse and did nothing on a trackpad — the third report of these controls failing, and the one that finally explained the previous two. A trackpad click carries a little movement between press and release; the board read that movement as the start of dragging the card and took the gesture over, so the button never received it. A mouse click carries no movement, which is why the same card behaved differently on a desktop and a laptop. Rather than guess at a tolerance that would work on every trackpad, Visual Notes now draws the controls itself instead of using the browser's, so a press on them is recognised as a press on them and never becomes a drag. Dragging a card by its picture is unchanged, and clicking the picture still plays.
- **The space bar and other board shortcuts no longer stop working at random.** Holding space to pan, Ctrl+F to search, `/` for quick-add and `T` for the text tool all quietly stopped after you clicked almost anything — a card, a toolbar button, a video — and started working again once you clicked an empty part of the canvas. They required the canvas itself to be the focused element, which almost nothing leaves true. Reported as shortcuts that "stop working randomly and start working the same way".

### Added
- **Hand and select modes.** Press **H** for the hand and **V** to go back to selecting, or use the two new buttons at the top of the toolbar. In hand mode a plain left-drag pans the board from anywhere, including on top of a card. Panning otherwise needs a middle or right button, which is awkward on a trackpad and worse on a tablet. Holding space still pans in either mode, and **Escape** returns to selecting. Requested by a user; thank you.
- **Arrow keys nudge the selected cards.** One point at a time, or ten with **Shift** held, and each nudge undoes in a single step. Useful for lining cards up more precisely than a drag allows.

## 1.1.29

### Fixed
- **Video controls now work at any card size.** Play, pause, the scrubber, volume and fullscreen did nothing on a video card unless you first made the card much wider — reported on vertical phone clips, where it never worked at the size the card arrives at. The canvas was reserving a fixed strip at the bottom of the card for the controls, but the browser lays them out on **two rows** when a video is narrow and one row when it's wide, so on a vertical clip the whole control bar sat outside the strip and every press on it was taken as an attempt to drag the card. The canvas no longer sets aside any part of a video: a press is left alone until it actually moves, so the controls receive it whatever shape the card is, and moving the pointer still drags the card exactly as before.

### Changed
- **A vertical video no longer arrives as a very tall card.** Card size was worked out from a fixed width, so a portrait phone clip came in around 320 × 569 — most of a screen for one card. A newly added clip is now fitted to a sensible size in both directions, so a vertical one lands nearer 200 × 360. Landscape video is unchanged, and a card you have resized yourself is left alone.

## 1.1.28

### Fixed
- **The VISUAL tag no longer flashes CANVAS first.** Board rows in the file explorer appeared as an orange **CANVAS** tag for a moment before settling to blue **VISUAL**, as though they were still loading — and did it again each time a row scrolled out of view and back. Telling a board from an ordinary canvas means reading the file, but that was made to hold up every row, including the ones already identified. Rows Visual Notes has seen before are now marked in the same frame they appear. A board it has genuinely never seen still has to be read once, so a brand-new board may take a moment the first time.
- **Clicking a video to play it now works in a popped-out window.** A board opened in its own window would let you drag a video card but never play it by clicking the picture — the play button in the controls still worked, so it looked like a half-broken card rather than an obvious bug.

## 1.1.27

### Added
- **Videos play on the canvas.** Drag a video into a board — from the file explorer, from your desktop, or with the new **Video** tool — and it becomes a player you can watch in place, instead of an icon you had to open somewhere else. Click the picture to play or pause, double-click for fullscreen, and drag the card by its picture as you would any other. The card takes the shape of the clip, so a portrait phone video isn't stranded in a letterbox. Boards you already have keep their file cards: right-click one pointing at a video and choose **Play on canvas** to turn it into a player. Because a video card is stored as an ordinary Canvas file node, the same board plays in Obsidian's own Canvas view too. Formats Obsidian can't decode (`.mkv` and `.avi` usually) say so on the card and offer to open the file externally, rather than sitting there as a black rectangle. Requested by a user building a moodboard; thank you.
- **Visual Notes boards are labelled in the file explorer.** A board and one of Obsidian's own canvases are both `.canvas` files, which is the point — but it also meant they looked identical in the sidebar, with no way to tell which was which before opening it. Boards now carry a **VISUAL** tag in place of the usual **CANVAS** one, in Visual Notes' own colour. Nothing about the files changes, and you can turn it off under Settings → **Mark Visual Notes boards in the file explorer**.
- **A light/dark button on every board.** In the bottom-right corner beside the zoom and snap controls, a sun/moon button switches Obsidian between light and dark — the whole app, the same setting as Appearance → **Base color scheme**, not just the board you are looking at. It follows the theme rather than the click, so it always shows where you actually are, including when you change the scheme from somewhere else. Turn it off under Settings → **Light/dark button on boards**.

### Fixed
- **Editing a board in two places no longer quietly loses one of them.** While a board is open, Visual Notes holds the whole thing in memory, and every save wrote that copy straight over the file — so if the board had changed in the meantime, that change was replaced with no warning and no copy kept. The two writes did not even have to be close together: a board left open in the morning would still overwrite an afternoon's work when it next saved. This affected far more than shared vaults — one person with a laptop and an iPad on Obsidian Sync hit exactly the same thing, as did Dropbox and Syncthing vaults, two Obsidian panes on the same board, and any edit made outside Obsidian.

  Every save now checks the file first. If it holds a version Visual Notes was not expecting, that version is written beside the board as `YourBoard.canvas.conflict.bak` **before** your save lands, and a message tells you where it went — so both versions survive and you can put them back together in your own time. If you have not actually changed anything yourself, the other version is simply left alone and nothing is written at all. Panning and zooming don't count as changes, so just looking around a board never triggers any of this.

## 1.1.26

### Added
- **Web clips land on a board by themselves.** Set a **clippings folder** and a **board for clips** under Settings → **Web clips**, then point [Obsidian Web Clipper](https://obsidian.md/help/web-clipper)'s note location at that folder: everything you clip appears on the board as a card, arranged in rows below whatever is already there. It works on anything that writes a note into that folder, not only the Web Clipper — the iOS share sheet and other tools land there too. Clips made while Obsidian was closed are picked up the next time it starts, and **Import web clips now** does the same on demand. Nothing is ever added twice, however it arrives.
- **Clipped pages look like clipped pages.** A note saved from the web now shows the article's real title (not the sanitised filename), a clickable link back to the site it came from, and its cover image where there is one — with the properties block no longer dumped at the top of the card as raw text. **Dragging a clipping onto a canvas** now creates that same card rather than a plain icon tile.

### Changed
- **The README now says what Visual Notes is for** before listing what it contains, and answers the question two people asked after the launch: how it differs from Obsidian's own Canvas. It *is* Canvas — the same `.canvas` file in your vault — with card types Canvas doesn't have.

### Security
- **Links on a board are checked before they open.** A card's link can come from the *file* rather than from anything you typed — a board shared with you carries whatever its author put in it — and those links were opened without being checked first. A `javascript:` link runs when opened rather than simply failing to load, so opening a shared board and clicking a card was enough to run its author's script. Every link now has to be an ordinary web address before it will open. The same check now covers link previews being fetched, and images pulled from a remote page.
- No behaviour changes for ordinary boards: every real link, preview and image works exactly as before.

## 1.1.25

### Fixed
- **Calendar: the items behind "+N more" could not be reached.** A month cell lists the first few of a day's items and sums up the rest as "+N more" — but that line was plain text with nothing behind it, and the cell hides whatever overflows it, so anything past the third item could not be read, clicked or right-clicked by any route at all. It is now a button: click it, or press Enter or Space on it, to open the day in full, and **Show less** to close it again. The opened day floats over the days below rather than pushing the month around it, a very long day scrolls inside its own panel, and only one day stays open at a time. Reported by a user whose screenshot made the cause obvious; thank you.
- **Calendar: adding or deleting a note on a busy day looked like it did nothing.** The same cap was behind this. A new note on a day that already held three items was rendered out of sight, and deleting one of the three visible items simply pulled a hidden one up into the gap — so either way the day looked exactly as it had a moment before, and the button appeared not to have worked. The day you just edited now opens on its own, so the change is visible where you made it.

## 1.1.24

### Added
- **A default folder for new boards.** Settings → **Default folder for new boards** sets where boards are created, so the **Location** field arrives already pointing where you keep them instead of at the vault root every single time. Creating a board by right-clicking a folder in the file explorer still uses *that* folder — pointing at a folder is a clearer instruction than a setting — and **Reset** in the New board window now returns to your chosen default rather than to the vault root. Requested by a user; thank you.

### Changed
- **Adding a board tile no longer asks for the name twice.** Adding a tile meant typing a **Label**, then pressing **Create new…**, which opened a second window on top of the first asking for a **board name** — the name you had just typed. Leaving the target empty now creates that board for you, named after the label, when you press **Create**. Everything that worked before still works: **Browse…** points a tile at a board you already have, and **Create new…** is still there for when you want the board named something other than the tile. Tiles that point at a **note** or a **folder** are unchanged and still ask you to choose one, since those are links to something that already exists rather than something the tile implies making.
- **The tile window's button now reads "Create" when you're adding a tile**, and "Save" only when you're editing one — it can now genuinely create a file, so calling it Save was understating what it did.

## 1.1.23

### Added
- **A board can no longer be emptied without a copy being kept.** If a save is about to replace a board that has cards in it with one that has none, the previous contents are written alongside it as `YourBoard.canvas.before-empty.bak` first, and a message tells you it happened. Clearing a board yourself still works exactly as before — this never blocks the change, it just means the previous version is always there to go back to.

### Fixed
- **A board that couldn't be read could be overwritten with an empty one.** If a board file failed to open or parse, what appeared on screen was an empty placeholder — and the next automatic save wrote that placeholder over the real file. The placeholder is now marked as such and is never saved, so a file we can't read is left exactly as it is.
- **A board that couldn't be read is no longer handed to Obsidian's native Canvas.** Visual Notes passes `.canvas` files it doesn't recognise to Obsidian's own Canvas view, which is correct for a canvas made elsewhere — but a file that merely *failed to read* was treated the same way, and native Canvas rebuilds a file from its own model when it saves, which drops Visual Notes' board data. "Couldn't read this file" now means stop, not hand it to something that will rewrite it.

### Note
This release is a response to a report of a board opening empty, which we have not yet been able to reproduce. It does not claim to fix the cause. What it does is make that outcome recoverable rather than permanent, and visible rather than silent — and if it happens again, the presence or absence of the `.before-empty.bak` file says which half of the code to look in. Thanks to the user who reported it and patiently answered several rounds of questions.

## 1.1.22

### Fixed
- **A compatibility warning in Obsidian's plugin health check.** The bullet indent added in 1.1.21 was built with `text-indent`, which Obsidian's checker reports as only partially supported. The property is flagged as a whole because two of its keywords have patchy support; the plain measurement used here does not, but the check goes by the property name. The indent is now built from margins instead, which nothing flags. **Bullets should look exactly as they did in 1.1.21** — this is a change of method, not of appearance. A test now fails the build if a flagged property returns to the stylesheet, since the health check itself only runs on Obsidian's side.

## 1.1.21

### Fixed
- **Bullet points lost their indent on continuation lines.** Starting a bullet and then pressing Shift+Enter to add more lines to that same bullet left those lines flush against the marker instead of lined up under the text. The same fault also affected any bullet long enough to wrap on its own, and — more visibly — notes written before bullets existed, where a single bullet holding several paragraphs rendered with its marker stranded on a line of its own. All three were the same thing: list items had no hanging indent, so only the *first* line of an item ever cleared the bullet. Reported with an exceptionally clear write-up and side-by-side screenshots; thank you.
- **The formatting popover could cover the note you were editing.** It positioned itself above the *selected text*, which meant that selecting anything below the first line or two put it directly over the rest of the note. It now sits clear of the card entirely — below it by default, since the card's own toolbar takes the space above — while still following your selection left and right so it stays near what you're working on. It also no longer lands on top of the toolbar when it has to flip, and the toolbar can no longer be pushed onto a card taller than the window.

## 1.1.20

### Added
- **A Text tool.** Press `T` (or pick **Text** from the toolbar) and click anywhere to drop bare text straight onto the canvas — no card, border or background. Text cards never wrap, so the box is exactly as wide as its longest line and you press Enter for a new one; **dragging a corner scales the words themselves**, the way resizing a drawing scales the strokes. There's no width limit, so you can drag a headline as large as you want. The **Size** button offers exact pixel sizes (16 / 24 / 32 / 48 / 64 / 96 / 128) — the same unit a drag sets, so picking one never fights what you dragged. Requested independently by two people, one of whom asked for the `T` shortcut by name. Boards stay readable in Obsidian's native Canvas view, where a text card shows up as its plain words.
- **Fonts on notes and text.** A new **Font** button switches a card between Obsidian's Text, Interface and Monospace fonts, so it follows whatever you've set under Appearance → Font rather than a font this plugin picked for you.
- **"No background" for notes.** A toggle in any note's **Colour** panel strips its fill, border and shadow, leaving the writing free-floating on the canvas. Turning it back on restores the colour you had.

### Fixed
- **Kanban items couldn't be ticked off.** The circle at the left of each item was a working checkbox that never received the click: pressing it started a card drag instead, which swallowed the click before it landed. It also had no hover state at all, so nothing about it suggested it could be pressed — which is why it read as a bullet point rather than a control. Both fixed. Reported by a user; thank you.
- **The kanban tick sat off-centre** in its circle, and further off in the larger item size, which used the same fixed offsets. It's now centred at either size.

### Note on sizes
Per-card text sizes and text colours already existed before this release — on a note's **Size** button and in the formatting popover that appears when you select text. Two people asked for features that were already there, so they clearly weren't findable enough; the README now covers them properly.

## 1.1.19

### Fixed
- **Note text turned unreadable while you were editing it on a light-coloured card.** Card text is coloured to contrast with the card's own background, so a pale sticky gets dark text — but the editor that opens when you start typing sits outside the element carrying that colour, and fell back to your Obsidian theme's text colour instead. Under a dark theme that meant near-white text on a pale note the moment you clicked into it, and the same applied to the "Start typing…" placeholder on an empty one. Both now use the same colour as the finished text, including any text colour you've picked yourself. Thanks to the user who reported this against 1.1.18 with a clear set of steps.

### Removed
- **The board light/dark appearance button** has been taken off the canvas controls. Added in 1.1.14, it let a board pin its own light or dark surface regardless of your Obsidian theme, but having two separate places that changed how a board looked caused more confusion than the flexibility was worth. Boards now follow your Obsidian theme, set in **Settings → Appearance** as usual. If you had pinned a board, it will follow your theme from now on — the pinned value is left in the file rather than stripped out, so nothing is removed from your boards.

## 1.1.18

### Fixed
- The licence stopped being recognised as MIT in 1.1.17. Explaining the Icon Board fork *inside* the LICENSE file broke it: licence detectors match the file against known templates, and any extra prose in the body means it no longer matches. The explanation now lives only in the README's Credits section, and LICENSE is verbatim MIT again — with both copyright notices, which is what the licence actually requires and what detection tolerates.

## 1.1.17

### Changed
- **Credit where it's due.** Visual Notes began as a fork of [Icon Board](https://github.com/RK-Admin-01/obsidian-icon-board) by RK-Media, and that wasn't recorded anywhere. Their copyright notice is now retained in the licence as the MIT terms require, and the README carries a Credits section explaining what was inherited, how the two have diverged, and where to find the original.
- **Documented how the plugin is built.** A new README section states plainly that most of the code is written with AI assistance, and sets out what that means for maintenance: every release tested in a real vault, a test suite that runs on each build, a changelog driven by user reports, and boards stored as ordinary `.canvas` files that stay readable in Obsidian's native Canvas view with or without this plugin installed.

## 1.1.16

### Changed
- The project moved to a new GitHub address after an account rename: https://github.com/dandersondev/visual-notes. Links in the README, the plugin manifest metadata, and the bundled file header now point there. The old address still redirects, so nothing breaks either way.

## 1.1.15

### Fixed
- Bullet list markers could fail to pick up the text size of their own item on a board opened in a separate popout window, which has its own copy of the browser's element types. The two type checks behind this now use Obsidian's cross-window-safe equivalent.

## 1.1.14

### Added
- **Text size, at three levels.** A new **Card text size** setting (Settings → Freeform canvas) scales the text on every card from 100% to 250%, updating any open board live; the plugin's own toolbars and panels deliberately stay put, since scaling those makes the interface unwieldy. Individual Notes can override it from a new **Size** button on the card's floating bar (XS through 4X), and any *selection* of text can be sized on its own from the formatting popover (XS through 5X) — so a single note can carry a big bold heading above ordinary body text. Selection sizes are relative, so they stay proportional when you change either of the other two.
- **Bullet points in Notes.** A **Bullet** button on the card's floating bar turns the line the cursor is on into a bullet — no need to select the text first — and typing `- ` at the start of a line converts it as you go. Enter continues the list, Enter on an empty item leaves it. Bullets take the size of the text they're on, so a large heading gets a large marker.
- **Per-board light/dark appearance.** A new button in the bottom-right controls flips a board's canvas and cards between light and dark independently of your Obsidian theme — so a dark moodboard can live in a light vault. The choice is saved with the board and travels with the file, and the colour swatches offered for cards, stickies and kanban items follow the board rather than the theme. Boards you never toggle keep following Obsidian exactly as before.

### Fixed
- The Note text-size control existed in the file format but had no way to reach it — no button, menu item or command ever set it, so it could only be used by hand-editing the `.canvas` file, and topped out well below a usable heading size.

## 1.1.13

### Changed
- **Back to a clean health report.** Two new warnings appeared, both about the bundled copy of Obsidian's type definitions importing two CodeMirror packages that aren't listed as this plugin's dependencies. They're Obsidian's own — supplied by the app at runtime, and already excluded from the build — so adding them to this plugin's dependency list to satisfy the checker would have claimed a dependency it doesn't have.
  - They're only needed by Obsidian's editor-extension API, which this plugin doesn't use at all. Those definitions are now left out of the bundled copy, and the imports go with them. No dependency was added and nothing this plugin uses was removed, which the build confirms by compiling against both the trimmed copy and Obsidian's real one.
  - A test now fails the build if the bundled copies ever import a package that isn't a declared dependency, so this can't return quietly — including from a future Obsidian release. Verified by reintroducing exactly the reported import and confirming it's caught.

## 1.1.12

### Fixed
- **1.1.11's automated checks failed, so it was never published. This release supersedes it** — everything described under 1.1.11 below is included here.
  - The cause was in the build tooling, not the plugin. The starter boards are stored as `.canvas` files and compiled into the plugin, and the step that does that was copying their line endings through as-is. Line endings depend on the machine a copy of the repository was made on, so the same source produced two slightly different results depending on where it was built — and the check added in 1.1.11 to catch exactly that kind of inconsistency did its job on its own release.
  - Newlines are now normalised when the boards are compiled in, so the result is identical everywhere. The starter boards themselves are unchanged in content; only the invisible line-ending characters inside their text differ, which nothing can see.
  - A test now verifies this directly rather than leaving it to the automated checks, so the problem surfaces on the machine that causes it. Verified by reintroducing the fault and confirming the test catches it.

## 1.1.11

*Superseded by 1.1.12 — this version was never published. Its changes are included there.*

### Added
- **Imported tile JSON is now checked before it replaces anything.** Previously any JSON array was accepted, so a file with the wrong shape would be saved over your existing tiles and only fail later while drawing them, with nothing pointing back to the import as the cause. Each entry is now validated first, and if one is wrong the import is refused with a message naming exactly which entry and which field — nothing is replaced. Import is deliberately all-or-nothing: quietly keeping the valid half would still have thrown away what you had.
- **Your previous tiles are kept when you import.** Replacing is destructive, so the outgoing tiles are now saved in plugin settings under `preImportBackup` first. (This is separate from `legacyBackup`, which holds the one-time copy from the v1 upgrade and is left alone.)

### Fixed
- **Corrupted or hand-edited settings no longer break the plugin.** `data.json` is an ordinary file — it gets synced between devices, edited by hand, and written by older versions — and a bad value in it used to survive loading and then fail somewhere unrelated. Settings are now repaired as they load: invalid values are discarded so the normal default applies, out-of-range numbers are brought back into range, and a single unreadable tile is dropped without taking the rest of your board with it.
- **A clearer message if the Kanban "Create new…" button can't work.** Creating a Kanban board runs a command belonging to the community Kanban plugin, through part of Obsidian not intended for plugins to use. If either changes, that button used to fail silently. It now explains what happened and suggests creating the board from the Kanban plugin directly.

### Changed
- Updated the build tool to clear a security advisory. It only ever affected the local development server, never the released plugin, but there's no reason to carry it.
- Internal safeguards, no visible effect: the release process now runs the test suite before publishing (previously tests and releases could run at the same time, so a failing test couldn't reliably stop a release), and a new test runs all 16 starter boards through a full save-and-reload cycle to confirm every kind of card survives it. That last one is aimed squarely at the class of bug behind the data loss fixed in 1.1.0 — verified by reintroducing it deliberately and confirming the test catches it.

## 1.1.10

### Changed
- **Clears the one warning left after 1.1.9.** The check reported "Promise-returning method provided where a void return was expected" against the bundled copy of Obsidian's type definitions — their `Plugin` class declares `onload()` as possibly returning a Promise, while the `Component` class it builds on declares it plain `void`. That mismatch is in Obsidian's own published definitions, and it's harmless in practice: every plugin with an `async onload()` — which is most of them, this one included — relies on it compiling, and it does.
  - The normalisation now aligns the two: the base method's written type is widened to match what the override already declares. Widening the base changes nothing for any code built on these classes — anything that compiled before still compiles, with the same meaning — whereas the first attempt at this fix went the other way (narrowing the override) and immediately recreated the same warning inside this plugin's own code, where its build caught it before anything shipped. The build also still compiles against Obsidian's real, unmodified definitions as a separate step, so the two can't drift apart unnoticed.
  - A check that runs with the tests re-derives the class relationships from the shipped files independently and fails the build if this pattern ever reappears — including via a future Obsidian release. Verified to catch exactly the reported case when the fix is undone.
  - `main.js` remains byte-for-byte identical to 1.1.7 through 1.1.9. Type definitions are used for checking only; nothing about behaviour changes. Minimum supported Obsidian version remains 1.7.2. **With this, the check reports zero errors and zero warnings.**

## 1.1.9

### Changed
- **Clears the remaining 196 warnings behind the "caution" health rating.** 1.1.8 got the errors to zero, but left 196 warnings — every one of them in the bundled copies of Obsidian's and three other libraries' type definitions, none in this plugin's own code. They were the definitions' authors' own style choices being reported against this plugin: 150 were "unexpected any" on signatures like Obsidian's own `onChange(callback: (value: string) => any)`, and the rest were redundancies like `'woff' | 'woff2' | … | string`, where the `string` already covers the named values.
  - Previous releases copied those definitions exactly as written, on the reasoning that anything else risked them no longer matching. They're now normalised instead: `any` becomes `unknown`, unions drop members that another member already covers, bare `Function` gets a real signature, and interfaces with no members of their own become plain type aliases. **Warnings measured 196 → 0.**
  - Every one of those changes either means exactly the same thing to the compiler or is stricter than what was there before, and that direction is the point: if this plugin's code compiles against the normalised copies, it necessarily compiles against the originals. The build now also compiles against the real installed libraries as a separate step, so a change that altered a meaning could not pass both. Both run in CI on every push.
  - It found one real thing in the process. With `any` narrowed to `unknown`, a type conversion in the settings-loading code turned out to be doing nothing, and it's been removed.
  - `main.js` is byte-for-byte identical to 1.1.7's and 1.1.8's, verified as part of the build. Type definitions are used for checking only and are deliberately kept out of the bundle, so nothing about behaviour can change.
  - Checks that run with the tests now fail the build if any of these patterns reappears — including when a future Obsidian release introduces a new one. The minimum supported Obsidian version remains 1.7.2.

## 1.1.8

### Fixed
- **1.1.7 reported 19 errors in Obsidian's plugin check. This release clears them.** The errors were "uses Obsidian APIs newer than the declared minimum app version", and every one of them was in the bundled copy of Obsidian's type definitions rather than in this plugin's code.
  - The cause: 1.1.5 began bundling the whole of Obsidian's type definitions so the check could see them, and that copy describes the entire Obsidian API — including Bases, which this plugin doesn't use. Bases' definitions are built on a class introduced in Obsidian 1.10, and each of the 19 classes built on it counts as a use of it. So the copy reported itself as using an API newer than the minimum supported version, for a feature the plugin never touches.
  - The fix: the bundled copy now describes only the part of the API the plugin actually uses. The 48 Bases-related definitions are left out, along with the one method that returns them. Nothing the plugin uses was removed, which the build proves by compiling against the trimmed copy.
  - **The minimum supported Obsidian version is unchanged at 1.7.2.** Raising it would also have silenced these errors, and it was the wrong trade — it would buy a clean report by cutting off everyone on an older version, for an API this plugin doesn't call. Obsidian 1.13 in particular is still early access, so requiring it would have made the plugin uninstallable for everyone on the stable release.
  - `main.js` is byte-for-byte identical to 1.1.7's, verified as part of the build. Type definitions are used for checking only and are deliberately kept out of the bundle, so nothing about behaviour can change.
  - A check that runs with the tests now fails the build if the bundled definitions contain any class built on an API newer than the declared minimum version — the exact condition behind these 19 errors. Run against 1.1.7's copy it reproduces all 19, so this can't ship unnoticed again.

### Known issue
- The **caution** rating is expected to remain, and it now looks like it can't be resolved from this end. Around 195 warnings are left, all of them in the bundled third-party definitions and none in this plugin's own code. They're measured, not guessed at: trimming the definitions further to only what the plugin can reach would remove about 20 more, because the rest are in the parts of the Obsidian API the plugin genuinely uses. They can't be silenced — the check keeps a list of rules that may never be silenced, and most of these are on it — and they can't be edited without the copies no longer matching what they mirror. Removing the copies would put roughly 9,500 warnings back into this plugin's own code. None of this affects how the plugin behaves, how safe it is, or whether it installs.

## 1.1.7

### Fixed
- **1.1.6 failed Obsidian's plugin check and would not install. This release fixes that** — please update if you're on 1.1.6.
  - 1.1.6 marked the bundled type definitions as third-party so the check would skip them, using a standard comment for the purpose. The check rejects that comment three separate ways, all as hard errors: it doesn't allow one that covers every rule rather than a named list, it requires such a comment to be explicitly closed again, and — the part that makes this unfixable — it keeps a list of rules that may never be silenced under any circumstances. Most of what needed silencing is on that list. No behaviour changed in 1.1.6 and none changes here; the plugin simply couldn't be installed.
  - The markers are gone, and the bundled definitions are now copied exactly as their authors wrote them. A check that runs with the tests now fails the build for any suppression comment that would trip the same wires, with the never-silence list written down so it can't be rediscovered the hard way.
  - One subtlety worth recording: `@types/sortablejs` ships two suppression comments of its own that would have tripped the same error once 1.1.6's markers were removed. Comments can't affect type information, so they're now stripped from the copies, and the check that compares each copy against its original ignores them on both sides.

### Known issue
- The plugin will likely still show a **caution** rating. Around 200 warnings remain, and every one of them is in the bundled third-party definitions rather than in this plugin's own code — which is now clean. They are the definitions' authors' own style choices, and they cannot be silenced (see above) or edited without the copies no longer matching what they mirror. Removing the copies isn't an option either: that's what put roughly 9,500 warnings into this plugin's own code and earned a *risky* rating in the first place. Nothing here affects how the plugin behaves or how safe it is.

## 1.1.6

### Changed
- **Clears the remaining warnings behind the "caution" health rating.** 1.1.5 fixed the bulk of them by bundling Obsidian's type definitions so the code-safety check has the type information it needs. Two things were left over, both now handled:
  - **The three other libraries the plugin uses** — for drag-and-drop, pen strokes, and board image export — had the same problem 1.1.5 solved for Obsidian: the check couldn't see their type information either, so a handful of ordinary calls in the drag, pen, and export code were still being reported as unsafe. Their definitions are now bundled the same way.
  - **The bundled definitions were themselves being checked**, and reported around 240 warnings about their authors' own style choices — none of which can be changed without the copies no longer matching what they mirror. They are now marked as third-party so the check skips them, and only the files that actually needed marking carry it, since a marker with nothing to suppress counts as a warning of its own.
  - Measured against a reproduction of the check's environment, this takes the plugin from 227 warnings to 2. The last two are `@types/sortablejs`'s own suppression comments, which can't be resolved from here.
  - Nothing about the plugin's behaviour changes. The compiled `main.js` is byte-for-byte identical to 1.1.5's, which is verified as part of the build — the type definitions are used for checking only and are deliberately kept out of the bundle.

## 1.1.5

### Changed
- **Resolves the "risky" health rating.** Obsidian's code-safety check was reporting thousands of "unsafe call" warnings across nearly every file. Those warnings were never real — the check analyses the source without Obsidian's own type definitions available, so every value obtained from the Obsidian API looks untyped to it and every use of one is counted as unsafe. The plugin now carries its own copy of those type definitions and resolves the API from it, so the analysis has the type information it needs whether or not anything is installed alongside. Measured against a faithful reproduction of the check's environment, this takes it from 9,510 warnings to none.
  - Nothing about the plugin's behaviour changes, and nothing in it was ever doing anything unsafe. 1.1.3 attempted this by shipping a lint configuration, which turned out not to be read by the check; this addresses the underlying cause instead.
  - The bundled definitions are Obsidian's own, used under their MIT licence, with the licence included alongside them. They are byte-identical to the version the plugin builds against, and a check that runs with the tests fails the build if the two ever diverge — so the copy can't quietly fall behind and mask a real API change.

## 1.1.4

### Fixed
- **1.1.3 failed Obsidian's plugin check on update. This release fixes that** — please update if you're on 1.1.3.
  - The cause was a single line added in 1.1.3: a comment telling the linter to skip one rule. Obsidian's check requires such comments to state their reason on the comment itself, and 1.1.3 put the explanation on the lines above instead, which counts as no reason at all — a hard error rather than a warning. The code it referred to has been rewritten so no such comment is needed, which is the better fix anyway. No behaviour changed.
  - A check now runs with the tests that fails the build if any lint-suppression comment lacks an inline reason, so this can't ship again.

### Known issue
- The "unsafe call" warnings behind the plugin's health rating are **not** resolved, and 1.1.3's attempt at them did not work. Those warnings are still spurious — they come from the code being analysed without Obsidian's own type definitions available, which makes every value obtained from the Obsidian API look untyped. Nothing in the plugin is doing anything unsafe, and nothing about its behaviour is affected. 1.1.3 added a lint configuration hoping the check would use it; the identical warning list on 1.1.4's predecessor shows it doesn't. Being warnings rather than errors, they affect the rating shown but not whether the plugin installs or updates. Still being looked into.

## 1.1.3

### Changed
- **Addresses the "risky" health rating Obsidian showed for this plugin.** The rating came from a code-safety check reporting thousands of "unsafe call" warnings across nearly every file. Those warnings were not real: the check analysed the source without Obsidian's own type definitions available, so every value obtained from the Obsidian API looked untyped to it, and every use of one was counted as unsafe. The give-away was that the only calls *not* flagged were the handful that never touch the Obsidian API. Nothing about the plugin's behaviour was ever affected, and nothing in it was doing anything unsafe.
  - The plugin now ships its own lint configuration, so a checker no longer has to guess how to analyse the code, and the type definitions are resolved from the project itself. Running the same rules with the types present reports no unsafe calls at all.
  - Linting is now part of the build and runs in CI on every change, so this is verified before each release rather than discovered after one.

### Fixed
- A handful of genuine tidy-ups surfaced while confirming the above, none of them user-visible: three leftover variables that were assigned but never read (including a vestigial flag in the pen tool's straight-line mode), and two functions declared as asynchronous that never actually waited for anything — one of which made the asset-relink scan look like it performed disk reads it never did.

## 1.1.2

### Fixed
- **Two settings were missing entirely on Obsidian 1.13 and above**, with no sign anything was wrong. Obsidian 1.13 changed how plugin settings are built, and these two hadn't been registered for the new way — so on 1.13 they simply weren't there, while on 1.12 and below they showed up normally. Reported by a user who went as far as reading the compiled plugin code to find the cause, having reinstalled twice on the strength of advice that could never have worked. Thank you — that was a genuinely good catch.
  - **"Pan the canvas with"** (added in 1.0.71) is now present on every supported Obsidian version. If you're on 1.13+ and have been unable to find it, it's under Freeform canvas where it always should have been. Your saved choice was being honoured the whole time; only the dropdown to change it was missing.
  - **The version line at the top of the settings tab** is back on 1.13+ too. This is the more annoying of the two, because its whole job is to warn you when an update only half-applied — `manifest.json` updated but `main.js` not — which is exactly the state where features look mysteriously absent. It was invisible on the versions that most needed it, so "check what build you're actually running" wasn't available as a first step.
- Both settings paths are now covered by a test that fails if a setting is ever added to one and not the other, which is how this went unnoticed since 1.0.71. Nothing enforced that the two lists agreed.

## 1.1.1

### Fixed
- **Clicking a YouTube card didn't start the video**, even though hovering it said "Click to play". The only thing that worked was Shift-clicking, and after clicking anything else on the canvas you had to Shift-click again. Reported by a user on Windows 10; it affected every platform.
  - The cause was that the card takes pointer capture when you press it, so it can be dragged. Pointer capture redirects the rest of that press — the click included — at the card itself, so the video's own click handler never heard about it. Shift-click was the sole exception because holding Shift selects the card and stops before capture is taken, which is exactly why that one gesture worked.

### Changed
- **YouTube cards now play and pause with a single click, every time.** Previously the first click after touching anything else was spent "waking up" the video and a second was needed to actually pause it. A click now goes straight to the player, so it responds the same whether you just started the video or come back to it ten minutes later.
  - Dragging a video card from anywhere on it, and zooming the canvas with the scroll wheel over it, both keep working exactly as before — the click no longer has to disable those to reach the player.
  - **To reach YouTube's own controls** — the seek bar, volume, fullscreen — hover the video and use the small button at its top-right. Clicking anywhere outside the card hands the video back to Visual Notes so it's draggable again; playback carries on regardless.
  - Playback keeps running when you click away, click other cards, or pan around the board.

## 1.1.0

### Fixed
- **Boards could be permanently emptied by opening them normally from the file explorer.** Obsidian's built-in Canvas view rebuilds a `.canvas` file from its own model whenever it saves, and that model has no room for the board-level data Visual Notes stores alongside the cards. Because Obsidian's Canvas — not Visual Notes — is what opens a `.canvas` file first, anything that made it save in that split second wiped that data. The board then stopped being recognised as a Visual Notes board at all: it opened as a plain canvas from then on, and the menu option to switch back refused it with "This canvas wasn't created by Visual Notes" — even though every card was still sitting in the file untouched. Kanban boards, to-do lists, sticky notes and note cards all appeared to be gone for good; connections were unaffected, which is what made the cause hard to spot. This was most likely to happen with other canvas plugins installed (Advanced Canvas and similar patch the built-in Canvas view and save as soon as a file loads), but the plugin's own "Toggle native Canvas view" command could trigger it too.
  - A board in this state is now recognised and repaired automatically the next time you open it — the cards and layout come back, and the file is re-marked so it can't degrade further.
  - Anything stored only at board level — the saved viewport position, free-floating pen drawings, and archived cards — cannot be recovered once the built-in Canvas view has overwritten it. A copy of the damaged file is saved next to the board as `<board>.canvas.native-backup.bak` so those are still retrievable by hand.
  - Kanban items are no longer deleted when their board loses its card data. They're preserved untouched instead, matching how the plugin already treats any other content it doesn't recognise.
  - "Toggle native Canvas view" now takes a backup first and explains what editing over there costs.
- Note this makes the damage recoverable rather than impossible: the built-in Canvas view still discards board-level data when it saves, so it's best not to edit a Visual Notes board there.

### Changed
- **Internal rename, with one thing to watch.** The plugin stored its data in `.canvas` files under a key named `ib`, left over from the plugin's original name before it became Visual Notes. That key is now `vn`, and the matching `ib-` prefix on the plugin's CSS class names and theme variables is now `visual-notes-`.
  - **Existing boards are safe and need no action.** The old key is still read, permanently — boards created by any earlier version open exactly as before and quietly move to the new key the first time you save them.
  - **If you have a CSS snippet or theme targeting Visual Notes**, anything referring to `--ib-…` variables or `.ib-…` classes needs updating to the `--visual-notes-…` / `.visual-notes-…` equivalents. Everything else is internal and invisible.
  - **Downgrading below 1.1.0 is not supported** for a board that has been saved by this version: an older build won't recognise the new key and will treat the board as a plain canvas.

## 1.0.75

### Added
- **Group frames now support an explicit background color, independent of the border/label color.** Open a group's context menu and use the new "Color" button: the Background tab picks a solid fill from the same pastel palette as sticky notes, and a "Transparent" switch toggles between that fill (shown at full color, or faded like before) and the original see-through tint. The Border tab still sets the accent used for the frame's border and label chip, matching the previous single-color behavior.

## 1.0.74

### Changed
- Internal code cleanup with no change to how the plugin behaves: removed two redundant type assertions that the plugin review tooling flagged in 1.0.73. They were compile-time only, so apart from the version stamp the compiled output is identical to 1.0.73 — there's nothing to notice, and no need to update if 1.0.73 is working for you.

## 1.0.73

### Added
- **The settings tab now shows which build is actually running**, as a small "Visual Notes v…" line at the top. If that version ever disagrees with what Obsidian thinks is installed, it turns into a warning explaining what happened and how to fix it. This catches a genuinely confusing failure: an update that replaces the small `manifest.json` but not the ~1 MB `main.js`, leaving Obsidian reporting the new version while still running the old code — so newly-added features are silently absent even though the version number says they should be there. Previously the only way to spot this was to open `main.js` in a text editor and read its first line.

## 1.0.72

### Added
- **Connection ports along card edges** — a connection no longer has to meet a card at whatever point happens to face the other end. Each edge now offers a row of pins (1, 3, 5, or 7 of them, more on a longer edge), and a connection dropped onto one stays locked to that exact point as the cards move around, the way pins work in a node graph. Drag out from any pin: the line snaps onto a target pin as you pass over it and that pin swells green, so there's no guessing where a release will land. Dropping anywhere else on a card still leaves that end free to slide around the edge, exactly as before.
- **Re-aim a connection that's already drawn** — select it and drag either endpoint onto a different pin, or onto a different card entirely. Endpoint handles are filled when pinned and hollow when free-sliding, and **double-clicking** a pinned one releases it back to the automatic behaviour (the same gesture that resets a curve's bend handle).
- **Two cards can be joined more than once**, as long as the new line lands on a different pair of pins — previously a second connection between the same pair was silently discarded.
- Ports reveal themselves progressively, so a card doesn't turn into a field of dots: hovering shows only the four edge midpoints (exactly the handles a card had before this existed), moving toward an edge fades in that edge's full row, and every pin on every card only appears while you're actually dragging a connection. The extra pins are drawn smaller and dimmer than the midpoints, and brighten as you point at one.
- Pinning is entirely optional — every connection made before this update keeps its original behaviour, untouched.

### Changed
- Pinned ends are stored using the JSON Canvas spec's own `fromSide`/`toSide` fields, so a pinned connection still leaves and enters the right edge in Obsidian's native Canvas or any other canvas-compatible tool. It works in the other direction too: a connection drawn in one of those tools arrives here already pinned to the side its author chose.

### Fixed
- Card connection handles used to swallow clicks even while they were invisible, so a drag that started near a card's edge could be quietly captured by a handle you couldn't see instead of moving the card.

## 1.0.71

### Added
- **Choice of mouse button for panning the canvas** — a new "Pan the canvas with" setting lets you pick middle-click (the previous default, unchanged), right-click, or either, for anyone who finds a middle-click physically awkward or whose mouse doesn't have one. Space + left-click still pans no matter which you choose. When right-click is selected, a drag that actually pans the canvas no longer pops the right-click context menu on release — a plain right-click with no drag still opens it as before.
- New starter template: **D&D Campaign Atlas**.

## 1.0.70

### Added
- **Calendar card: jump to a month/year directly** — click the month/year label to swap it for a native month picker: type the month and year straight in, or use its built-in calendar-icon dropdown to pick one. No more clicking Previous hundreds of times to reach a date years away.
- **Calendar card: lock the displayed month/year** — the new lock icon in the calendar's header freezes Previous/Today/Next and the month/year jump so an accidental click can't shift you off a date you navigated to deliberately. Unlock any time from the same icon.
- **Calendar** was missing from the canvas right-click "Add" menu (Organize section) — it was only reachable from the toolbar. Added there too.

## 1.0.69

### Added
- **Copy, cut, and paste card groups** with **⌘/Ctrl C**, **⌘/Ctrl X**, and **⌘/Ctrl V**. A copy takes the whole selection as one unit: the cards, the connections drawn between them, and any selected pen/highlighter sketches. Selecting a group frame brings the cards inside it along, matching what dragging that frame already does. Paste lands centred on the pointer, and works across boards and across Obsidian windows — everything gets fresh ids, so pasting onto the board you copied from is safe. Also available from the right-click menu on cards, sketches, and the canvas.
- **Group templates**: save any cluster of cards as your own reusable build. Select the cards, right-click → **Create template…**, name it — then right-click anywhere on the canvas, choose **Templates**, and pick it to drop a fresh copy at that spot. Anything can be templated: a styled header row, a meeting-notes layout, a connected diagram, a set of kanban columns. Templates are normalized to their own origin, so where they were on the board you saved them from doesn't matter.
- Group templates are stored as plain `.canvas` files in `_Templates/Groups/`, so they can be inspected, edited as a board, renamed, or deleted from the file explorer like anything else in the vault. Saving over an existing name asks first, and they're kept out of the whole-board **New board from template** picker.

## 1.0.68

### Added
- **Undo/redo buttons**: two small icon buttons now sit directly above the trash zone (bottom-left, always visible), so undo/redo has an on-screen affordance instead of being Cmd/Ctrl+Z only. Covers everything the keyboard shortcut already did, including pen/highlighter strokes — useful on iPad, where drawing with Apple Pencil usually means there's no keyboard in reach to undo a stroke. Each button greys out automatically when there's nothing left to undo/redo.

## 1.0.67

### Changed
- The card context bar (Edit/Color/Delete, etc.) now floats directly above the selected card on desktop/iPad instead of taking over the fixed toolbar's slot — it tracks live while you drag, resize, or pan/zoom the canvas, flips below the card if there's no room above, and steers clear of the trash zone. Phone keeps its original bottom-docked bar unchanged.
- The context bar is now compact and icon-only, matching native Obsidian Canvas's selection toolbar — hover for a tooltip instead of a text label underneath each icon.
- Color swatches now lay out as a proper grid box instead of a single tall column.

## 1.0.66

### Added
- **Pen Options panel**: a new gear icon in the Pen picker opens a draggable panel exposing perfect-freehand's own tuning controls — Size, Thinning, Streamline, Smoothing, Easing, Taper Start/Cap Start, Taper End/Cap End, plus a Reset button. Changes apply live to every stroke on the board (old and new) and are saved with plugin settings, so they persist across reloads.

### Fixed
- The pen "Drawing — hold Shift for straight lines" tooltip banner overlapped the toolbar when the toolbar position was set to Top; it now sits below the toolbar in that layout.
- Pen thickness now defaults to Medium instead of an in-between value that didn't match any of the Thin/Medium/Thick picker options.

## 1.0.65

### Changed
- Reverted the 1.0.61–1.0.64 Pencil-stroke changes (pointercancel committing partial strokes, coalesced-sample reading, single-sample dot rendering, and the interrupted-stroke resume/stitch mechanism) back to 1.0.60's simpler behavior. Each of those fixes addressed a real, confirmed defect, but together they introduced new rendering artifacts (fragmented dots, then beaded/jagged lines) without fully resolving the underlying issue, so this rolls back to the last known-stable baseline. The 1.0.60 pointerType-scoped touch/Pencil fixes and the iPadOS Scribble documentation (the actual root cause of the original vanishing-stroke reports) are both kept.

## 1.0.64

### Fixed
- iPad: fast Pencil strokes could still come out looking beaded/jagged instead of one smooth line — the 1.0.63 fix that resumes a stroke interrupted mid-letter used one fixed reconnect distance, which a fast stroke could easily outrun during even a brief WebKit hiccup, so most of those interruptions were narrowly failing to reconnect and rendering as a chain of short, independently round-capped segments instead. The allowed reconnect distance now scales with how long the interruption actually lasted.

## 1.0.63

### Fixed
- iPad: continuous Pencil handwriting could still come apart into several disconnected fragments (rendered as stray dots since 1.0.62, silently dropped before that) — WebKit can drop and reacquire Pencil contact mid-letter. A stroke that gets interrupted (rather than deliberately lifted) now resumes as one continuous stroke if the next touch lands soon after and close to where it left off; a genuine, deliberate release still ends its own separate mark.
- Pen mode's `touch-action: none` (see 1.0.60) now also applies to every element inside the canvas, not just the background, so it takes effect for strokes starting over a card too.

### Docs
- README: noted that iPadOS Scribble can intercept fast, small Pencil strokes before the canvas ever sees them, and that turning it off (Settings → Apple Pencil → Scribble) resolves it — a system-level behavior no web-based app can override.

## 1.0.62

### Fixed
- iPad: fast, small Pencil strokes (a quick cursive "s" or "e") could still vanish entirely — most of their real samples were likely getting bundled into the browser's coalesced-event list rather than dispatched as their own pointermove, so only reading each event's own final position under-sampled exactly those strokes, sometimes down to too little data to keep. Every coalesced sample is now read, and a Pencil stroke that still ends up with just one sample renders as a small dot instead of being silently dropped.

## 1.0.61

### Fixed
- iPad: a Pencil stroke could still be silently lost if WebKit cancelled its tracking mid-stroke (pointercancel) rather than ending it normally — the whole stroke was discarded outright, same as when a finger gesture genuinely takes over. Pencil (and mouse) strokes now commit whatever was drawn up to that point instead of throwing it away; finger strokes still discard on cancel, since that's a real gesture handoff. The canvas also captures the pointer at stroke start so move/release events keep reaching it reliably wherever the contact strays.

## 1.0.60

### Fixed
- iPad: Apple Pencil strokes could still be silently discarded with no palm, finger, or other touch involved at all — 1.0.59 scoped the pinch-protection touch-count check to finger input, but missed that the adjacent `isPrimary` check on the same line was still unconditional. WebKit's own hover/touch bookkeeping around the Pencil's lift-and-retouch transition could hand a stroke a false `isPrimary` with nothing else touching the screen, and that alone was enough to drop it. Both checks are now scoped to finger input.

## 1.0.59

### Fixed
- iPad: Apple Pencil strokes could be silently discarded — refused to start, or cancelled mid-stroke — whenever a resting palm or supporting finger counted as a second touch. The pinch-zoom guard that cancels a stroke on a second finger only makes sense for finger-drawn strokes; it's now scoped to touch input only, so normal handwriting posture with the Pencil no longer trips it.
- iPad: drawing could feel like it paused for a beat before the stroke actually appeared — the canvas had no `touch-action` set, so WebKit briefly held each touch/Pencil-down to decide whether it might be the start of a scroll or pinch before committing it to the page. Pen mode already handles pinch detection itself, so it now opts out of that native gesture recognition entirely while active.
- A saved "default sticky color" picked under one theme stayed stuck at that exact color even after switching theme, since it's stored as a literal hex — new sticky notes (and kanban items falling back to it) could end up jarringly bright on a dark canvas. It now re-resolves to the equivalent swatch in whichever theme is currently active.

## 1.0.58

### Changed
- Card background color pickers (recolor a card, kanban item labels, default sticky color) now offer a muted, dark-friendly palette when your theme is dark, instead of the same washed-out pastels used in light mode. Line, accent, and pen ink colors are unchanged — they were already vivid enough to work in both themes.

## 1.0.57

### Fixed
- iPad: the Pen tool could still go unresponsive on the second stroke with Apple Pencil specifically (finger was unaffected) — Apple Pencil is tracked as one persistent hoverable device and reuses the same pointer ID across separate taps, unlike a finger touch, which always gets a fresh one. If a stroke's own release event was ever missed, its listeners stayed attached and silently absorbed the next stroke's input instead of letting it start cleanly. A new stroke now force-closes any previous one still waiting on its release before it begins.

## 1.0.56

### Fixed
- iPad: drawing a second pen stroke quickly after the first could come out corrupted — the stroke's move/release listeners didn't filter by which touch/pencil contact actually started them, so a palm-rejection contact, a stray second touch, or the next stroke's own pointer starting before the previous one's listeners finished detaching could all feed the wrong coordinates into the wrong stroke. Now filtered to the exact pointer that started each stroke, matching how every other drag gesture in the plugin already works.

## 1.0.55

### Fixed
- Undo/redo, delete, select-all, duplicate, group, and Escape-to-clear-selection went silent after clicking any toolbar or pen-picker button, until you clicked back into empty canvas space first — those shortcuts only listened while the canvas element itself had focus, but the toolbar/picker are separate elements next to it, not inside it. They now work anywhere focus lands within the board.
- The canvas, cards, and pen ink color now genuinely follow your active Obsidian theme (built-in or community, light or dark) instead of switching between two fixed hardcoded palettes — including updating live if you switch theme without reloading the board.

## 1.0.54

### Fixed
- iPad: cards (sticky notes, etc.) could still flicker or vanish on the canvas despite the 1.0.48 Safari fix — confirmed on-device that `Platform.isSafari` doesn't actually fire inside Obsidian's iPadOS app, so the workaround never applied. Now also triggers under `Platform.isIosApp`, which reliably covers it.

### Docs
- README: documented the template system (15 bundled starter templates, save-your-own), the pressure-sensitive pen/eraser/multi-select drawing tools, and the edge-to-edge canvas layout — none of which were previously mentioned.

## 1.0.53

### Fixed
- Pen strokes rendered as a thin, sterile tapered bar instead of a natural handwritten line — most noticeable on straight-ish strokes like "I" or "T". A leftover auto-straighten step from the old renderer was snapping any stroke over 40px with low wobble down to just its two endpoints before the pressure-tapered outline ever saw it, discarding all the hand-drawn detail and pressure samples in between. Removed; Shift-drag still gives a deliberate straight line.
- Very short pen strokes/dots (a quick tap or flick) could render as a near-invisible hairline instead of a proper mark — perfect-freehand's tip-taper becomes unstable once the taper distance approaches the stroke's own length. Short strokes now get a plain full-width round cap instead of a taper.

## 1.0.52

### Fixed
- Moving or resizing a pen stroke stripped its stylus pressure data, so the pressure-tapered outline reverted to a uniform/simulated shape as soon as you dragged or resized it. Drag and resize now carry each point's pressure through unchanged.
- Internal: use `window.requestAnimationFrame`/`window.cancelAnimationFrame` (not the bare global) for the pen tool's live-stroke redraw batching, for popout-window compatibility. No behavior change.

## 1.0.51

### Fixed
- iPad: the Pen tool could go unresponsive for about a second after finishing a stroke — iOS ends an interrupted touch (palm rejection, a pinch starting, etc.) with a different signal than a normal release, which the plugin wasn't listening for, so the finished stroke's internal listeners stayed attached and fought the next one.
- iPad: drawing while pinch-zooming — a second finger landing mid-stroke now cancels the stroke instead of drawing a stray line, and a new stroke can no longer start from a non-primary touch.
- iPad/stylus: strokes drawn with pressure could show a fat dot at the start and/or end — pressing down before moving (or lifting while still pressing) produced a full-width round cap; stroke tips now taper in properly instead.
- Live pen strokes could visibly lag on high-frequency (120Hz) stylus input — the in-progress line was fully recomputed on every single pointer sample; it's now redrawn at most once per animation frame.
- "Done (Enter)" in the Pen tool banner stopped responding to the Enter key after clicking any pen-picker control (color, width, instrument) — focus had moved off the canvas, which was the only place listening for it. Enter/Escape now exit the Pen tool no matter what has focus.
- The eraser could only remove a straight or near-straight line by touching its endpoints — a straight segment is stored as just its two endpoints, and the eraser was only checking distance to stored points, not the line between them. It now detects the eraser's movement crossing the actual segment, so scrubbing through the middle of a line erases it.

## 1.0.50

### Changed
- Pen strokes are now rendered with [perfect-freehand](https://github.com/steveruizok/perfect-freehand) (MIT license, © Steve Ruiz): pressure from a stylus/tablet now tapers and varies the width of a stroke instead of every line being a uniform thickness. Mouse input gets a simulated taper based on drawing speed.

### Fixed
- The Pen tool's stroke-grouping (which strokes drawn together count as one sketch for select/move/delete) compared a new stroke's start point against the current sketch's bounding *rectangle* rather than the actual drawn line — so a new stroke starting anywhere inside a large or diagonal shape (a big circle, a corner-to-corner line) could get swept into that group even though it was nowhere near the real ink. Now checks true distance to the drawn points themselves.

## 1.0.49

### Changed
- The canvas now fills the entire pane edge-to-edge, matching Obsidian's native Canvas — removed the wasted padding/border Obsidian's default view pane was adding on all sides, and turned the board-name header into a small floating pill in the top-left corner (over the canvas) instead of a full-width bar reserving space at the top.
- Moved "Save as template" out of the top bar and into the toolbar's "···" menu and the Command Palette ("Save current board as template"), since the header no longer has room to spare.
- Toolbar, zoom control, minimap, search, and filter now sit closer to the screen edges (16px instead of 24px).

### Fixed
- The Pen tool's size/color picker could overlap the trash icon on smaller or lower-resolution screens (e.g. 1920×1080 at 100% scaling) — it now positions itself relative to the available canvas space and flips away from the trash zone if they'd collide.

## 1.0.48

### Fixed
- Notes, sticky notes, and other cards flickering or disappearing entirely on iPad — Safari has known bugs tracking `content-visibility: auto` (an off-screen-card rendering optimization) through the pan/zoom transform on the canvas, which could make it wrongly treat an on-screen card as skipped. Turned off for Safari (incl. the iPad/iOS app) specifically; unaffected elsewhere.

## 1.0.47

### Fixed
- Undo/redo (Ctrl+Z / Ctrl+Shift+Z) now works for the Pen tool — drawing, erasing, dragging, resizing, and recoloring a stroke or sketch can all be undone. Previously undo only ever tracked cards and connections, so pen/highlighter changes were silently never undoable no matter what you'd just done.

## 1.0.46

### Changed
- Internal: replaced two `.flatMap(id => this.groupStrokes(id))` calls in the drawing multi-select code with plain loops (plugin-review compliance — 1.0.45's explicit typing cleared most of the reported ESLint warnings but the review site's checker still flagged these two calls themselves as unsafe). No behaviour change.

## 1.0.45

### Changed
- Internal: added explicit types around the new drawing multi-select code (plugin-review compliance — cleared a batch of `@typescript-eslint/no-unsafe-*` warnings). No behaviour change.

## 1.0.44

### Fixed
- Box-select (drag a rubber-band rectangle) and Shift/Ctrl-click multi-select now work on pen and highlighter strokes, same as they already did for cards — previously a click always replaced whatever drawing was selected, and the box-select marquee ignored drawings entirely.
- Drawing several separate doodles without turning the Pen tool off in between no longer welds them into one giant selectable/movable group — a new stroke only joins the current sketch if it actually starts near it; one drawn somewhere else on the canvas now gets its own group automatically.

## 1.0.43

### Fixed
- Kanban, column, and kanban-board headers/titles used a hardcoded serif font regardless of your configured font, and cards showed Obsidian's Interface font instead of your Text font everywhere else — both now follow Appearance → Font like the rest of the app.
- A kanban board's "Add item", "Add column", and "Remove column" buttons (and the collapse/column-options buttons) could silently do nothing when clicked — a card-drag handler was suppressing the click for any press outside the title text. Fixed for every affected button.
- Double-clicking to rename a kanban card, kanban board, or column now works from anywhere in the header (not just the exact title text, including the small "Untitled" placeholder) — same underlying cause as above. Also added a "…" menu to every kanban card, kanban board, and column with a Rename option that doesn't depend on double-click at all.
- The lock/collapse/"…" buttons in kanban and column headers were invisible outside a hover state that silently never applied to columns or a board's own title bar, making them impossible to find. Now always visible.
- A long kanban/column/board title could visually run underneath the lock icon.

### Changed
- Column and kanban-board-column backgrounds now use Obsidian's theme color instead of a hardcoded gray.

## 1.0.42

### Fixed
- The canvas background and grid dots stayed their light-mode colors even in a dark theme, unless you'd manually set a custom color in Settings — same underlying cause as the note/sticky/pen readability fixes in 1.0.41 (a hardcoded default with no dark-theme variant). Now uses Obsidian's own theme colors so it matches your actual theme, including non-standard ones, rather than a generic dark gray.

## 1.0.41

### Fixed
- Notes and sticky notes now auto-contrast their text against their own background color, instead of using a single app-wide text color regardless of the card's actual color — this was the cause of white-on-white notes and barely-readable text on the default pastel sticky colors.
- Blank Notes now default to a theme-following background instead of a hardcoded near-white color, so they no longer look washed out on a dark theme.
- The Pen tool's default ink color now follows your theme (light ink on dark, dark ink on light) instead of one fixed dark color that could blend into a dark canvas.

### Changed
- Internal: the Settings page's sticky-color palette now shares its color list with the in-canvas picker instead of keeping its own separate copy, so the two can't drift out of sync.

## 1.0.40

### Fixed
- CSS build warning: a duplicate `transform` declaration in the phone context-bar rule (introduced in 1.0.39).
- The mobile "+" button overlapped the minimap/zoom/snap controls, and both overlapped the bottom context bar when a card was selected. The minimap/zoom/snap stack now shifts to whichever bottom corner the "+" button isn't using, and hides outright while the context bar is showing (it becomes a full-width bar that would otherwise sit on top of them either way).

### Added
- Canvas navigation on touch devices: pan with one finger, pinch with two to zoom — previously one finger only rubber-band-selected, with no way to pan without a mouse.
- Settings → Freeform canvas → "Mobile '+' button position": choose which corner (bottom right/left, top right/left) the phone add-card button sits in, in case the default still overlaps something on your device.

## 1.0.39

### Fixed
- Major mobile/touch UX overhaul, aimed at iPhone in particular (iPad was largely fine already):
  - The rich-text formatting popover no longer appears on phones at all — it had no phone-specific sizing or positioning and was very likely the cause of editing taking over the whole screen with a large white popup. It's unaffected on iPad/desktop.
  - Long-press now opens a proper bottom action sheet with your card's actions, instead of feeding a synthetic touch event into a desktop-style context menu — the likely reason menus weren't appearing at all on iPhone.
  - The bottom toolbar no longer crams 9+ tool buttons into a tiny horizontally-scrolling strip on phone widths. It now collapses to a single "+" button (bottom-right, thumb-reachable); tapping it opens a full labeled tool sheet.
  - Bottom-anchored UI now avoids the iPhone's home-indicator safe area, and shifts up out of the way of the on-screen keyboard while you're editing.

### Added
- Sticky notes, callouts, group labels, calendar titles, and column titles can now be edited with a single tap: select the card, then tap "Edit"/"Rename"/"Title" in the bottom bar — no more relying on double-tap, which is unreliable on touch. Kanban items open their editor on a single tap on phones too.

## 1.0.38

### Fixed
- A tile could link to the board it lives on, creating a "dead end" tile that appeared to do nothing when clicked — most likely to happen in a fresh vault, where the current board was often the only entry in the target picker. The picker now excludes the current board, saving a self-linked tile is refused with an explanation, and clicking an already-saved self-linked tile (from before this fix) now explains the problem instead of silently doing nothing.

### Changed
- The New Board dialog now labels the two layouts "Canvas" and "Tile grid" (previously "Freeform"/"Grid") with clearer descriptions, and defaults to Canvas — the grid default was contributing to users ending up with a tile-launcher page when they expected a canvas.
- Every open board now shows a small "Canvas" or "Tile grid" badge next to its name in the header, since the two look identical otherwise (same file extension, same icon).

## 1.0.37

### Changed
- Internal: board export now creates its download-trigger/canvas elements via Obsidian's `createEl` helper instead of `document.createElement`, and uses `window.setTimeout` for popout-window compatibility (plugin-review compliance). No behaviour change.

## 1.0.36

### Added
- Export the board as a PNG or PDF — right-click empty canvas space and choose "Export as PNG…" or "Export as PDF…". Captures the whole board (not just the current view), including connections and pen drawings. Known limitation: bookmark/map cards with live embeds export as an empty gap rather than a thumbnail.

## 1.0.35

### Fixed
- Picking a "Top strip" color for a Note had no visible effect (bug #8) — the note's background fill layer sat in its own stacking context that always painted above the strip, regardless of DOM order. The strip is now visible as soon as you pick a color.

### Added
- Notes now get the same selection-triggered formatting popup as checklist/kanban item text (Bold/Italic/Underline/Strikethrough plus, new, a font Color and Highlight option) — select some text in a Note to see it (bug #8).

## 1.0.34

### Fixed
- Comments stayed visually faded (0.6 opacity) even after un-marking them "Resolved" (bug #9) — the resolved styling was applied with a one-way toggle that added the class but never removed it. Un-resolving a comment now restores full opacity immediately.

## 1.0.33

### Fixed
- Deleting a selected card left the floating format bar (Bold/Italic/etc.) showing stale options for the just-deleted card until you clicked the canvas (bug #5) — the delete action cleared the selection but skipped the refresh step that tells the bar to hide, unlike Archive/Duplicate. The bar now resets immediately.

## 1.0.32

### Fixed
- Removed the "Oval" shape option from a blank Note card's right-click menu — it was a dead duplicate of "Circle" (both set the exact same underlying shape), and only Oval showed a checkmark for it, so neither item reflected the current shape correctly. Circle now shows the checkmark itself.

## 1.0.31

### Fixed
- Connection arrowheads no longer let the line's shaft poke out past the tip (bug #6). Arrowheads are now drawn as directly-computed triangles anchored to the connection's true endpoint, and the visible line is trimmed to an exact sub-segment of the true path so it stops cleanly at the arrowhead's base — for straight, bent, and elbow-routed connections alike. (An interim build had a regression on bent connections where the trimmed line could visibly separate from the selection outline and made clicking the middle of a hard bend unreliable; that's fixed here too.)

## 1.0.30

### Fixed
- Checklist checkbox: fixed a double checkmark caused by the plugin forcing native OS checkbox rendering on top of Obsidian's own theme-drawn checkmark (bug #4) — visible on themes where the two didn't happen to match colour. Also centred the checkmark within the box.

## 1.0.29

### Fixed
- Multiple toolbar tools (e.g. Pen and Line, or Pen and a placement tool like Column) could show as selected at the same time, with the earlier one stuck active underneath the new one (thanks for the bug report!). Activating any tool now correctly exits the other two first, so only one is ever highlighted.

## 1.0.28

### Fixed
- Dragging a card, releasing the mouse just off the card without moving far enough to count as a real drag, and later just hovering back over it could start moving the card again with no button held ("stuck" drag). Pointer capture is now acquired immediately on press (matching every other drag/resize in the app) instead of only after the drag threshold was crossed, so a release is always delivered correctly no matter where the cursor ends up.

## 1.0.27

### Changed
- Internal: the overflow menu's positioning now uses Obsidian's `setCssStyles` API (plugin-review compliance). No behaviour change.

## 1.0.26

### Fixed
- The toolbar's "…" overflow menu could be cut off at the screen edge on smaller windows, leaving items unreachable (thanks to the first community bug report! 🎉). The menu now repositions itself to stay fully on screen for every toolbar position, and scrolls internally when the window is shorter than the menu.

## 1.0.25

### Fixed
- Restored compatibility with Obsidian 1.12 and earlier — versions 1.0.20–1.0.24 required a not-yet-released Obsidian 1.13 and could not be installed; the settings tab also rendered blank on 1.12. Minimum Obsidian version is back to 1.7.2.

## 1.0.24

### Added
- Image cards can now be created **from a web URL** (alongside vault and disk upload) — the image is hot-linked, nothing is stored in the vault.

## 1.0.23

### Fixed
- Group frame names were clipped by the frame's top edge; the name tab now renders fully visible straddling the border.

## 1.0.22

### Added
- New starter template: **Creative Studio Hub** — a film-production kanban, animation reference corner, and study desk showcasing every card type.

## 1.0.21

### Added
- New starter template: **Project Ideas** — a Milanote-style creative project moodboard.

## 1.0.12

### Added
- Right-click a checklist task to **delete** it.

## 1.0.11

### Added
- Checklist subtasks can now be created by **right-click → Make subtask** or by **dragging a task to the right** over its new parent, alongside the existing Tab / Shift+Tab shortcut.

## 1.0.1 – 1.0.19

- Plugin-review compliance work: Obsidian API modernisation (createEl helpers, setCssStyles, popout-window-safe timers, declarative settings), CSS compatibility fixes, release workflow with auto-generated notes, and the "Starfleet Technical Manual" starter template rework.

## 1.0.0

- Initial release.
