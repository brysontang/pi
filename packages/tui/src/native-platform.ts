import { createRequire } from "node:module";
import * as path from "node:path";
import { getNativeModuleCandidates } from "./native-module-path.ts";

const cjsRequire = createRequire(import.meta.url);

export type ModifierKey = "shift" | "command" | "control" | "option";

export interface NativeClipboard {
	getText(): string;
	setText(text: string): void;
	hasImage(): boolean;
	getImageBinary(): Uint8Array;
}

type NativePlatformHelper = {
	enableVirtualTerminalInput?: () => boolean;
	isModifierPressed?: (name: ModifierKey) => boolean;
	getClipboardText?: () => string;
	setClipboardText?: (text: string) => void;
	hasClipboardImage?: () => boolean;
	getClipboardImage?: () => Uint8Array;
};

let nativePlatformHelper: NativePlatformHelper | null | undefined;
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

	for (const modulePath of getNativeModuleCandidates(nativePath)) {
		try {
			const helper = cjsRequire(modulePath) as unknown;
			if (isNativePlatformHelper(helper)) {
				nativePlatformHelper = helper;
				return helper;
			}
		} catch {
			// Try the next possible packaging location.
		}
	}

	return undefined;
}

export function getNativeClipboard(): NativeClipboard | undefined {
	if (nativeClipboard !== undefined) return nativeClipboard ?? undefined;
	nativeClipboard = null;

	const helper = getNativePlatformHelper();
	if (
		!helper?.getClipboardText ||
		!helper.setClipboardText ||
		!helper.hasClipboardImage ||
		!helper.getClipboardImage
	) {
		return undefined;
	}

	const getText = helper.getClipboardText;
	const setText = helper.setClipboardText;
	const hasImage = helper.hasClipboardImage;
	const getImageBinary = helper.getClipboardImage;
	nativeClipboard = {
		getText: () => getText(),
		setText: (text) => setText(text),
		hasImage: () => hasImage(),
		getImageBinary: () => getImageBinary(),
	};
	return nativeClipboard;
}
