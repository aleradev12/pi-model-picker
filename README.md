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
- `scripts/smoke-bundle.mjs` — imports the deployable bundle and fails if it
  still depends on `./core.ts`.

## Commands

```sh
npm run verify   # syntax check + tests + bundle + standalone import smoke test
```

For local development, Pi must load the standalone bundle, not `index.ts`:

```sh
ln -sfn "$PWD/dist/new-model-picker.ts" ~/.pi/agent/extensions/new-model-picker.ts
```

`index.ts` imports `./core.ts`; Pi resolves relative imports from the extension
entry path, so linking `index.ts` directly into `~/.pi/agent/extensions/` will
not work.

## UX summary

- ↑/↓ moves through models and collapsed group headers with wrap-around;
  expanded headers are labels, not focus targets. A focused collapsed header
  is highlighted, and Enter/→ expands it onto its first model.
- ←/→ collapse/expand the current group (works during search); Ctrl+G toggles
  all groups; Enter applies; Esc cancels.
- A fixed two-line panel below search shows context, reasoning, and full pricing
  for the focused model without changing the list height. Resting rows show only
  compact pricing. The title owns the position count (`Pick a model (n/m)`, or
  `Manage Favorites/Hidden models (n/m)`).
- Ctrl+S sets the configured default (canonical model id in `settings.json`),
  Ctrl+F/Ctrl+H toggle favorite/hidden for the highlighted model. Hiding the
  default or active model is refused.
- Ctrl+O opens Settings: toggle startup/new triggers or open full checkbox
  management for Favorites/Hidden (provider groups only, hidden included,
  Enter toggles without exiting, Esc returns to Settings).
- Ordinary mode has no Recent group. Hidden models appear only in the final
  Hidden group, which starts collapsed on every picker opening and after search.

## Persistence

State lives in `~/.pi/agent/new-model-picker-{recents,favorites,hidden}.json`.
Recents are capped at 20; favorites and hidden entries are not truncated.
Config lives in `~/.pi/agent/new-model-picker.json`, and the
default model inside pi's `settings.json` (other keys are preserved; a
malformed settings file is never overwritten). All writes are atomic
(mkdir + temp file + rename).
