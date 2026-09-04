import assert from "node:assert/strict";
import { test } from "node:test";
import { getNativeClipboard, getNativeClipboardReader } from "../src/native-platform.ts";

test(
	"loads the clipboard API from the current native platform helper",
	{ skip: !["darwin", "win32"].includes(process.platform) || !["arm64", "x64"].includes(process.arch) },
	() => {
		const reader = getNativeClipboardReader();
		assert.ok(reader);
		assert.equal(typeof reader.getText, "function");
		assert.equal(typeof reader.hasImage, "function");
		assert.equal(typeof reader.getImageBinary, "function");

		const clipboard = getNativeClipboard();
		assert.ok(clipboard);
		assert.equal(typeof clipboard.setText, "function");
	},
);
