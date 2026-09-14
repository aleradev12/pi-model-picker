/**
 * Pure core of the model picker: persistence, fuzzy matching, grouping and
 * the grouped list widget. No pi imports here — everything is injectable so
 * it can be unit-tested with a temp directory and synthetic models.
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { Key, matchesKey, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";

/** Structural subset of pi-ai's Model — Model<Api> is assignable to this. */
export interface PickerModel {
	provider: string;
	id: string;
	name: string;
}

export interface PickerConfig {
	reasons: string[];
	maxRecents: number;
}

export interface RecentEntry {
	provider: string;
	id: string;
}

interface AgentSettings {
	defaultProvider?: unknown;
	defaultModel?: unknown;
	defaultThinkingLevel?: unknown;
}

const VALID_REASONS = new Set(["startup", "new", "resume", "fork"]);
const MAX_RECENT_ENTRIES = 20;

export const keyOf = (m: PickerModel): string => `${m.provider}/${m.id}`;

export function isValidReason(reason: string): boolean {
	return VALID_REASONS.has(reason);
}

/**
 * Chrome lines around the list inside the overlay: box border (2), title (1),
 * search input (1), fixed model details (2), help (2), plus slack.
 */
const OVERLAY_CHROME_LINES = 2 + 1 + 1 + 2 + 2 + 2;
/** The overlay may use the full terminal height (overlayOptions). */
const OVERLAY_MAX_HEIGHT_FRACTION = 1;

/**
 * Conservative rendered-line budget for the list viewport. Everything outside
 * the list (overlay chrome, borders, title, search, help) is fixed, and the
 * overlay may use the full terminal height — so on small
 * terminals the budget shrinks instead of letting the overlay truncate it.
 */
export function listLineBudget(termRows: number | undefined, fallbackRows = 24, maxLines = 26): number {
	const rows = termRows && termRows > 0 ? termRows : fallbackRows;
	const overlayHeight = Math.max(1, Math.floor(rows * OVERLAY_MAX_HEIGHT_FRACTION));
	return Math.max(1, Math.min(maxLines, overlayHeight - OVERLAY_CHROME_LINES));
}

function readJson(path: string): unknown {
	return JSON.parse(readFileSync(path, "utf8"));
}

/** Atomic JSON write: mkdir -p the parent, write a temp file, rename over. */
function writeJson(path: string, data: unknown, pretty: "\t" | 2 = "\t"): void {
	mkdirSync(dirname(path), { recursive: true });
	const tmp = `${path}.${process.pid}.tmp`;
	writeFileSync(tmp, `${JSON.stringify(data, null, pretty)}\n`);
	renameSync(tmp, path);
}

export interface Store {
	configPath: () => string;
	recentsPath: () => string;
	favoritesPath: () => string;
	hiddenPath: () => string;
	settingsPath: () => string;
	loadConfig: () => PickerConfig;
	saveConfig: (config: PickerConfig) => boolean;
	loadEntries: (path: string) => RecentEntry[];
	saveEntries: (path: string, entries: RecentEntry[]) => boolean;
	loadRecents: () => RecentEntry[];
	saveRecents: (entries: RecentEntry[]) => boolean;
	loadFavorites: () => RecentEntry[];
	saveFavorites: (entries: RecentEntry[]) => boolean;
	loadHidden: () => RecentEntry[];
	saveHidden: (entries: RecentEntry[]) => boolean;
	/** Configured default key ("provider/id") resolved against available models. */
	getConfiguredDefaultKey: (available: PickerModel[]) => string;
	getConfiguredDefaultThinkingLevel: () => string;
	/** Persists defaultProvider/defaultModel into settings.json, preserving other keys. */
	saveConfiguredDefault: (model: PickerModel) => boolean;
}

