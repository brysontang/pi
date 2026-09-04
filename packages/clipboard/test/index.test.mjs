import assert from "node:assert/strict";
import { test } from "node:test";

const expectedFunctions = [
	"availableFormats",
	"callThreadsafeFunction",
	"clear",
	"getHtml",
	"getImageBase64",
	"getImageBinary",
	"getRtf",
	"getText",
	"hasHtml",
	"hasImage",
	"hasRtf",
	"hasText",
	"setHtml",
	"setImageBase64",
	"setImageBinary",
	"setRtf",
	"setText",
	"watch",
];

test("loads the native binding and exposes the clipboard API", async () => {
	const clipboard = await import("../dist/index.cjs");
	for (const name of expectedFunctions) {
		assert.equal(typeof clipboard[name], "function", `${name} is not a function`);
	}
});
