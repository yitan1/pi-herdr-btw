> **Custom fork:** Maintained on the `custom` branch. Install with
> `pi install git:github.com/yitan1/pi-herdr-btw@v0.3.1-custom.1`.
> Adds `/btw1` and `/btw2` opt-in cache-sharing experiments.
> See [LOCAL_PATCH.md](LOCAL_PATCH.md) for behavior, migration and maintenance.
> The upstream README follows; its npm install command installs upstream, not this fork.

# pi-herdr-btw

A [Pi](https://github.com/earendil-works/pi) extension inspired by [Claude Code's `/btw`](https://code.claude.com/docs/en/interactive-mode#side-questions-with-/btw). It opens a tool-enabled side conversation in a focused [Herdr](https://github.com/ogulcancelik/herdr) pane without changing the parent transcript.

Unlike Claude Code's one-shot, tool-free overlay, this side thread runs in a separate Pi process and supports editing the initial question, tools, and follow-ups, as well as merding the side thread back into the main one with a summary.

## Behavior

- snapshots the parent's current, compaction-aware context
- inherits its cwd, model, and thinking level by default
- prefills the question for review by default
- leaves the parent session unchanged
- remains usable while the parent is working

## Requirements

- [Pi](https://pi.dev/) and [Herdr](https://herdr.dev) v0.7.4+ installed (launches use `herdr pane split` + `herdr agent start --kind pi --pane`).
- Pi running in a Herdr-managed pane

## Install

```bash
pi install npm:pi-herdr-btw
```

From a checkout:

```bash
pi install /absolute/path/to/pi-herdr-btw
```

## Usage

```text
/btw                              open an empty side pane
/btw <question...>                open a side pane with a draft question
/btw ask <question...>            escape hatch for questions starting with a reserved word
/btw config [...]                 show or change defaults
/btw merge <prompt...>            fold this side thread into the parent and continue with the prompt
/btw help                         show the grammar
```

Only the exact first words `ask`, `config`, `merge`, and `help` are subcommands; anything else is a question. The new pane opens with the question ready to edit or submit.

## Merge

In the side pane, `/btw merge <prompt>` closes the loop: it packages the side conversation (user/assistant turns, no tool payloads) as a transcript, hands it to the parent together with your prompt, refocuses the parent pane, and closes the side pane. The parent appends the transcript as one visible, context-participating message and auto-submits your prompt, so it is already working with the side thread's findings by the time you are back. Bare `/btw merge` opens an editor to compose the prompt.

Delivery waits for the parent to settle if it is busy and survives reloads; an unacknowledged merge outlives the closed pane until the parent picks it up. In the parent, `/btw merge` rescans for pending requests.

## Config

Run `/btw config` to show current defaults.

```text
/btw config auto-submit on|off
/btw config model inherit|provider/model
/btw config thinking inherit|off|minimal|low|medium|high|xhigh|max
/btw config tools inherit|all|read-only|none
/btw config split right|down
/btw config reset
```

Settings are stored in Pi's agent directory (`~/.pi/agent/pi-herdr-btw.json` by default).

## Prompt cache

When the child inherits the parent's model, tools, and thinking level (the defaults), it replays the parent's exact system prompt and native messages so providers with prefix-based prompt caching (notably Anthropic) can reuse the warm parent cache. Configured model, tool, or thinking overrides are explicit cache-breaking choices; the child then falls back to a portable flattened snapshot and says why. OpenAI/gateway cache routing across the new child session is not guaranteed.

## Caveats

The child receives a static context snapshot and does not see later parent activity; use `/btw merge <prompt>` to fold the side thread back in. The child shares the working directory, so enabled tools can modify shared files. Very large parent contexts may exceed the child's context limit.

Launch data is stored in a private temporary directory, removed when the child exits normally (unacknowledged merges are retained until delivered), and cleaned up after 24 hours if left stale.

## Development

```bash
npm install
npm run check
npm run pack:check
```

## License

MIT

### Per-machine side-thread extensions

Copy `child-extensions.example.json` to
`~/.pi/agent/pi-herdr-btw-extensions.json` (or your custom Pi agent directory).
The shipped template uses `mode: "inherit"` and empty `allowlist` / `denylist`:
no extensions are excluded or hard-coded by default.

Use `mode: "allowlist"` to load only named enabled extensions, or
`mode: "denylist"` to exclude named enabled extensions. Entries may be package
names, local extension file stems, configured package sources, or absolute
entry-point paths. `onMissing: "warn"` skips unmatched allowlist entries with a
warning; `"error"` blocks the launch. Missing denylist entries are harmless.
BTW itself is always included. An empty allowlist loads only BTW; an empty
 denylist keeps all discovered enabled extensions. The old absolute-path array
format remains supported. Configuration is local and is not synced by Git.

This applies equally to `/btw`, `/btw1`, and `/btw2`; cache-sharing behavior is
unchanged. See [maintenance notes](LOCAL_PATCH.md#per-machine-side-thread-extension-policy)
for trust, discovery, and deployment details.

### Optional persistent side sessions (Observation Pack compatibility)

The default remains ephemeral. Enable on each machine with:

```text
/btw config persistent on
```

This applies to `/btw`, `/btw1`, and `/btw2`. Persistent children use
`<agentDir>/btw-sessions/<launchId>/sessions` instead of `--no-session`.
Before splitting a pane, BTW snapshots the idle parent's SoL-Pi Observation Pack
`objects/` into a private per-launch directory. Before the child's first request,
verified copies are installed under the child's own `sol-pi/<sessionId>/`
runtime directory. Existing observation IDs therefore remain recallable without
sharing the parent's writable state. No SoL-Pi source changes are required.
Parent journals and reducer state are NOT copied. Missing Observation Pack data
is valid; copying or verification failures block the launch/child input.
Snapshots are capped at 512 MiB; they are never silently truncated.

For matching tool availability, use extension policy `mode: "inherit"` (the
shipped template). In persistent mode inherited extensions are resolved explicitly
and BTW is placed first, so it injects parent history before other context hooks
such as Observation Pack. As with named policies, parent CLI-only `-e` extensions
are not discovered. Cache reuse remains experimental: context transforms and tool
schemas can differ even with identical tool names; confirm with provider usage.

These directories contain full tool outputs and child transcripts. They are kept
on disk after exit, including completed snapshots from failed launches; automatic
cleanup is deliberately not implemented. Delete a launch directory manually only
after its child has stopped and any merge has completed. Persistent storage does
not yet provide standalone resumable BTW context: the parent snapshot/merge
protocol still uses the existing temporary payload mailbox.

Disable for future launches with `/btw config persistent off`. Existing side
threads and saved data are not changed. Persistent mode supports Observation Pack
object inheritance only, not a generic migration of all SoL-Pi runtime state.

### Inheritance diagnostics

`/btw check` displays diagnostics locally without a model call. In a parent it
reports whether a recent request baseline exists; in a child it shows parent-data
integrity, Observation Pack installation status, and the first-request comparison.
`check` is now a reserved first word: use `/btw ask check ...` for a question.

The parent fingerprints each supported request and retains only its latest
baseline in memory. Launch payloads contain hashes, not an extra copy of request
text. Switching/reloading sessions clears the baseline; after `/reload`, send a
normal parent message before opening a child if you want a comparison baseline.
The child automatically checks its first request only. Subsequent `/btw check`
commands show that saved result, not a fresh validation of later turns.

Currently supported: OpenAI Responses and Codex Responses with explicit nonempty
`input` arrays. Server-side conversation/previous-response references and unknown
formats report unverified. Checks cover provider/API/model identity, system and
developer prompt material, complete ordered tool definitions, and the longest
matching input-item prefix. Object keys are canonicalized; arrays and message
fields are preserved. Different cache keys alone do not create a prompt mismatch.

Results are observations at BTW's `before_provider_request` hook, NOT a guarantee
of the final wire payload: later extension hooks can still change it. The baseline
covers the parent's last request, not the assistant/tool messages generated after
that request. Missing baselines, fallback document mode, unsupported requests and
mismatches are reported explicitly; they do not alter cache sharing or block an
otherwise valid conversation. Parent-data integrity failure still blocks input.
Actual cache hits must be confirmed from provider usage.

The display reports fingerprint/comparison time, excluding snapshot disk copying,
payload integrity verification, and network latency. Diagnostics themselves do
not send additional API requests.
