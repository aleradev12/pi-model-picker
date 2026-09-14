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
	type ListTheme,
	type ListItem,
	type ModelGroup,
	type PickerModel,
} from "../core.ts";

const plainTheme: ListTheme = {
	selectedText: (t) => t,
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

test("row model: up/down visits headers and items in visual order", () => {
	const { list, events } = makeList([group("a", ["a1", "a2"]), group("b", ["b1"])]);
	list.setSelectedValue("a1");
	assert.equal(list.getSelectedItem()?.value, "a1");

	list.handleInput("\x1B[B"); // down → a2
	assert.equal(list.getSelectedItem()?.value, "a2");
	list.handleInput("\x1B[B"); // down → header b
	assert.equal(list.getSelectedItem(), null);
	assert.equal(list.isGroupFocused(), true);
	list.handleInput("\x1B[B"); // down → b1
	assert.equal(list.getSelectedItem()?.value, "b1");
	assert.deepEqual(events.selected, ["a2", "header", "b1"]);

	list.handleInput("\x1B[A"); // up → header b
	assert.equal(list.getSelectedItem(), null);
	list.handleInput("\x1B[A"); // up → a2
	assert.equal(list.getSelectedItem()?.value, "a2");
});

test("row model: up/down wraps without traps", () => {
	const { list } = makeList([group("a", ["a1"]), group("b", ["b1"])]);
	list.setSelectedValue("a1");
	list.handleInput("\x1B[A"); // up → header a
	assert.equal(list.getSelectedItem(), null);
	list.handleInput("\x1B[A"); // up wraps to last row: b1
	assert.equal(list.getSelectedItem()?.value, "b1");
	list.handleInput("\x1B[B"); // down wraps to first row: header a
	assert.equal(list.getSelectedItem(), null);
	list.handleInput("\x1B[B"); // → a1
	assert.equal(list.getSelectedItem()?.value, "a1");
});

test("row model: enter on header toggles collapse and never selects", () => {
	const { list, events } = makeList([group("a", ["a1"]), group("b", ["b1"])]);
	list.setSelectedValue("a1");
	list.handleInput("\x1B[A"); // header a
	events.select.length = 0;
	list.handleInput("\r");
	assert.deepEqual(events.select, []);
	const lines = list.render(40).join("\n");
	assert.match(lines, /▸ a/); // collapsed
	assert.doesNotMatch(lines, /a1/);

	list.handleInput("\r"); // expand again
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

test("row model: action keys do nothing while a header is focused", () => {
	const { list, events } = makeList([group("a", ["a1"])]);
	list.handleInput("\x06"); // ctrl+f
	list.handleInput("\x08"); // ctrl+h
	list.handleInput("\x13"); // ctrl+s
	list.handleInput("\r"); // enter toggles, never selects
	assert.deepEqual(events.select, []);
	assert.deepEqual(events.selected.filter((v) => v !== "header"), []);
});

test("row model: empty list renders no-match and ignores navigation", () => {
	const { list } = makeList([]);
	assert.match(list.render(40)[0]!, /No matches/);
	list.handleInput("\x1B[B");
	list.handleInput("\r");
	assert.equal(list.getSelectedItem(), null);
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
	assert.deepEqual(groups.map((g) => g.id), ["favorites", "recent", "provider:openai", "provider:anthropic", "hidden"]);
	// hidden model appears ONLY in the hidden group
	const nonHiddenGroups = groups.slice(0, 3).flatMap((g) => g.items.map((i) => i.value));
	assert.ok(!nonHiddenGroups.includes("openai/gpt-4"));
});

test("buildGroups: recent group is deduped across default/current/recents and capped", () => {
	const ordered = [model("p", "m1"), model("p", "m2"), model("p", "m3"), model("p", "m4")];
	const groups = buildGroups({
		ordered,
		query: "",
		manageMode: null,
		favoriteKeys: [],
		hiddenKeys: [],
		recentKeys: ["p/m1", "p/m2", "p/m3"],
		defaultKey: "p/m1",
		currentKey: "p/m1",
		maxRecents: 2,
		itemOf: (m) => item(keyOf(m)),
	});
	const recent = groups.find((g) => g.id === "recent")!;
	assert.deepEqual(recent.items.map((i) => i.value), ["p/m1", "p/m2"]);
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

const withTempDir = (fn: (dir: string) => void): void => {
	const dir = mkdtempSync(join(tmpdir(), "pi-picker-test-"));
	try {
		fn(dir);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
};

test("store: entries round-trip, dedupe on load, and cap at 15", () => {
	withTempDir((dir) => {
		const store = createStore(dir);
		const entries = Array.from({ length: 20 }, (_, i) => ({ provider: "p", id: `m${i}` }));
		assert.equal(store.saveRecents(entries), true);
		const loaded = store.loadRecents();
		assert.equal(loaded.length, 15);
		assert.equal(loaded[0]!.id, "m0");

		store.saveFavorites([{ provider: "p", id: "x" }, { provider: "p", id: "x" }]);
		assert.deepEqual(store.loadFavorites(), [{ provider: "p", id: "x" }, { provider: "p", id: "x" }]);
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


test("store: saveConfiguredDefault refuses to overwrite malformed settings", () => {
	withTempDir((dir) => {
		const store = createStore(dir);
		writeFileSync(join(dir, "settings.json"), "{not json");
		assert.equal(store.saveConfiguredDefault(model("openai", "gpt-5")), false);
		assert.equal(readFileSync(join(dir, "settings.json"), "utf8"), "{not json");
	});
});
