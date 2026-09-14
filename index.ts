/**
 * new-model-picker — пикер модели после /new
 *
 * В отличие от pi-startup-picker (работает только на обычном старте), этот
 * экстеншен показывает поиск + выбор модели на session_start с reason "new"
 * (т.е. сразу после /new), а также по команде /model-picker.
 *
 * Поведение:
 *  - Недавние модели (последние выборы) показываются сверху списка.
 *  - Ввод фильтрует список (нечёткий поиск по provider/id/name).
 *  - Esc — отмена, остаётся текущая модель.
 *  - Выбор сохраняется в недавние и применяется через pi.setModel().
 *
 * Конфиг ~/.pi/agent/new-model-picker.json (необязателен):
 * {
 *   "reasons": ["new"],   // когда показывать: "startup" | "new" | "resume" | "fork"
 *   "maxRecents": 5       // сколько недавних моделей показывать сверху
 * }
 *
 * Недавние хранятся в ~/.pi/agent/new-model-picker-recents.json
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Api, Model } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { Container, Input, Key, matchesKey, type SelectItem, Text, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";

interface PickerConfig {
	reasons: string[];
	maxRecents: number;
}

interface RecentEntry {
	provider: string;
	id: string;
}

interface AgentSettings {
	defaultProvider?: unknown;
	defaultModel?: unknown;
	defaultThinkingLevel?: unknown;
}

const VALID_REASONS = new Set(["startup", "new", "resume", "fork"]);
const AUTOCOMPLETE_UI_MARKER = Symbol.for("new-model-picker.autocomplete-installed");

const keyOf = (m: Model<Api>): string => `${m.provider}/${m.id}`;

function configPath(): string {
	return join(getAgentDir(), "new-model-picker.json");
}

function recentsPath(): string {
	return join(getAgentDir(), "new-model-picker-recents.json");
}

function favoritesPath(): string {
	return join(getAgentDir(), "new-model-picker-favorites.json");
}

function hiddenPath(): string {
	return join(getAgentDir(), "new-model-picker-hidden.json");
}

function settingsPath(): string {
	return join(getAgentDir(), "settings.json");
}

/** Модель, заданная в настройках pi для новых сессий. */
function getConfiguredDefaultKey(available: Model<Api>[]): string {
	try {
		const settings = JSON.parse(readFileSync(settingsPath(), "utf8")) as AgentSettings;
		if (typeof settings.defaultProvider !== "string" || typeof settings.defaultModel !== "string") {
			return "";
		}

		const model = available.find(
			(m) =>
				m.provider === settings.defaultProvider &&
				(m.id === settings.defaultModel || m.name === settings.defaultModel),
		);
		return model ? keyOf(model) : "";
	} catch {
		return "";
	}
}

function getConfiguredDefaultThinkingLevel(): string {
	try {
		const settings = JSON.parse(readFileSync(settingsPath(), "utf8")) as AgentSettings;
		return typeof settings.defaultThinkingLevel === "string" ? settings.defaultThinkingLevel : "";
	} catch {
		return "";
	}
}

function saveConfiguredDefault(model: Model<Api>): boolean {
	try {
		const raw: Record<string, unknown> = JSON.parse(readFileSync(settingsPath(), "utf8"));
		writeFileSync(
			settingsPath(),
			`${JSON.stringify({ ...raw, defaultProvider: model.provider, defaultModel: model.name || model.id }, null, 2)}\n`,
		);
		return true;
	} catch {
		return false;
	}
}

function loadConfig(): PickerConfig {
	const defaults: PickerConfig = { reasons: ["startup", "new"], maxRecents: 5 };
	try {
		const raw = JSON.parse(readFileSync(configPath(), "utf8")) as Partial<PickerConfig>;
		return {
			reasons: Array.isArray(raw.reasons)
				? raw.reasons.filter((r): r is string => typeof r === "string" && VALID_REASONS.has(r))
				: defaults.reasons,
			maxRecents:
				typeof raw.maxRecents === "number"
					? Math.max(0, Math.min(20, Math.floor(raw.maxRecents)))
					: defaults.maxRecents,
		};
	} catch {
		return defaults;
	}
}

