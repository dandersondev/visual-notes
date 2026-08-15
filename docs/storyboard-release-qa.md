# Storyboard release QA

Complete this checklist on desktop and on a physical iPad before bumping the release version. Automated tests cover persistence and event cleanup; they do not substitute for real Pencil, touch, export, and modal behavior.

## Create and persist

- Add a Storyboard from the toolbar, slash menu, and canvas context menu.
- Rename it, close without editing, and confirm an unchanged board is not rewritten.
- Add, duplicate, reorder, delete, and move shots between scene sections; reopen the vault and confirm the order and content persist.
- Open the Screenwriting template and confirm its four-shot example survives two save/reload cycles.

## Images and annotations

- Pick one background image, then import a folder containing numbered images and confirm natural filename order and one shot per image.
- Draw with mouse and Apple Pencil, including pressure changes, fast strokes, palm contact, and interruption by Control Center/app switching.
- Confirm an interrupted gesture stops drawing and a later hover/touch does not resume it.
- Select, move, resize, recolour, copy/paste, erase, and Delete/Backspace text, arrows, and ink.
- Edit text from the inspector and directly on the frame; verify Undo/Redo treats each gesture as one action.
- Enable onion skinning on the first and later shots; verify the prior shot appears only on later shots and never captures input.

## Playback and exports

- Mix aspect ratios and durations, including zero; verify the displayed total and playback order/timing.
- Export the Markdown shot list and inspect headings, metadata, notes, and total duration.
- Export a PNG contact sheet and verify images, ink, text, arrows, headings, shot notes, safe filename, success notice, and cleanup after success and a forced failure.

## iPad interaction

- Test portrait and landscape; switch among the Scenes, Stage and Shot drawers; verify touch scrolling in the section list, inspector, brush bar and filmstrip; then test Pencil drawing and finger selection.
- With canvas pen mode active, open the Storyboard and press Escape from a hardware keyboard; confirm the modal closes normally.
- Background the app during an active Pencil stroke, return, and confirm there are no stuck listeners or continuing ink.
- Confirm toolbar controls remain reachable at the supported viewport sizes and that the Obsidian sidebar gesture still works from the screen edge.

## Performance fixture

- Run `npm run generate-benchmarks`, copy `benchmarks/Storyboard 40.canvas` and forty test images named `frame-01.jpg` through `frame-40.jpg` into a vault folder named `Benchmark Assets`.
- Record file-open time, focused-editor open time, drawing latency, onion-skin redraw, save time and contact-sheet export time in desktop DevTools.
- Repeat drawing, onion skin and save checks on iPad; confirm the 40-shot filmstrip and grid remain responsive.
