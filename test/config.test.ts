import assert from "node:assert/strict";
import { lstat, mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
	applyConfigCommand,
	ConfigStore,
	DEFAULT_CONFIG,
	formatConfig,
	parseConfig,
} from "../src/config.ts";

test("config commands expose a small validated settings interface", () => {
	let config = { ...DEFAULT_CONFIG };
	config = applyConfigCommand(config, "auto-submit on").config;
	config = applyConfigCommand(config, "model anthropic/claude-sonnet").config;
	config = applyConfigCommand(config, "thinking xhigh").config;
	config = applyConfigCommand(config, "tools read-only").config;
	config = applyConfigCommand(config, "split down").config;

	assert.deepEqual(config, {
		...DEFAULT_CONFIG,
		autoSubmit: true,
		model: "anthropic/claude-sonnet",
		thinking: "xhigh",
		tools: "read-only",
		split: "down",
	});
	assert.match(formatConfig(config), /auto-submit: on/);
	assert.deepEqual(applyConfigCommand(config, "reset").config, DEFAULT_CONFIG);
	assert.throws(() => applyConfigCommand(config, "model not-a-qualified-model"), /btw config/);
	assert.throws(() => applyConfigCommand(config, "tools dangerous"), /btw config/);
});

test("parseConfig fills omitted values and rejects invalid values", () => {
	assert.deepEqual(parseConfig({ autoSubmit: true }), { ...DEFAULT_CONFIG, autoSubmit: true });
	assert.throws(() => parseConfig({ thinking: "huge" }), /thinking/);
	assert.throws(() => parseConfig({ split: "left" }), /split/);
});

test("ConfigStore persists private config and resets it", async (t) => {
	const directory = await mkdtemp(join(tmpdir(), "pi-herdr-btw-config-test-"));
	t.after(async () => {
		const { rm } = await import("node:fs/promises");
		await rm(directory, { recursive: true, force: true });
	});
	const path = join(directory, "config.json");
	const store = new ConfigStore(path);
	const config = { ...DEFAULT_CONFIG, autoSubmit: true, tools: "none" as const };

	assert.deepEqual(await store.load(), DEFAULT_CONFIG);
	await store.save(config);
	assert.deepEqual(await store.load(), config);
	assert.equal(JSON.parse(await readFile(path, "utf8")).tools, "none");
	if (process.platform !== "win32") assert.equal((await lstat(path)).mode & 0o777, 0o600);
	assert.deepEqual(await store.reset(), DEFAULT_CONFIG);
	assert.deepEqual(await store.load(), DEFAULT_CONFIG);
});

test("cache sharing is opt-in, validated, configurable and resettable", () => {
	assert.equal(parseConfig({}).shareKey, false);
	assert.equal(parseConfig({}).shareHeader, false);
	let config = applyConfigCommand({ ...DEFAULT_CONFIG }, "share-key on").config;
	config = applyConfigCommand(config, "share-header on").config;
	assert.equal(config.shareKey, true);
	assert.equal(config.shareHeader, true);
	assert.match(formatConfig(config), /share-key: on/);
	assert.match(formatConfig(config), /share-header: on/);
	assert.equal(applyConfigCommand(config, "share-key off").config.shareHeader, true);
	assert.equal(applyConfigCommand(config, "share-header off").config.shareKey, true);
	assert.deepEqual(applyConfigCommand(config, "reset").config, DEFAULT_CONFIG);
	assert.throws(() => parseConfig({ shareKey: "true" }), /shareKey/);
	assert.throws(() => parseConfig({ shareHeader: 1 }), /shareHeader/);
	assert.throws(() => applyConfigCommand(config, "share-key yes"), /btw config/);
	assert.throws(() => applyConfigCommand(config, "share-header yes"), /btw config/);
});
