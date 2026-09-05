import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	type FileEntry,
	JsonlSessionStorage,
	SessionManager,
	type SessionStorage,
} from "../../src/core/session-manager.ts";

/** A non-filesystem backend: records are copied at the same boundary as a DB commit. */
class RecordStorage implements SessionStorage {
	readonly records = new Map<string, FileEntry[]>();
	failWrites = false;

	createReference(header: { id: string }): string {
		return header.id;
	}

	load(reference: string): FileEntry[] | undefined {
		return structuredClone(this.records.get(reference));
	}

	write(reference: string, entries: readonly FileEntry[], mode: "create" | "rewrite" | "append"): void {
		if (this.failWrites) throw new Error("storage unavailable");
		if (mode === "create" && this.records.has(reference)) throw new Error("already exists");
		if (mode === "append" && !this.records.has(reference)) throw new Error("missing append target");
		this.records.set(
			reference,
			structuredClone(mode === "append" ? [...this.records.get(reference)!, ...entries] : [...entries]),
		);
	}
}

describe("SessionManager storage composition", () => {
	let directory: string;
	beforeEach(() => {
		directory = mkdtempSync(join(tmpdir(), "pi-storage-"));
	});
	afterEach(() => {
		rmSync(directory, { recursive: true, force: true });
	});

	for (const kind of ["records", "jsonl"] as const) {
		describe(kind, () => {
			let storage: SessionStorage;
			beforeEach(() => {
				storage =
					kind === "records"
						? new RecordStorage()
						: new JsonlSessionStorage(join(directory, "sessions"), { deferUntilAssistant: false });
			});

			it("persists before the first assistant and resumes the native leaf", () => {
				const manager = SessionManager.withStorage(directory, storage);
				const first = manager.appendMessage({ role: "user", content: "first", timestamp: 1 });
				const resumed = SessionManager.withStorage(directory, storage, manager.getSessionReference());
				expect(resumed.getSessionId()).toBe(manager.getSessionId());
				expect(resumed.getEntries()).toEqual(manager.getEntries());
				const second = resumed.appendMessage({ role: "user", content: "second", timestamp: 2 });
				expect(resumed.getEntry(second)?.parentId).toBe(first);
				expect(manager.openSession(resumed.getSessionReference()!).getEntries()).toEqual(resumed.getEntries());
				if (kind === "records") {
					expect(manager.getSessionFile()).toBeUndefined();
					expect(readdirSync(directory)).toEqual([]);
				}
			});

			it("keeps native branches, labels, compaction and custom entries on reload", () => {
				const manager = SessionManager.withStorage(directory, storage);
				const root = manager.appendMessage({ role: "user", content: "root", timestamp: 1 });
				manager.appendMessage({ role: "user", content: "abandoned", timestamp: 2 });
				manager.branch(root);
				const kept = manager.appendMessage({ role: "user", content: "kept", timestamp: 3 });
				manager.appendLabelChange(kept, "checkpoint");
				manager.appendCompaction("summary", kept, 1000);
				manager.appendModelChange("test", "model");
				manager.appendThinkingLevelChange("high");
				manager.appendCustomEntry("test:state", { limit: 100 });
				manager.appendCustomMessageEntry("test:context", "context", false);
				const restored = manager.openSession(manager.getSessionReference()!);
				expect(restored.getTree()).toEqual(manager.getTree());
				expect(restored.buildSessionContext()).toEqual(manager.buildSessionContext());
				expect(restored.getLabel(kept)).toBe("checkpoint");
				const originalReference = manager.getSessionReference()!;
				const forkReference = restored.createBranchedSession(restored.getLeafId()!)!;
				expect(forkReference).not.toBe(originalReference);
				expect(restored.openSession(forkReference).getTree()).toEqual(restored.getTree());
				expect(restored.openSession(originalReference).getTree()).toEqual(manager.getTree());
				expect(restored.getHeader()?.parentSession).toBe(originalReference);
			});

			it("uses the supplied backend for new sessions without retiring old records", () => {
				const manager = SessionManager.withStorage(directory, storage);
				const old = manager.getSessionReference()!;
				manager.appendCustomEntry("test:old");
				const fresh = manager.createNew();
				expect(fresh.getSessionReference()).not.toBe(old);
				expect(fresh.getEntries()).toEqual([]);
				expect(fresh.openSession(old).getEntries()).toEqual(manager.getEntries());
				manager.newSession();
				expect(manager.getSessionReference()).not.toBe(old);
				expect(manager.openSession(old).getEntries()).toHaveLength(1);
			});

			it("migrates through the backend without creating a transcript file", () => {
				const header = {
					type: "session" as const,
					version: 2,
					id: "legacy",
					timestamp: "2026-01-01T00:00:00Z",
					cwd: directory,
				};
				const reference = storage.createReference(header);
				storage.write(reference, [header], "create");
				const manager = SessionManager.withStorage(directory, storage, reference);
				expect(manager.getHeader()?.version).toBe(3);
				expect(storage.load(reference)?.[0]).toEqual(manager.getHeader());
			});

			it("rejects missing resumes and duplicate ids without replacing history", () => {
				expect(() => SessionManager.withStorage(directory, storage, "missing")).toThrow("Session not found");
				const manager = SessionManager.withStorage(directory, storage, undefined, { id: "existing" });
				manager.appendCustomEntry("test:keep");
				const reference = manager.getSessionReference()!;
				const previous = storage.load(reference);
				// The duplicate reference is backend-defined, not an invented filesystem path.
				expect(() => storage.write(reference, [], "create")).toThrow();
				expect(storage.load(reference)).toEqual(previous);
			});
		});
	}

	it("propagates write failures, never switching to a JSONL file", () => {
		const storage = new RecordStorage();
		storage.failWrites = true;
		expect(() => SessionManager.withStorage(directory, storage)).toThrow("storage unavailable");
		storage.failWrites = false;
		const manager = SessionManager.withStorage(directory, storage);
		storage.failWrites = true;
		expect(() => manager.appendCustomEntry("test:failure")).toThrow("storage unavailable");
		expect(manager.getEntries()).toEqual([]);
		expect(manager.getLeafId()).toBeNull();
		storage.failWrites = false;
		const committed = manager.appendCustomEntry("test:recovered");
		expect(manager.getEntry(committed)?.parentId).toBeNull();
		expect(manager.openSession(manager.getSessionReference()!).getEntries()).toEqual(manager.getEntries());
		expect(readdirSync(directory)).toEqual([]);
	});

	it("preserves the native CLI's delayed JSONL creation", () => {
		const manager = SessionManager.create(directory, directory);
		manager.appendMessage({ role: "user", content: "waiting", timestamp: 1 });
		expect(existsSync(manager.getSessionFile()!)).toBe(false);
	});
});
