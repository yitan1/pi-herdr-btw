import assert from "node:assert/strict";
import test from "node:test";
import { spawnSync } from "node:child_process";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { deleteCleanupEntry, listCleanupEntries, markPersistentClosed, markPersistentRunning, showCleanup } from "../src/cleanup.ts";
import { ContextStore } from "../src/context-store.ts";
import { fixturePayload } from "./fixtures.ts";
import { MERGE_PROTOCOL_VERSION } from "../src/merge.ts";

const deadPid = spawnSync(process.execPath, ["-e", ""]).pid;
assert.ok(deadPid > 0);
async function record(agent: string, id: string, overrides: Record<string, unknown> = {}) {
 const root = join(agent, "btw-sessions", id);
 await mkdir(root, { recursive: true, mode: 0o700 });
 await writeFile(join(root, "transcript.jsonl"), "test transcript");
 await writeFile(join(root, "lifecycle.json"), JSON.stringify({ version: 1, launchId: id, host: hostname(), pid: deadPid, state: "closed", createdAt: "2026-01-01T00:00:00Z", payloadPath: "/not/a/mailbox", merge: "none", ...overrides }));
 return root;
}

test("inventory distinguishes ready/running/unknown and only deletes a confirmed closed record", async () => {
 const agent = await mkdtemp(join(tmpdir(), "btw-cleanup-"));
 try {
  assert.deepEqual(await listCleanupEntries(agent), []);
  const ready = await record(agent, "closed");
  await record(agent, "live", { pid: process.pid });
  await record(agent, "crashed", { state: "running" });
  await record(agent, "foreign", { host: "another-host" });
  await record(agent, "uncertain", { merge: "unknown" });
  const legacy = join(agent, "btw-sessions", "legacy");
  await mkdir(legacy); await writeFile(join(legacy, "old-data"), "legacy");
  const entries = new Map((await listCleanupEntries(agent)).map((entry) => [entry.launchId, entry]));
  assert.equal(entries.get("closed")?.status, "Ready");
  assert.ok(entries.get("closed")!.bytes > 0);
  assert.equal(entries.get("live")?.status, "Running");
  for (const id of ["crashed", "foreign", "uncertain", "legacy"]) assert.equal(entries.get(id)?.status, "Unknown");
  for (const id of ["live", "crashed", "foreign", "uncertain", "legacy"]) await assert.rejects(deleteCleanupEntry(id, agent), /refused/);
  await deleteCleanupEntry("closed", agent);
  await assert.rejects(lstat(ready), { code: "ENOENT" });
  assert.equal(await readFile(join(legacy, "old-data"), "utf8"), "legacy");
  await assert.rejects(deleteCleanupEntry("../escape", agent));
 } finally { await rm(agent, { recursive: true, force: true }); }
});

test("cleanup rechecks lifecycle after selection and rejects symlinks and locks", async () => {
 const agent = await mkdtemp(join(tmpdir(), "btw-cleanup-"));
 try {
  const root = await record(agent, "changed");
  assert.equal((await listCleanupEntries(agent))[0]?.status, "Ready");
  await record(agent, "changed", { pid: process.pid, state: "running" });
  await assert.rejects(deleteCleanupEntry("changed", agent), /Running/);
  await record(agent, "changed");
  const target = join(agent, "outside"); await mkdir(target); await writeFile(join(target, "keep"), "keep");
  await symlink(target, join(root, "linked"));
  await assert.rejects(deleteCleanupEntry("changed", agent), /Unknown/);
  assert.equal(await readFile(join(target, "keep"), "utf8"), "keep");
  await symlink(target, join(agent, "btw-sessions", "linked-root"));
  await assert.rejects(deleteCleanupEntry("linked-root", agent), /Unsafe/);
  const locked = await record(agent, "locked"); await mkdir(join(locked, ".lifecycle-lock"));
  await assert.rejects(deleteCleanupEntry("locked", agent), { code: "EEXIST" });
  assert.equal((await listCleanupEntries(agent)).find((entry) => entry.launchId === "locked")?.status, "Unknown");
 } finally { await rm(agent, { recursive: true, force: true }); }
});

