# Audit phase 10 — the map

2026-10-03, `main` at 5842b8c. The canvas: how the tree is laid out and
opened, what a card says, how you find and reach an experiment, and how the
map holds up as projects grow. Looked at in Chromium with a fixture project
holding every state a card can be in (`ui-fixture.mjs`). The earlier UI audit
(13 September, F01–F38) was checked against the current build rather than
repeated.

Files: `canvas/Canvas.tsx`, `canvas/NodeCard.tsx`, `canvas/useLaidOutNodes.ts`,
`canvas/layout.ts`, `canvas/zoom.ts`, `canvas/MenuBar.tsx`,
`canvas/CanvasNotices.tsx`, `nodeStatus.tsx`, `state/RunControls.tsx`,
`styles/canvas.css`, `styles/primitives.css`.

## How it works

The tree is laid out top to bottom by dagre; a card you drag keeps its
position until you choose *Automatic position*. A card is its name, a
coloured status dot, its description, its state as a word, and *Review +N*
when it has changes. Detail thins as you zoom out: the full card down to 55%,
then name and dot, then below 28% a dot alone. Opening a project fits the
whole tree (at most 100%, at least 25%). Selecting a card opens it in the
panel and pans just enough to show it. Status words and dots cover not
started, running, waiting, queued, needs you, finished, stopped, failed;
marks show frozen, archived and behind.

## Findings

### M1 · High · verified — Nothing tells you an experiment is waiting for you

When the agent asks a question, its run stops until you answer, with no time
limit, holding one of the three run slots (phase 8, I3). With an experiment in
that state:

- the tab's title stayed "Bonsai" and its icon did not change;
- nothing appeared over the map or in the panel of the experiment being read;
- the only sign was the card's status dot — 6 px, in the same purple as the
  selection and the app's accent — and the word "Needs you" in the same grey
  pill as "Finished" and "Not started";
- at the zoom the map opens at (below), that dot is about 2 px.

The same is true of a run finishing or failing while you are in your editor,
which is where people are while an agent works. The whole loop — start
something, do other work, come back when it needs you — depends on being told.

**Fix (S–M).**

- The tab title counts what is waiting: "(1) Needs you · Bonsai", and the
  favicon gets a dot.
- A strip over the map lists experiments that need you, each a link —
  visible whichever experiment is open.
- Optionally, a system notification when a question arrives or a run ends
  while the window is in the background (the browser asks permission once).
- On the card, give *Needs you* and *Failed* their colour in the pill, not
  only in the dot.

### M2 · Medium · verified — The map opens too far out to read, and there is no way to find an experiment by name

Opening fits the whole tree. A project's experiments mostly branch from
master, so trees are wide and shallow, and fitting a wide tree means zooming
far out:

| Window | Experiments | Opens at | What a card shows |
| --- | --- | --- | --- |
| 1280×720 | 14 (9 from master) | 30% | name and dot; names about 4 px high |
| 1024×640 | 14 | 28% | **a dot alone: no names at all** |
| 1280×720 | 200 or 500 | 25% (the minimum) | dots, and the tree does not fit |

At those levels the cards' *Review* control and ⋯ menu are not drawn either,
so nothing can be done to a card until you zoom in.

Then there is no search. Finding "the Redis one" in forty experiments means
reading the map; the only filter in the interface is for files in Review.

And adding an experiment re-lays out the whole tree: adding one child to a
14-card map moved 8 of the 13 existing cards, master included, by up to 137
units — the card you were looking at shifts sideways.

**Fix (M).**

- Open on the selected experiment's neighbourhood at a readable zoom (its
  parent, siblings and children at 100%), and keep *Fit canvas* for the whole
  tree.
- A *Go to experiment* box (⌘K / Ctrl+K) that searches names and
  descriptions, with status, and selects and reveals the match.
- Keep existing cards still when one is added — pin each card's laid-out
  position the first time it is drawn, and lay out only new ones around them.

### M3 · Medium · verified — Every update re-lays out and redraws the whole map

Each "tree changed" event — a run sends several, and so do status changes and
renames — refetches the tree, runs the layout for every experiment and
redraws every card, even when only one word on one card changed.
`map-scale.mjs` measured the page's main-thread time per update:

| Experiments | Map drawn in | Per update | Of which the layout alone |
| --- | --- | --- | --- |
| 13 | 0.23 s | 23 ms | 4 ms |
| 200 | 0.76 s | 126 ms | 49 ms |
| 500 | 1.38 s | 297 ms | 130 ms |

At 500 experiments and three runs going, that is the page frozen for a third
of a second at a time, several times a minute — typing in the composer
stutters.

Reproduce: `node scripts/audit/map-scale.mjs` (needs `npm run build`).

**Fix (S–M).** Lay out again only when the tree's shape changes — the set of
experiments, their parents, card sizes or pinned positions — not on every
refetch (`useLaidOutNodes.ts:61` recomputes whenever the array changes). Keep
a card's previous data object when its fields are unchanged, so React Flow's
memoised cards skip re-rendering.

### M4 · Medium · verified — With a keyboard, the map is a long flat list

- **Every connecting line is a tab stop** — "Conversation from master to
  Redis cache" — and they all come before the first card: 13 stops on the
  14-card fixture, 499 on a 500-card map. Focusing a line does nothing.
- Then three stops per card (the card, its ⋯, its +), in creation order
  rather than tree order.
- **Arrow keys do nothing** on a focused card. There is no way to go to a
  parent, child or sibling.
- At the opening zoom, *Review* is not rendered, so it is not reachable at
  all.

**Fix (S).** `edgesFocusable={false}` on the canvas; arrow keys on a focused
card move focus along the tree (↑ parent, ↓ first child, ←/→ siblings),
revealing the card; ⌘K from M2 for jumping.

### M5 · Low · verified — For a project Bonsai created, the top bar spends its width on Bonsai's storage path

Beside the project name the bar shows the project's folder
(`MenuBar.tsx:90-93`). For a project made from your folder that is your
folder, which is useful. For a project Bonsai created it is Bonsai's own
`…/data/repos/<36-character id>/worktrees/<id>` path, and at 1280 px the
project's name is cut to "checkout-servi…" to make room for it.

**Fix (S).** Show the folder only for projects made from one of yours; keep
the internal location in the project menu's *Open folder*.

## What is solid

- **The earlier audit's map findings hold.** Selecting no longer pins a card;
  a background addition keeps the zoom; selection pans minimally; a card's
  status is a word with an accessible name, not colour alone; one family of
  canvas controls; the narrow window switches between Map and Experiment.
- **Cards are honest about code.** No *Review* control on a card with nothing
  to review; "no file changes" for a question-only experiment; *Behind*,
  frozen and archived each have a mark with a tooltip saying what to do.
- **The card menu, where it is drawn, is scaled back to a readable size**
  whatever the zoom.
- **Branching is direct**: the + on a card, or drag it to a spot on the map.

## Handed to later phases

- Colour contrast and the full keyboard and screen-reader pass → phase 16.
- Compare picking on the map → phase 13.

## Fix first

M1: the agent waits silently for a person who has no way of knowing. Then M2's
readable opening and *Go to experiment*, then M3 before projects reach a few
hundred experiments.
