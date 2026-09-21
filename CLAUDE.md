# Project agent memory

Keep this file for durable project-specific facts that are easy to misread from
names alone. Prefer concise pointers to authoritative code and history over
duplicating the README.

## Repository lineage — do not conflate the two implementations

This repository, `casret/pi-observational-memory`, is a fork of
`amosblomqvist/pi-observational-memory`. Its immutable fork baseline is
`78a1efcfdd46332253fb289724f05b26dfc7769e`. The active casret line continues on
`adaptive-context-compaction` (starting with six casret commits through
`e384f439cc763ec15771559099b7b644a8dc2672`); `main` may still point at the parent
baseline, so inspect bookmarks/history before deciding which line is current.

`elpapi42/pi-observational-memory` is **not** this repository's upstream and is
not a sibling fork. It is a separate implementation with unrelated Git history.
Never describe it as “upstream,” calculate ahead/behind against it, or plan a
rebase/merge as though the histories were shared. Moving to it would be a
replacement/migration; porting an idea from it requires a design-level adaptation.

The package names are another trap:

- this lineage: package `observational-memory`, version `0.1.0`, not published to npm;
- elpapi42 lineage: npm package `pi-observational-memory`, independently versioned
  (V3 as of 2026-09).

Verify lineage with GitHub fork metadata and local remotes before making claims:

```bash
gh api repos/casret/pi-observational-memory \
  --jq '{full_name, parent: .parent.full_name, source: .source.full_name}'
jj git remote list
```

## Architectural identity

This lineage uses parallel **Pi subprocess observers** to write atomic,
branch-local observations, deterministic model-free compaction, and a single
**consolidator** that promotes older observations into per-session, grep-able
`.memory/<sessionId>/` topic files plus `INDEX.md` and `JOURNEY.md`. See
`README.md`, `src/ledger/`, `src/hooks/`, `src/memory/`, and `agent/`.

The elpapi42 V3 implementation is useful reference material but has a different
center of gravity: provider-backed observer/reflector/dropper loops, a
branch-local observation/reflection/drop ledger, source citations, an agent
`recall` tool, npm releases, and no topic-file/JOURNEY consolidation model.

## Pi compatibility boundary

Do not upgrade this extension to Pi 0.87 unchanged. Pi 0.87 makes
`SessionManager.buildSessionProjection()` authoritative and adds branch-local
`context_edit` omissions/replacements. Current observer, compaction, and handoff
paths still derive source material from raw branch entries, which can resurrect
failed or omitted attempts. The Pi 0.87 migration must project canonical entries
while retaining source-entry IDs as coverage watermarks, with regression tests
for omitted and replaced context. The separate elpapi42 V3 implementation has
the same raw-branch projection gap and additional Pi 0.87 worker API changes; its
newer release number does not remove this blocker.