export function createStore(agentDir: string): Store {
	const pathOf = (file: string) => join(agentDir, file);

	const isEntry = (e: unknown): e is RecentEntry =>
		!!e && typeof e === "object" && typeof (e as RecentEntry).provider === "string" && typeof (e as RecentEntry).id === "string";

	const loadEntries = (path: string): RecentEntry[] => {
		try {
			const raw: unknown = readJson(path);
			return Array.isArray(raw) ? raw.filter(isEntry) : [];
		} catch {
			return [];
		}
	};

	const saveEntries = (path: string, entries: RecentEntry[]): boolean => {
		try {
			writeJson(path, entries);
			return true;
		} catch {
			// Optional picker state must never block model selection.
			return false;
		}
	};

	const loadSettings = (createIfMissing = false): AgentSettings | null => {
		try {
			const raw: unknown = readJson(pathOf("settings.json"));
			return !!raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as AgentSettings) : null;
		} catch (error) {
			// A missing settings.json is not malformed data: callers that write
			// settings may bootstrap it; readers just see an empty settings file.
			if (createIfMissing && (error as NodeJS.ErrnoException)?.code === "ENOENT") return {};
			return null;
		}
	};

	return {
		configPath: () => pathOf("new-model-picker.json"),
		recentsPath: () => pathOf("new-model-picker-recents.json"),
		favoritesPath: () => pathOf("new-model-picker-favorites.json"),
		hiddenPath: () => pathOf("new-model-picker-hidden.json"),
		settingsPath: () => pathOf("settings.json"),

		loadConfig: () => {
			const defaults: PickerConfig = { reasons: ["startup", "new"], maxRecents: 5 };
			try {
				const raw = readJson(pathOf("new-model-picker.json")) as Partial<PickerConfig>;
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
		},

		saveConfig: (config) => {
			try {
				writeJson(pathOf("new-model-picker.json"), config, 2);
				return true;
			} catch {
				return false;
			}
		},

		loadEntries,
		saveEntries,
		loadRecents: () => loadEntries(pathOf("new-model-picker-recents.json")),
		saveRecents: (entries) => saveEntries(pathOf("new-model-picker-recents.json"), entries.slice(0, MAX_RECENT_ENTRIES)),
		loadFavorites: () => loadEntries(pathOf("new-model-picker-favorites.json")),
		saveFavorites: (entries) => saveEntries(pathOf("new-model-picker-favorites.json"), entries),
		loadHidden: () => loadEntries(pathOf("new-model-picker-hidden.json")),
		saveHidden: (entries) => saveEntries(pathOf("new-model-picker-hidden.json"), entries),

		getConfiguredDefaultKey: (available) => {
			const settings = loadSettings();
			if (typeof settings?.defaultProvider !== "string" || typeof settings?.defaultModel !== "string") {
				return "";
			}
			// defaultModel historically stored a display name; id is canonical.
			const model = available.find(
				(m) => m.provider === settings.defaultProvider && (m.id === settings.defaultModel || m.name === settings.defaultModel),
			);
			return model ? keyOf(model) : "";
		},

		getConfiguredDefaultThinkingLevel: () => {
			const level = loadSettings()?.defaultThinkingLevel;
			return typeof level === "string" ? level : "";
		},

		saveConfiguredDefault: (model) => {
			const settings = loadSettings(true);
			// A malformed settings.json is user data — refuse to overwrite it.
			if (!settings) return false;
			try {
				writeJson(pathOf("settings.json"), { ...settings, defaultProvider: model.provider, defaultModel: model.id }, 2);
				return true;
			} catch {
				return false;
			}
		},
	};
}

/** Fuzzy match: every character of query appears in target in order. */
export function fuzzyMatch(query: string, target: string): boolean {
	if (!query) return true;
	let i = 0;
	const q = query.toLowerCase();
	const t = target.toLowerCase();
	for (const ch of t) {
		if (ch === q[i]) i++;
		if (i >= q.length) return true;
	}
	return i >= q.length;
}

export interface ListItem {
	value: string;
	label: string;
	description?: string;
	inlineDetails?: string[];
}

export interface ModelGroup {
	id: string;
	title: string;
	items: ListItem[];
	collapsible: boolean;
	initiallyCollapsed?: boolean;
}

export type ManageMode = "favorites" | "hidden" | null;

export interface GroupingInput {
	/** All available models in stable display order. */
	ordered: PickerModel[];
	query: string;
	manageMode: ManageMode;
	favoriteKeys: string[];
	hiddenKeys: string[];
	recentKeys: string[];
	defaultKey: string;
	currentKey: string;
	maxRecents: number;
	itemOf: (model: PickerModel) => ListItem;
}

const matchesQuery = (model: PickerModel, name: string, q: string): boolean => fuzzyMatch(q, `${model.provider}/${model.id} ${name}`);

/**
 * Builds the display groups:
 *  - management mode: provider groups only, hidden models included;
 *  - ordinary mode: Favorites, provider groups, Hidden (last);
 *  - search: visible matches by provider; hidden matches stay in a collapsed
 *    Hidden group.
 */