function saveConfig(config: PickerConfig): boolean {
	try {
		writeFileSync(configPath(), `${JSON.stringify(config, null, 2)}\n`);
		return true;
	} catch {
		return false;
	}
}

function loadRecents(): RecentEntry[] {
	try {
		const raw: unknown = JSON.parse(readFileSync(recentsPath(), "utf8"));
		if (!Array.isArray(raw)) return [];
		return raw.filter(
			(e): e is RecentEntry =>
				!!e &&
				typeof e === "object" &&
				typeof (e as RecentEntry).provider === "string" &&
				typeof (e as RecentEntry).id === "string",
		);
	} catch {
		return [];
	}
}

function saveEntries(path: string, entries: RecentEntry[]): void {
	try {
		mkdirSync(dirname(path), { recursive: true });
		writeFileSync(path, JSON.stringify(entries.slice(0, 15), null, "\t"));
	} catch {
		// Optional picker state must never block model selection.
	}
}

function saveRecents(entries: RecentEntry[]): void {
	saveEntries(recentsPath(), entries);
}

function loadFavorites(): RecentEntry[] {
	try {
		const raw: unknown = JSON.parse(readFileSync(favoritesPath(), "utf8"));
		return Array.isArray(raw)
			? raw.filter(
				(e): e is RecentEntry =>
					!!e && typeof e === "object" && typeof (e as RecentEntry).provider === "string" && typeof (e as RecentEntry).id === "string",
			)
			: [];
	} catch {
		return [];
	}
}

function saveFavorites(entries: RecentEntry[]): void {
	saveEntries(favoritesPath(), entries);
}

function loadHidden(): RecentEntry[] {
	try {
		const raw: unknown = JSON.parse(readFileSync(hiddenPath(), "utf8"));
		return Array.isArray(raw)
			? raw.filter((e): e is RecentEntry => !!e && typeof e === "object" && typeof (e as RecentEntry).provider === "string" && typeof (e as RecentEntry).id === "string")
			: [];
	} catch {
		return [];
	}
}

function saveHidden(entries: RecentEntry[]): void {
	saveEntries(hiddenPath(), entries);
}

/** Нечёткое совпадение: все символы query встречаются в target по порядку. */
function fuzzyMatch(query: string, target: string): boolean {
	if (!query) return true;
	let i = 0;
	const t = target.toLowerCase();
	for (const ch of t) {
		if (ch === query[i]) i++;
		if (i >= query.length) return true;
	}
	return i >= query.length;
}

interface ModelListTheme {
	selectedText: (text: string) => string;
	description: (text: string) => string;
	scrollInfo: (text: string) => string;
	noMatch: (text: string) => string;
	heading: (text: string) => string;
}

interface ModelGroup {
	id: string;
	title: string;
	items: SelectItem[];
	collapsible: boolean;
}

interface GroupedItem {
	item: SelectItem;
	group: ModelGroup;
}

/** Model selector with wrapped rows and non-selectable collapsible provider headings. */
class GroupedModelList {
	public onSelect?: (item: SelectItem) => void;
	public onCancel?: () => void;
	public onSelectionChange?: (item: SelectItem) => void;
	public onSaveDefault?: (item: SelectItem) => void;
	public onToggleFavorite?: (item: SelectItem) => void;
	public onToggleHidden?: (item: SelectItem) => void;
	public onStateChange?: () => void;
	private selectedIndex = 0;
	private focusedGroupId?: string;
	private readonly collapsed = new Set<string>();

	constructor(
		private readonly groups: ModelGroup[],
		private readonly maxVisible: () => number,
		private readonly theme: ModelListTheme,
		private readonly searching: boolean,
	) {}

	private get visibleItems(): GroupedItem[] {
		return this.groups.flatMap((group) =>
			!this.collapsed.has(group.id) ? group.items.map((item) => ({ item, group })) : [],
		);
	}

