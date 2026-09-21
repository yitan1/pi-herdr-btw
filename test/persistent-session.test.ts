import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { installParentObservations, persistentPaths, preparePersistentSession } from "../src/persistent-session.ts";
import { applyConfigCommand, DEFAULT_CONFIG, parseConfig } from "../src/config.ts";
import { buildAgentStartArgs } from "../src/core.ts";

const name = "obs_0123456789abcdef01234567.txt";

test("persistent config is opt-in and launch flags are exclusive", () => {
	assert.equal(parseConfig({}).persistent, false);
	assert.equal(applyConfigCommand({ ...DEFAULT_CONFIG }, "persistent on").config.persistent, true);
	assert.throws(() => parseConfig({ persistent: "on" }));
	assert.throws(() => applyConfigCommand({ ...DEFAULT_CONFIG }, "persistent yes"));
	const args = buildAgentStartArgs({ paneName: "side", cwd: "/tmp", payloadPath: "/tmp/payload.json", model: "a/b", thinkingLevel: "off", toolMode: "inherit", activeTools: [], split: "right", sessionDir: "/tmp/side sessions" }, "pane");
	assert.ok(!args.includes("--no-session"));
	assert.equal(args[args.indexOf("--session-dir") + 1], "/tmp/side sessions");
});

test("observation snapshots preserve bytes and isolate parent, snapshot and child writes", async () => {
	const agent = await mkdtemp(join(tmpdir(), "btw-persistence-"));
	try {
		const parent = join(agent, "parent");
		const objects = join(parent, "sol-pi", "parent-id", "observation-pack", "objects");
		await mkdir(objects, { recursive: true, mode: 0o700 });
		const content = Buffer.from("original tool output 中文\n".repeat(1000));
		await writeFile(join(objects, name), content);
		await writeFile(join(objects, "../ledger.jsonl"), "parent-only journal");
		const sessions = await preparePersistentSession("launch-id", parent, "parent-id", agent);
		await writeFile(join(objects, name), "parent changed after snapshot");
		await installParentObservations("launch-id", sessions, "child-id", agent);
		const child = join(sessions, "sol-pi", "child-id", "observation-pack", "objects", name);
		assert.deepEqual(await readFile(child), content);
		await assert.rejects(readFile(join(sessions, "sol-pi", "child-id", "observation-pack", "ledger.jsonl")), { code: "ENOENT" });
		await installParentObservations("launch-id", sessions, "child-id", agent); // safe reload
		await writeFile(child, "child modified its copy");
		assert.equal(await readFile(join(objects, name), "utf8"), "parent changed after snapshot");
		assert.deepEqual(await readFile(join(persistentPaths("launch-id", agent).snapshot, name)), content);
		await assert.rejects(installParentObservations("launch-id", sessions, "child-id", agent), /Conflicting/);
		await assert.rejects(installParentObservations("launch-id", parent, "child-id", agent), /unexpected session directory/);
		await assert.rejects(preparePersistentSession("launch-id", parent, "parent-id", agent), { code: "EEXIST" });
	} finally { await rm(agent, { recursive: true, force: true }); }
});

test("no SoL-Pi data is valid; unsafe identities, symlinks and corrupted snapshots fail closed", async () => {
	const agent = await mkdtemp(join(tmpdir(), "btw-persistence-"));
	try {
		const sessions = await preparePersistentSession("empty", undefined, "parent", agent);
		await installParentObservations("empty", sessions, "child", agent);
		assert.deepEqual(await readdir(join(sessions, "sol-pi", "child", "observation-pack", "objects")), []);
		assert.throws(() => persistentPaths("../escape", agent));
		const parent = join(agent, "parent");
		const objects = join(parent, "sol-pi", "parent", "observation-pack", "objects");
		await mkdir(objects, { recursive: true, mode: 0o700 });
		const external = join(agent, "external");
		await writeFile(external, "do not follow");
		await symlink(external, join(objects, name));
		await assert.rejects(preparePersistentSession("bad-link", parent, "parent", agent));
		await assert.rejects(readFile(join(persistentPaths("bad-link", agent).root, "observations.json")), { code: "ENOENT" });
		await rm(join(objects, name));
		await writeFile(join(objects, name), "valid object");
		const childDir = await preparePersistentSession("corrupt", parent, "parent", agent);
		await writeFile(join(persistentPaths("corrupt", agent).snapshot, name), "tampered");
		await assert.rejects(installParentObservations("corrupt", childDir, "child", agent), /Invalid BTW observation/);
	} finally { await rm(agent, { recursive: true, force: true }); }
});
