# MemPalace pi extension

A pi package that brings core MemPalace workflows to pi.

## What it adds

- Slash commands:
  - `/mempalace:help`
  - `/mempalace:init`
  - `/mempalace:search <query>`
  - `/mempalace:mine [path]`
  - `/mempalace:status`
  - `/mempalace:doctor` (custom rendered status panel)
- Agent tools:
  - `mempalace_instructions`
  - `mempalace_init`
  - `mempalace_search`
  - `mempalace_mine`
  - `mempalace_status`
- MCP bridge:
  - starts `python3 -m mempalace.mcp_server` when available
  - dynamically exposes MemPalace MCP tools to the agent
  - uses MCP for `mempalace_status` and `mempalace_search` when possible, with CLI fallback
- Session hooks:
  - auto-save reminder every 15 non-command user messages
  - pre-compaction reminder that blocks compaction once per user checkpoint, then allows the retry to proceed

## Requirements

- Python 3.9+
- `mempalace` installed in the Python environment visible to `python3`, `python`, or the `mempalace` executable

## Install in pi

### Local package

From the package directory:

```bash
pi install .
```

Or add the local path to `.pi/settings.json` / `~/.pi/agent/settings.json`.

### From npm

```bash
pi install npm:mempalace-pi
```

## Usage

After installation, restart pi or run `/reload`, then use:

- `/mempalace:init`
- `/mempalace:status`
- `/mempalace:doctor`
- `/mempalace:search auth token rotation`
- `/mempalace:mine .`

## Publish to npm

Before publishing, confirm the package name is available:

```bash
npm view mempalace-pi name
```

Then publish:

```bash
npm publish
```

Pi will discover the package through the `pi` manifest in `package.json`.

## Package structure

This package now follows a simple library-style layout:

```text
mempalace-pi/
  src/
    index.ts        # pi extension entrypoint
    commands.ts     # slash commands
    hooks.ts        # session and compaction hooks
    renderers.ts    # custom UI renderers
    runtime.ts      # shared runtime / MCP state
    tools.ts        # core tool registrations
    utils.ts        # CLI helpers and shared utilities
    constants.ts    # package constants
    mcp-client.ts   # internal MCP bridge helper
  README.md
  LICENSE
  package.json
```

This avoids putting helper modules inside an auto-discovered `extensions/` directory, which can cause pi to try loading non-extension files as extension entrypoints, and keeps the package closer to normal library structure best practices.

## Notes

This extension now includes a built-in MCP bridge for `mempalace.mcp_server`, so pi agents can use the structured MemPalace tool surface when the MCP server is available. For compatibility, the package keeps CLI-backed fallbacks for setup, mining, and for status/search if MCP cannot be started.

If `MEMPAL_DIR` is set, the extension also kicks off a background `mempalace mine "$MEMPAL_DIR"` when an auto-save or pre-compact reminder triggers.