	setSelectedValue(value: string): void {
		const index = this.visibleItems.findIndex(({ item }) => item.value === value);
		if (index >= 0) this.selectedIndex = index;
	}

	getSelectedItem(): SelectItem | null {
		return this.focusedGroupId ? null : this.visibleItems[this.selectedIndex]?.item ?? null;
	}

	isGroupFocused(): boolean {
		return !!this.focusedGroupId;
	}

	positionLabel(): string {
		const visible = this.visibleItems;
		return visible.length > 0 ? `${this.selectedIndex + 1}/${visible.length}` : "0/0";
	}

	allGroupsCollapsed(): boolean {
		const collapsible = this.groups.filter((group) => group.collapsible);
		return collapsible.length > 0 && collapsible.every((group) => this.collapsed.has(group.id));
	}

	invalidate(): void {}

	render(width: number): string[] {
		const visible = this.visibleItems;
		const collapsedHeaders = this.groups
			.filter((group) => group.collapsible && this.collapsed.has(group.id))
			.map((group) =>
				group.id === this.focusedGroupId
					? this.theme.selectedText(`→ ▸ ${group.title}`)
					: this.theme.heading(`  ▸ ${group.title}`),
			);
		if (visible.length === 0) return collapsedHeaders.length > 0 ? collapsedHeaders : [this.theme.noMatch("  No matches")];
		const maxVisible = this.maxVisible();
		const start = Math.max(0, Math.min(this.selectedIndex - Math.floor(maxVisible / 2), visible.length - maxVisible));
		const end = Math.min(start + maxVisible, visible.length);
		const lines: string[] = [...collapsedHeaders];
		let previousGroupId: string | undefined;

		for (let i = start; i < end; i++) {
			const entry = visible[i]!;
			if (entry.group.id !== previousGroupId) {
				const marker = entry.group.collapsible ? "▾ " : "";
				lines.push(this.theme.heading(`${marker}${entry.group.title}`));
				previousGroupId = entry.group.id;
			}
			this.renderItem(lines, entry.item, !this.focusedGroupId && i === this.selectedIndex, width, entry.group.collapsible);
		}

		if (start > 0 || end < visible.length) lines.push(this.theme.scrollInfo(`  (${this.selectedIndex + 1}/${visible.length})`));
		return lines;
	}

	private renderItem(lines: string[], item: SelectItem, selected: boolean, width: number, nested = false): void {
		const groupIndent = nested ? "  " : "";
		const prefix = width >= 2 ? `${groupIndent}${selected ? "→ " : "  "}` : "";
		const labelWidth = Math.max(1, width - prefix.length);
		const hasDefaultMarker = item.label.startsWith("[default] ");
		const labelText = hasDefaultMarker ? item.label.slice("[default] ".length) : item.label;
		const modelLabel = selected ? this.theme.selectedText(labelText) : labelText;
		const label = hasDefaultMarker ? `${this.theme.description("[default] ")}${modelLabel}` : modelLabel;
		const inlineDetails = (item as SelectItem & { inlineDetails?: string[] }).inlineDetails;
		if (selected && inlineDetails) {
			lines.push(`${prefix}${label}`);
			lines.push(...inlineDetails.map((line) => this.theme.description(`│       ${line}`)));
			return;
		}
		const description = item.description ? `  ${item.description}` : "";
		if (visibleWidth(item.label) + visibleWidth(description) <= labelWidth) {
			lines.push(`${prefix}${label}${this.theme.description(description)}`);
			return;
		}
		const labelLines = wrapTextWithAnsi(label, labelWidth);
		lines.push(...labelLines.map((line, lineIndex) => `${lineIndex === 0 ? prefix : " ".repeat(prefix.length)}${line}`));
		if (item.description) {
			const indent = " ".repeat(Math.min(4, Math.max(0, width - 1)));
			const descriptionLines = wrapTextWithAnsi(this.theme.description(item.description), Math.max(1, width - indent.length));
			lines.push(...descriptionLines.map((line) => `${indent}${line}`));
		}
	}

