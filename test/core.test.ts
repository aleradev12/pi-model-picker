import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	buildGroups,
	createStore,
	fuzzyMatch,
	GroupedModelList,
	keyOf,
	listLineBudget,
	type ListTheme,
	type ListItem,
	type ModelGroup,
	type PickerModel,
} from "../core.ts";

const plainTheme: ListTheme = {
	selectedText: (t) => t,
	selectedHeading: (t) => `[selected]${t}`,
	description: (t) => t,
	scrollInfo: (t) => t,
	noMatch: (t) => t,
	heading: (t) => t,
};

const model = (provider: string, id: string, name = ""): PickerModel => ({
	provider,
	id,
	name: name || id,
});

const item = (value: string): ListItem => ({ value, label: value });
const group = (id: string, items: string[], collapsible = true): ModelGroup => ({
	id,
	title: id,
	items: items.map(item),
	collapsible,
});

test("fuzzyMatch matches in-order subsequences, case-insensitively", () => {
	assert.equal(fuzzyMatch("", "anything"), true);
	assert.equal(fuzzyMatch("abc", "a1b2c3"), true);
	assert.equal(fuzzyMatch("ABC", "xyzabc"), true);
	assert.equal(fuzzyMatch("ac", "ca"), false);
	assert.equal(fuzzyMatch("openai", "openai/gpt-5"), true);
	assert.equal(fuzzyMatch("gpt5", "openai/gpt-5"), true);
});

test("keyOf uses provider/id", () => {
	assert.equal(keyOf(model("openai", "gpt-5")), "openai/gpt-5");
});

type ListResult = {
	list: GroupedModelList;
	events: { selected: string[]; select: string[]; state: number };
};

const makeList = (groups: ModelGroup[], maxLines = 100): ListResult => {
	const events = { selected: [] as string[], select: [] as string[], state: 0 };
	const list = new GroupedModelList(groups, () => maxLines, plainTheme);
	list.onSelectionChange = (i) => events.selected.push(i?.value ?? "header");
	list.onSelect = (i) => events.select.push(i.value);
	list.onStateChange = () => events.state++;
	return { list, events };
};

test("row model: up/down skips expanded headers and visits models in visual order", () => {
	const { list, events } = makeList([group("a", ["a1", "a2"]), group("b", ["b1"])]);
	list.setSelectedValue("a1");
	list.handleInput("\x1B[B");
	assert.equal(list.getSelectedItem()?.value, "a2");
	list.handleInput("\x1B[B");
	assert.equal(list.getSelectedItem()?.value, "b1");
	list.handleInput("\x1B[A");
	assert.equal(list.getSelectedItem()?.value, "a2");
	assert.deepEqual(events.selected, ["a2", "b1", "a2"]);
});

test("row model: up/down wraps without traps", () => {
	const { list } = makeList([group("a", ["a1"]), group("b", ["b1"])]);
	list.setSelectedValue("a1");
	list.handleInput("\x1B[A");
	assert.equal(list.getSelectedItem()?.value, "b1");
	list.handleInput("\x1B[B");
	assert.equal(list.getSelectedItem()?.value, "a1");
});

test("row model: enter on a collapsed header expands it and never selects", () => {
	const collapsed = { ...group("a", ["a1"]), initiallyCollapsed: true };
	const { list, events } = makeList([collapsed, group("b", ["b1"])]);
	assert.equal(list.isGroupFocused(), true);
	list.handleInput("\r");
	assert.deepEqual(events.select, []);
	assert.equal(list.getSelectedItem()?.value, "a1");
	assert.match(list.render(40).join("\n"), /a1/);
});

test("row model: left collapses current group, right expands onto first item", () => {
	const { list } = makeList([group("a", ["a1", "a2"]), group("b", ["b1"])]);
	list.setSelectedValue("a2");
	list.handleInput("\x1B[D"); // left → collapse group a
	assert.equal(list.getSelectedItem(), null);
	assert.match(list.render(40).join("\n"), /▸ a/);
	assert.doesNotMatch(list.render(40).join("\n"), /a1/);

	list.handleInput("\x1B[C"); // right → expand, cursor on a1
	assert.equal(list.getSelectedItem()?.value, "a1");
});

