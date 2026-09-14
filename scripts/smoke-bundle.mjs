import { readFileSync } from "node:fs";

const bundleUrl = new URL("../dist/new-model-picker.ts", import.meta.url);
const source = readFileSync(bundleUrl, "utf8");

if (/from\s+["']\.\/core\.ts["']|require\(\s*["']\.\/core\.ts["']/.test(source)) {
	throw new Error("deployable bundle still imports ./core.ts");
}

const extension = await import(bundleUrl.href);
if (typeof extension.default !== "function") {
	throw new Error("deployable bundle has no default extension function");
}

console.log("ok: standalone bundle imports without local source modules");
