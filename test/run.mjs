#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const [major, minor] = process.versions.node.split(".").map(Number);
if (major < 22 || (major === 22 && minor < 6)) {
	console.error("pi-search-boost tests require Node.js >=22.6 (native TypeScript stripping)");
	process.exit(1);
}

const suite = process.argv[2] ?? "unit";
const names = suite === "all"
	? ["unit.test.ts", "blackbox.test.ts"]
	: suite === "blackbox" ? ["blackbox.test.ts"] : ["unit.test.ts"];
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const temp = fs.mkdtempSync(path.join(os.tmpdir(), "pi-search-boost-test-"));

try {
	for (const name of ["index.ts", "package.json"]) fs.copyFileSync(path.join(root, name), path.join(temp, name));
	fs.cpSync(path.join(root, "lib"), path.join(temp, "lib"), { recursive: true });
	fs.mkdirSync(path.join(temp, "test"), { recursive: true });
	for (const name of names) fs.copyFileSync(path.join(root, "test", name), path.join(temp, "test", name));
	const result = spawnSync(
		process.execPath,
		["--experimental-strip-types", "--test", ...names.map((name) => path.join(temp, "test", name))],
		{
			stdio: "inherit",
			// Unit modules run from the copy outside node_modules, but Pi's loader
			// must smoke-test the original installed entry so its peer dependencies
			// resolve from the consumer's node_modules tree.
			env: { ...process.env, PI_SEARCH_TEST_PACKAGE_ROOT: root },
		},
	);
	if (result.error) throw result.error;
	process.exitCode = result.status ?? 1;
} finally {
	fs.rmSync(temp, { recursive: true, force: true });
}
