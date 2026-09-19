/**
 * new-model-picker — model picker after /new, on startup, and via /model-picker.
 *
 * Behavior:
 *  - Grouped list (Favorites / providers / Hidden) with collapsible headers;
 *    ↑/↓ visits models and collapsed headers, skipping expanded headers.
 *  - Typing filters (fuzzy over provider/id/name); ←/→ collapse/expand groups.
 *  - Selected model details use a fixed two-line panel; the title owns the count.
 *  - Ctrl+O opens settings (startup/new toggles + Favorites/Hidden management);
 *    management modes show provider groups only, Enter toggles, Esc goes back.
 *  - Esc cancels; a pick is applied via pi.setModel().
 *
 * Config ~/.pi/agent/new-model-picker.json (optional):
 *   { "reasons": ["startup", "new"] }
 *
 * State files: ~/.pi/agent/new-model-picker-{favorites,hidden}.json
 */

import type { Api, Model } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import {
	buildGroups,
	createStore,
	GroupedModelList,
	isValidReason,
	Key,
	keyOf,
	listLineBudget,
	matchesKey,
	type ListItem,
	type ListTheme,
	type ManageMode,
} from "./core.ts";
import { Container, Input, Text, visibleWidth } from "@earendil-works/pi-tui";

// Module-scoped, not Symbol.for: /reload re-evaluates this module (and Pi
// clears provider wrappers), so the flag resets and the autocomplete wrapper
// is reliably re-registered — while repeated session_start events within one
// module instance never accumulate duplicate wrappers.
let autocompleteRegistered = false;
const store = createStore(getAgentDir());

type LoadedPickerConfig = ReturnType<typeof store.loadConfig>;