export function buildGroups(input: GroupingInput): ModelGroup[] {
	const { ordered, query, manageMode, favoriteKeys, hiddenKeys, recentKeys, defaultKey, currentKey, maxRecents, itemOf } = input;
	const q = query.trim().toLowerCase();

	const byKey = new Map(ordered.map((m) => [keyOf(m), m]));
	const itemWithProvider = (model: PickerModel): ListItem => ({ ...itemOf(model), description: `· ${model.provider}` });
	const visible = (key: string): boolean => manageMode !== null || !hiddenKeys.includes(key);

	const matching = ordered.filter((m) => visible(keyOf(m)) && matchesQuery(m, m.name ?? "", q));
	const providerGroups = new Map<string, ListItem[]>();
	for (const model of matching) {
		const group = providerGroups.get(model.provider) ?? [];
		group.push(itemOf(model));
		providerGroups.set(model.provider, group);
	}
	const groups: ModelGroup[] = [...providerGroups].map(([provider, items]) => ({
		id: `provider:${provider}`,
		title: provider,
		items,
		collapsible: true,
	}));

	if (manageMode) return groups;

	const hidden = hiddenKeys
		.map((key) => byKey.get(key))
		.filter((m): m is PickerModel => !!m)
		.filter((m) => matchesQuery(m, m.name ?? "", q));
	const hiddenGroup: ModelGroup[] =
		hidden.length > 0
			? [{ id: "hidden", title: "Hidden", items: hidden.map(itemWithProvider), collapsible: true, initiallyCollapsed: true }]
			: [];

	if (q) {
		const favoriteMatchKeys = new Set(favoriteKeys.filter((key) => visible(key) && matching.some((model) => keyOf(model) === key)));
		const favoriteMatches = favoriteKeys
			.filter((key) => favoriteMatchKeys.has(key))
			.map((key) => byKey.get(key))
			.filter((model): model is PickerModel => !!model);
		const favoriteMatchesGroup: ModelGroup[] = favoriteMatches.length > 0
			? [{
				id: "favorites",
				title: "Favorites",
				items: favoriteMatches.map(itemWithProvider),
				collapsible: true,
			}]
			: [];
		const remainingProviderGroups = groups
			.map((group) => ({ ...group, items: group.items.filter((item) => !favoriteMatchKeys.has(item.value)) }))
			.filter((group) => group.items.length > 0);
		return [...favoriteMatchesGroup, ...remainingProviderGroups, ...hiddenGroup];
	}

	const favorites = favoriteKeys
		.filter((key) => visible(key))
		.map((key) => byKey.get(key))
		.filter((m): m is PickerModel => !!m);
	const favoriteGroup: ModelGroup[] = favorites.length > 0
		? [{
			id: "favorites",
			title: "Favorites",
			items: favorites.map(itemWithProvider),
			collapsible: true,
		}]
		: [];

	const preferredKeys = [defaultKey, currentKey, ...recentKeys].filter((key, index, keys) => !!key && visible(key) && keys.indexOf(key) === index);
	return [...favoriteGroup, ...groups, ...hiddenGroup];
}

export interface ListTheme {
	selectedText: (text: string) => string;
	selectedHeading: (text: string) => string;
	description: (text: string) => string;
	scrollInfo: (text: string) => string;
	noMatch: (text: string) => string;
	heading: (text: string) => string;
}

const matchesCancel = (data: string): boolean => matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl("c")) || data === "\x03";

type Row = { kind: "header"; group: ModelGroup } | { kind: "item"; item: ListItem; group: ModelGroup };

/**
 * Grouped model list with one display row model. Items and collapsed headers
 * are focusable; expanded headers remain visible labels and are skipped by
 * Up/Down.
 *
 * Rendering is budgeted in rendered lines (selected rows may span several),
 * and everything is scrolled through one viewport window.
 */
export class GroupedModelList {
	public onSelect?: (item: ListItem) => void;
	public onCancel?: () => void;
	public onSelectionChange?: (item: ListItem | null) => void;
	public onSaveDefault?: (item: ListItem) => void;
	public onToggleFavorite?: (item: ListItem) => void;
	public onToggleHidden?: (item: ListItem) => void;
	public onStateChange?: () => void;

	private index = 0;
	private readonly collapsed = new Set<string>();

	private readonly groups: ModelGroup[];
	private readonly maxLines: () => number;
	private readonly theme: ListTheme;

	constructor(groups: ModelGroup[], maxLines: () => number, theme: ListTheme) {
		this.groups = groups;
		this.maxLines = maxLines;
		this.theme = theme;
		for (const group of groups) if (group.initiallyCollapsed) this.collapsed.add(group.id);
		const firstFocusable = this.rows.findIndex((row) => this.isFocusable(row));
		this.index = firstFocusable >= 0 ? firstFocusable : 0;
	}

	private get rows(): Row[] {
		return this.groups.flatMap((group) => {
			const header: Row = { kind: "header", group };
			if (!group.collapsible || !this.collapsed.has(group.id)) {
				return [header, ...group.items.map((item): Row => ({ kind: "item", item, group }))];
			}
			return [header];
		});
	}

