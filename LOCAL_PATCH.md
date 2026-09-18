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

Requires Pi >=0.85.1 and Node >=22.19.0.

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
