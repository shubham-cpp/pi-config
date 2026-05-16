# Pi Config

Personal Pi config repo. Safe allowlist Git setup. Track chosen config + extensions. Ignore secrets, sessions, cache, history by default.

## Included

- `.gitignore` — ignore all by default; allowlist safe files only.
- `LICENSE` — Apache-2.0 license.
- `README.md` — this map.
- `agent/settings.json` — Pi defaults: provider, model, thinking, compaction, packages.
- `agent/mcp.json` — MCP server config.
- `agent/extensions/*.ts` — custom Pi extensions.
- `agent/themes/vague.json` — Pi theme ported from vague.nvim palette.

## Not included

- `agent/auth.json` — secrets/auth. Never commit.
- `agent/sessions/` — chat/session logs. Private/local.
- `agent/run-history.jsonl` — run history. Private/local.
- `agent/mcp-cache.json` — generated cache.
- `agent/mcp-npx-cache.json` — generated npx cache.

## Extensions

### `auto-session-name.ts`

Names new sessions from first prompt.

- Uses small Codex/OpenAI model when auth available.
- Falls back to cleaned prompt text when model/auth missing.
- Keeps title short: 2–6-ish words, no quotes/punctuation.

### `copy-all.ts`

Adds `copy-all` command.

- Waits until agent idle.
- Collects user + assistant messages from current branch.
- Converts text/image blocks into readable transcript.
- Copies transcript to clipboard using platform clipboard CLI.

Uses `pbcopy` on macOS. Uses `wl-copy` on Linux/Wayland. If neither program exists, shows: `cannot copy because program not found: pbcopy, wl-copy`.

### `fish-footer.ts`

Custom single-line Pi footer, fish-shell style.

Shows:

- shortened cwd, like fish `prompt_pwd`
- git branch
- session name
- context usage bar
- model/mode
- thinking level
- spinner while agent works

### `nerd-prompt-prefix.ts`

Custom prompt editor with nerd-font prefix + reverse history search.

Adds:

- prompt prefix from `PI_PROMPT_PREFIX`, default ` `
- prompt history from previous Pi sessions
- `Ctrl-r` reverse search panel
- up/down navigation inside search
- enter accept, escape cancel

## Themes

### `vague`

Dark Pi theme based on local vague.nvim palette from:

Design choices:

- `#141415` base bg for export page.
- `#1c1c24` / `#252530` for message + tool surfaces.
- `#7e98e8` hint blue as main accent.
- `#7fa563`, `#d8647e`, `#f3be7c` for success/error/warning.
- terminal default text preserved for main message text.
- full `fg` used for dense tool output/code blocks for readability.

Enabled by:

```json
"theme": "vague"
```

## Installed packages

From `agent/settings.json`:

### `npm:pi-mcp-adapter`

Pi package for MCP adapter support. Lets Pi talk to MCP servers/tools.

### `npm:pi-subagents`

Subagent workflows for Pi.

Purpose:

- delegate tasks to specialist agents
- run chains/parallel agents
- async/background agent runs
- review/advisory flows

### `npm:pi-web-access`

Web access tools/skills for Pi.

Purpose:

- web search
- fetch web content
- code/docs search
- library/source research

### `npm:@juicesharp/rpiv-ask-user-question`

Interactive user-question tool package.

Purpose:

- structured clarification prompts
- single/multi choice questions
- richer decision UI during agent runs

## MCP servers

From `agent/mcp.json`:

### `context7`

Runs via:

```bash
npx -y @upstash/context7-mcp
```

Purpose: fetch current library docs/API references through Context7 MCP.

Lifecycle: lazy. Starts only when needed.

## Pre-commit check

Run before commit:

```bash
git status --short
grep -R "token\|key\|secret\|password" README.md agent/settings.json agent/mcp.json agent/extensions agent/themes || true
```
