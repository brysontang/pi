import {
	getNativeClipboard,
	getNativeClipboardReader,
	type NativeClipboard,
	type NativeClipboardReader,
} from "@earendil-works/pi-tui";

function hasDisplay(): boolean {
	if (process.platform === "win32" || process.platform === "darwin") return true;
	return Boolean(process.env.DISPLAY || process.env.WAYLAND_DISPLAY);
}

export function getClipboardReader(): NativeClipboardReader | null {
	return hasDisplay() ? (getNativeClipboardReader() ?? null) : null;
}

export function getClipboardWriter(): NativeClipboard | null {
	return hasDisplay() ? (getNativeClipboard() ?? null) : null;
}
