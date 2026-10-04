# Audit phase 16 — interface foundations

2026-10-04, `codex/audit-fixes`. Reviewed selection ownership, keyboard/focus behavior, loading/error recovery, draft persistence, stale frontend behavior, message history and map rendering. This is a practical release review, not a complete WCAG conformance audit.

## Findings and fixes

### U1 · Medium · reproduced — an unsent draft could silently become memory-only

The draft store caught storage quota/privacy exceptions and continued editing without telling the user. A reload could then discard the message. The new build notice also overstated draft persistence.

The shared draft store now tracks failed persistence across experiment and comparison drafts. One visible notice explains that affected messages exist only in the tab; a browser unload warning applies while those drafts remain unsaved. A successful later write or clearing the draft removes the warning. The build notice no longer unconditionally claims that drafts are saved.

The real-browser regression makes browser storage throw, types a message, verifies the visible notice and canceled unload event, restores storage, edits again, and reloads to verify the saved text. This exercises the actual composer/store integration, not a parallel mock implementation.

### U2 · Low/Medium · confirmed against code — card actions captured old callbacks

`useCardActions` deliberately excluded callback dependencies from a memo. Preserving tree identity for M3 made those stale closures longer-lived. Actions now use current callbacks; the canvas provides stable forwarding functions at the rendering boundary. Application selection remains authoritative: React Flow measurement/position updates are accepted, but its independent selection changes cannot overwrite the application's selection ring.

### U3 · Medium · reproduced during regression testing — cancelled response parsing could crash comparison reload

The shared API client converted any JSON read failure into an error object, then returned that object as successful data when the HTTP status was 200. Cancellation after headers arrived could therefore replace a comparison with an object missing its turns and crash rendering. Successful-response body errors now reject; non-JSON HTTP failures retain their status-based error. Comparison refreshes also ignore results after their controller is aborted. Tests exercise the actual API client with a cancelled response body, malformed successful JSON and a non-JSON 503 response.

## Related fixes verified together

- M1: cross-project waiting-question strip and tab count, with direct navigation to the blocked experiment.
- M2/M4: readable initial map, experiment search, keyboard parent/child/sibling traversal, and explicit Fit canvas.
- C2: bounded initial message history, automatic earlier-page loading on upward scroll with a manual load/retry fallback, anchored reading position and durable sequence reconciliation during a running turn. Explicitly loading older pages expands the rendered history; this is not full DOM virtualization.
- S3: build identity mismatch explains the required reload and blocks stale UI mutations. Reload remains explicit, preserving normal draft and unsaved-settings protections.
- N3/C1/C3: settings draft ownership, accessible waiting-question controls in short windows, and independently scrolling tables retain their prior browser regressions.

Initialization now applies measured map geometry before paint instead of delayed fit/reveal timers. Browser tests use real pointer input and verify visibility, actual selection, persisted requests, scrolling and reload behavior. Timing measurements are supplementary and machine-dependent.