test("row model: left/right work the same regardless of search state", () => {
	// The list itself is search-agnostic; collapse must behave identically.
	for (const maxLines of [10, 100]) {
		const { list } = makeList([group("a", ["a1"]), group("b", ["b1"])], maxLines);
		list.setSelectedValue("b1");
		list.handleInput("\x1B[D");
		assert.equal(list.getSelectedItem(), null);
		list.handleInput("\x1B[C");
		assert.equal(list.getSelectedItem()?.value, "b1");
	}
});

test("row model: ctrl+g collapses all onto a header, then expands all", () => {
	const { list } = makeList([group("a", ["a1"]), group("b", ["b1"]), group("c", ["c1"])]);
	list.setSelectedValue("b1");
	list.handleInput("\x03"); // ignored control
	list.handleInput("\x07"); // ctrl+g
	assert.equal(list.getSelectedItem(), null);
	assert.equal(list.allGroupsCollapsed(), true);
	const lines = list.render(40).join("\n");
	assert.match(lines, /▸ a/);
	assert.match(lines, /▸ b/);
	assert.match(lines, /▸ c/);

	list.handleInput("\x07");
	assert.equal(list.allGroupsCollapsed(), false);
	assert.match(list.render(40).join("\n"), /b1/);
});

test("row model: action keys do nothing while a collapsed header is focused", () => {
	const { list, events } = makeList([{ ...group("a", ["a1"]), initiallyCollapsed: true }]);
	list.handleInput("\x06"); // ctrl+f
	list.handleInput("\x08"); // ctrl+h
	list.handleInput("\x13"); // ctrl+s
	assert.deepEqual(events.select, []);
	assert.deepEqual(events.selected.filter((v) => v !== "header"), []);
});

test("row model: only the focused collapsed header is highlighted", () => {
	const groups = [
		{ ...group("a", ["a1"]), initiallyCollapsed: true },
		{ ...group("b", ["b1"]), initiallyCollapsed: true },
	];
	const { list } = makeList(groups);
	let lines = list.render(40);
	assert.equal(lines.filter((line) => line.includes("[selected]")).length, 1);
	assert.match(lines.find((line) => line.includes("[selected]"))!, /a/);
	list.handleInput("\x1B[B");
	lines = list.render(40);
	assert.equal(lines.filter((line) => line.includes("[selected]")).length, 1);
	assert.match(lines.find((line) => line.includes("[selected]"))!, /b/);
});

test("row model: empty list renders no-match and ignores navigation", () => {
	const { list } = makeList([]);
	assert.match(list.render(40)[0]!, /No matches/);
	list.handleInput("\x1B[B");
	list.handleInput("\r");
	assert.equal(list.getSelectedItem(), null);
});

test("row model: positionLabel counts items by cursor index, never 0/N", () => {
	const { list } = makeList([group("a", ["a1", "a2"]), group("b", ["b1"])]);
	// Expanded headers are skipped; item positions must never report 0/N.
	list.setSelectedValue("a1");
	assert.equal(list.positionLabel(), "1/3");
	list.setSelectedValue("a2");
	assert.equal(list.positionLabel(), "2/3");
	list.setSelectedValue("b1");
	assert.equal(list.positionLabel(), "3/3");
	list.handleInput("\x1B[A"); // up → a2
	assert.equal(list.positionLabel(), "2/3");
});

test("row model: selection stays centered even at list edges", () => {
	const ids = Array.from({ length: 20 }, (_, index) => `m${index + 1}`);
	const { list } = makeList([group("models", ids)], 8);
	const selectedLine = () => list.render(50).findIndex((line) => line.includes("→ "));

	for (const id of ["m1", "m7", "m8", "m9", "m12", "m20"]) {
		list.setSelectedValue(id);
		const lines = list.render(50);
		assert.equal(selectedLine(), 3, `expected centered anchor for ${id}`);
		assert.equal(lines.length, 8);
	}
});