test("child closure never deletes data; pending merges require a matching ack", async () => {
 const agent = await mkdtemp(join(tmpdir(), "btw-cleanup-"));
 const store = new ContextStore();
 let mailbox: string | undefined;
 try {
  const payload = fixturePayload({ launchId: "pending" });
  mailbox = await store.create(payload);
  const root = await record(agent, "pending");
  await markPersistentRunning("pending", mailbox, agent);
  const request = { protocolVersion: MERGE_PROTOCOL_VERSION, requestId: "request-1", launchId: payload.launchId, parentSessionId: payload.parentSessionId, capability: payload.capability, createdAt: new Date().toISOString(), summary: "summary", prompt: "continue" };
  await store.writeMergeRequest(mailbox, request);
  await markPersistentClosed("pending", agent);
  assert.equal(await readFile(join(root, "transcript.jsonl"), "utf8"), "test transcript");
  assert.equal((await listCleanupEntries(agent))[0]?.status, "Running"); // shutdown callback runs before PID exits
  const state = JSON.parse(await readFile(join(root, "lifecycle.json"), "utf8"));
  assert.equal(state.state, "closed"); assert.equal(state.merge, "pending");
  await writeFile(join(root, "lifecycle.json"), JSON.stringify({ ...state, pid: deadPid }));
  assert.equal((await listCleanupEntries(agent))[0]?.status, "Pending merge");
  await assert.rejects(deleteCleanupEntry("pending", agent), /Pending merge/);
  await store.writeMergeAck(mailbox, { protocolVersion: MERGE_PROTOCOL_VERSION, requestId: "stale-request", status: "accepted", processedAt: new Date().toISOString() });
  assert.equal((await listCleanupEntries(agent))[0]?.status, "Pending merge");
  await store.writeMergeAck(mailbox, { protocolVersion: MERGE_PROTOCOL_VERSION, requestId: request.requestId, status: "accepted", processedAt: new Date().toISOString() });
  assert.equal((await listCleanupEntries(agent))[0]?.status, "Ready");
  await deleteCleanupEntry("pending", agent);
  assert.ok(await store.read(mailbox)); // temporary mailbox not removed by manual cleanup
 } finally { if (mailbox) await store.remove(mailbox); await rm(agent, { recursive: true, force: true }); }
});

test("manual UI cancellation preserves records; confirmation is required and unknown records are skipped", async () => {
 const agent = await mkdtemp(join(tmpdir(), "btw-cleanup-ui-"));
 const previous = process.env.PI_CODING_AGENT_DIR;
 process.env.PI_CODING_AGENT_DIR = agent;
 try {
  const root = await record(agent, "closed");
  let confirmed = false;
  const notifications: string[] = [];
  const ctx = { hasUI: true, ui: {
   select: async (_title: string, items: string[]) => items[0],
   confirm: async () => confirmed,
   notify: (text: string) => notifications.push(text),
  } } as unknown as ExtensionCommandContext;
  await showCleanup(ctx); assert.ok(await lstat(root));
  confirmed = true;
  await showCleanup(ctx); await assert.rejects(lstat(root), { code: "ENOENT" });
  assert.match(notifications.at(-1)!, /Deleted BTW record/);
  const unknown = await record(agent, "unknown", { state: "running" });
  await showCleanup(ctx); assert.ok(await lstat(unknown));
  assert.match(notifications.at(-1)!, /Skipped: Unknown/);
 } finally {
  if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previous;
  await rm(agent, { recursive: true, force: true });
 }
});

test("normal closure with no merge stays cleanable after mailbox cleanup; missing mailbox at exit is unknown", async () => {
 const agent = await mkdtemp(join(tmpdir(), "btw-cleanup-"));
 const store = new ContextStore();
 let mailbox: string | undefined;
 try {
  mailbox = await store.create(fixturePayload({ launchId: "normal" }));
  const root = await record(agent, "normal");
  await markPersistentRunning("normal", mailbox, agent);
  await markPersistentClosed("normal", agent);
  const file = join(root, "lifecycle.json");
  const state = JSON.parse(await readFile(file, "utf8"));
  assert.equal(state.merge, "none");
  await store.remove(mailbox);
  await writeFile(file, JSON.stringify({ ...state, pid: deadPid }));
  assert.equal((await listCleanupEntries(agent))[0]?.status, "Ready");
  await markPersistentRunning("normal", mailbox, agent);
  await markPersistentClosed("normal", agent);
  const unknown = JSON.parse(await readFile(file, "utf8"));
  assert.equal(unknown.merge, "unknown");
  await writeFile(file, JSON.stringify({ ...unknown, pid: deadPid }));
  assert.equal((await listCleanupEntries(agent))[0]?.status, "Unknown");
 } finally { if (mailbox) await store.remove(mailbox); await rm(agent, { recursive: true, force: true }); }
});
