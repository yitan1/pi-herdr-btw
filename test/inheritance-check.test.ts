import assert from "node:assert/strict";
import test from "node:test";
import { captureRequest, compareRequests, fingerprint, formatInheritanceReport, isRequestFingerprint } from "../src/inheritance-check.ts";
import { createPayload, isBtwPayload } from "../src/core.ts";
import { fixturePayloadOptions } from "./fixtures.ts";

const identity = { sessionId: "parent", provider: "openai", model: "test", api: "openai-responses" };
const request = () => ({ model: "test", instructions: "private system prompt", tools: [{ name: "read", parameters: { type: "object", properties: { path: { type: "string" } } } }], input: [{ role: "user", content: "private question" }, { type: "function_call_output", call_id: "call-1", output: "original tool result" }] });

test("fingerprints contain no prompt text, ignore object-key order, and preserve array order", () => {
	const result = captureRequest(request(), identity)!;
	assert.ok(isRequestFingerprint(result));
	assert.ok(!JSON.stringify(result).includes("private"));
	assert.equal(fingerprint({ a: 1, b: 2 }), fingerprint({ b: 2, a: 1 }));
	assert.notEqual(fingerprint([1, 2]), fingerprint([2, 1]));
	assert.equal(isRequestFingerprint({ ...result, toolsHash: "invalid" }), false);
	assert.equal(isRequestFingerprint({ ...result, captureMs: -1 }), false);
});

test("child suffixes retain the prefix; cache hints do not affect prompt fingerprints", () => {
	const body = request();
	const parent = captureRequest(body, identity)!;
	const child = captureRequest({ ...body, prompt_cache_key: "different", input: [...body.input, { role: "user", content: "side question" }] }, { ...identity, sessionId: "child" });
	const report = compareRequests(parent, child, true);
	assert.equal(report.status, "match");
	assert.equal(report.matched, 2);
	assert.ok(report.checkMs >= 0);
	assert.match(formatInheritanceReport(report), /后续扩展仍可能修改/);
});

test("system, same-name tool schema, tool order, context projection and model changes are detected", () => {
	const body = request();
	body.tools.push({ name: "bash", parameters: { type: "object", properties: { path: { type: "string" } } } });
	const parent = captureRequest(body, identity)!;
	for (const changed of [
		{ ...body, instructions: "changed system" },
		{ ...body, tools: [{ name: "read", parameters: { type: "object", properties: { path: { type: "number" } } } }, body.tools[1]] },
		{ ...body, tools: [...body.tools].reverse() },
		{ ...body, input: [body.input[0], { type: "function_call_output", call_id: "call-1", output: "[observation placeholder]" }] },
		{ ...body, input: body.input.slice(0, 1) },
		{ ...body, model: "other-model" },
	]) assert.equal(compareRequests(parent, captureRequest(changed, identity), true).status, "different");
	assert.equal(compareRequests(parent, captureRequest({ ...body, input: body.input.slice(0, 1) }, identity), true).matched, 1);
});

test("missing baselines, fallback and unsupported request formats never report a match", () => {
	const parent = captureRequest(request(), identity)!;
	assert.equal(compareRequests(undefined, parent, true).status, "no-baseline");
	assert.equal(compareRequests(parent, undefined, true).status, "unsupported");
	assert.equal(compareRequests(parent, parent, false).status, "fallback");
	for (const body of [null, {}, { ...request(), input: "string input" }, { ...request(), input: [] }, { ...request(), previous_response_id: "server-side-history" }]) assert.equal(captureRequest(body, identity), undefined);
	assert.equal(captureRequest(request(), { ...identity, api: "anthropic-messages" }), undefined);
	assert.match(formatInheritanceReport(undefined), /待首次请求/);
});

test("new payloads hash parent context; old payloads and optional request baselines remain compatible", () => {
	const options = fixturePayloadOptions();
	const payload = createPayload(options);
	assert.equal(payload.parentContextHash, fingerprint({ system: options.parentSystemPrompt, messages: options.messages }));
	const old = { ...payload }; delete old.parentContextHash;
	assert.ok(isBtwPayload(old));
	const baseline = captureRequest(request(), { ...identity, sessionId: payload.parentSessionId })!;
	assert.ok(isBtwPayload({ ...payload, parentRequestFingerprint: baseline }));
	assert.equal(isBtwPayload({ ...payload, parentRequestFingerprint: { ...baseline, sessionId: "wrong-session" } }), false);
});
