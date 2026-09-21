import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

const OBJECT = /^obs_[a-f0-9]{24}\.txt$/;
const SAFE_ID = /^[a-z0-9][a-z0-9._-]*$/i;
const MAX_SNAPSHOT_BYTES = 512 * 1024 * 1024;
const digest = (data: Buffer) => createHash("sha256").update(data).digest("hex");
function safeId(id: string): string {
	if (!SAFE_ID.test(id) || id === "." || id === "..") throw new Error("Unsafe BTW session identity");
	return id;
}
export function persistentPaths(launchId: string, agentDir = getAgentDir()) {
	const root = join(agentDir, "btw-sessions", safeId(launchId));
	return { root, sessions: join(root, "sessions"), snapshot: join(root, "parent-observations") };
}
async function directory(path: string, create = false): Promise<void> {
	if (create) await mkdir(path, { mode: 0o700 }).catch((error: NodeJS.ErrnoException) => {
		if (error.code !== "EEXIST") throw error;
	});
	const stat = await lstat(path);
	if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`Not a regular directory: ${path}`);
	if (process.platform !== "win32" && (stat.uid !== process.getuid?.() || (create && (stat.mode & 0o077)))) {
		throw new Error(`Not a private owned directory: ${path}`);
	}
}
async function readObject(path: string): Promise<Buffer> {
	const link = await lstat(path);
	if (!link.isFile() || link.isSymbolicLink()) throw new Error(`Not a regular observation file: ${path}`);
	const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
	try {
		const before = await handle.stat();
		if (!before.isFile() || before.size > MAX_SNAPSHOT_BYTES) throw new Error(`Invalid observation object: ${path}`);
		const data = await handle.readFile();
		const after = await handle.stat();
		if (before.size !== data.length || before.size !== after.size || before.mtimeMs !== after.mtimeMs) {
			throw new Error(`Observation changed during snapshot: ${path}`);
		}
		return data;
	} finally { await handle.close(); }
}

/** Called while the parent is idle, before any side pane is created. */
export async function preparePersistentSession(
	launchId: string, parentSessionDir: string | undefined, parentSessionId: string, agentDir = getAgentDir(),
): Promise<string> {
	const paths = persistentPaths(launchId, agentDir);
	await directory(agentDir);
	await directory(join(agentDir, "btw-sessions"), true);
	// Never reuse or clean an existing launch directory.
	await mkdir(paths.root, { mode: 0o700 });
	try {
		await directory(paths.sessions, true);
		await directory(paths.snapshot, true);
		const manifest: Array<{ name: string; hash: string; bytes: number }> = [];
		let total = 0;
		if (parentSessionDir) {
			let source = parentSessionDir;
			let present = true;
			await directory(source);
			for (const part of ["sol-pi", safeId(parentSessionId), "observation-pack", "objects"]) {
				source = join(source, part);
				try { await directory(source); }
				catch (error) {
					if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
					present = false; break;
				}
			}
			if (present) {
				for (const name of (await readdir(source)).sort()) {
					if (!OBJECT.test(name)) continue;
					const data = await readObject(join(source, name));
					total += data.length;
					if (total > MAX_SNAPSHOT_BYTES) throw new Error("BTW observation snapshot exceeds 512 MiB");
					await writeFile(join(paths.snapshot, name), data, { flag: "wx", mode: 0o600 });
					manifest.push({ name, hash: digest(data), bytes: data.length });
				}
			}
		}
		await writeFile(join(paths.root, "observations.json"), JSON.stringify(manifest), { flag: "wx", mode: 0o600 });
		return paths.sessions;
	} catch (error) {
		await rm(paths.root, { recursive: true, force: true });
		throw error;
	}
}

/** Install verified objects under the child's real identity before its first request. */
export async function installParentObservations(
	launchId: string, sessionDir: string | undefined, sessionId: string, agentDir = getAgentDir(),
): Promise<void> {
	const paths = persistentPaths(launchId, agentDir);
	for (const path of [agentDir, join(agentDir, "btw-sessions"), paths.root, paths.snapshot, paths.sessions]) await directory(path);
	if (!sessionDir || await realpath(sessionDir) !== await realpath(paths.sessions)) {
		throw new Error("BTW persistent child was started with an unexpected session directory");
	}
	const manifest: unknown = JSON.parse((await readObject(join(paths.root, "observations.json"))).toString("utf8"));
	if (!Array.isArray(manifest) || manifest.some((entry) => !entry || !OBJECT.test(entry.name)
		|| !/^[a-f0-9]{64}$/.test(entry.hash) || !Number.isSafeInteger(entry.bytes) || entry.bytes < 0)) {
		throw new Error("Invalid BTW observation snapshot manifest");
	}
	let target = paths.sessions;
	for (const part of ["sol-pi", safeId(sessionId), "observation-pack", "objects"]) {
		target = join(target, part); await directory(target, true);
	}
	let total = 0;
	for (const entry of manifest) {
		const data = await readObject(join(paths.snapshot, entry.name));
		total += data.length;
		if (data.length !== entry.bytes || digest(data) !== entry.hash || total > MAX_SNAPSHOT_BYTES) {
			throw new Error(`Invalid BTW observation snapshot object: ${entry.name}`);
		}
		const dest = join(target, entry.name);
		try { await writeFile(dest, data, { flag: "wx", mode: 0o600 }); }
		catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
			if (!(await readObject(dest)).equals(data)) throw new Error(`Conflicting child observation: ${entry.name}`);
		}
	}
}
