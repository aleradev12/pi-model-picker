/**
 * Bundles core.ts + index.ts into a single deployable extension file,
 * dist/new-model-picker.ts, ready to copy into ~/.pi/agent/extensions/.
 * Bare package imports (@earendil-works/*) are preserved — pi resolves them.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (file) => readFileSync(join(root, file), "utf8");

const stripImports = (source) =>
	source
		.split("\n")
		.filter((line) => !/^import\b/.test(line) && !/^} from\b/.test(line))
		.join("\n");

const stripExports = (source) => source.replace(/^export (?=(declare )?(async )?(interface|type|class|function|const|let|var|enum)\b)/gm, "");

const collectImports = (source) => {
	// Returns [{ typeOnly, names[], default, module }]
	const imports = [];
	const re = /import\s+(type\s+)?(?:(\*)\s+as\s+(\w+)|(\w+)\s*,\s*)?(?:\{([^}]*)\}|(\w+))?\s*from\s*["']([^"']+)["']|import\s*["']([^"']+)["']/g;
	let match;
	while ((match = re.exec(source)) !== null) {
		imports.push({
			typeOnly: !!match[1],
			star: match[3],
			default: match[4],
			names: (match[5] ?? "").split(",").map((s) => s.trim()).filter(Boolean),
			module: match[7] ?? match[8],
		});
	}
	return imports;
};

const mergeImports = (all) => {
	const byModule = new Map();
	for (const entry of all) {
		const key = `${entry.typeOnly ? "type " : ""}${entry.module}`;
		if (!byModule.has(key)) byModule.set(key, { typeOnly: entry.typeOnly, module: entry.module, names: new Set(), star: entry.star, default: entry.default });
		const merged = byModule.get(key);
		for (const name of entry.names) merged.names.add(name);
	}
	return [...byModule.values()].map((entry) => {
		const parts = [];
		if (entry.star) parts.push(`* as ${entry.star}`);
		if (entry.default) parts.push(entry.default);
		if (entry.names.size) parts.push(`{ ${[...entry.names].join(", ")} }`);
		return `import ${entry.typeOnly ? "type " : ""}${parts.join(", ")} from "${entry.module}";`;
	});
};

const core = read("core.ts");
const index = read("index.ts");

// Inline the core module where index.ts imports it.
const indexWithoutCoreImport = index.replace(
	/import\s*\{[^}]*\}\s*from\s*"\.\/core\.ts";\n/s,
	"",
);
if (indexWithoutCoreImport === index) {
	throw new Error("bundle: expected index.ts to import from ./core.ts");
}

const imports = mergeImports([...collectImports(core), ...collectImports(indexWithoutCoreImport)]);
const bundle = `${imports.join("\n")}\n\n${stripExports(stripImports(core))}\n${stripExports(stripImports(indexWithoutCoreImport))}`;

const outDir = join(root, "dist");
mkdirSync(outDir, { recursive: true });
const outFile = join(outDir, "new-model-picker.ts");
writeFileSync(outFile, bundle);

// Sanity: the bundle must survive type-stripping.
const { stripTypeScriptTypes } = await import("node:module");
stripTypeScriptTypes(bundle, { sourceMap: false });
console.log(`bundle: ${outFile} (${bundle.split("\n").length} lines)`);
