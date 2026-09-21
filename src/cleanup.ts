import { constants } from "node:fs";
import { lstat, mkdir, open, readdir, rename, rm, writeFile } from "node:fs/promises";
import { hostname } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { getAgentDir, type ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { ContextStore } from "./context-store.ts";
import { ackMatchesRequest, isMergeRequest } from "./merge.ts";
import { persistentPaths } from "./persistent-session.ts";

const STATE_FILE = "lifecycle.json";
type Lifecycle = {
	version: 1; launchId: string; host: string; pid: number;
	state: "running" | "closed"; createdAt: string; payloadPath: string;
	merge: "none" | "pending" | "unknown";
};
export type CleanupEntry = { launchId: string; createdAt: string; bytes: number; status: "Ready" | "Running" | "Pending merge" | "Unknown"; reason?: string };

async function checkedDirectory(path: string): Promise<void> {
	const stat = await lstat(path);
	if (!stat.isDirectory() || stat.isSymbolicLink() || (process.platform !== "win32" && stat.uid !== process.getuid?.())) {
		throw new Error("Unsafe or foreign directory");
	}
}
async function checkedRoot(launchId: string, agentDir: string): Promise<string> {
	const root = persistentPaths(launchId, agentDir).root;
	for (const path of [agentDir, join(agentDir, "btw-sessions"), root]) await checkedDirectory(path);
	return root;
}
async function readState(root: string, launchId: string): Promise<Lifecycle> {
	const path = join(root, STATE_FILE);
	const stat = await lstat(path);
	if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 16 * 1024) throw new Error("Invalid lifecycle file");
	const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
	let value: Lifecycle;
	try { value = JSON.parse(await handle.readFile("utf8")); } finally { await handle.close(); }
	if (!value || value.version !== 1 || value.launchId !== launchId || typeof value.host !== "string"
		|| !Number.isSafeInteger(value.pid) || value.pid <= 0 || !["running", "closed"].includes(value.state)
		|| !["none", "pending", "unknown"].includes(value.merge) || typeof value.payloadPath !== "string"
		|| typeof value.createdAt !== "string" || !Number.isFinite(Date.parse(value.createdAt))) throw new Error("Invalid lifecycle metadata");
	return value;
}
async function writeState(root: string, value: Lifecycle): Promise<void> {
	const temp = join(root, `.lifecycle-${randomUUID()}.tmp`);
	try {
		await writeFile(temp, JSON.stringify(value), { flag: "wx", mode: 0o600 });
		await rename(temp, join(root, STATE_FILE));
	} finally { await rm(temp, { force: true }); }
}
async function withLock<T>(root: string, run: () => Promise<T>): Promise<T> {
	const lock = join(root, ".lifecycle-lock");
	await mkdir(lock, { mode: 0o700 }); // No stale-lock guessing: unknown state is retained.
	try { return await run(); } finally { await rm(lock, { recursive: true, force: true }); }
}
function processStatus(pid: number): "alive" | "dead" | "unknown" {
	try { process.kill(pid, 0); return "alive"; }
	catch (error) { return (error as NodeJS.ErrnoException).code === "ESRCH" ? "dead" : "unknown"; }
}

