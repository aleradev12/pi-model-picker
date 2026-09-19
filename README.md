# Pi Model Picker

[![CI](https://github.com/aleradev12/pi-model-picker/actions/workflows/ci.yml/badge.svg)](https://github.com/aleradev12/pi-model-picker/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/@aleradev12/pi-model-picker)](https://www.npmjs.com/package/@aleradev12/pi-model-picker)

A grouped model picker extension for [Pi](https://github.com/badlogic/pi-mono).

https://github.com/user-attachments/assets/ae769fa6-a91b-47ec-9a1b-e828d69d185a



## Why use it?

Pi's built-in model list becomes unwieldy when several providers are configured. This picker opens automatically on startup and when creating a new session — so choosing the right model is a deliberate step rather than something easy to forget. Both triggers can be disabled in its settings.

- **Fast search that finds the intended model first.** Fuzzy matching searches provider, ID, and display name, while ranking direct matches above accidental character matches.
- **A calmer model list.** Group models by provider, hide those you do not use, and pin favorites at the top without duplicate entries.
- **Useful context at the point of choice.** Focusing a model shows its context window, reasoning level, and input/output/cache pricing.
- **Works in any terminal.** The full-screen UI adapts its list height to the available window and keeps the focused row visible.

## Install

```sh
pi install npm:@aleradev12/pi-model-picker
```

Or install directly from GitHub:

```sh
pi install git:github.com/aleradev12/pi-model-picker
```

Reload Pi after installation:

```text
/reload
```

## Usage

Open `/model-picker`, then type to filter. Use `↑` / `↓` to navigate, `Enter` to select, `Ctrl+F` for favorites, `Ctrl+H` to hide a model, and `Ctrl+O` for settings.

Optional configuration lives in `~/.pi/agent/new-model-picker.json`:

```json
{ "reasons": ["startup", "new"] }
```

## Security and privacy

The extension makes no network requests, starts no child processes, and has no
runtime dependencies beyond Pi. It reads Pi's available model metadata and
stores only picker preferences in `~/.pi/agent/`. Selecting **Set default** also
updates `defaultProvider` and `defaultModel` in Pi's existing `settings.json`.
Writes are atomic and use private file permissions. Provider-supplied labels are
sanitized before terminal output.

See [SECURITY.md](SECURITY.md) for vulnerability reporting.

## Development

Requires Node.js 22.18 or newer.

```sh
npm ci
npm run verify
npm pack --dry-run
```

`verify` performs a strict TypeScript check, executes the test suite, rebuilds
the published extension, and smoke-tests it through Pi's extension loader.
CI runs the same command on every push and pull request.

## License

[MIT](LICENSE)
