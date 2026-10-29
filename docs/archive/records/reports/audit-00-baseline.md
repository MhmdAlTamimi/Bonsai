# Audit phase 0 — baseline

2026-09-29, on `main` at 5842b8c. The numbers later phases are measured
against. Re-run with `node scripts/baseline.mjs` (after `npm run build`) and
compare `test-results/baseline.json`.

Machine: Linux, 4 CPUs, Node 22.22.2, git 2.43. Timings are comparable only on
the same machine; counts and sizes are comparable anywhere. Two full runs a few
minutes apart differed by up to 2× on some timings (the 500-card map drew in
1.9 s, then 1.1 s), so compare timings as the median of a few runs.

## Tests

| Suite | Tests | Time | Line / branch coverage | Files it loads |
|---|---|---|---|---|
| Server unit | 367, all pass | 24 s | 85% / 83% | 73 |
| Interface and shared unit | 120, all pass | 1.3 s | 97% / 91% | 21 |
| Browser (end to end) | 25, all pass | 77 s | not measured | — |

What the coverage figures leave out, because Node counts only files a test
loads:

- **The HTTP layer has no unit tests.** The route handlers (`api/routes/*.ts`,
  over 1,300 lines), `routing.ts`, `index.ts` and `config.ts` are loaded by no
  unit test; only the browser suite reaches them.
- **Interface components have no unit tests.** The 21 files the interface tests
  load are pure helpers. The React components — about 15,000 lines in some 110
  files — are exercised only by the 25 browser tests.

CI (run 64, both jobs green): Linux 2 min 32 s, Windows 6 min 42 s.

## Build and what the browser downloads

| | |
|---|---|
| Cold build (server + interface) | 12.2 s |
| Warm build — paid by every `npm start` | 3.2 s |
| JavaScript | 569 KB (180 KB gzipped), in three chunks of about 60 KB gzipped each |
| CSS | 80 KB (16 KB gzipped) |

## Startup and memory

| | |
|---|---|
| Server ready, empty data folder | 0.34 s |
| Server ready, 500 experiments on disk | 0.27 s |
| First tree after that restart | 11 ms |
| Server memory, idle | 89 MB |
| Server memory after 61 runs and 40 selections | 161 MB |
| Server memory over 300 runs on one experiment | 158 → 179 MB, levelling off (not a leak) |
| Page memory, before → after the long session | 4.3 → 5.8 MB JS heap, 486 → 638 DOM nodes |

## A tree as it grows (real server, real git)

| Experiments | Create one | Tree request | Tree payload | Database | Server memory |
|---|---|---|---|---|---|
| 10 | 17 ms | 1.7 ms | 6 KB | 0.5 MB | 93 MB |
| 100 | 17 ms | 3.3 ms | 59 KB | 2.4 MB | 115 MB |
| 500 | 19 ms | 8.1 ms | 292 KB | 4.4 MB | 159 MB |

The map with 500 cards: first drawn in 1.1–1.9 s, 21 MB JS heap, 6,675 DOM
nodes, 2,196 event listeners.

## A day's use (stand-in agent)

| | |
|---|---|
| One run, start to finish (stand-in agent, ~30 ms of "work") | 357 ms median |
| Selecting another experiment | 19 ms median, 2 requests |
| One run watched from the page | 10 requests, 10 server events |

The 10 requests for one watched run are: the conversation 4 times, the
experiment's details 4 times, the tree twice.

## Measured costs handed to later phases

- **The page re-downloads the whole conversation on every change.** The server
  can send only what is new (`afterSeq`), but the page always asks from the
  start (`packages/ui/src/panel/chat/useChat.ts:65`). At 300 runs on one
  experiment the conversation is 3 MB and the experiment's details 242 KB;
  a watched run fetches each four times — about 13 MB, parsed and re-rendered,
  per run. Fine today, linear in the life of an experiment. → phases 9 and 11.
- **The 500-card map** (1–2 s to draw, 6,700 DOM nodes) is the number to beat
  if large trees matter. → phase 10.

## Tooling found broken

`scripts/measure-requests.mjs` drove the start page by selectors the redesign
removed and failed at its first step, so requests per run had not been
measurable since. `scripts/baseline.mjs` replaces it: it creates projects
through the API, so a page redesign cannot break the measurement.
