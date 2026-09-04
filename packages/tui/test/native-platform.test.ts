import assert from "node:assert/strict";
import { test } from "node:test";
import { getNativeClipboard } from "../src/native-platform.ts";

test(
	"loads the clipboard API from the current native platform helper",
	{ skip: !["darwin", "win32"].includes(process.platform) || !["arm64", "x64"].includes(process.arch) },
	() => {
		const clipboard = getNativeClipboard();
		assert.ok(clipboard);
		assert.equal(typeof clipboard.getText, "function");
		assert.equal(typeof clipboard.setText, "function");
		assert.equal(typeof clipboard.hasImage, "function");
		assert.equal(typeof clipboard.getImageBinary, "function");
	},
);
