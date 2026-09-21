export type BtwRoute =
	| { kind: "open" }
	| { kind: "ask"; question: string }
	| { kind: "config"; args: string }
	| { kind: "merge"; text: string }
	| { kind: "help" }
	| { kind: "check" }
	| { kind: "cleanup" };

export const HELP_TEXT = `/btw usage:
/btw                        open an empty side pane using saved defaults
/btw <question...>          open a side pane with a draft question
/btw1 <question...>         open btw with shared cache key only
/btw2 <question...>         open btw with shared cache key and session header
/btw ask <question...>      explicit form for questions starting with a reserved word
/btw config [...]           show or change defaults (persistent, auto-submit, share-key, share-header, model, thinking, tools, split, reset)
/btw merge <prompt...>      fold this side thread into the parent and continue with the prompt
/btw check                  show inheritance diagnostics without a model request
/btw cleanup                delete one or all Ready records (no second confirmation)
/btw help                   show this grammar`;

/**
 * Exact first-word routing. Only the reserved words `ask`, `config`, `merge`,
 * `check`, `cleanup`, and `help` are subcommands; any other first word keeps the whole input as a
 * question. `/btw ask ...` is the escape hatch for questions that begin with a
 * reserved word.
 */
export function parseBtwCommand(input: string): BtwRoute {
	const trimmed = input.trim();
	if (!trimmed) return { kind: "open" };

	const spaceIndex = trimmed.search(/\s/);
	const first = spaceIndex === -1 ? trimmed : trimmed.slice(0, spaceIndex);
	const rest = spaceIndex === -1 ? "" : trimmed.slice(spaceIndex).trim();

	switch (first) {
		case "ask":
			return rest ? { kind: "ask", question: rest } : { kind: "open" };
		case "config":
			return { kind: "config", args: rest };
		case "merge":
			return { kind: "merge", text: rest };
		case "cleanup":
			return { kind: "cleanup" };
		case "check":
			return { kind: "check" };
		case "help":
			return { kind: "help" };
		default:
			return { kind: "ask", question: trimmed };
	}
}

/** Complete only the first argument; never reinterpret free-form question text. */
export function getBtwArgumentCompletions(prefix: string, child = false) {
	const argument = prefix.trimStart();
	if (/\s/.test(argument)) return null;
	const commands = child
		? [
			["merge", "Merge this side thread into the parent"],
			["check", "Show inheritance diagnostics"],
			["cleanup", "Review and delete closed persistent records"],
			["help", "Show command help"],
		]
		: [
			["ask", "Ask a question starting with a reserved word"],
			["config", "Show or change defaults"],
			["merge", "Check pending side-thread merges"],
			["check", "Show request baseline status"],
			["cleanup", "Review and delete closed persistent records"],
			["help", "Show command help"],
		];
	const items = commands.filter(([value]) => value!.startsWith(argument))
		.map(([value, description]) => ({ value: value!, label: value!, description }));
	return items.length ? items : null;
}