function pickModel(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	config: LoadedPickerConfig,
): Promise<void> {
	// The picker is a TUI-only feature.
	if (!ctx.hasUI || ctx.mode !== "tui") return Promise.resolve();

	const available = ctx.modelRegistry.getAvailable();
	if (available.length === 0) {
		ctx.ui.notify("new-model-picker: no available models", "warning");
		return Promise.resolve();
	}

	const current = ctx.model;
	const currentKey = current ? keyOf(current) : "";
	// Don't rely on ctx.model alone: after /new it may differ from the
	// configured default, and Enter must confirm exactly defaultModel.
	const configuredDefaultKey = store.getConfiguredDefaultKey(available);
	let defaultKey = configuredDefaultKey || currentKey;
	const defaultThinkingLevel = store.getConfiguredDefaultThinkingLevel() || ctx.thinkingLevel;

	const entryKey = (e: { provider: string; id: string }): string => `${e.provider}/${e.id}`;
	const dedupeKnown = (entries: { provider: string; id: string }[]): string[] => {
		const seen = new Set<string>();
		return entries
			.map(entryKey)
			.filter((key) => !seen.has(key) && available.some((m) => keyOf(m) === key) && seen.add(key) !== undefined);
	};
	let favoriteKeys = dedupeKnown(store.loadFavorites());
	// Preserve persisted entries, including a previously hidden default/active
	// model, so it remains reachable in Hidden and can always be unhidden.
	let hiddenKeys = dedupeKnown(store.loadHidden());
	let manageMode: ManageMode = null;

	const byKey = new Map(available.map((model) => [keyOf(model), model]));
	const ordered = [...available].sort((a, b) => a.provider.localeCompare(b.provider) || a.id.localeCompare(b.id));

	const labelOf = (m: Model<Api>): string => {
		const key = keyOf(m);
		const marker = key === defaultKey ? "[default] " : "";
		const checkbox = manageMode ? `[${(manageMode === "favorites" ? favoriteKeys : hiddenKeys).includes(key) ? "x" : " "}] ` : "";
		const name = m.name && m.name !== m.id ? ` — ${m.name}` : "";
		return `${checkbox}${marker}${m.id}${name}`;
	};

	const formatNumber = (value: number): string =>
		value.toLocaleString("en-US", { maximumFractionDigits: value > 0 && value < 1 ? 3 : 2 });

	const formatContext = (tokens: number): string =>
		tokens >= 1_000_000 ? `${formatNumber(tokens / 1_000_000)}m ctx` : `${Math.round(tokens / 1_000)}k ctx`;

	const itemOf = (model: Model<Api>): ListItem => ({
		value: keyOf(model),
		label: labelOf(model),
	});

	const groupsFor = (query: string) =>
		buildGroups({
			ordered,
			query,
			manageMode,
			favoriteKeys,
			hiddenKeys,
			defaultKey,
			itemOf,
		});

	return ctx.ui.custom<Model<Api> | null>((tui, theme, _kb, done) => {
		const container = new Container();
		const borderColor = (s: string) => theme.fg("accent", s);
		const title = new Text(theme.fg("accent", theme.bold("Pick a model")), 1, 0);
		const search = new Input({ placeholder: "Filter (provider / model / name)…" });
		// Keep this component exactly two rows tall, including on group headers.
		const emptyDetails = "\u200b\n\u200b";
		const details = new Text(emptyDetails, 1, 0);
		const listSlot = new Container();
		const help = new Text("", 1, 0);

		const listTheme: ListTheme = {
			selectedText: (t: string) => theme.bg("selectedBg", theme.fg("text", t)),
			selectedHeading: (t: string) => theme.bg("selectedBg", theme.fg("text", t)),
			description: (t: string) => theme.fg("muted", t),
			scrollInfo: (t: string) => theme.fg("dim", t),
			noMatch: (t: string) => theme.fg("warning", t),
			heading: (t: string) => theme.fg("accent", theme.bold(t)),
		};

		let uiMode: "pick" | "settings" = "pick";
		let settingsIndex = 0;
		let selectedValue = "";
		let showDefaultHint = true;
		let selectList: GroupedModelList;

		const updateDetails = (item: ListItem | null): void => {
			const model = item ? byKey.get(item.value) : undefined;
			if (!model) {
				details.setText(emptyDetails);
				return;
			}
			const reasoning = model.reasoning ? defaultThinkingLevel : "none";
			details.setText(theme.fg("muted", [
				`${formatContext(model.contextWindow)} · reasoning: ${reasoning}`,
				`↑Read ${formatNumber(model.cost.input)}$ · ↓Write ${formatNumber(model.cost.output)}$ · Cache ${formatNumber(model.cost.cacheRead)}$`,
			].join("\n")));
		};

		const updateChrome = () => {
			if (uiMode === "settings") {
				title.setText(theme.fg("accent", theme.bold("Settings")));
				help.setText(theme.fg("dim", "↑↓ select | enter toggle/open | ctrl+c quit | esc back"));
				return;
			}
			const heading = manageMode === "favorites" ? "Manage Favorites" : manageMode === "hidden" ? "Manage Hidden models" : "Pick a model";
			const defaultHint = !manageMode && showDefaultHint && selectList.getSelectedItem()?.value === defaultKey
				? " - press Enter to default"
				: "";
			title.setText(theme.fg("accent", theme.bold(`${heading} (${selectList.positionLabel()})${defaultHint}`)));
			const groupAction = selectList.isGroupFocused() ? "←→ expand group" : "←→ collapse group";
			const manageAction = manageMode ? "enter toggle | esc back" : "";
			help.setText(
				theme.fg(
					"dim",
					`↑↓ navigate | enter ${manageMode ? "toggle" : "apply"} | ctrl+s set default | ctrl+o settings | esc cancel\n${groupAction} | ctrl+g ${selectList.allGroupsCollapsed() ? "show" : "collapse"} all${manageAction ? ` | ${manageAction}` : ""}`,
				),
			);
		};

		const buildList = (query: string): GroupedModelList => {
			const list = new GroupedModelList(
				groupsFor(query),
				// Conservative line budget: overlay is capped at 90% of the
				// terminal height and the surrounding chrome (borders, title,
				// search, help, padding) is fixed — see listLineBudget().
				() => listLineBudget(process.stdout.rows),
				listTheme,
			);
			// A non-empty query is ranked, so focus its best match rather than
			// preserving a previously selected (and potentially weaker) model.
			// With no query retain the configured/default selection as before.
			if (!query.trim()) list.setSelectedValue(selectedValue || defaultKey);
			selectedValue = list.getSelectedItem()?.value ?? selectedValue;
			list.onSelectionChange = (item) => {
				showDefaultHint = false;
				if (item) selectedValue = item.value;
				updateDetails(item);
				updateChrome();
			};
			list.onStateChange = updateChrome;
			list.onSelect = (item) => {
				if (!manageMode) return done(byKey.get(item.value) ?? null);
				toggleEntry(item.value);
				rebuild(search.getValue());
			};
			list.onCancel = () => {
				if (manageMode) {
					manageMode = null;
					uiMode = "settings";
					rebuild(search.getValue());
				} else done(null);
			};
			list.onToggleHidden = (item) => {
				// Unhide intent is decided before the canHide guard: a persisted
				// hidden default/active model must always be unhide-able.
				const hiding = !hiddenKeys.includes(item.value);
				if (hiding && !canHide(item.value)) return;
				const previousKeys = hiddenKeys;
				const fallbackValue = hiding ? list.fallbackValueAfterRemoval() : item.value;
				hiddenKeys = hiding ? [item.value, ...hiddenKeys] : hiddenKeys.filter((key) => key !== item.value);
				if (!persistHidden()) {
					hiddenKeys = previousKeys;
					return;
				}
				selectedValue = fallbackValue;
				ctx.ui.notify(hiding ? `Hidden: ${item.value}` : `Shown: ${item.value}`, "info");
				rebuild(search.getValue());
			};
			list.onToggleFavorite = (item) => {
				const model = byKey.get(item.value);
				if (!model) return;
				const adding = !favoriteKeys.includes(item.value);
				favoriteKeys = adding ? [item.value, ...favoriteKeys] : favoriteKeys.filter((key) => key !== item.value);
				if (!store.saveFavorites(favoriteKeys.map(toEntry))) {
					ctx.ui.notify("new-model-picker: could not save favorites", "error");
					return;
				}
				ctx.ui.notify(adding ? `Favorite: ${item.value}` : `Removed favorite: ${item.value}`, "info");
				rebuild(search.getValue());
			};
			list.onSaveDefault = (item) => {
				const model = byKey.get(item.value);
				if (!model || !store.saveConfiguredDefault(model)) {
					ctx.ui.notify("new-model-picker: could not save default model", "error");
					return;
				}
				defaultKey = keyOf(model);
				ctx.ui.notify(`Default model: ${defaultKey}`, "info");
				rebuild(search.getValue());
			};
			return list;
		};

		const toEntry = (key: string): { provider: string; id: string } => {
			const model = byKey.get(key)!;
			return { provider: model.provider, id: model.id };
		};

		const persistHidden = (): boolean => {
			if (store.saveHidden(hiddenKeys.map(toEntry))) return true;
			ctx.ui.notify("new-model-picker: could not save hidden models", "error");
			return false;
		};

		// Hiding the default or active model would leave the picker without a
		// usable [default] marker, so it is refused.
		const canHide = (key: string): boolean => {
			if (!byKey.has(key)) return false;
			if (key === defaultKey || key === currentKey) {
				ctx.ui.notify(`Cannot hide the default/active model: ${key}`, "warning");
				return false;
			}
			return true;
		};

		const toggleEntry = (value: string): void => {
			const keys = manageMode === "favorites" ? favoriteKeys : hiddenKeys;
			const adding = !keys.includes(value);
			// Only the hiding direction is guarded: unhiding a persisted hidden
			// default/active model must always work.
			if (manageMode === "hidden" && adding && !canHide(value)) return;
			const nextKeys = adding ? [value, ...keys] : keys.filter((key) => key !== value);
			if (manageMode === "favorites") {
				favoriteKeys = nextKeys;
				if (!store.saveFavorites(nextKeys.map(toEntry))) {
					ctx.ui.notify("new-model-picker: could not save favorites", "error");
					return;
				}
			} else {
				hiddenKeys = nextKeys;
				if (!persistHidden()) return;
			}
			rebuild(search.getValue());
		};

		container.addChild(title);
		container.addChild(search);
		container.addChild(details);
		container.addChild(listSlot);
		container.addChild(help);
		selectList = buildList("");
		listSlot.addChild(selectList);
		updateDetails(selectList.getSelectedItem());
		updateChrome();

		const rebuild = (query: string) => {
			listSlot.clear();
			selectList = buildList(query);
			listSlot.addChild(selectList);
			updateDetails(selectList.getSelectedItem());
			updateChrome();
		};

		const openManagement = (mode: "favorites" | "hidden") => {
			manageMode = mode;
			uiMode = "pick";
			search.setValue("");
			selectedValue = "";
			rebuild("");
		};

		const toggleAutostart = (reason: "startup" | "new") => {
			const nextConfig = store.loadConfig();
			const enabled = nextConfig.reasons.includes(reason);
			nextConfig.reasons = enabled
				? nextConfig.reasons.filter((value) => value !== reason)
				: [...new Set([...nextConfig.reasons, reason])];
			if (store.saveConfig(nextConfig)) ctx.ui.notify(`Picker on ${reason}: ${enabled ? "off" : "on"}`, "info");
			else ctx.ui.notify("new-model-picker: could not save configuration", "error");
		};

		return {
			render: (width: number) => {
				const innerWidth = Math.max(1, width - 2);
				let content: string[];
				if (uiMode === "settings") {
					const reasons = store.loadConfig().reasons;
					const toggleRow = (index: number, checked: boolean, label: string) =>
						`  ${settingsIndex === index ? "→" : " "} [${checked ? "x" : " "}] ${label}`;
					const actionRow = (index: number, label: string) =>
						`  ${settingsIndex === index ? "→" : " "} ${label}`;
					content = [
						theme.fg("accent", theme.bold("Settings")),
						toggleRow(0, reasons.includes("startup"), "Show picker on application startup"),
						toggleRow(1, reasons.includes("new"), "Show picker on new session"),
						actionRow(2, "Manage Favorites (Ctrl+F in picker)"),
						actionRow(3, "Manage Hidden models (Ctrl+H in picker)"),
						theme.fg("dim", "↑↓ select | enter toggle/open | esc back"),
					];
				} else if (manageMode) {
					// Management is a checkbox list, not a filterable picker.
					content = [
						...title.render(innerWidth),
						...details.render(innerWidth),
						...listSlot.render(innerWidth),
						...help.render(innerWidth),
					];
				} else {
					content = container.render(innerWidth);
				}
				const horizontal = "─".repeat(innerWidth);
				return [
					borderColor(`╭${horizontal}╮`),
					...content.map((line) => {
						const padding = " ".repeat(Math.max(0, innerWidth - visibleWidth(line)));
						return `${borderColor("│")}${line}${padding}${borderColor("│")}`;
					}),
					borderColor(`╰${horizontal}╯`),
				];
			},
			invalidate: () => container.invalidate(),
			handleInput: (data: string) => {
				if (data === "\x03") {
					done(null);
				} else if (uiMode === "settings") {
					if (matchesKey(data, Key.escape)) {
						uiMode = "pick";
						updateChrome();
					} else if (matchesKey(data, Key.up)) settingsIndex = (settingsIndex + 3) % 4;
					else if (matchesKey(data, Key.down)) settingsIndex = (settingsIndex + 1) % 4;
					else if (matchesKey(data, Key.enter)) {
						if (settingsIndex === 0) toggleAutostart("startup");
						else if (settingsIndex === 1) toggleAutostart("new");
						else openManagement(settingsIndex === 2 ? "favorites" : "hidden");
					}
				} else if (matchesKey(data, Key.ctrl("o")) && !manageMode) {
					uiMode = "settings";
					settingsIndex = 0;
					updateChrome();
				} else if (
					matchesKey(data, Key.up) ||
					matchesKey(data, Key.down) ||
					matchesKey(data, Key.left) ||
					matchesKey(data, Key.right) ||
					matchesKey(data, Key.enter) ||
					matchesKey(data, Key.escape) ||
					matchesKey(data, Key.ctrl("f")) ||
					matchesKey(data, Key.ctrl("h")) ||
					matchesKey(data, Key.ctrl("g")) ||
					matchesKey(data, Key.ctrl("s"))
				) {
					selectList.handleInput(data);
				} else if (!manageMode) {
					const before = search.getValue();
					search.handleInput(data);
					const after = search.getValue();
					if (after !== before) rebuild(after);
				}
				tui.requestRender();
			},
		};
	}, {
		overlay: true,
		overlayOptions: {
			anchor: "center",
			width: "100%",
			maxHeight: "100%",
			margin: 0,
		},
	}).then(async (result) => {
		if (!result) return; // Esc — keep the current model

		if (keyOf(result) === currentKey) {
			ctx.ui.notify(`Model unchanged: ${keyOf(result)}`, "info");
			return;
		}

		const ok = await pi.setModel(result);
		if (!ok) {
			ctx.ui.notify(`new-model-picker: no authorization for ${keyOf(result)}`, "error");
			return;
		}

		ctx.ui.notify(`Model: ${keyOf(result)}`, "info");
	});
}

