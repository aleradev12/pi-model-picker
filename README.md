# Pi Model Picker

A grouped, keyboard-first model picker extension for [Pi](https://github.com/badlogic/pi-mono).



https://github.com/user-attachments/assets/ae769fa6-a91b-47ec-9a1b-e828d69d185a



## Why use it?

Pi's built-in model list becomes unwieldy when several providers are configured. This picker opens automatically on startup and when creating a new session — so choosing the right model is a deliberate step rather than something easy to forget. Both triggers can be disabled in its settings.

- **Fast search that finds the intended model first.** Fuzzy matching searches provider, ID, and display name, while ranking direct matches above accidental character matches.
- **A calmer model list.** Group models by provider, hide those you do not use, and pin favorites at the top without duplicate entries.
- **Useful context at the point of choice.** Focusing a model shows its context window, reasoning level, and input/output/cache pricing.
- **Works in any terminal.** The full-screen, keyboard-first UI adapts its list height to the available window and keeps the focused row visible.

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

## Development

```sh
npm install
npm run verify
```

## License

[MIT](LICENSE)
