# pi-model-picker

Enhanced Pi model picker extension: a grouped, searchable model chooser shown
on session start (per config), after `/new`, and via `/model-picker`.

## Layout

- `index.ts` — pi extension glue: session hook, `/model-picker` command,
  autocomplete wrapper, overlay container, settings/management UI wiring.
- `core.ts` — pure, testable core: persistence store (injectable agent dir),
  fuzzy match, group building, and the `GroupedModelList` row-model widget.
- `test/core.test.ts` — unit tests (`node --test`, Node ≥ 22.18/24 type stripping).
- `scripts/bundle.mjs` — inlines `core.ts` + `index.ts` into the single-file
  deployable `dist/new-model-picker.ts` (copy it to `~/.pi/agent/extensions/`).
- `scripts/check.mjs` — syntax-checks the TS sources via Node's type stripper.

## Commands

```
npm run verify   # syntax check + tests + bundle
```

## UX summary

- ↑/↓ moves through one ordered row model — group headers and models are all
  reachable, with wrap-around and no traps. Enter on a header collapses/expands.
- ←/→ collapse/expand the current group (works during search); Ctrl+G toggles
  all groups; Enter applies; Esc cancels.
- The selected model shows wrapped inline details; the title owns the position
  count (`Pick a model (n/m)`, or `Manage Favorites/Hidden models (n/m)`).
- Ctrl+S sets the configured default (canonical model id in `settings.json`),
  Ctrl+F/Ctrl+H toggle favorite/hidden for the highlighted model. Hiding the
  default or active model is refused.
- Ctrl+O opens Settings: toggle startup/new triggers or open full checkbox
  management for Favorites/Hidden (provider groups only, hidden included,
  Enter toggles without exiting, Esc returns to Settings).
- Ordinary mode excludes hidden models everywhere and keeps a Hidden group last.

## Persistence

State lives in `~/.pi/agent/new-model-picker-{recents,favorites,hidden}.json`
(entries capped at 15), config in `~/.pi/agent/new-model-picker.json`, and the
default model inside pi's `settings.json` (other keys are preserved; a
malformed settings file is never overwritten). All writes are atomic
(mkdir + temp file + rename).