test("row model: removal fallback prefers next distinct item, then previous", () => {
	const { list } = makeList([group("favorites", ["m2"]), group("provider", ["m1", "m2", "m3"])]);
	list.setSelectedValue("m2");
	assert.equal(list.fallbackValueAfterRemoval(), "m1", "duplicate occurrence of the removed model is skipped");
	const simple = makeList([group("models", ["m1", "m2", "m3"])]).list;
	simple.setSelectedValue("m2");
	assert.equal(simple.fallbackValueAfterRemoval(), "m3");
	simple.setSelectedValue("m3");
	assert.equal(simple.fallbackValueAfterRemoval(), "m2");
	const single = makeList([group("models", ["only"])]).list;
	assert.equal(single.fallbackValueAfterRemoval(), "");
});

test("row model: selected model is highlighted and indented from headings", () => {
	const theme: ListTheme = { ...plainTheme, selectedText: (text) => `[selected-model]${text}` };
	const list = new GroupedModelList([group("models", ["m1", "m2"])], () => 8, theme);
	list.setSelectedValue("m1");
	const lines = list.render(40);
	const selected = lines.find((line) => line.includes("[selected-model]"));
	assert.match(selected!, /  → m1/);
	assert.equal(lines.filter((line) => line.includes("[selected-model]")).length, 1);
});

test("row model: render respects the line budget including selected details", () => {
	const detailGroup: ModelGroup = {
		id: "a",
		title: "a",
		items: ["a1", "a2", "a3", "a4", "a5"].map(item),
		collapsible: true,
	};
	const { list } = makeList([detailGroup], 4);
	list.setSelectedValue("a3");
	const lines = list.render(60);
	assert.ok(lines.length <= 5, `expected <= 5 lines, got ${lines.length}`);
	assert.ok(lines.some((line) => line.includes("a3")), "selected row must stay visible");
});

test("row model: oversized selected details are clipped to the line budget", () => {
	const detailGroup: ModelGroup = {
		id: "a",
		title: "a",
		collapsible: true,
		items: [{ value: "a/1", label: "model", inlineDetails: ["first detail", "second detail", "third detail"] }],
	};
	const { list } = makeList([detailGroup], 2);
	list.setSelectedValue("a/1");
	const lines = list.render(40);
	assert.equal(lines.length, 2);
	assert.match(lines[0]!, /model/);
	assert.match(lines[1]!, /first detail/);
});

test("row model: selected inline details are wrapped to width", () => {
	const detailGroup: ModelGroup = {
		id: "a",
		title: "a",
		items: [{ value: "a1", label: "a1", inlineDetails: ["word ".repeat(30).trim()] }],
		collapsible: true,
	};
	const { list } = makeList([detailGroup], 100);
	list.setSelectedValue("a1");
	const lines = list.render(30);
	for (const line of lines) {
		// ANSI-free theme, so visible width equals string length
		assert.ok(line.length <= 30, `line too wide (${line.length}): ${line}`);
	}
	assert.ok(lines.length > 2, "details should wrap onto multiple lines");
});

test("buildGroups: ordinary mode excludes hidden everywhere and keeps Hidden last", () => {
	const ordered = [model("openai", "gpt-5"), model("openai", "gpt-4"), model("anthropic", "claude")];
	const favoriteKeys = ["openai/gpt-5"];
	const hiddenKeys = ["openai/gpt-4"];
	const groups = buildGroups({
		ordered,
		query: "",
		manageMode: null,
		favoriteKeys,
		hiddenKeys,
		recentKeys: ["openai/gpt-4"],
		defaultKey: "anthropic/claude",
		currentKey: "",
		maxRecents: 5,
		itemOf: (m) => item(keyOf(m)),
	});
	assert.deepEqual(groups.map((g) => g.id), ["favorites", "provider:openai", "provider:anthropic", "hidden"]);
	assert.equal(groups.at(-1)!.initiallyCollapsed, true);
	// hidden model appears ONLY in the hidden group
	const nonHiddenGroups = groups.slice(0, 3).flatMap((g) => g.items.map((i) => i.value));
	assert.ok(!nonHiddenGroups.includes("openai/gpt-4"));
});

test("buildGroups: ordinary mode does not render a Recent group", () => {
	const groups = buildGroups({
		ordered: [model("p", "m1"), model("p", "m2")],
		query: "",
		manageMode: null,
		favoriteKeys: [],
		hiddenKeys: [],
		recentKeys: ["p/m1", "p/m2"],
		defaultKey: "p/m1",
		currentKey: "p/m2",
		maxRecents: 5,
		itemOf: (m) => item(keyOf(m)),
	});
	assert.equal(groups.some((group) => group.id === "recent"), false);
});

