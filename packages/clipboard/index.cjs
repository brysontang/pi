const { readFileSync } = require("node:fs");
const { join } = require("node:path");

function isMusl() {
	try {
		if (readFileSync("/usr/bin/ldd", "utf8").includes("musl")) return true;
	} catch {
		// Fall through to the runtime report.
	}

	const report = typeof process.report?.getReport === "function" ? process.report.getReport() : undefined;
	if (report?.header?.glibcVersionRuntime) return false;
	return report?.sharedObjects?.some((file) => file.includes("libc.musl-") || file.includes("ld-musl-")) ?? false;
}

function getTarget() {
	if (process.platform === "darwin" && (process.arch === "arm64" || process.arch === "x64")) {
		return { directory: "darwin", target: `darwin-${process.arch}` };
	}
	if (process.platform === "win32" && (process.arch === "arm64" || process.arch === "x64")) {
		return { directory: "win32", target: `win32-${process.arch}-msvc` };
	}
	if (process.platform === "linux" && ["arm64", "riscv64", "x64"].includes(process.arch)) {
		const libc = isMusl() ? "musl" : "gnu";
		if (process.arch === "riscv64" && libc === "musl") {
			throw new Error("Unsupported clipboard platform: linux-riscv64-musl");
		}
		return { directory: "linux", target: `linux-${process.arch}-${libc}` };
	}
	throw new Error(`Unsupported clipboard platform: ${process.platform}-${process.arch}`);
}

let nativeBinding;
if (process.env.NAPI_RS_NATIVE_LIBRARY_PATH) {
	nativeBinding = require(process.env.NAPI_RS_NATIVE_LIBRARY_PATH);
} else {
	const { directory, target } = getTarget();
	nativeBinding = require(join(__dirname, "..", "native", directory, "prebuilds", target, `clipboard.${target}.node`));
}

module.exports = nativeBinding;
module.exports.availableFormats = nativeBinding.availableFormats;
module.exports.callThreadsafeFunction = nativeBinding.callThreadsafeFunction;
module.exports.clear = nativeBinding.clear;
module.exports.getHtml = nativeBinding.getHtml;
module.exports.getImageBase64 = nativeBinding.getImageBase64;
module.exports.getImageBinary = nativeBinding.getImageBinary;
module.exports.getRtf = nativeBinding.getRtf;
module.exports.getText = nativeBinding.getText;
module.exports.hasHtml = nativeBinding.hasHtml;
module.exports.hasImage = nativeBinding.hasImage;
module.exports.hasRtf = nativeBinding.hasRtf;
module.exports.hasText = nativeBinding.hasText;
module.exports.setHtml = nativeBinding.setHtml;
module.exports.setImageBase64 = nativeBinding.setImageBase64;
module.exports.setImageBinary = nativeBinding.setImageBinary;
module.exports.setRtf = nativeBinding.setRtf;
module.exports.setText = nativeBinding.setText;
module.exports.watch = nativeBinding.watch;