	private isFocusable(row: Row): boolean {
		return row.kind === "item" || (row.group.collapsible && this.collapsed.has(row.group.id));
	}

	// Rows are recreated on every `rows` access, so position must be derived
	// from the cursor index, never from object identity.
	private rowItemNumber(rowIndex: number): { position: number; total: number } {
		let position = 0;
		let total = 0;
		this.rows.forEach((candidate, i) => {
			if (candidate.kind !== "item") return;
			total++;
			if (i <= rowIndex) position = total;
		});
		return { position, total };
	}

	private notifySelection(): void {
		const row = this.rows[this.index];
		this.onSelectionChange?.(row?.kind === "item" ? row.item : null);
	}

	setSelectedValue(value: string): void {
		const index = this.rows.findIndex((row) => row.kind === "item" && row.item.value === value);
		if (index >= 0) this.index = index;
	}

	getSelectedItem(): ListItem | null {
		const row = this.rows[this.index];
		return row?.kind === "item" ? row.item : null;
	}

	/** Next distinct item in display order, or the previous one when absent. */
	fallbackValueAfterRemoval(): string {
		const rows = this.rows;
		const removedValue = this.getSelectedItem()?.value;
		for (let index = this.index + 1; index < rows.length; index++) {
			if (rows[index]!.kind === "item" && rows[index]!.item.value !== removedValue) return rows[index]!.item.value;
		}
		for (let index = this.index - 1; index >= 0; index--) {
			if (rows[index]!.kind === "item" && rows[index]!.item.value !== removedValue) return rows[index]!.item.value;
		}
		return "";
	}

	isGroupFocused(): boolean {
		return this.rows[this.index]?.kind === "header";
	}

	positionLabel(): string {
		const { position, total } = this.rowItemNumber(this.index);
		return `${position}/${total}`;
	}

	allGroupsCollapsed(): boolean {
		const collapsible = this.groups.filter((group) => group.collapsible);
		return collapsible.length > 0 && collapsible.every((group) => this.collapsed.has(group.id));
	}

	private toggleGroup(group: ModelGroup): void {
		if (!group.collapsible) return;
		const expanding = this.collapsed.has(group.id);
		if (expanding) this.collapsed.delete(group.id);
		else this.collapsed.add(group.id);
		const rows = this.rows;
		const target = expanding
			? rows.find((row) => row.kind === "item" && row.group.id === group.id)
			: rows.find((row) => row.kind === "header" && row.group.id === group.id);
		this.index = target ? rows.indexOf(target) : Math.min(this.index, rows.length - 1);
		this.notifySelection();
		this.onStateChange?.();
	}

	handleInput(data: string): void {
		const rows = this.rows;
		if (rows.length === 0) {
			if (matchesCancel(data)) this.onCancel?.();
			return;
		}
		if (matchesKey(data, Key.up) || matchesKey(data, Key.down)) {
			const direction = matchesKey(data, Key.up) ? -1 : 1;
			for (let step = 1; step <= rows.length; step++) {
				const candidate = (this.index + direction * step + rows.length) % rows.length;
				if (this.isFocusable(rows[candidate]!)) {
					this.index = candidate;
					break;
				}
			}
			this.notifySelection();
			this.onStateChange?.();
			return;
		}
		if (matchesKey(data, Key.left) || matchesKey(data, Key.right)) {
			const row = rows[this.index]!;
			const group = row.kind === "header" ? row.group : row.group;
			if (group.collapsible && matchesKey(data, Key.left) && !this.collapsed.has(group.id)) {
				this.toggleGroup(group);
			} else if (group.collapsible && matchesKey(data, Key.right) && this.collapsed.has(group.id)) {
				this.toggleGroup(group);
			}
			return;
		}
		if (matchesKey(data, Key.ctrl("g"))) {
			const shouldExpand = this.allGroupsCollapsed();
			const focusedGroupId = rows[this.index]?.group.id;
			for (const group of this.groups) if (group.collapsible) shouldExpand ? this.collapsed.delete(group.id) : this.collapsed.add(group.id);
			const after = this.rows;
			if (!shouldExpand) {
				const target = after.find((candidate) => candidate.kind === "header" && candidate.group.id === focusedGroupId)
					?? after.find((candidate) => candidate.kind === "header");
				this.index = target ? after.indexOf(target) : 0;
			} else {
				const target = after.find((candidate) => candidate.kind === "item" && candidate.group.id === focusedGroupId)
					?? after.find((candidate) => candidate.kind === "item");
				this.index = target ? after.indexOf(target) : 0;
			}
			this.notifySelection();
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
			const row = this.rows[this.index]!;
			if (row.kind === "header") {
				this.toggleGroup(row.group);
			} else {
				this.onSelect?.(row.item);
			}
		} else if (matchesCancel(data)) {
			this.onCancel?.();
		}
	}