	handleInput(data: string): void {
		const visible = this.visibleItems;
		if (matchesKey(data, Key.up) || matchesKey(data, Key.down)) {
			if (visible.length === 0 && !this.focusedGroupId) return;
			if (this.focusedGroupId) {
				const direction = matchesKey(data, Key.up) ? -1 : 1;
				if (visible.length > 0) {
					this.focusedGroupId = undefined;
					this.selectedIndex = direction > 0 ? 0 : visible.length - 1;
					this.onSelectionChange?.(visible[this.selectedIndex]!.item);
				}
				this.onStateChange?.();
				return;
			}
			const direction = matchesKey(data, Key.up) ? -1 : 1;
			const collapsedGroups = this.groups.filter((group) => this.collapsed.has(group.id));
			if (collapsedGroups.length > 0 && ((direction < 0 && this.selectedIndex === 0) || (direction > 0 && this.selectedIndex === visible.length - 1))) {
				this.focusedGroupId = direction < 0 ? collapsedGroups[collapsedGroups.length - 1]!.id : collapsedGroups[0]!.id;
				this.onStateChange?.();
				return;
			}
			this.selectedIndex = (this.selectedIndex + direction + visible.length) % visible.length;
			this.onSelectionChange?.(visible[this.selectedIndex]!.item);
			return;
		}
		if (matchesKey(data, Key.left) || matchesKey(data, Key.right)) {
			const focusedGroup = this.groups.find((group) => group.id === this.focusedGroupId);
			if (focusedGroup && this.collapsed.has(focusedGroup.id)) {
				if (matchesKey(data, Key.right)) {
					this.collapsed.delete(focusedGroup.id);
					this.focusedGroupId = undefined;
					this.selectedIndex = Math.max(0, this.visibleItems.findIndex((entry) => entry.group.id === focusedGroup.id));
					const selected = this.visibleItems[this.selectedIndex];
					if (selected) this.onSelectionChange?.(selected.item);
					this.onStateChange?.();
				}
				return;
			}
			const group = visible[this.selectedIndex]?.group;
			if (group?.collapsible) {
				if (matchesKey(data, Key.left)) {
					this.collapsed.add(group.id);
					this.focusedGroupId = group.id;
					const groupIndex = this.groups.indexOf(group);
					const nextGroup = this.groups.slice(groupIndex + 1).find((candidate) => !this.collapsed.has(candidate.id) && candidate.items.length > 0);
					this.selectedIndex = nextGroup ? this.visibleItems.findIndex((entry) => entry.group.id === nextGroup.id) : 0;
				} else {
					this.collapsed.delete(group.id);
					this.focusedGroupId = undefined;
					this.selectedIndex = this.visibleItems.findIndex((entry) => entry.group.id === group.id);
				}
				const selected = this.visibleItems[this.selectedIndex];
				if (selected) this.onSelectionChange?.(selected.item);
				this.onStateChange?.();
			}
			return;
		}
		if (matchesKey(data, Key.ctrl("g"))) {
			const collapsible = this.groups.filter((group) => group.collapsible);
			const shouldExpand = this.allGroupsCollapsed();
			for (const group of collapsible) shouldExpand ? this.collapsed.delete(group.id) : this.collapsed.add(group.id);
			this.focusedGroupId = shouldExpand ? undefined : collapsible[0]?.id;
			this.selectedIndex = Math.max(0, Math.min(this.selectedIndex, this.visibleItems.length - 1));
			const selected = this.visibleItems[this.selectedIndex];
			if (selected) this.onSelectionChange?.(selected.item);
			this.onStateChange?.();
			return;
		}
		if (matchesKey(data, Key.ctrl("h"))) {
			const item = this.getSelectedItem();
			if (item) this.onToggleHidden?.(item);
		} else if (matchesKey(data, Key.ctrl("f"))) {
			const item = this.getSelectedItem();
			if (item) this.onToggleFavorite?.(item);
		} else if (matchesKey(data, Key.ctrl("s"))) {
			const item = this.getSelectedItem();
			if (item) this.onSaveDefault?.(item);
		} else if (matchesKey(data, Key.enter)) {
			const item = this.getSelectedItem();
			if (item) this.onSelect?.(item);
		} else if (matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl("c"))) {
			this.onCancel?.();
		}
	}
}

