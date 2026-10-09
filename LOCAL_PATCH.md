# Custom BTW maintenance

This fork preserves the locally used changes on top of upstream
`oscabriel/pi-herdr-btw` tag `v0.3.1`, commit
`679916281e46d4930969183562b5d343df0e968c`.

## Behavior

- `/btw` uses saved defaults; cache sharing remains off by default.
- `/btw1 <question>` enables parent prompt-cache-key sharing for that launch only.
- `/btw2 <question>` enables parent prompt-cache-key and session-header sharing for that launch only.
- `/btw config share-key on|off` and `/btw config share-header on|off` persist defaults.
- Other upstream behavior (model/thinking/tool inheritance, split, draft and merge) is retained.

Sharing is experimental, not a cache-hit guarantee. It requires the native matching
parent-prefix context path. Key sharing supports OpenAI Responses and Codex
Responses only, and only replaces an existing nonempty `prompt_cache_key`.
Header sharing applies only to OpenAI Responses. A conflicting `session-id`
header prevents overriding `session_id`. The local child session identity is
never changed. `PI_HERDR_BTW_SHARE_CACHE_KEY=0` disables both sharing mechanisms.

Configuration stays in `~/.pi/agent/pi-herdr-btw.json`; no user configuration,
credentials, request logs or session files belong in this repository.

## Install the same release on every machine

The current `custom` branch requires Pi >=1.1.0 and Node >=22.19.0.
The older pinned release below predates the Pi 1.1 replay fixes. To install
the reviewed branch instead (not an immutable release):

```sh
pi install git:github.com/yitan1/pi-herdr-btw@custom
```

```sh
pi install git:github.com/yitan1/pi-herdr-btw@v0.3.1-custom.1
```

Remove the old `npm:pi-herdr-btw` entry from Pi settings after the Git installation
succeeds. Do not load both packages simultaneously. Run `/reload` in existing Pi
sessions, preferably after finishing any existing BTW side threads.

The Git tag is pinned. Update to a new reviewed release by explicitly installing
its new tag. Do not edit Pi's managed clone: package reconciliation can reset and
clean it. Make changes in a separate development clone on branch `custom`.

## Development and upstream updates

```sh
git clone https://github.com/yitan1/pi-herdr-btw.git
cd pi-herdr-btw
git switch custom
git remote add upstream https://github.com/oscabriel/pi-herdr-btw.git
npm ci --ignore-scripts --no-audit --no-fund
npm run check
```

Fetch upstream tags, review and merge the desired upstream release into `custom`,
resolve conflicts, run `npm run check`, and manually check Herdr launch/merge.
Create a new version and tag only after validation. Keep released tags immutable;
rollback by installing an earlier custom release tag.

The first custom release preserves the installed runtime TypeScript files
unchanged. It adds regression tests for aliases, configuration, supported APIs,
fallback behavior, header conflicts and the environment kill switch. Tests mock
Herdr and provider calls; they do not measure real API cache hits.

## Per-machine side-thread extension policy

