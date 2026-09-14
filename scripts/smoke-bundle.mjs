import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const bundleUrl = new URL("../dist/new-model-picker.ts", import.meta.url);
const source = readFileSync(bundleUrl, "utf8");

if (/from\s+["']\.\/core\.ts["']|require\(\s*["']\.\/core\.ts["']/.test(source)) {
	throw new Error("deployable bundle still imports ./core.ts");
}

// Node's native TypeScript stripping accepts some declarations that Pi's jiti
// parser rejects. Load through Pi's real extension loader to cover deployment.
const piEntryUrl = import.meta.resolve("@earendil-works/pi-coding-agent");
const loaderUrl = new URL("./core/extensions/loader.js", piEntryUrl);
const { loadExtensions } = await import(loaderUrl.href);
const result = await loadExtensions([fileURLToPath(bundleUrl)], process.cwd());
if (result.errors.length > 0 || result.extensions.length !== 1) {
	const messages = result.errors.map((entry) => entry.error ?? String(entry)).join("\n");
	throw new Error(`Pi extension loader rejected the bundle:\n${messages}`);
}

console.log("ok: Pi extension loader accepts standalone bundle");