function pickModel(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	config: PickerConfig,
	includeCurrentInRecents = false,
): Promise<void> {
	// Пикер — TUI-only фича
	if (!ctx.hasUI || ctx.mode !== "tui") return Promise.resolve();

	const available = ctx.modelRegistry.getAvailable();
	if (available.length === 0) {
		ctx.ui.notify("new-model-picker: no available models", "warning");
		return Promise.resolve();
	}

	const current = ctx.model;
	const currentKey = current ? keyOf(current) : "";
	// Не полагаемся только на ctx.model: после /new он может отличаться от
	// настройки по умолчанию, а Enter должен выбирать именно defaultModel.
	const configuredDefaultKey = getConfiguredDefaultKey(available);
	let defaultKey = configuredDefaultKey || currentKey;
	const defaultThinkingLevel = getConfiguredDefaultThinkingLevel() || ctx.thinkingLevel;

	// Недавние: только те, что ещё существуют в реестре, без дублей
	const seen = new Set<string>();
	const entryKey = (e: RecentEntry): string => `${e.provider}/${e.id}`;
	const recentKeys = loadRecents()
		.map(entryKey)
		.filter((k) => {
			if (seen.has(k) || !available.some((m) => keyOf(m) === k)) return false;
			seen.add(k);
			return true;
		})
		.slice(0, config.maxRecents);
	const recentSet = new Set(recentKeys);
	let favoriteKeys = loadFavorites()
		.map(entryKey)
		.filter((key, index, keys) => keys.indexOf(key) === index && available.some((model) => keyOf(model) === key));
	let hiddenKeys = loadHidden()
		.map(entryKey)
		.filter((key, index, keys) => keys.indexOf(key) === index && available.some((model) => keyOf(model) === key));
	let manageMode: "favorites" | "hidden" | null = null;

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

	const descriptionOf = (m: Model<Api>): string => {
		// Rates are USD per 1M tokens: read/input, write/output, and cache read.
		let text = `${formatContext(m.contextWindow)}  |  $ R${formatNumber(m.cost.input)} W${formatNumber(m.cost.output)} C${formatNumber(m.cost.cacheRead)}`;
		if (!ctx.modelRegistry.hasConfiguredAuth(m)) text += " · no auth";
		return text;
	};

	const itemOf = (model: Model<Api>): SelectItem => ({
		value: keyOf(model),
		label: labelOf(model),
		description: descriptionOf(model),
		inlineDetails: [
			`${model.provider} · ${formatContext(model.contextWindow)} · ${model.reasoning ? `reasoning: available · default: ${defaultThinkingLevel}` : "reasoning: unavailable"}`,
			`↑ Read: ${formatNumber(model.cost.input)}$   ↓ Write: ${formatNumber(model.cost.output)}$   Cache: ${formatNumber(model.cost.cacheRead)}$ / 1M tokens`,
		],
	} as SelectItem & { inlineDetails: string[] });

	const groupsFor = (query: string): ModelGroup[] => {
		const q = query.trim().toLowerCase();
		const matching = ordered.filter((model) => (manageMode || !hiddenKeys.includes(keyOf(model))) && fuzzyMatch(q, `${keyOf(model)} ${model.name ?? ""}`));
		const providerGroups = new Map<string, SelectItem[]>();
		for (const model of matching) {
			const group = providerGroups.get(model.provider) ?? [];
			group.push(itemOf(model));
			providerGroups.set(model.provider, group);
		}
		const groups = [...providerGroups].map(([provider, items]) => ({
			id: `provider:${provider}`,
			title: provider,
			items,
			collapsible: true,
		}));

		// During search, show each match exactly once in its provider group.
		if (manageMode) return groups;
		const hidden = hiddenKeys.map((key) => byKey.get(key)).filter((model): model is Model<Api> => !!model)
			.filter((model) => fuzzyMatch(q, `${keyOf(model)} ${model.name ?? ""}`));
		const hiddenGroup = hidden.length > 0 ? [{ id: "hidden", title: "Hidden", items: hidden.map(itemOf), collapsible: true }] : [];
		if (q) return [...groups, ...hiddenGroup];
		const favorites = favoriteKeys
			.filter((key) => !hiddenKeys.includes(key))
			.map((key) => byKey.get(key))
			.filter((model): model is Model<Api> => !!model);
		const favoriteGroup = favorites.length > 0 ? [{ id: "favorites", title: "Favorites", items: favorites.map(itemOf), collapsible: true }] : [];
		const preferredKeys = [defaultKey, ...(includeCurrentInRecents ? [currentKey] : []), ...recentKeys];
		const recentModels = preferredKeys
			.filter((key, index) => !!key && !hiddenKeys.includes(key) && preferredKeys.indexOf(key) === index)
			.map((key) => byKey.get(key))
			.filter((model): model is Model<Api> => !!model)
			.slice(0, config.maxRecents);
		const recentGroup = recentModels.length > 0 ? [{ id: "recent", title: "Recent", items: recentModels.map(itemOf), collapsible: true }] : [];
		return [...favoriteGroup, ...recentGroup, ...groups, ...hiddenGroup];
	};

	return ctx.ui.custom<Model<Api> | null>((tui, theme, _kb, done) => {
		const container = new Container();
		const borderColor = (s: string) => theme.fg("accent", s);
		const title = new Text(theme.fg("accent", theme.bold("Pick a model")));
		const search = new Input({ placeholder: "Filter (provider / model / name)…" });
		const listSlot = new Container();
		const details = new Text("");
		const help = new Text("");


		const listTheme = {
			selectedText: (t: string) => theme.fg("accent", t),
			description: (t: string) => theme.fg("muted", t),
			scrollInfo: (t: string) => theme.fg("dim", t),
			noMatch: (t: string) => theme.fg("warning", t),
			heading: (t: string) => theme.fg("accent", theme.bold(t)),
		};

		const updateDetails = (item: SelectItem | null) => {
			const model = item ? byKey.get(item.value) : undefined;
			if (!model) {
				details.setText("");
				return;
			}
			const displayName = model.name && model.name !== model.id ? `\n  ${model.name}` : "";
			const reasoning = model.reasoning
				? `reasoning: available · default: ${defaultThinkingLevel}`
				: "reasoning: unavailable";
			const pricing = `↑Read: ${formatNumber(model.cost.input)}$  ↓Write: ${formatNumber(model.cost.output)}$  Cache: ${formatNumber(model.cost.cacheRead)}$ per 1M tokens`;
			details.setText(theme.fg("dim", `  ${keyOf(model)}${displayName}\n  ${formatContext(model.contextWindow)} · ${reasoning}\n  ${pricing}`));
		};

		const toggleAutostart = (reason: "startup" | "new") => {
			const nextConfig = loadConfig();
			const enabled = nextConfig.reasons.includes(reason);
			nextConfig.reasons = enabled
				? nextConfig.reasons.filter((value) => value !== reason)
				: [...new Set([...nextConfig.reasons, reason])];
			if (saveConfig(nextConfig)) ctx.ui.notify(`Picker on ${reason}: ${enabled ? "off" : "on"}`, "info");
			else ctx.ui.notify("new-model-picker: could not save configuration", "error");
		};

		const updateHelp = (list: GroupedModelList) => {
			const groupAction = list.isGroupFocused()
				? "←→ show group"
				: "←→ collapse group";
			const allAction = list.allGroupsCollapsed() ? "ctrl+g show all groups" : "ctrl+g collapse all groups";
			help.setText(theme.fg("dim", `↑↓ select | enter apply | ctrl+s set default | ctrl+o settings | esc cancel\n${groupAction} | ${allAction}`));
		};

		const buildList = (query: string): GroupedModelList => {
			const groups = groupsFor(query);
			const list = new GroupedModelList(
				groups,
				// On narrow terminals a wrapped model needs two rows; reserve chrome for
				// Labels may wrap to two rows; preserve the fixed picker chrome first.
				() => Math.max(3, Math.min(14, Math.floor(((process.stdout.rows || 24) - 30) / 2))),
				listTheme,
				!!query.trim(),
			);
			// With an empty filter, Enter always confirms defaultModel from settings.json.
			if (!query.trim()) list.setSelectedValue(defaultKey);
			updateDetails(list.getSelectedItem());
			updateHelp(list);
			list.onSelectionChange = (item) => {
				updateDetails(item);
				title.setText(theme.fg("accent", theme.bold(`Pick a model (${list.positionLabel()})`)));
			};
			list.onStateChange = () => updateHelp(list);
			list.onToggleHidden = (item) => {
				if (!byKey.has(item.value)) return;
				hiddenKeys = hiddenKeys.includes(item.value)
					? hiddenKeys.filter((key) => key !== item.value)
					: [item.value, ...hiddenKeys];
				saveHidden(hiddenKeys.map((key) => {
					const hidden = byKey.get(key)!;
					return { provider: hidden.provider, id: hidden.id };
				}));
				ctx.ui.notify(hiddenKeys.includes(item.value) ? `Hidden: ${item.value}` : `Shown: ${item.value}`, "info");
				rebuild(search.getValue());
			};
			list.onToggleFavorite = (item) => {
				const model = byKey.get(item.value);
				if (!model) return;
				favoriteKeys = favoriteKeys.includes(item.value)
					? favoriteKeys.filter((key) => key !== item.value)
					: [item.value, ...favoriteKeys];
				saveFavorites(favoriteKeys.map((key) => {
					const favorite = byKey.get(key)!;
					return { provider: favorite.provider, id: favorite.id };
				}));
				ctx.ui.notify(favoriteKeys.includes(item.value) ? `Favorite: ${item.value}` : `Removed favorite: ${item.value}`, "info");
				rebuild(search.getValue());
			};
			list.onSaveDefault = (item) => {
				const model = byKey.get(item.value);
				if (!model || !saveConfiguredDefault(model)) {
					ctx.ui.notify("new-model-picker: could not save default model", "error");
					return;
				}
				defaultKey = keyOf(model);
				ctx.ui.notify(`Default model: ${defaultKey}`, "info");
				rebuild(search.getValue());
			};
			list.onSelect = (item) => {
				if (!manageMode) return done(byKey.get(item.value) ?? null);
				const keys = manageMode === "favorites" ? favoriteKeys : hiddenKeys;
				const nextKeys = keys.includes(item.value) ? keys.filter((key) => key !== item.value) : [item.value, ...keys];
				if (manageMode === "favorites") { favoriteKeys = nextKeys; saveFavorites(nextKeys.map((key) => ({ provider: byKey.get(key)!.provider, id: byKey.get(key)!.id }))); }
				else { hiddenKeys = nextKeys; saveHidden(nextKeys.map((key) => ({ provider: byKey.get(key)!.provider, id: byKey.get(key)!.id }))); }
				rebuild(search.getValue());
			};
			list.onCancel = () => {
				if (manageMode) { manageMode = null; rebuild(""); }
				else done(null);
			};
			return list;
		};

		let settingsOpen = false;
		let settingsIndex = 0;
		let selectList = buildList("");
		listSlot.addChild(selectList);

		container.addChild(title);
		container.addChild(search);
		container.addChild(listSlot);
		container.addChild(help);

		const rebuild = (query: string) => {
			listSlot.clear();
			selectList = buildList(query);
			listSlot.addChild(selectList);
		};

		return {
			render: (width: number) => {
				const innerWidth = Math.max(1, width - 2);
				const config = loadConfig();
				const settingsLines = [
					theme.fg("accent", theme.bold("Settings")),
					`${settingsIndex === 0 ? "→ " : "  "}[${config.reasons.includes("startup") ? "x" : " "}] Show picker on application startup`,
					`${settingsIndex === 1 ? "→ " : "  "}[${config.reasons.includes("new") ? "x" : " "}] Show picker on new session`,
					`${settingsIndex === 2 ? "→ " : "  "}Manage Favorites (Ctrl+F in picker)`,
					`${settingsIndex === 3 ? "→ " : "  "}Manage Hidden models (Ctrl+H in picker)`,
					theme.fg("dim", "↑↓ select | enter toggle/open | esc back"),
				];
				const content = settingsOpen ? settingsLines : container.render(innerWidth);
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
				if (settingsOpen) {
					if (matchesKey(data, Key.escape)) settingsOpen = false;
					else if (matchesKey(data, Key.up)) settingsIndex = (settingsIndex + 3) % 4;
					else if (matchesKey(data, Key.down)) settingsIndex = (settingsIndex + 1) % 4;
					else if (matchesKey(data, Key.enter) && settingsIndex < 2) toggleAutostart(settingsIndex === 0 ? "startup" : "new");
					else if (matchesKey(data, Key.enter)) {
						manageMode = settingsIndex === 2 ? "favorites" : "hidden";
						settingsOpen = false;
						search.setValue("");
						rebuild("");
					}
				} else if (data === "\x03") {
					// ctrl+c
					done(null);
				} else if (matchesKey(data, Key.ctrl("o"))) {
					settingsOpen = true;
				} else if (
					matchesKey(data, Key.up) ||
					matchesKey(data, Key.down) ||
					matchesKey(data, Key.left) ||
					matchesKey(data, Key.right) ||
					matchesKey(data, Key.enter) ||
					matchesKey(data, Key.escape) ||
					matchesKey(data, Key.ctrl("c")) ||
					matchesKey(data, Key.ctrl("f")) ||
					matchesKey(data, Key.ctrl("h")) ||
					matchesKey(data, Key.ctrl("g")) ||
					matchesKey(data, Key.ctrl("s"))
				) {
					selectList.handleInput(data);
				} else {
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
			width: "92%",
			maxHeight: "90%",
			margin: 1,
		},
	}).then(async (result) => {
		if (!result) return; // Esc — оставить текущую модель

		if (keyOf(result) === currentKey) {
			ctx.ui.notify(`Model unchanged: ${keyOf(result)}`, "info");
			return;
		}

		const ok = await pi.setModel(result);
		if (!ok) {
			ctx.ui.notify(`new-model-picker: no authorization for ${keyOf(result)}`, "error");
			return;
		}

		// Сохранить в недавние (наверх)
		const entry: RecentEntry = { provider: result.provider, id: result.id };
		const next = [entry, ...loadRecents().filter((e) => !(e.provider === entry.provider && e.id === entry.id))];
		saveRecents(next);

		ctx.ui.notify(`Model: ${keyOf(result)}`, "info");
	});
}

export default function (pi: ExtensionAPI) {
	// Конфиг читаем на каждый session_start — правки подхватываются без /reload
	pi.on("session_start", async (event, ctx) => {
		const ui = ctx.ui as unknown as Record<PropertyKey, unknown>;
		if (!ui[AUTOCOMPLETE_UI_MARKER]) {
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
			ui[AUTOCOMPLETE_UI_MARKER] = true;
		}

		const config = loadConfig();
		if (!config.reasons.includes(event.reason)) return;
		await pickModel(pi, ctx, config, false);
	});

	pi.registerCommand("model-picker", {
		description: "Choose a model (enhanced picker)",
		handler: async (_args, ctx) => {
			await pickModel(pi, ctx, loadConfig(), true);
		},
	});

}