/** Only the child records lifecycle state. No directory is deleted on exit. */
export async function markPersistentRunning(launchId: string, payloadPath: string, agentDir = getAgentDir()): Promise<void> {
	const root = await checkedRoot(launchId, agentDir);
	await withLock(root, async () => {
		try {
			const previous = await readState(root, launchId);
			if (previous.host !== hostname() || (previous.pid !== process.pid && processStatus(previous.pid) !== "dead")) {
				throw new Error("Persistent side thread may already be running");
			}
		} catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
		const stat = await lstat(root);
		await writeState(root, { version: 1, launchId, host: hostname(), pid: process.pid, state: "running",
			createdAt: new Date(stat.birthtimeMs || stat.mtimeMs).toISOString(), payloadPath, merge: "unknown" });
	});
}
export async function markPersistentClosed(launchId: string, agentDir = getAgentDir()): Promise<void> {
	const root = await checkedRoot(launchId, agentDir);
	await withLock(root, async () => {
		const state = await readState(root, launchId);
		if (state.pid !== process.pid || state.host !== hostname()) throw new Error("Lifecycle owner mismatch");
		let merge: Lifecycle["merge"] = "unknown";
		try {
			const store = new ContextStore();
			const payload = await store.read(state.payloadPath);
			if (payload.launchId !== launchId) throw new Error("Mailbox identity mismatch");
			const request = await store.readMergeRequest(state.payloadPath);
			if (request === undefined) merge = "none";
			else if (isMergeRequest(request) && request.launchId === launchId) {
				merge = ackMatchesRequest(await store.readMergeAck(state.payloadPath), request) ? "none" : "pending";
			}
		} catch { /* Never infer merge completion from a missing or unreadable mailbox. */ }
		await writeState(root, { ...state, state: "closed", merge });
	});
}
async function treeBytes(path: string): Promise<number> {
	const stat = await lstat(path);
	if (stat.isSymbolicLink()) throw new Error("Symlink in side-thread data");
	if (stat.isFile()) return stat.size;
	if (!stat.isDirectory()) throw new Error("Unexpected file type in side-thread data");
	let bytes = 0;
	for (const name of await readdir(path)) bytes += await treeBytes(join(path, name));
	return bytes;
}
async function inspect(launchId: string, agentDir: string, locked = false): Promise<CleanupEntry> {
	const entry: CleanupEntry = { launchId, createdAt: "unknown", bytes: 0, status: "Unknown" };
	try {
		const root = await checkedRoot(launchId, agentDir);
		const stat = await lstat(root);
		entry.createdAt = new Date(stat.birthtimeMs || stat.mtimeMs).toISOString();
		entry.bytes = await treeBytes(root);
		if (!locked && (await readdir(root)).includes(".lifecycle-lock")) throw new Error("Lifecycle operation in progress");
		const state = await readState(root, launchId);
		entry.createdAt = state.createdAt;
		if (state.host !== hostname()) throw new Error("Different host");
		const process = processStatus(state.pid);
		if (process === "alive") return { ...entry, status: "Running" };
		if (process !== "dead" || state.state !== "closed") throw new Error("Exit was not confirmed");
		if (state.merge === "unknown") throw new Error("Merge state was not confirmed");
		let mailboxExists = true;
		try { await lstat(state.payloadPath); }
		catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
			mailboxExists = false;
		}
		if (!mailboxExists && state.merge === "pending") throw new Error("Pending merge mailbox unavailable");
		if (mailboxExists) {
			const store = new ContextStore();
			const payload = await store.read(state.payloadPath);
			if (payload.launchId !== launchId) throw new Error("Mailbox identity mismatch");
			const request = await store.readMergeRequest(state.payloadPath);
			if (request !== undefined) {
				if (!isMergeRequest(request) || request.launchId !== launchId) throw new Error("Merge request unavailable");
				if (!ackMatchesRequest(await store.readMergeAck(state.payloadPath), request)) return { ...entry, status: "Pending merge" };
			} else if (state.merge === "pending") throw new Error("Pending merge request unavailable");
		}
		return { ...entry, status: "Ready" };
	} catch (error) {
		return { ...entry, reason: (error as NodeJS.ErrnoException).code === "ENOENT" ? "No lifecycle record (legacy or incomplete launch)" : error instanceof Error ? error.message : String(error) };
	}
}
export async function listCleanupEntries(agentDir = getAgentDir()): Promise<CleanupEntry[]> {
	await checkedDirectory(agentDir);
	const base = join(agentDir, "btw-sessions");
	try { await checkedDirectory(base); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
	const result: CleanupEntry[] = [];
	for (const name of await readdir(base)) {
		if (!/^[a-z0-9][a-z0-9._-]*$/i.test(name)) continue;
		result.push(await inspect(name, agentDir));
	}
	return result.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}
export async function deleteCleanupEntry(launchId: string, agentDir = getAgentDir()): Promise<void> {
	const root = await checkedRoot(launchId, agentDir);
	await withLock(root, async () => {
		const current = await inspect(launchId, agentDir, true);
		if (current.status !== "Ready") throw new Error(`Cleanup refused: ${current.status}${current.reason ? ` (${current.reason})` : ""}`);
		// Move out of the launch namespace while holding its lifecycle lock.
		const tombstone = join(agentDir, "btw-sessions", `.deleting-${randomUUID()}`);
		await rename(root, tombstone);
		await rm(tombstone, { recursive: true });
	});
}
export async function showCleanup(ctx: ExtensionCommandContext): Promise<void> {
	if (!ctx.hasUI) { ctx.ui.notify("/btw cleanup requires an interactive UI.", "warning"); return; }
	try {
		const entries = await listCleanupEntries();
		if (!entries.length) { ctx.ui.notify("No persistent BTW records.", "info"); return; }
		const labels = entries.map((entry) => `${entry.createdAt} | ${(entry.bytes / 1024 / 1024).toFixed(2)} MiB | ${entry.status} | ${entry.launchId}`);
		const selected = await ctx.ui.select("BTW cleanup — select one record (Esc to cancel)", labels);
		if (selected === undefined) return;
		const entry = entries[labels.indexOf(selected)];
		if (!entry) return;
		if (entry.status !== "Ready") { ctx.ui.notify(`Skipped: ${entry.status}${entry.reason ? ` — ${entry.reason}` : ""}`, "warning"); return; }
		if (!await ctx.ui.confirm("Delete BTW record?", `${entry.launchId}\nThis permanently deletes its transcript and SoL-Pi objects, including data referenced by copied merge text. Parent data and temporary mailboxes are not touched.`)) return;
		await deleteCleanupEntry(entry.launchId);
		ctx.ui.notify(`Deleted BTW record: ${entry.launchId}`, "info");
	} catch (error) { ctx.ui.notify(`BTW cleanup failed: ${error instanceof Error ? error.message : String(error)}`, "error"); }
}
