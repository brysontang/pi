import { execFileSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { expect, test } from "vitest";

test("bundling the SDK does not launch an imported internal process", async () => {
	const directory = await mkdtemp(join(tmpdir(), "pi-sdk-bundle-"));
	try {
		const outfile = join(directory, "app.mjs");
		await build({
			stdin: {
				contents: 'import { createAgentSession } from "../src/index.ts"; console.log(typeof createAgentSession);',
				resolveDir: fileURLToPath(new URL(".", import.meta.url)),
				loader: "ts",
			},
			outfile,
			bundle: true,
			platform: "node",
			format: "esm",
			target: "node22",
			banner: {
				js: 'import { createRequire as __sdkCreateRequire } from "node:module"; const require = __sdkCreateRequire(import.meta.url);',
			},
		});
		expect(execFileSync(process.execPath, [outfile], { encoding: "utf8", timeout: 30_000 }).trim()).toBe("function");
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
}, 60_000);
