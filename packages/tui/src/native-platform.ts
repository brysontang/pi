import { createRequire } from "node:module";
import * as path from "node:path";
import { getNativeModuleCandidates } from "./native-module-path.ts";

const cjsRequire = createRequire(import.meta.url);

export type ModifierKey = "shift" | "command" | "control" | "option";

export interface NativeClipboardReader {
	getText(): string;
	hasImage(): boolean;
	getImageBinary(): Uint8Array;
}

export interface NativeClipboard extends NativeClipboardReader {
	setText(text: string): void;
}

type NativePlatformHelper = {
	enableVirtualTerminalInput?: () => boolean;
	isModifierPressed?: (name: ModifierKey) => boolean;
	isClipboardAvailable?: () => boolean;
	getClipboardText?: () => string;
	setClipboardText?: (text: string) => void;
	hasClipboardImage?: () => boolean;
	getClipboardImage?: () => Uint8Array;
};

let nativePlatformHelper: NativePlatformHelper | null | undefined;
let nativeClipboardHelper: NativePlatformHelper | null | undefined;
let nativeClipboardReader: NativeClipboardReader | null | undefined;
let nativeClipboard: NativeClipboard | null | undefined;

function isNativePlatformHelper(value: unknown): value is NativePlatformHelper {
	if (typeof value !== "object" || value === null) return false;
	const candidate = value as Record<string, unknown>;
	return (
		typeof candidate.isModifierPressed === "function" ||
		typeof candidate.enableVirtualTerminalInput === "function" ||
		typeof candidate.getClipboardText === "function"
	);
}

function loadNativePlatformHelper(nativePath: string): NativePlatformHelper | undefined {
	for (const modulePath of getNativeModuleCandidates(nativePath)) {
		try {
			const helper = cjsRequire(modulePath) as unknown;
			if (isNativePlatformHelper(helper)) return helper;
		} catch {
			// Try the next possible packaging location.
		}
	}
	return undefined;
}

export function getNativePlatformHelper(): NativePlatformHelper | undefined {
	if (nativePlatformHelper !== undefined) return nativePlatformHelper ?? undefined;
	nativePlatformHelper = null;

	const arch = process.arch;
	if (arch !== "x64" && arch !== "arm64") return undefined;

	let nativePath: string;
	if (process.platform === "darwin") {
		nativePath = path.join("native", "darwin", "prebuilds", `darwin-${arch}`, "darwin-platform.node");
	} else if (process.platform === "win32") {
		nativePath = path.join("native", "win32", "prebuilds", `win32-${arch}`, "win32-platform.node");
	} else {
		return undefined;
	}

	nativePlatformHelper = loadNativePlatformHelper(nativePath) ?? null;
	return nativePlatformHelper ?? undefined;
}

function getNativeClipboardHelper(): NativePlatformHelper | undefined {
	if (nativeClipboardHelper !== undefined) return nativeClipboardHelper ?? undefined;
	nativeClipboardHelper = null;

	const arch = process.arch;
	if (arch !== "x64" && arch !== "arm64") return undefined;

	if (process.platform !== "linux") {
		nativeClipboardHelper = getNativePlatformHelper() ?? null;
		return nativeClipboardHelper ?? undefined;
	}

	const nativePaths: string[] = [];
	if (process.env.WAYLAND_DISPLAY) {
		nativePaths.push(path.join("native", "linux", "prebuilds", `linux-${arch}`, "linux-platform-wayland.node"));
	}
	if (process.env.DISPLAY) {
		nativePaths.push(path.join("native", "linux", "prebuilds", `linux-${arch}`, "linux-platform-x11.node"));
	}

	for (const nativePath of nativePaths) {
		const helper = loadNativePlatformHelper(nativePath);
		if (!helper?.isClipboardAvailable) continue;
		try {
			if (helper.isClipboardAvailable()) {
				nativeClipboardHelper = helper;
				return helper;
			}
		} catch {
			// Try the next display backend.
		}
	}

	return undefined;
}

export function getNativeClipboardReader(): NativeClipboardReader | undefined {
	if (nativeClipboardReader !== undefined) return nativeClipboardReader ?? undefined;
	nativeClipboardReader = null;

	const helper = getNativeClipboardHelper();
	if (!helper?.getClipboardText || !helper.hasClipboardImage || !helper.getClipboardImage) {
		return undefined;
	}

	const getText = helper.getClipboardText;
	const hasImage = helper.hasClipboardImage;
	const getImageBinary = helper.getClipboardImage;
	nativeClipboardReader = {
		getText: () => getText(),
		hasImage: () => hasImage(),
		getImageBinary: () => getImageBinary(),
	};
	return nativeClipboardReader;
}

export function getNativeClipboard(): NativeClipboard | undefined {
	if (nativeClipboard !== undefined) return nativeClipboard ?? undefined;
	nativeClipboard = null;

	const reader = getNativeClipboardReader();
	const helper = getNativeClipboardHelper();
	if (!reader || !helper?.setClipboardText) return undefined;

	const setText = helper.setClipboardText;
	nativeClipboard = {
		...reader,
		setText: (text) => setText(text),
	};
	return nativeClipboard;
}