test("buildGroups: search shows each match once in its provider group", () => {
	const ordered = [model("openai", "gpt-5"), model("openai", "gpt-4"), model("anthropic", "claude")];
	const groups = buildGroups({
		ordered,
		query: "gpt",
		manageMode: null,
		favoriteKeys: ["openai/gpt-5"],
		hiddenKeys: [],
		recentKeys: ["openai/gpt-5"],
		defaultKey: "",
		currentKey: "",
		maxRecents: 5,
		itemOf: (m) => item(keyOf(m)),
	});
	assert.deepEqual(groups.map((g) => g.title), ["openai"]);
	assert.deepEqual(groups[0]!.items.map((i) => i.value), ["openai/gpt-5", "openai/gpt-4"]);
});

test("buildGroups: a hidden search match stays behind a collapsed Hidden group", () => {
	const groups = buildGroups({
		ordered: [model("p", "visible"), model("p", "secret")],
		query: "secret",
		manageMode: null,
		favoriteKeys: [],
		hiddenKeys: ["p/secret"],
		recentKeys: [],
		defaultKey: "",
		currentKey: "",
		maxRecents: 0,
		itemOf: (m) => item(keyOf(m)),
	});
	assert.deepEqual(groups.map((group) => group.id), ["hidden"]);
	assert.equal(groups[0]!.initiallyCollapsed, true);
	const { list } = makeList(groups);
	assert.equal(list.isGroupFocused(), true);
	assert.doesNotMatch(list.render(40).join("\n"), /p\/secret/);
});

test("buildGroups: management mode shows provider groups only, including hidden", () => {
	const ordered = [model("openai", "gpt-5"), model("openai", "gpt-4")];
	const groups = buildGroups({
		ordered,
		query: "",
		manageMode: "hidden",
		favoriteKeys: [],
		hiddenKeys: ["openai/gpt-4"],
		recentKeys: [],
		defaultKey: "",
		currentKey: "",
		maxRecents: 5,
		itemOf: (m) => item(keyOf(m)),
	});
	assert.deepEqual(groups.map((g) => g.id), ["provider:openai"]);
	assert.deepEqual(groups[0]!.items.map((i) => i.value), ["openai/gpt-5", "openai/gpt-4"]);
});

test("listLineBudget: caps on large terminals and shrinks on small ones", () => {
	// Large terminal: hard cap of 26 list lines.
	assert.equal(listLineBudget(100), 26);
	assert.equal(listLineBudget(undefined), listLineBudget(24));
	// Normal terminal: budget fits inside the full-height overlay after chrome.
	const budget = listLineBudget(24);
	assert.equal(budget, 24 - 10);
	assert.ok(budget >= 1);
	// Small terminal: budget never exceeds what the overlay can show, so the
	// overlay must not truncate the picker.
	for (const rows of [8, 10, 12, 14, 16]) {
		const small = listLineBudget(rows);
		assert.ok(small >= 1, `rows=${rows} budget=${small}`);
		assert.equal(small, Math.max(1, rows - 10));
		assert.ok(small <= 26);
	}
	assert.equal(listLineBudget(0), listLineBudget(24));
	assert.equal(listLineBudget(-3), listLineBudget(24));
});

