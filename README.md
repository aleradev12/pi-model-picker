# Pi Model Picker

A grouped, searchable, keyboard-first model picker for
[Pi](https://github.com/badlogic/pi-mono).

It replaces a long flat model list with provider groups, favorites, hidden
models, persistent preferences, and a stable full-screen overlay designed for
both large and small terminals.

## Features

- Models grouped by provider
- Fast fuzzy search across provider, model ID, and display name
- Favorites promoted to the top of search results without duplicate entries
- Persistent Favorites and Hidden lists
- Hidden models isolated in a collapsed group at the bottom
- Dedicated checklist screens for managing Favorites and Hidden models
- Collapsible provider groups
- Configurable picker startup behavior
- Persistent default-model selection
- Compact context, reasoning, and pricing details for the focused model
- Centered selection: the list scrolls while the cursor stays in place
- Full-terminal bordered overlay with small-terminal height adaptation
- Mouse-free, keyboard-first operation

## Requirements

- Pi with TypeScript extension support
- Node.js 22.18 or newer; Node.js 24 is recommended for development

## Installation

> Pi extensions execute with the same system access as Pi. Review third-party
> extension source before installing it.

### Install from GitHub

After the repository is published, install it as a Pi git package:

```sh
pi install git:github.com/<owner>/pi-model-picker
```

You can pin a tag or commit:

```sh
pi install git:github.com/<owner>/pi-model-picker@v1.0.0
```

Pi clones the repository, installs its dependencies, runs the package prepare
script, and loads `dist/new-model-picker.ts` from the package manifest.

### Install from a local checkout

```sh
git clone <repository-url>
cd pi-model-picker
npm install
npm run verify
pi install "$PWD"
```

For extension development, you can instead link the generated standalone file:

```sh
ln -sfn "$PWD/dist/new-model-picker.ts" \
  ~/.pi/agent/extensions/new-model-picker.ts
```

Do not link `index.ts` directly. It imports `./core.ts`, while the generated
file in `dist/` is the standalone extension entry expected by Pi.

Reload Pi after rebuilding:

```text
/reload
```

## Usage

Open the picker manually:

```text
/model-picker
```

By default it also opens on application startup and after creating a new
session. These behaviors can be changed from the picker Settings screen.

### Main picker

| Key | Action |
| --- | --- |
| `↑` / `↓` | Move through models and collapsed groups |
| `Enter` | Select the focused model or expand a collapsed group |
| `←` | Collapse the current model's group |
| `→` | Expand a focused collapsed group |
| `Ctrl+G` | Collapse or expand all groups |
| `Ctrl+S` | Save the focused model as Pi's default |
| `Ctrl+F` | Add or remove the focused model from Favorites |
| `Ctrl+H` | Hide or unhide the focused model |
| `Ctrl+O` | Open Settings |
| `Esc` | Close the picker |

Typing in the main picker filters the list. Favorite matches appear first in a
Favorites group, followed by the remaining provider groups. A matching hidden
model remains behind the collapsed Hidden group.

The configured default model is selected initially. Until navigation begins,
the title explains that pressing `Enter` will keep/select the default.

### Navigation behavior

Expanded group headings are visual labels and are skipped by `↑`/`↓`. Collapsed
group headings are focusable, use the selected background color, and can be
expanded with `Enter` or `→`.

The focused row stays vertically centered. Near the beginning or end of the
list, blank rows are inserted instead of moving the cursor away from its fixed
position.

After hiding a model with `Ctrl+H`, focus moves to the next distinct visible
model. If there is no next model, it moves to the previous one.

### Settings and checklist modes

Press `Ctrl+O` to open Settings:

- Show picker on application startup
- Show picker on new session
- Manage Favorites
- Manage Hidden models

The management screens display provider groups with `[ ]` and `[x]` checkboxes.
Press `Enter` to toggle an entry without closing the screen. These screens do
not show a search field. Press `Esc` to return to Settings.

The active or configured-default model cannot be newly hidden. A previously
persisted hidden active/default model remains reachable so it can be unhidden.

## Display

Model rows contain the model ID and optional display name. Models are indented
under their group heading. Favorites also include a compact muted provider
suffix because the group can mix providers:

```text
  ▾ Favorites
    gpt-5.6-sol — GPT-5.6 Sol  · openai-codex
  → GLM-5.3-Flash             · zai-api
```

A fixed two-line panel below the search field shows details without changing
the list height:

```text
272k ctx · reasoning: medium
↑Read 5$ · ↓Write 30$ · Cache 0.5$
```

Models without reasoning support show `reasoning: none`.

## Configuration

Optional configuration is stored at:

```text
~/.pi/agent/new-model-picker.json
```

Default configuration:

```json
{
  "reasons": ["startup", "new"],
  "maxRecents": 5
}
```

`reasons` accepts Pi session-start reasons such as `startup`, `new`, `resume`,
and `fork`. Startup and new-session behavior can be changed from Settings.

`maxRecents` is retained for state compatibility, although recent models are no
longer rendered as a separate group.

## Persistent state

The extension stores user state in the Pi agent directory:

```text
~/.pi/agent/new-model-picker-favorites.json
~/.pi/agent/new-model-picker-hidden.json
~/.pi/agent/new-model-picker-recents.json
~/.pi/agent/new-model-picker.json
```

The configured default model is written to Pi's existing
`~/.pi/agent/settings.json`. Other settings are preserved. A malformed settings
file is never overwritten.

Favorites and Hidden entries are not truncated. Recent state is capped at 20
entries. Writes are atomic: parent directories are created as needed, data is
written to a temporary file, and then renamed into place.

## Development

Install dependencies:

```sh
npm install
```

Run the complete verification pipeline:

```sh
npm run verify
```

This runs:

1. TypeScript syntax checks for `core.ts` and `index.ts`
2. Node's test suite
3. Standalone bundle generation
4. A smoke test through Pi's real extension loader

Useful individual commands:

```sh
npm test
npm run check
npm run bundle
npm run smoke:bundle
```

The generated extension is:

```text
dist/new-model-picker.ts
```

## Project structure

```text
index.ts                    Pi lifecycle, commands, overlay, and UI wiring
core.ts                     Grouping, navigation, rendering, and persistence
scripts/bundle.mjs          Standalone extension bundle generator
scripts/check.mjs           Source syntax checks
scripts/smoke-bundle.mjs    Real Pi-loader smoke test
test/core.test.ts           Navigation, grouping, rendering, and store tests
```

## Verification philosophy

Unit tests cover the pure row model, centered viewport, group transitions,
search ordering, hidden/favorite persistence, and settings safety. The bundle
smoke test intentionally uses Pi's actual `loadExtensions()` implementation so
parser and loader incompatibilities are caught before installation.

For visual changes, also test the picker interactively in both a tall terminal
and a heavily height-constrained terminal.