	render(width: number): string[] {
		const rows = this.rows;
		if (rows.length === 0) return [this.theme.noMatch("  No matches")];

		const rendered = rows.map((row) => this.renderRow(row, width));
		const budget = Math.max(1, this.maxLines());
		const selectedHeight = rendered[this.index]!.length;
		if (selectedHeight >= budget) return rendered[this.index]!.slice(0, budget);

		// Keep one stable status row and center the selected block in the remaining
		// viewport. Missing content near either edge becomes blank padding, so the
		// cursor never drifts up or down while navigating.
		const contentBudget = Math.max(1, budget - 1);
		const targetBefore = Math.floor(Math.max(0, contentBudget - selectedHeight) / 2);
		const targetAfter = contentBudget - selectedHeight - targetBefore;
		let start = this.index;
		let before = 0;
		while (start > 0 && before + rendered[start - 1]!.length <= targetBefore) {
			start--;
			before += rendered[start]!.length;
		}
		let end = this.index + 1;
		let after = 0;
		while (end < rows.length && after + rendered[end]!.length <= targetAfter) {
			after += rendered[end]!.length;
			end++;
		}

		const lines: string[] = Array.from({ length: targetBefore - before }, () => "");
		for (let index = start; index < end; index++) lines.push(...rendered[index]!);
		while (lines.length < contentBudget) lines.push("");

		const truncated = start > 0 || end < rows.length;
		if (budget > 1) {
			const hidden = rows.length - (end - start);
			lines.push(truncated ? this.theme.scrollInfo(`  … ${hidden} hidden (↑↓ to scroll)`) : "");
		}
		return lines;
	}

	private renderRow(row: Row, width: number): string[] {
		if (row.kind === "header") {
			const collapsed = row.group.collapsible && this.collapsed.has(row.group.id);
			const focusedRow = this.rows[this.index];
			const focused = focusedRow?.kind === "header" && focusedRow.group.id === row.group.id;
			const marker = row.group.collapsible ? (collapsed ? "▸" : "▾") : " ";
			const label = `${marker} ${row.group.title}`;
			return [focused ? this.theme.selectedHeading(`→ ${label}`) : this.theme.heading(`  ${label}`)];
		}
		return this.renderItem(row.item, width);
	}

	private renderItem(item: ListItem, width: number): string[] {
		const selected = this.rows[this.index]?.kind === "item" && this.rows[this.index]!.item === item;
		// Models are indented relative to group headings; the arrow occupies the
		// same model column without shifting the label.
		const prefix = width >= 4 ? (selected ? "  → " : "    ") : selected ? "→ " : "  ";
		const labelWidth = Math.max(1, width - prefix.length);
		const hasDefaultMarker = item.label.startsWith("[default] ");
		const labelText = hasDefaultMarker ? item.label.slice("[default] ".length) : item.label;
		const label = hasDefaultMarker ? `${this.theme.description("[default] ")}${labelText}` : labelText;

		const description = item.description ? `  ${item.description}` : "";
		if (!(selected && item.inlineDetails?.length) && visibleWidth(item.label) + visibleWidth(description) <= labelWidth) {
			const line = `${prefix}${label}${this.theme.description(description)}`;
			return [selected ? this.theme.selectedText(line) : line];
		}

		const lines: string[] = [];
		const labelLines = wrapTextWithAnsi(label, labelWidth);
		lines.push(...labelLines.map((line, lineIndex) => {
			const rendered = `${lineIndex === 0 ? prefix : " ".repeat(prefix.length)}${line}`;
			return selected ? this.theme.selectedText(rendered) : rendered;
		}));
		if (selected && item.inlineDetails?.length) {
			const indent = "        ";
			const detailWidth = Math.max(1, width - indent.length);
			for (const detail of item.inlineDetails) {
				lines.push(...wrapTextWithAnsi(this.theme.description(detail), detailWidth).map((line) => `${indent}${line}`));
			}
		} else if (item.description) {
			const indent = " ".repeat(Math.min(4, Math.max(0, width - 1)));
			const descriptionLines = wrapTextWithAnsi(this.theme.description(item.description), Math.max(1, width - indent.length));
			lines.push(...descriptionLines.map((line) => `${indent}${line}`));
		}
		return lines;
	}
}
