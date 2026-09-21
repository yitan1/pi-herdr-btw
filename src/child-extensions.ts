import { access, readFile, realpath } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

/** Missing file preserves automatic discovery; an explicit list always includes BTW itself. */
export async function loadChildExtensions(
	path = join(getAgentDir(), "pi-herdr-btw-extensions.json"),
	selfPath = fileURLToPath(new URL("../index.ts", import.meta.url)),
): Promise<string[] | undefined> {
	let text: string;
	try {
		text = await readFile(path, "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
		throw error;
	}
	const paths: unknown = JSON.parse(text);
	if (!Array.isArray(paths) || paths.some((p) => typeof p !== "string" || !isAbsolute(p))) {
		throw new Error("/btw extension whitelist must be a JSON array of absolute local paths");
	}
	const resolved = await Promise.all([selfPath, ...paths].map(async (p: string) => {
		await access(p);
		return realpath(p);
	}));
	return [...new Set(resolved)];
}
