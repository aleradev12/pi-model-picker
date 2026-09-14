/**
 * Syntax-checks the TypeScript sources by stripping types with Node's built-in
 * stripper and running `node --check` on the resulting ESM.
 */
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";

const files = ["core.ts", "index.ts"];
const tmp = mkdtempSync(join(tmpdir(), "pi-picker-check-"));
try {
	for (const file of files) {
		const source = readFileSync(new URL(`../${file}`, import.meta.url), "utf8");
		const stripped = stripTypeScriptTypes(source, { sourceMap: false });
		const out = join(tmp, file.replace(/\.ts$/, ".mjs"));
		writeFileSync(out, stripped);
		execFileSync(process.execPath, ["--check", out], { stdio: "inherit" });
		console.log(`ok: ${file}`);
	}
} finally {
	rmSync(tmp, { recursive: true, force: true });
}
