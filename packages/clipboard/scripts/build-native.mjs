import { chmodSync, copyFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const packageDirectory = dirname(dirname(fileURLToPath(import.meta.url)));
const targets = new Map([
	[
		"aarch64-apple-darwin",
		{
			artifact: "libcrosscopy_clipboard.dylib",
			output: "native/darwin/prebuilds/darwin-arm64/clipboard.darwin-arm64.node",
			deploymentTarget: "11.0",
		},
	],
	[
		"x86_64-apple-darwin",
		{
			artifact: "libcrosscopy_clipboard.dylib",
			output: "native/darwin/prebuilds/darwin-x64/clipboard.darwin-x64.node",
			deploymentTarget: "10.15",
		},
	],
	[
		"aarch64-unknown-linux-gnu",
		{
			artifact: "libcrosscopy_clipboard.so",
			output: "native/linux/prebuilds/linux-arm64-gnu/clipboard.linux-arm64-gnu.node",
		},
	],
	[
		"aarch64-unknown-linux-musl",
		{
			artifact: "libcrosscopy_clipboard.so",
			output: "native/linux/prebuilds/linux-arm64-musl/clipboard.linux-arm64-musl.node",
		},
	],
	[
		"riscv64gc-unknown-linux-gnu",
		{
			artifact: "libcrosscopy_clipboard.so",
			output: "native/linux/prebuilds/linux-riscv64-gnu/clipboard.linux-riscv64-gnu.node",
		},
	],
	[
		"x86_64-unknown-linux-gnu",
		{
			artifact: "libcrosscopy_clipboard.so",
			output: "native/linux/prebuilds/linux-x64-gnu/clipboard.linux-x64-gnu.node",
		},
	],
	[
		"x86_64-unknown-linux-musl",
		{
			artifact: "libcrosscopy_clipboard.so",
			output: "native/linux/prebuilds/linux-x64-musl/clipboard.linux-x64-musl.node",
		},
	],
	[
		"aarch64-pc-windows-msvc",
		{
			artifact: "crosscopy_clipboard.dll",
			output: "native/win32/prebuilds/win32-arm64-msvc/clipboard.win32-arm64-msvc.node",
		},
	],
	[
		"x86_64-pc-windows-msvc",
		{
			artifact: "crosscopy_clipboard.dll",
			output: "native/win32/prebuilds/win32-x64-msvc/clipboard.win32-x64-msvc.node",
		},
	],
]);

function run(command, args, options = {}) {
	const result = spawnSync(command, args, { stdio: "inherit", ...options });
	if (result.error) throw result.error;
	if (result.status !== 0) throw new Error(`${command} failed with exit code ${result.status ?? 1}`);
}

function detectHostTarget() {
	const result = spawnSync(process.env.RUSTC ?? "rustc", ["-vV"], { encoding: "utf8" });
	if (result.error) throw result.error;
	if (result.status !== 0) throw new Error("rustc -vV failed");
	const host = result.stdout.match(/^host: (.+)$/m)?.[1];
	if (!host) throw new Error("Could not determine the Rust host target");
	return host;
}

function parseTargets() {
	const requestedTargets = [];
	const args = process.argv.slice(2);
	for (let index = 0; index < args.length; index++) {
		const argument = args[index];
		if (argument === "--help" || argument === "-h") {
			console.log(`Usage: node scripts/build-native.mjs [--target <rust-target>]...

With no target, builds for the Rust host target. Supported targets:
${[...targets.keys()].map((target) => `  ${target}`).join("\n")}`);
			process.exit(0);
		}
		if (argument !== "--target" || !args[index + 1]) {
			throw new Error(`Unknown or incomplete argument: ${argument}`);
		}
		requestedTargets.push(args[++index]);
	}
	return requestedTargets.length > 0 ? requestedTargets : [detectHostTarget()];
}

const cargoTargetDirectoryValue = process.env.CARGO_TARGET_DIR ?? "target";
const cargoTargetDirectory = isAbsolute(cargoTargetDirectoryValue)
	? cargoTargetDirectoryValue
	: resolve(packageDirectory, cargoTargetDirectoryValue);

for (const target of parseTargets()) {
	const settings = targets.get(target);
	if (!settings) throw new Error(`Unsupported native target: ${target}`);

	const env = { ...process.env };
	if (settings.deploymentTarget && !env.MACOSX_DEPLOYMENT_TARGET) {
		env.MACOSX_DEPLOYMENT_TARGET = settings.deploymentTarget;
	}
	if (target.endsWith("-musl")) {
		env.RUSTFLAGS = [env.RUSTFLAGS, "-C target-feature=-crt-static"].filter(Boolean).join(" ");
	}

	run(process.env.CARGO ?? "cargo", ["build", "--locked", "--release", "--target", target], {
		cwd: packageDirectory,
		env,
	});

	const artifact = join(cargoTargetDirectory, target, "release", settings.artifact);
	if (!existsSync(artifact)) throw new Error(`Cargo did not produce ${artifact}`);

	const output = join(packageDirectory, settings.output);
	mkdirSync(dirname(output), { recursive: true });
	copyFileSync(artifact, output);
	if (process.platform !== "win32") chmodSync(output, 0o755);
	console.log(`Built ${settings.output}`);
}
