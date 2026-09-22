import assert from "node:assert/strict";
import test from "node:test";
import { HELP_TEXT, parseBtwCommand, getBtwArgumentCompletions } from "../src/router.ts";

test("bare /btw opens an empty side pane", () => {
	assert.deepEqual(parseBtwCommand(""), { kind: "open" });
	assert.deepEqual(parseBtwCommand("   "), { kind: "open" });
});

test("only exact reserved first words route to subcommands", () => {
	assert.deepEqual(parseBtwCommand("config"), { kind: "config", args: "" });
	assert.deepEqual(parseBtwCommand("config auto-submit on"), {
		kind: "config",
		args: "auto-submit on",
	});
	assert.deepEqual(parseBtwCommand("merge"), { kind: "merge", text: "" });
	assert.deepEqual(parseBtwCommand("merge use the summary"), {
		kind: "merge",
		text: "use the summary",
	});
	assert.deepEqual(parseBtwCommand("help"), { kind: "help" });
	assert.deepEqual(parseBtwCommand("check"), { kind: "check" });
	assert.deepEqual(parseBtwCommand("cleanup"), { kind: "ask", question: "cleanup" });
	assert.deepEqual(parseBtwCommand("ask cleanup old records"), { kind: "ask", question: "cleanup old records" });
});

test("unknown first words remain questions", () => {
	assert.deepEqual(parseBtwCommand("configuration options?"), {
		kind: "ask",
		question: "configuration options?",
	});
	assert.deepEqual(parseBtwCommand("what is a merge sort?"), {
		kind: "ask",
		question: "what is a merge sort?",
	});
});

test("/btw ask is the escape hatch for reserved words", () => {
	assert.deepEqual(parseBtwCommand("ask merge sort"), { kind: "ask", question: "merge sort" });
	assert.deepEqual(parseBtwCommand("ask config files"), { kind: "ask", question: "config files" });
	assert.deepEqual(parseBtwCommand("ask"), { kind: "open" });
});

test("help text covers the full grammar", () => {
	for (const token of ["ask", "config", "merge", "help", "check"]) {
		assert.match(HELP_TEXT, new RegExp(`/btw ${token}`));
	}
});


test("subcommand completion includes check and leaves question text alone", () => {
 assert.equal(getBtwArgumentCompletions("cl"), null);
 assert.deepEqual(getBtwArgumentCompletions("ch")?.map((item) => item.value), ["check"]);
 assert.ok(getBtwArgumentCompletions("")?.some((item) => item.value === "config"));
 assert.equal(getBtwArgumentCompletions("check this code"), null);
 assert.equal(getBtwArgumentCompletions("cleanup "), null);
 assert.equal(getBtwArgumentCompletions("unknown"), null);
 assert.equal(getBtwArgumentCompletions("cl", true), null);
 assert.equal(getBtwArgumentCompletions("config", true), null);
 assert.ok(getBtwArgumentCompletions("", true)?.some((item) => item.value === "merge"));
});
