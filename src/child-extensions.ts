import { access, readFile, realpath } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, parse } from "node:path";
import { fileURLToPath } from "node:url";
import { DefaultPackageManager, getAgentDir, SettingsManager } from "@earendil-works/pi-coding-agent";

export type ExtensionCandidate = { path: string; names: string[] };
export type ChildExtensionOptions = {
	cwd?: string;
	projectTrusted?: boolean;
	warn?: (message: string) => void;
	resolve?: () => Promise<ExtensionCandidate[]>;
};

async function discover(options: ChildExtensionOptions): Promise<ExtensionCandidate[]> {
	const cwd = options.cwd ?? process.cwd();
	const agentDir = getAgentDir();
	const settingsManager = SettingsManager.create(cwd, agentDir, { projectTrusted: options.projectTrusted ?? false });
	const manager = new DefaultPackageManager({ cwd, agentDir, settingsManager });
	// Never install missing packages just to enumerate candidates.
	const resources = await manager.resolve(async () => "skip");
	return Promise.all(resources.extensions.filter((r) => r.enabled).map(async (r) => {
		const names = [r.metadata.source, basename(r.path).replace(/\.(?:[cm]?js|ts)$/, "")];
		if (names.includes("index")) names.push(basename(dirname(r.path)));
		if (r.metadata.origin === "package") {
			for (let dir = dirname(r.path); dir !== parse(dir).root; dir = dirname(dir)) {
				try {
					const pkg = JSON.parse(await readFile(join(dir, "package.json"), "utf8"));
					if (typeof pkg.name === "string") { names.push(pkg.name); break; }
				} catch (error) {
					if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
				}
			}
		}
		return { path: await realpath(r.path), names };
	}));
}

/** Missing configuration preserves discovery; legacy absolute-path arrays remain supported. */
export async function loadChildExtensions(
	path = join(getAgentDir(), "pi-herdr-btw-extensions.json"),
	selfPath = fileURLToPath(new URL("../index.ts", import.meta.url)),
	options: ChildExtensionOptions = {},
): Promise<string[] | undefined> {
	let text: string;
	try { text = await readFile(path, "utf8"); }
	catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
		throw error;
	}
	const config: unknown = JSON.parse(text);
	if (Array.isArray(config)) {
		if (config.some((p) => typeof p !== "string" || !isAbsolute(p))) {
			throw new Error("/btw legacy extension whitelist must be a JSON array of absolute local paths");
		}
		const resolved = await Promise.all([selfPath, ...config].map(async (p: string) => {
			await access(p);
			return realpath(p);
		}));
		return [...new Set(resolved)];
	}
	if (!config || typeof config !== "object") throw new Error("/btw invalid extension policy");
	const value = config as Record<string, unknown>;
	const { mode = "inherit", allowlist = [], denylist = [], onMissing = "warn" } = value;
	if (Object.keys(value).some((key) => !["mode", "allowlist", "denylist", "onMissing"].includes(key))
		|| !["inherit", "allowlist", "denylist"].includes(mode as string)
		|| !["warn", "error"].includes(onMissing as string)
		|| ![allowlist, denylist].every((list) => Array.isArray(list) && list.every((s) => typeof s === "string" && s.trim().length > 0))) {
		throw new Error("/btw invalid extension policy: expected mode, allowlist, denylist and onMissing");
	}
	if (mode === "inherit") return undefined;
	const candidates = await (options.resolve ?? (() => discover(options)))();
	const self = await realpath(selfPath);
	const selectors = (mode === "allowlist" ? allowlist : denylist) as string[];
	const matched = new Set<string>();
	for (const selector of selectors) {
		let normalized = selector;
		if (isAbsolute(selector)) {
			try { normalized = await realpath(selector); }
			catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
		}
		const hits = candidates.filter((c) => c.path === normalized || c.names.includes(selector));
		// One package can intentionally expose multiple extension entry points.
		if (hits.length === 0 && mode === "allowlist") {
			const message = `/btw extension not installed or not enabled: ${selector}`;
			if (onMissing === "error") throw new Error(message);
			options.warn?.(message);
		}
		for (const hit of hits) matched.add(hit.path);
	}
	const selected = candidates.filter((c) => mode === "allowlist" ? matched.has(c.path) : !matched.has(c.path));
	// Never load a second copy of BTW from the discovered global package.
	return [...new Set([self, ...selected.filter((c) => !c.names.includes("pi-herdr-btw")).map((c) => c.path)])];
}
