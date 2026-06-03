# Remote MCP Transport — Design Document

**Date:** 2026-06-03  
**Status:** Approved  
**Author:** Agent

## Overview

Add support for connecting to a remote MCP server via Streamable HTTP transport, while preserving the existing stdio subprocess transport as the default when no remote is configured.

## Config

A new config file at `~/.pi/mempalace.json`:

```json
{
  "mcpUrl": "https://mcp.example.com/mcp",
  "mcpTimeout": 8000
}
```

- `mcpUrl` (required for remote mode): Full URL of the MCP server endpoint.
- `mcpTimeout` (optional, default 8000ms): Per-request timeout in milliseconds.
- Missing file or malformed JSON → falls back to stdio subprocess (current behavior).
- Empty or invalid `mcpUrl` → falls back to stdio subprocess.

## Architecture

```
┌─────────────────────────────────────────────┐
│              MemPalaceRuntime                │
│  (circuit breaker, fallback tools, etc.)    │
└──────────────┬──────────────────────────────┘
               │
     ┌─────────┴──────────┐
     │  McpTransport (IF)  │
     │  ┌──────────────┐  │  ← subprocess (existing)
     │  │ StdioTransport│  │
     │  └──────────────┘  │
     │  ┌──────────────┐  │
     │  │  HttpTransport│  ← NEW: Streamable HTTP
     │  └──────────────┘  │
     └────────────────────┘
               ▲
               │ chosen by:
               │ ~/.pi/mempalace.json { "mcpUrl": "..." }
```

## New Files

### `src/mcp-config.ts`

Reads `~/.pi/mempalace.json`, validates fields, returns `McpConfig`. Returns empty config (no `mcpUrl`) when the file does not exist — this preserves current stdio behavior as the default.

### `src/mcp-transport.ts`

Defines the `McpTransport` interface and two implementations:

```typescript
interface McpTransport {
  connect(signal?: AbortSignal): Promise<void>;
  callTool(name: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<unknown>;
  listTools(signal?: AbortSignal): Promise<McpToolDefinition[]>;
  close(): void;
  isConnected: boolean;
}
```

#### `StdioTransport`

Wraps the existing subprocess logic from `mcp-client.ts`. No behavioral changes — the subprocess spawn, JSON-RPC over stdin/stdout, and line parsing move verbatim.

#### `HttpTransport`

Implements the MCP Streamable HTTP transport:

1. **Initialize**: POST to `mcpUrl` with `initialize` request. Capture `Mcp-Session-Id` from the response header.
2. **List tools**: POST to same URL with `Mcp-Session-Id` header + `tools/list` request. Parse tool definitions from response.
3. **Call tool**: POST to same URL with `Mcp-Session-Id` header + `tools/call` request. Parse result from response.
4. **Pending requests**: Maintains a `Map<number, { resolve, reject }>` keyed by JSON-RPC request ID, identical pattern to the existing stdio client.
5. **Timeouts**: Per-request timeout using `setTimeout`. Default 8s, configurable via `mcpTimeout` in config.
6. **Abort**: Clears pending request timers and resolves/rejects on `AbortSignal`.

No SSE event stream parsing is needed — responses arrive as regular JSON HTTP responses.

## Modified Files

### `src/mcp-client.ts`

`MemPalaceMcpClient` becomes a thin facade that delegates to an `McpTransport`. Direct subprocess/spawn logic moves to `StdioTransport`. Transport-agnostic utilities (`normalizeMcpToolResult`, `mcpToolSchemaToTypeBox`, `getMcpErrorKind`) stay in place.

### `src/runtime.ts`

- Imports `loadMcpConfig` and the transport types.
- `ensureMcpConnected()` loads config and instantiates the appropriate transport:
  - `mcpUrl` present → `HttpTransport`
  - `mcpUrl` absent → `StdioTransport` (current behavior)
- `shutdown()` calls `transport.close()` instead of `mcpClient.close()`.
- No changes to circuit breaker, fallback tool registration, or tool dispatch logic.

## Error Handling

| Scenario | Behavior |
|---|---|
| `mcpUrl` not set | Falls back to stdio subprocess (current behavior, zero change) |
| `mcpUrl` set, server unreachable | Tagged `"transport"` error → circuit breaker trips → tools fall back to Python CLI/local |
| `mcpUrl` set, `initialize` fails | Same as unreachable — transport error, circuit breaker |
| `mcpUrl` set, tools/list fails | Same — transport error, circuit breaker |
| Individual tool call fails (server error) | Tagged `"tool"` error → propagates to caller, no circuit breaker |
| Tool call times out | Tagged `"transport"` error → trips circuit breaker |
| Config file malformed JSON | Returns empty config → falls back to stdio subprocess |
| Config file missing/moved | Returns empty config → falls back to stdio subprocess |

The circuit breaker logic remains unchanged: transport errors trip it, tool-level errors do not.

## Backwards Compatibility

- Zero behavioral change when `~/.pi/mempalace.json` does not exist or has no `mcpUrl`.
- All existing tools, slash commands, hooks, and renderers continue to work identically.
- The stdio transport code is preserved verbatim inside `StdioTransport`.

## Testing Strategy

- **Unit tests**: Mock the transport interface to test `runtime.ts` logic (circuit breaker, fallback registration) without needing a real MCP server or Python.
- **HttpTransport tests**: Use an HTTP mock server (e.g., `nock` or `express`) to validate initialize → session-ID capture → tool call flow.
- **Integration test**: Run against the local mcp-proxy (port 28765) to verify end-to-end communication.