const withTempDir = (fn: (dir: string) => void): void => {
	const dir = mkdtempSync(join(tmpdir(), "pi-picker-test-"));
	try {
		fn(dir);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
};

test("store: recents are capped but favorites and hidden entries are not truncated", () => {
	withTempDir((dir) => {
		const store = createStore(dir);
		const entries = Array.from({ length: 30 }, (_, i) => ({ provider: "p", id: `m${i}` }));
		assert.equal(store.saveRecents(entries), true);
		assert.equal(store.loadRecents().length, 20);

		assert.equal(store.saveFavorites(entries), true);
		assert.equal(store.loadFavorites().length, 30);
		assert.equal(store.saveHidden(entries), true);
		assert.equal(store.loadHidden().length, 30);
	});
});

test("store: saving into a missing directory creates it", () => {
	withTempDir((dir) => {
		const store = createStore(join(dir, "agent", "nested"));
		assert.equal(store.saveHidden([{ provider: "p", id: "m" }]), true);
		assert.deepEqual(store.loadHidden(), [{ provider: "p", id: "m" }]);
	});
});

test("store: malformed JSON falls back to defaults instead of throwing", () => {
	withTempDir((dir) => {
		writeFileSync(join(dir, "new-model-picker-recents.json"), "{not json");
		writeFileSync(join(dir, "new-model-picker-favorites.json"), "42");
		writeFileSync(join(dir, "new-model-picker.json"), "{oops");
		writeFileSync(join(dir, "settings.json"), "{oops");
		const store = createStore(dir);
		assert.deepEqual(store.loadRecents(), []);
		assert.deepEqual(store.loadFavorites(), []);
		assert.deepEqual(store.loadConfig(), { reasons: ["startup", "new"], maxRecents: 5 });
		assert.equal(store.getConfiguredDefaultKey([]), "");
	});
});

test("store: config validation clamps maxRecents and filters reasons", () => {
	withTempDir((dir) => {
		const store = createStore(dir);
		assert.equal(store.saveConfig({ reasons: ["startup", "bogus"] as string[], maxRecents: 99 }), true);
		const loaded = store.loadConfig();
		assert.deepEqual(loaded.reasons, ["startup"]);
		assert.equal(loaded.maxRecents, 20);
	});
});

test("store: default key resolves by id and by legacy name", () => {
	withTempDir((dir) => {
		const store = createStore(dir);
		const settings = { defaultProvider: "openai", defaultModel: "gpt-5", extra: "keep" };
		writeFileSync(join(dir, "settings.json"), JSON.stringify(settings));
		const available = [model("openai", "gpt-5")];
		assert.equal(store.getConfiguredDefaultKey(available), "openai/gpt-5");

		// legacy: defaultModel stored a display name
		writeFileSync(join(dir, "settings.json"), JSON.stringify({ ...settings, defaultModel: "GPT-5 Model" }));
		const named = [model("openai", "gpt-5", "GPT-5 Model")];
		assert.equal(store.getConfiguredDefaultKey(named), "openai/gpt-5");
	});
});

test("store: saveConfiguredDefault persists canonical id and preserves other keys", () => {
	withTempDir((dir) => {
		const store = createStore(dir);
		mkdirSync(dir, { recursive: true });
		writeFileSync(join(dir, "settings.json"), JSON.stringify({ theme: "dark", defaultThinkingLevel: "high" }));
		assert.equal(store.saveConfiguredDefault(model("openai", "gpt-5", "GPT-5")), true);
		const saved = JSON.parse(readFileSync(join(dir, "settings.json"), "utf8"));
		assert.equal(saved.theme, "dark");
		assert.equal(saved.defaultThinkingLevel, "high");
		assert.equal(saved.defaultProvider, "openai");
		assert.equal(saved.defaultModel, "gpt-5");
	});
});


test("store: saveConfiguredDefault creates settings.json when missing", () => {
	withTempDir((dir) => {
		const store = createStore(dir);
		assert.equal(store.getConfiguredDefaultKey([]), ""); // reads fine without the file
		assert.equal(store.saveConfiguredDefault(model("openai", "gpt-5")), true);
		const saved = JSON.parse(readFileSync(join(dir, "settings.json"), "utf8"));
		assert.equal(saved.defaultProvider, "openai");
		assert.equal(saved.defaultModel, "gpt-5");
		// And a subsequent save preserves the bootstrapped file.
		assert.equal(store.saveConfiguredDefault(model("p", "m2")), true);
		assert.equal(JSON.parse(readFileSync(join(dir, "settings.json"), "utf8")).defaultModel, "m2");
	});
});

test("store: saveConfiguredDefault refuses to overwrite malformed settings", () => {
	withTempDir((dir) => {
		const store = createStore(dir);
		writeFileSync(join(dir, "settings.json"), "{not json");
		assert.equal(store.saveConfiguredDefault(model("openai", "gpt-5")), false);
		assert.equal(readFileSync(join(dir, "settings.json"), "utf8"), "{not json");
	});
});