Copy `child-extensions.example.json` to
`~/.pi/agent/pi-herdr-btw-extensions.json` (or Pi's custom agent directory).
The repository template has empty allow/deny lists and `mode: "inherit"`;
it contains no machine-specific extension preferences or paths.

- `inherit`: normal Pi extension discovery (also the default without a file).
- `allowlist`: select only enabled installed extensions matching `allowlist`.
  An empty list loads only BTW itself.
- `denylist`: select enabled installed extensions except matches in `denylist`.
  An empty list excludes nothing. New enabled extensions are automatically included.
- `onMissing`: `warn` (default, skip with notification) or `error` for unmatched
  allowlist selectors. Unmatched denylist selectors are harmless.

Selectors match exact package names, configured package sources, local extension
file stems, or absolute entry-point paths. A package name can select multiple
entry points. Names matching multiple local entries select all matches; use an
absolute path to narrow the selection. Matching is case-sensitive.

Named policies use Pi's package resolver with the current project trust state;
disabled resources stay disabled, untrusted project resources are not promoted,
and missing packages are not installed. They do not capture extra extensions
loaded solely via parent CLI `-e` arguments. BTW itself is always included and
cannot be excluded. Invalid configuration fails before creating a pane.
Legacy arrays of absolute paths retain their original strict validation behavior.
Only extensions are filtered, not skills, prompts, themes, or built-in tools.

All three commands (`/btw`, `/btw1`, `/btw2`) share this policy; their existing
cache-sharing overrides remain unchanged. No policy is written automatically.
Changes take effect on the next side-thread launch; reload the parent after code
updates. Existing children are unaffected.

Local deployment can use `~/.pi/agent/local-packages/pi-herdr-btw`, selected in
Pi's global packages settings instead of a pinned Git release. Keep changes out
of Pi-managed Git clones, which package reconciliation may reset. The development
clone and deployed copy must be kept in sync. Without an exclusion policy,
SoL-Pi Observation Pack's incompatibility with ephemeral sessions is unchanged.

## Ephemeral-only side sessions

All child launches use `--no-session`. Persistent session directories, parent
Observation Pack copies, lifecycle metadata, and the manual cleanup command have
been removed. Legacy `persistent` config values are ignored and omitted on save.
The existing temporary payload/mailbox protocol and its cleanup remain intact.
Existing user data under `btw-sessions/` is not removed by this code migration.
Action Fusion does not require persistent storage; Observation Pack still does.

## Request inheritance diagnostics

Parent request fingerprints are memory-only and session-bound. The optional
payload fields `parentRequestFingerprint` and `parentContextHash` are compatible
with existing version-4 payloads. Children check data integrity at load and compare
the first supported request against the parent baseline. `/btw check` is local.
No final-hook ordering guarantee is assumed; the README documents BTW's
observation point. The diagnostic does not mutate provider bodies or cache policy.
See README limitations before interpreting a match as a cache-hit guarantee.

## Local Pi 1.1.0 replay fix (2026-10-09)

Native replay now owns `context_with_system`, preserves the full parent transcript
(including system deltas), and does not return a forced `systemPrompt`. Pi 1.1.0
restores system state after `context` and projects forced prompts after extension
context transforms; the old combination duplicated/collapsed system state.
Only the child's initial consecutive system messages are replaced by the parent
prefix. The side-pane bridge and all child turns, including later child system
deltas, remain in the request. Injection is request-local, not session storage,
so merge still packages only the child's own text turns.

Before the first run only, `tools: inherit` restores the parent's ordered active
loadout if every requested name is registered and not hidden. It never attempts
partial activation, never retries on later turns, and checks the actual resulting
loadout before permitting native mode. Overrides, missing tools, mismatches,
missing parent prompt and legacy conversation-only payloads retain reference
fallback. `/btw check` shows concrete mode/reason, model/thinking, ordered tools,
missing/extra active names and restoration status without showing parent content,
session IDs, capabilities or request bodies. A pre-run check is read-only.

Context mode, first-request prefix comparison at BTW's hook, and sharing hints
are separate observations. No one of them establishes a cache hit. Existing
sharing API gates, conflict detection and kill switch remain intact. Other
extensions can still modify the transcript/loadout or force a prompt after BTW;
providers may collapse system deltas depending on API support. No final wire or
live provider cache behavior was tested.

Offline host tests (use development dependencies or an installed Pi >=1.1.0):

```sh
npm run test:local
# Explicit host override:
PI_TEST_HOST=/path/to/installed/pi-coding-agent npm run test:local
```

The Node harness resolves the development host first, then npm's global package
directory, or uses an explicit `PI_TEST_HOST` override. It uses that host's jiti
and aliases its Pi entry point.
It exercises mocked extension APIs plus the actual Pi 1.1.0 ExtensionRunner
context dispatch and AgentSession forced-prompt projection without constructing
sessions, reading credentials, starting providers or creating panes. The `test`/`typecheck` scripts require development dependencies. `npm run check`
runs typechecking, the TypeScript suite, and these host tests. Host peer minimums,
development dependencies and the lockfile now target Pi 1.1.0.

## Pi 1.1 built-in discovery fix (2026-10-09)

Inactive registered web tools are not necessarily hidden.
For example, pi-web-access 0.37.0 registers enabled tools normally, then its
`session_start` activation policy makes them inactive in a fresh dynamic session.
BTW's atomic restoration stopped at the missing `codemode`, leaving these tools
inactive as well. There is no activation event on that installed package's event
bus. `web_enable` is its loader tool; it uses Pi's `setActiveTools()` and enables
**every configured capability**. BTW must not run it automatically, since that
could exceed the parent's active subset. Registered non-hidden tools can instead
be selected by the existing supported Pi API with the exact ordered parent list.
Hidden or unavailable tools continue to block restoration without partial changes.
Diagnostics now distinguish unregistered from hidden and report exact restoration.

Named extension policies now give PackageManager the documented Pi 1.1 CLI
built-in catalog, so enabled `builtin:codemode` and the other built-ins survive a
named denylist's `--no-extensions`. Virtual builtin paths are not passed to
filesystem realpath. Selectors accept `builtin:codemode` or `codemode`; disabled
resources and explicit policy exclusions remain excluded. Legacy path arrays
remain strict filesystem-only lists. No settings or machine policy was changed.

The catalog is guarded by availability of the public codemode factory and tested
against this installed CLI's actual factory catalog. Future hosts that change
that catalog need review; this is not arbitrary-version builtin enumeration.
`PI_TEST_WEB` can point to an installed pi-web-access `tool-activation.ts`
for the optional web integration test; without it that test is explicitly skipped.
The added tests exercise actual package discovery and resource loading with CLI
built-ins, actual CLI argument parsing, disabled builtin resources, the auto-name
denylist, installed web activation/session-start and `web_enable` behavior, exact
subset restoration and hidden-tool rejection. No models, panes, network queries,
or MCP connections are started. Discovery tests use temporary synthetic settings,
not personal package preferences.

The first before-agent hook is still only BTW's observation point. A later
extension can change the loadout; notably web-access may re-add `web_enable` when
its fresh-session policy selected it but a parent snapshot omitted it. Such
cases cannot be promised an exact final request prefix by this patch. No live
provider cache behavior was tested. Reload the parent and create a new child to
use the fix; existing children retain their loaded code and resource set.

## Recommended inheritance strategy

Prefer `mode: "inherit"` (or no extension policy file) to retain normal host
discovery and its built-ins. Extensions that should not act in side threads
should guard their own hooks using `PI_HERDR_BTW_PAYLOAD`, rather than relying
on a machine-specific denylist that may drift from the parent loadout. Such
per-machine extension edits and global settings do not belong in this package.
Named filtering remains available when deliberate child isolation is needed;
excluded or hidden parent tools correctly force reference fallback.

The existing `v0.3.1-custom.1` tag is unchanged; these fixes are branch commits,
not a new tagged release. Reload the parent and launch a new child after updating.
