import assert from "node:assert/strict";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadChildExtensions } from "../src/child-extensions.ts";
import { buildAgentStartArgs, type HerdrLaunchOptions } from "../src/core.ts";

test("child whitelist: opt-in, mandatory self, deduplication and fail-closed validation", async () => {
	const dir = await mkdtemp(join(tmpdir(), "btw extensions "));
	try {
		const config = join(dir, "config.json");
		const self = join(dir, "self.ts");
		const other = join(dir, "other.ts");
		await writeFile(self, "");
		await writeFile(other, "");
		assert.equal(await loadChildExtensions(config, self), undefined);
		await writeFile(config, JSON.stringify([other, self, other]));
		assert.deepEqual(await loadChildExtensions(config, self), [await realpath(self), await realpath(other)]);
		await writeFile(config, "[]");
		assert.deepEqual(await loadChildExtensions(config, self), [await realpath(self)]);
		for (const bad of ['{}', '["relative.ts"]', '[123]', 'invalid']) {
			await writeFile(config, bad);
			await assert.rejects(loadChildExtensions(config, self));
		}
		await writeFile(config, JSON.stringify([join(dir, "missing.ts")]));
		await assert.rejects(loadChildExtensions(config, self));
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("child launch disables discovery only for an explicit whitelist and preserves argument boundaries", () => {
	const options: HerdrLaunchOptions = {
		paneName: "btw-test", cwd: "/tmp", payloadPath: "/tmp/payload.json",
		model: "provider/model", thinkingLevel: "off", toolMode: "inherit",
		activeTools: ["read"], split: "right", initialMessage: "/btw --launch-draft",
	};
	assert.equal(buildAgentStartArgs(options, "pane").includes("--no-extensions"), false);
	const args = buildAgentStartArgs({ ...options, childExtensions: ["/tmp/my extension.ts", "/tmp/btw.ts"] }, "pane");
	const start = args.indexOf("--no-extensions");
	assert.deepEqual(args.slice(start, start + 5), ["--no-extensions", "-e", "/tmp/my extension.ts", "-e", "/tmp/btw.ts"]);
	assert.ok(args.includes("--no-session"));
	assert.equal(args.at(-1), options.initialMessage);
});
