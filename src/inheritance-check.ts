import { createHash } from "node:crypto";

export type RequestFingerprint = {
	version: 1;
	sessionId: string;
	provider: string;
	model: string;
	api: string;
	capturedAt: string;
	systemHash: string;
	toolsHash: string;
	inputHashes: string[];
	captureMs: number;
};
const HASH = /^[a-f0-9]{64}$/;
export function fingerprint(value: unknown): string {
	const serialized = JSON.stringify(value, (_key, item) => {
		if (item && typeof item === "object" && !Array.isArray(item)) {
			return Object.fromEntries(Object.keys(item).sort().map((key) => [key, item[key]]));
		}
		return item;
	});
	return createHash("sha256").update(serialized ?? "undefined").digest("hex");
}
export function isRequestFingerprint(value: unknown): value is RequestFingerprint {
	if (!value || typeof value !== "object") return false;
	const v = value as RequestFingerprint;
	return v.version === 1 && [v.sessionId, v.provider, v.model, v.api, v.capturedAt].every((s) => typeof s === "string")
		&& HASH.test(v.systemHash) && HASH.test(v.toolsHash) && Array.isArray(v.inputHashes)
		&& v.inputHashes.every((s) => typeof s === "string" && HASH.test(s))
		&& Number.isFinite(v.captureMs) && v.captureMs >= 0;
}

/** A fingerprint of the payload observed at BTW's hook, not a final wire guarantee. */
export function captureRequest(
	body: unknown,
	identity: { sessionId: string; provider: string; model: string; api: string },
): RequestFingerprint | undefined {
	const started = performance.now();
	if (!["openai-responses", "openai-codex-responses"].includes(identity.api)
		|| !body || typeof body !== "object") return undefined;
	const b = body as Record<string, unknown>;
	// Unknown request shapes must not be reported as matching empty histories.
	if (!Array.isArray(b.input) || b.input.length === 0 || typeof b.model !== "string"
		|| b.previous_response_id != null || b.conversation != null
		|| (b.tools !== undefined && !Array.isArray(b.tools))
		|| (b.instructions !== undefined && b.instructions !== null && typeof b.instructions !== "string")) return undefined;
	const systemItems = b.input.filter((item) => item && typeof item === "object"
		&& ["system", "developer"].includes(item.role));
	return {
		version: 1, ...identity, model: b.model, capturedAt: new Date().toISOString(),
		systemHash: fingerprint({ instructions: b.instructions, systemItems }),
		toolsHash: fingerprint(b.tools),
		inputHashes: b.input.map((item) => fingerprint(item)),
		captureMs: performance.now() - started,
	};
}
export type InheritanceReport = {
	status: "match" | "different" | "no-baseline" | "unsupported" | "fallback";
	system?: boolean;
	tools?: boolean;
	identity?: boolean;
	matched: number;
	parentItems: number;
	checkMs: number;
};
export function compareRequests(parent: RequestFingerprint | undefined, child: RequestFingerprint | undefined, native: boolean): InheritanceReport {
	const started = performance.now();
	const base = { matched: 0, parentItems: parent?.inputHashes.length ?? 0, checkMs: child?.captureMs ?? 0 };
	if (!native) return { ...base, status: "fallback" };
	if (!parent) return { ...base, status: "no-baseline" };
	if (!child) return { ...base, status: "unsupported" };
	let matched = 0;
	while (matched < parent.inputHashes.length && parent.inputHashes[matched] === child.inputHashes[matched]) matched++;
	const system = parent.systemHash === child.systemHash;
	const tools = parent.toolsHash === child.toolsHash;
	const identity = parent.provider === child.provider && parent.model === child.model && parent.api === child.api;
	return { system, tools, identity, matched, parentItems: parent.inputHashes.length,
		status: system && tools && identity && matched === parent.inputHashes.length ? "match" : "different",
		checkMs: child.captureMs + performance.now() - started };
}
export function formatInheritanceReport(report: InheritanceReport | undefined): string {
	if (!report) return "首次请求继承检查：待首次请求（不会为检查额外调用模型）";
	const labels = { match: "可观测前缀匹配", different: "不一致", "no-baseline": "无父请求基准，未验证", unsupported: "API 或请求格式不支持，未验证", fallback: "参考文档继承，不是原样请求前缀" };
	const lines = [`首次请求继承检查：${labels[report.status]}`];
	if (report.system !== undefined) lines.push(`系统提示词：${report.system ? "一致" : "不同"}；工具定义：${report.tools ? "一致" : "不同"}；模型/API：${report.identity ? "一致" : "不同"}`,
		`父请求输入前缀：${report.matched}/${report.parentItems} 项匹配${report.matched < report.parentItems ? `（首个差异/缺失：第 ${report.matched + 1} 项）` : ""}`);
	lines.push(`检查耗时：${report.checkMs.toFixed(2)} ms`, "范围：BTW 请求钩子处；后续扩展仍可能修改。缓存命中以 API usage 为准。");
	return lines.join("\n");
}
