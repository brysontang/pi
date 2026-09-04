import { getNativeClipboard } from "@earendil-works/pi-tui";

function hasDisplay(): boolean {
	if (process.platform === "win32" || process.platform === "darwin") return true;
	return Boolean(process.env.DISPLAY || process.env.WAYLAND_DISPLAY);
}

export const clipboard = hasDisplay() ? (getNativeClipboard() ?? null) : null;