export default function (pi: ExtensionAPI) {
	// Config is read on every session_start so edits are picked up without /reload.
	pi.on("session_start", async (event, ctx) => {
		if (!autocompleteRegistered) {
			autocompleteRegistered = true;
			ctx.ui.addAutocompleteProvider((current) => ({
				triggerCharacters: [],
				async getSuggestions(lines, line, col, options) {
					const suggestions = await current.getSuggestions(lines, line, col, options);
					const beforeCursor = (lines[line] ?? "").slice(0, col).trimStart();
					if (!/^\/mod[^\s]*$/.test(beforeCursor)) return suggestions;
					const picker = {
						value: "model-picker",
						label: "model-picker",
						description: "Enhanced model picker",
					};
					return {
						prefix: suggestions?.prefix ?? beforeCursor,
						items: [picker, ...(suggestions?.items ?? []).filter((item) => item.value !== picker.value)],
					};
				},
				applyCompletion: (lines, line, col, item, prefix) => current.applyCompletion(lines, line, col, item, prefix),
				shouldTriggerFileCompletion: (lines, line, col) => current.shouldTriggerFileCompletion?.(lines, line, col) ?? true,
			}));
		}

		const config = store.loadConfig();
		if (!config.reasons.includes(event.reason) || !isValidReason(event.reason)) return;
		await pickModel(pi, ctx, config, false);
	});

	pi.registerCommand("model-picker", {
		description: "Choose a model (enhanced picker)",
		handler: async (_args, ctx) => {
			await pickModel(pi, ctx, store.loadConfig(), true);
		},
	});
}
