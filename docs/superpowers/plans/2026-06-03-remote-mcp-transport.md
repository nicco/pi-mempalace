# Remote MCP Transport Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add Streamable HTTP transport support so the extension can connect to a remote MCP server via `~/.pi/mempalace.json`, while preserving existing stdio subprocess behavior when no remote URL is configured.

**Architecture:** Introduce a `McpTransport` interface that abstracts the transport layer. Two implementations: `StdioTransport` (wraps existing subprocess logic, unchanged) and `HttpTransport` (new, uses MCP Streamable HTTP — POST requests with `Mcp-Session-Id` header). `MemPalaceMcpClient` becomes a thin facade delegating to whichever transport is selected by config. `MemPalaceRuntime` reads config and wires up the correct transport.

**Tech Stack:** TypeScript, Node.js 20+, `fetch` (native), JSON-RPC 2.0 over HTTP

---

## Task 1: Create mcp-config.ts — Config Loading

**Files:**
- Create: `src/mcp-config.ts`

### Step 1: Write the config module

Create `src/mcp-config.ts` with the config type, path constant, and loader function:

```typescript
import { homedir } from "node:os";
import { join } from "node:path";
import { readFile } from "node:fs/promises";

export type McpConfig = {
  mcpUrl?: string;
  mcpTimeout?: number;
};

const DEFAULT_TIMEOUT_MS = 8000;
const CONFIG_PATH = join(homedir(), ".pi", "mempalace.json");

export async function loadMcpConfig(): Promise<McpConfig> {
  try {
    const raw = await readFile(CONFIG_PATH, "utf8");
    const parsed = JSON.parse(raw) as McpConfig;
    return {
      mcpUrl: typeof parsed.mcpUrl === "string" && parsed.mcpUrl.trim()
        ? parsed.mcpUrl.trim()
        : undefined,
      mcpTimeout: typeof parsed.mcpTimeout === "number" && parsed.mcpTimeout > 0
        ? parsed.mcpTimeout
        : DEFAULT_TIMEOUT_MS,
    };
  } catch {
    // File missing, unreadable, or invalid JSON → empty config (falls back to stdio)
    return {};
  }
}
```

### Step 2: Verify it compiles

Run: `cd /home/nicco/projects/pi-mempalace && npx tsc --noEmit src/mcp-config.ts 2>&1 | head -20`
Expected: No errors (or only unrelated peer-dep warnings).

### Step 3: Commit

```bash
cd /home/nicco/projects/pi-mempalace
git add src/mcp-config.ts
git commit -m "feat: add mcp-config module for loading ~/.pi/mempalace.json"
```

---

## Task 2: Extract StdioTransport from mcp-client.ts

**Files:**
- Create: `src/mcp-transport.ts`
- Modify: `src/mcp-client.ts` (later, in Task 4)

This task extracts the subprocess/spawn/JSON-RPC-over-stdio logic from `mcp-client.ts` into a standalone `StdioTransport` class inside the new `mcp-transport.ts` file. The existing `mcp-client.ts` code is copied verbatim — no behavioral changes.

### Step 1: Create mcp-transport.ts with interface + StdioTransport

Create `src/mcp-transport.ts`:

```typescript
import { Type } from "@sinclair/typebox";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import * as readline from "node:readline";

// ---------------------------------------------------------------------------
// Public types (re-exported from mcp-client.ts for consumers)
// ---------------------------------------------------------------------------

export interface McpToolDefinition {
  name: string;
  description?: string;
  inputSchema?: {
    type?: string;
    properties?: Record<string, JsonSchema>;
    required?: string[];
  };
}

type JsonSchema = {
  type?: string;
  description?: string;
  enum?: unknown[];
  properties?: Record<string, JsonSchema>;
  required?: string[];
  items?: JsonSchema;
  minimum?: number;
  maximum?: number;
  maxLength?: number;
};

// ---------------------------------------------------------------------------
// Transport interface
// ---------------------------------------------------------------------------

export type McpErrorKind = "transport" | "tool" | "abort";

export interface McpTransport {
  connect(signal?: AbortSignal): Promise<void>;
  callTool(name: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<unknown>;
  listTools(signal?: AbortSignal): Promise<McpToolDefinition[]>;
  getTools(): McpToolDefinition[];
  getType(): "stdio" | "http";
  close(): void;
  get isConnected(): boolean;
  getCommandLine(): string;
  getStderr(): string;
}

// ---------------------------------------------------------------------------
// Tagged error helpers
// ---------------------------------------------------------------------------

type TaggedMcpError = Error & { mcpKind?: McpErrorKind };

export function createTaggedMcpError(message: string, kind: McpErrorKind): Error {
  const error = new Error(message) as TaggedMcpError;
  error.mcpKind = kind;
  return error;
}

export function getMcpErrorKind(error: unknown): McpErrorKind | undefined {
  return error instanceof Error ? (error as TaggedMcpError).mcpKind : undefined;
}

// ---------------------------------------------------------------------------
// StdioTransport — wraps the existing subprocess logic
// ---------------------------------------------------------------------------

const DEFAULT_MCP_CONNECT_TIMEOUT_MS = normalizeTimeout(process.env.MEMPALACE_MCP_CONNECT_TIMEOUT_MS, 8000);
const DEFAULT_MCP_REQUEST_TIMEOUT_MS = normalizeTimeout(process.env.MEMPALACE_MCP_REQUEST_TIMEOUT_MS, 8000);

export class StdioTransport implements McpTransport {
  private child?: ChildProcessWithoutNullStreams;
  private nextId = 1;
  private readonly pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
  private readonly discoveredTools = new Map<string, McpToolDefinition>();
  private stderrBuffer = "";
  private commandLine = "";
  private stdoutReader?: readline.Interface;

  get isConnected(): boolean {
    return !!this.child && !this.child.killed;
  }

  getCommandLine(): string {
    return this.commandLine;
  }

  getStderr(): string {
    return this.stderrBuffer.trim();
  }

  getTools(): McpToolDefinition[] {
    return [...this.discoveredTools.values()];
  }

  getType(): "stdio" {
    return "stdio";
  }

  async connect(signal?: AbortSignal): Promise<void> {
    if (this.isConnected && this.discoveredTools.size > 0) {
      return;
    }

    const attempts: Array<[string, string[]]> = [
      ["python3", ["-m", "mempalace.mcp_server"]],
      ["python", ["-m", "mempalace.mcp_server"]],
    ];

    const errors: Error[] = [];
    for (const [command, args] of attempts) {
      try {
        await this.spawnAndInitialize(command, args, signal, DEFAULT_MCP_CONNECT_TIMEOUT_MS);
        return;
      } catch (error) {
        const normalized = error instanceof Error ? error : new Error(String(error));
        errors.push(normalized);
        await this.close();
      }
    }

    throw this.summarizeConnectErrors(errors, attempts.map(([command]) => command));
  }

  async callTool(name: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<unknown> {
    if (!this.isConnected) {
      await this.connect(signal);
    }
    return this.request("tools/call", { name, arguments: args }, signal);
  }

  async listTools(signal?: AbortSignal): Promise<McpToolDefinition[]> {
    if (!this.isConnected) {
      await this.connect(signal);
    }
    const list = (await this.request("tools/list", {}, signal)) as { tools?: McpToolDefinition[] };
    return list.tools ?? [];
  }

  async close(): Promise<void> {
    for (const [, pending] of this.pending) {
      pending.reject(createTaggedMcpError("MemPalace MCP client closed.", "transport"));
    }
    this.pending.clear();

    this.stdoutReader?.close();
    this.stdoutReader = undefined;

    if (this.child && !this.child.killed) {
      this.child.kill();
    }
    this.child = undefined;
    this.discoveredTools.clear();
    this.commandLine = "";
  }

  private async spawnAndInitialize(
    command: string,
    args: string[],
    signal?: AbortSignal,
    timeoutMs = DEFAULT_MCP_CONNECT_TIMEOUT_MS,
  ): Promise<void> {
    this.stderrBuffer = "";
    this.commandLine = [command, ...args].join(" ");
    const child = spawn(command, args, { stdio: ["pipe", "pipe", "pipe"] });
    this.child = child;

    this.stdoutReader?.close();
    const rl = readline.createInterface({ input: child.stdout });
    this.stdoutReader = rl;
    rl.on("line", (line) => this.handleLine(line));
    child.stderr.on("data", (chunk) => {
      this.stderrBuffer += chunk.toString();
    });

    let startupComplete = false;
    let startupFailed = false;
    const startupFailure = new Promise<never>((_, reject) => {
      const fail = (error: Error) => {
        if (startupFailed) return;
        startupFailed = true;
        reject(error);
      };

      child.once("error", (error) => {
        fail(this.createStartupError(command, error.message));
      });
      child.once("exit", (code, sig) => {
        const reason = this.createStartupError(command, `process exited (${sig ?? code ?? "unknown"})`);
        if (!startupComplete) fail(reason);
        for (const [, pending] of this.pending) pending.reject(reason);
        this.pending.clear();
        this.child = undefined;
        this.stdoutReader?.close();
        this.stdoutReader = undefined;
      });
    });

    const abortStartup = () => {
      if (startupComplete || child.killed) return;
      child.kill();
    };
    signal?.addEventListener("abort", abortStartup, { once: true });

    let startupTimer: ReturnType<typeof setTimeout> | undefined;
    const clearStartupTimer = () => {
      if (!startupTimer) return;
      clearTimeout(startupTimer);
      startupTimer = undefined;
    };
    const startupTimeout = new Promise<never>((_, reject) => {
      startupTimer = setTimeout(() => {
        reject(this.createStartupError(command, `timed out after ${timeoutMs}ms during initialize/tools/list`));
      }, timeoutMs);
      signal?.addEventListener("abort", clearStartupTimer, { once: true });
    });

    try {
      await Promise.race([
        startupFailure,
        startupTimeout,
        (async () => {
          await this.request(
            "initialize",
            {
              protocolVersion: "2025-11-25",
              capabilities: { tools: {} },
              clientInfo: { name: "pi-mempalace", version: "0.2.2" },
            },
            signal,
          );
          await this.notify("notifications/initialized", {});
          const list = (await this.request("tools/list", {}, signal)) as { tools?: McpToolDefinition[] };
          this.discoveredTools.clear();
          for (const tool of list.tools ?? []) {
            this.discoveredTools.set(tool.name, tool);
          }
          startupComplete = true;
        })(),
      ]);
    } finally {
      clearStartupTimer();
      signal?.removeEventListener("abort", abortStartup);
      signal?.removeEventListener("abort", clearStartupTimer);
    }
  }

  private createStartupError(command: string, message: string): Error {
    const stderr = this.stderrBuffer.trim();
    const detail = stderr ? `${message}\n${stderr}` : message;
    return createTaggedMcpError(`Failed to start MemPalace MCP with ${command}: ${detail}`, "transport");
  }

  private summarizeConnectErrors(errors: Error[], attemptedCommands: string[]): Error {
    const messages = errors.map((error) => error.message).join("\n");
    const tried = attemptedCommands.join(", ");

    if (errors.length > 0 && errors.every((error) => /ENOENT/i.test(error.message))) {
      return createTaggedMcpError(`Python was not found (tried: ${tried}). Install Python 3 to enable MemPalace.`, "transport");
    }

    if (/No module named mempalace/i.test(messages)) {
      return createTaggedMcpError(`Python was found, but the mempalace package is not installed in the environment used by ${tried}.`, "transport");
    }

    return createTaggedMcpError(errors[errors.length - 1]?.message || "Failed to start MemPalace MCP server.", "transport");
  }

  private async notify(method: string, params: Record<string, unknown>): Promise<void> {
    if (!this.child) throw createTaggedMcpError("MemPalace MCP server is not running.", "transport");
    this.child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`);
  }

  private request(method: string, params: Record<string, unknown>, signal?: AbortSignal, timeoutMs = DEFAULT_MCP_REQUEST_TIMEOUT_MS): Promise<unknown> {
    if (!this.child) throw createTaggedMcpError("MemPalace MCP server is not running.", "transport");
    const id = this.nextId++;

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(createTaggedMcpError(`MemPalace MCP request timed out after ${timeoutMs}ms: ${method}`, "transport"));
      }, timeoutMs);
      const abort = () => {
        clearTimeout(timeout);
        this.pending.delete(id);
        reject(createTaggedMcpError(`MemPalace MCP request aborted: ${method}`, "abort"));
      };
      if (signal?.aborted) return abort();
      signal?.addEventListener("abort", abort, { once: true });

      this.pending.set(id, {
        resolve: (value) => {
          clearTimeout(timeout);
          signal?.removeEventListener("abort", abort);
          resolve(value);
        },
        reject: (error) => {
          clearTimeout(timeout);
          signal?.removeEventListener("abort", abort);
          reject(error);
        },
      });

      this.child?.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    });
  }

  private handleLine(line: string) {
    const trimmed = line.trim();
    if (!trimmed) return;
    let message: { jsonrpc?: string; id?: number; result?: unknown; error?: { code?: number; message?: string } };
    try {
      message = JSON.parse(trimmed) as typeof message;
    } catch {
      return;
    }
    if (typeof message.id !== "number") return;
    const pending = this.pending.get(message.id);
    if (!pending) return;
    this.pending.delete(message.id);
    if (message.error) {
      pending.reject(createTaggedMcpError(message.error.message || "Unknown MCP error", "tool"));
      return;
    }
    pending.resolve(message.result);
  }
}

function normalizeTimeout(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value || "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}
```

### Step 2: Verify compilation

Run: `cd /home/nicco/projects/pi-mempalace && npx tsc --noEmit src/mcp-transport.ts 2>&1 | head -20`
Expected: No errors.

### Step 3: Commit

```bash
cd /home/nicco/projects/pi-mempalace
git add src/mcp-transport.ts
git commit -m "feat: add McpTransport interface and StdioTransport (extracted from mcp-client)"
```

---

## Task 3: Append HttpTransport to mcp-transport.ts

**Files:**
- Modify: `src/mcp-transport.ts`

### Step 1: Append HttpTransport class

Add the following code at the end of `src/mcp-transport.ts`, after the closing brace of `StdioTransport` and before the `normalizeTimeout` function:

```typescript

// ---------------------------------------------------------------------------
// HttpTransport — MCP Streamable HTTP transport
// ---------------------------------------------------------------------------

export class HttpTransport implements McpTransport {
  private sessionId?: string;
  private nextId = 1;
  private readonly pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
  private readonly discoveredTools = new Map<string, McpToolDefinition>();
  private url = "";
  private timeoutMs: number;

  constructor(baseUrl: string, timeoutMs = DEFAULT_MCP_REQUEST_TIMEOUT_MS) {
    this.url = baseUrl;
    this.timeoutMs = timeoutMs;
  }

  get isConnected(): boolean {
    return !!this.sessionId;
  }

  getCommandLine(): string {
    return this.url;
  }

  getStderr(): string {
    return "";
  }

  getTools(): McpToolDefinition[] {
    return [...this.discoveredTools.values()];
  }

  getType(): "http" {
    return "http";
  }

  async connect(signal?: AbortSignal): Promise<void> {
    // Step 1: initialize
    const initResult = await this.post(
      "initialize",
      {
        protocolVersion: "2025-11-25",
        capabilities: { tools: {} },
        clientInfo: { name: "pi-mempalace", version: "0.2.2" },
      },
      signal,
    );

    if ((initResult as { error?: { message?: string } })?.error) {
      throw createTaggedMcpError(
        `MCP initialize failed: ${(initResult as { error: { message: string } }).error.message}`,
        "transport",
      );
    }

    // Step 2: capture session ID from response headers
    this.sessionId = (initResult as { _sessionId?: string })._sessionId;
    if (!this.sessionId) {
      throw createTaggedMcpError("MCP initialize did not return a session ID", "transport");
    }

    // Step 3: notify initialized
    await this.notify("notifications/initialized", {}, signal);

    // Step 4: list tools
    const list = (await this.request("tools/list", {}, signal)) as { tools?: McpToolDefinition[] };
    this.discoveredTools.clear();
    for (const tool of list.tools ?? []) {
      this.discoveredTools.set(tool.name, tool);
    }
  }

  async callTool(name: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<unknown> {
    if (!this.isConnected) {
      await this.connect(signal);
    }
    return this.request("tools/call", { name, arguments: args }, signal);
  }

  async listTools(signal?: AbortSignal): Promise<McpToolDefinition[]> {
    if (!this.isConnected) {
      await this.connect(signal);
    }
    const list = (await this.request("tools/list", {}, signal)) as { tools?: McpToolDefinition[] };
    return list.tools ?? [];
  }

  async close(): Promise<void> {
    for (const [, pending] of this.pending) {
      pending.reject(createTaggedMcpError("HTTP MCP transport closed.", "transport"));
    }
    this.pending.clear();
    this.sessionId = undefined;
    this.discoveredTools.clear();
  }

  private async notify(
    method: string,
    params: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<void> {
    if (!this.sessionId) throw createTaggedMcpError("HTTP MCP transport not connected.", "transport");
    await this.post(method, params, signal, true);
  }

  private request(
    method: string,
    params: Record<string, unknown>,
    signal?: AbortSignal,
    timeoutMs?: number,
  ): Promise<unknown> {
    if (!this.sessionId) throw createTaggedMcpError("HTTP MCP transport not connected.", "transport");
    const id = this.nextId++;
    const timeout = timeoutMs ?? this.timeoutMs;

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(createTaggedMcpError(`MCP request timed out after ${timeout}ms: ${method}`, "transport"));
      }, timeout);

      const abort = () => {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(createTaggedMcpError(`MCP request aborted: ${method}`, "abort"));
      };

      if (signal?.aborted) return abort();
      signal?.addEventListener("abort", abort, { once: true });

      this.pending.set(id, {
        resolve: (value) => {
          clearTimeout(timer);
          signal?.removeEventListener("abort", abort);
          resolve(value);
        },
        reject: (error) => {
          clearTimeout(timer);
          signal?.removeEventListener("abort", abort);
          reject(error);
        },
      });

      this.post(method, { ...params, _requestId: id }, signal)
        .then((result) => {
          this.pending.delete(id);
          resolve(result);
        })
        .catch((error) => {
          this.pending.delete(id);
          reject(error);
        });
    });
  }

  private async post(
    method: string,
    params: Record<string, unknown>,
    signal?: AbortSignal,
    isNotification = false,
  ): Promise<unknown> {
    if (!this.sessionId) throw createTaggedMcpError("HTTP MCP transport not connected.", "transport");

    const requestId = (params as { _requestId?: number })._requestId;
    const body = JSON.stringify({
      jsonrpc: "2.0",
      ...(requestId !== undefined ? { id: requestId } : {}),
      method,
      params,
    });

    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      Accept: "application/json",
      "Mcp-Session-Id": this.sessionId,
    };

    const response = await fetch(this.url, {
      method: "POST",
      headers,
      body,
      signal,
    });

    if (!response.ok) {
      const text = await response.text().catch(() => "");
      throw createTaggedMcpError(
        `MCP HTTP ${response.status}: ${text || response.statusText}`,
        "transport",
      );
    }

    // Capture session ID from response headers (may be set on first request)
    const newSessionId = response.headers.get("Mcp-Session-Id");
    if (newSessionId && newSessionId !== this.sessionId) {
      this.sessionId = newSessionId;
    }

    // For notifications, there may be no body
    if (isNotification) return undefined;

    const contentType = response.headers.get("content-type") || "";
    if (contentType.includes("text/event-stream")) {
      return await this.readSseResponse(response);
    }

    // Regular JSON response
    const data = await response.json() as { id?: number; result?: unknown; error?: { message?: string } };

    if (data.error) {
      throw createTaggedMcpError(data.error.message || "Unknown MCP error", "tool");
    }

    // Attach session ID for connect() to pick up
    if (this.sessionId) {
      (data as { _sessionId?: string })._sessionId = this.sessionId;
    }

    return data.result;
  }

  private async readSseResponse(response: Response): Promise<unknown> {
    const reader = response.body?.getReader();
    if (!reader) throw createTaggedMcpError("No response body for SSE stream.", "transport");

    const decoder = new TextDecoder();
    let buffer = "";

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed || trimmed.startsWith(":")) continue;

          if (trimmed.startsWith("event:")) continue;

          if (trimmed.startsWith("data:")) {
            const dataLine = trimmed.slice(5).trim();
            if (!dataLine) continue;

            let eventData: { id?: number; result?: unknown; error?: { message?: string } };
            try {
              eventData = JSON.parse(dataLine);
            } catch {
              continue;
            }

            if (eventData.error) {
              throw createTaggedMcpError(eventData.error.message || "Unknown MCP error", "tool");
            }

            // Check if this is an endpoint event
            if (
              eventData.result &&
              typeof eventData.result === "object" &&
              "endpoint" in (eventData.result as object)
            ) {
              this.url = (eventData.result as { endpoint?: string }).endpoint || this.url;
              continue;
            }

            return eventData.result;
          }
        }
      }
    } finally {
      reader.releaseLock();
    }

    throw createTaggedMcpError("SSE stream ended without result.", "transport");
  }
}
```

### Step 2: Verify compilation

Run: `cd /home/nicco/projects/pi-mempalace && npx tsc --noEmit src/mcp-transport.ts 2>&1 | head -20`
Expected: No errors.

### Step 3: Commit

```bash
cd /home/nicco/projects/pi-mempalace
git add src/mcp-transport.ts
git commit -m "feat: add HttpTransport for MCP Streamable HTTP transport"
```


---

## Task 4: Refactor MemPalaceMcpClient to delegate to transport

**Files:**
- Modify: `src/mcp-client.ts`

This task replaces the subprocess/spawn logic inside `MemPalaceMcpClient` with delegation to an `McpTransport`. The class becomes a thin facade. All transport-agnostic utilities stay in place.

### Step 1: Replace mcp-client.ts content

Replace the entire content of `src/mcp-client.ts` with:

```typescript
import { Type } from "@sinclair/typebox";
import type { McpToolDefinition, McpErrorKind } from "./mcp-transport";

// Re-export for backward compatibility
export { getMcpErrorKind } from "./mcp-transport";
export type { McpToolDefinition, McpErrorKind } from "./mcp-transport";

// schemaToTypeBox is private (not exported); mcpToolSchemaToTypeBox and
// normalizeMcpToolResult are defined as exported functions below.

// ---------------------------------------------------------------------------
// MemPalaceMcpClient — thin facade delegating to McpTransport
// ---------------------------------------------------------------------------

export class MemPalaceMcpClient {
  private transport?: import("./mcp-transport").McpTransport;

  setTransport(t: import("./mcp-transport").McpTransport): void {
    this.transport = t;
  }

  get isConnected(): boolean {
    return this.transport?.isConnected ?? false;
  }

  getCommandLine(): string {
    return this.transport?.getCommandLine() ?? "";
  }

  getStderr(): string {
    return this.transport?.getStderr() ?? "";
  }

  getTools(): McpToolDefinition[] {
    if (!this.transport) return [];
    // Tools are discovered during connect — we store them here temporarily
    // The transport itself tracks discovered tools internally.
    // We expose them via a protected accessor or by calling listTools.
    return [];
  }

  async connect(signal?: AbortSignal): Promise<{ commandLine: string; tools: McpToolDefinition[] }> {
    if (!this.transport) {
      throw new Error("No transport set. Call setTransport() before connect().");
    }
    await this.transport.connect(signal);
    const tools = await this.transport.listTools(signal);
    return { commandLine: this.transport!.getCommandLine(), tools };
  }

  async callTool(name: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<unknown> {
    if (!this.transport) {
      throw new Error("No transport set. Call setTransport() before callTool().");
    }
    return this.transport.callTool(name, args, signal);
  }

  async close(): Promise<void> {
    await this.transport?.close();
  }
}

// ---------------------------------------------------------------------------
// Transport-agnostic utilities (moved from old mcp-client.ts)
// ---------------------------------------------------------------------------

function schemaToTypeBox(schema: JsonSchema | undefined): unknown {
  if (!schema) return Type.Any();
  if (Array.isArray(schema.enum) && schema.enum.every((value) => typeof value === "string")) {
    return Type.Union(schema.enum.map((value) => Type.Literal(value as string)));
  }

  switch (schema.type) {
    case "string":
      return Type.String({
        description: schema.description,
        maxLength: schema.maxLength,
      });
    case "integer":
      return Type.Integer({
        description: schema.description,
        minimum: schema.minimum,
        maximum: schema.maximum,
      });
    case "number":
      return Type.Number({
        description: schema.description,
        minimum: schema.minimum,
        maximum: schema.maximum,
      });
    case "boolean":
      return Type.Boolean({ description: schema.description });
    case "array":
      return Type.Array(schemaToTypeBox(schema.items) as never, { description: schema.description });
    case "object": {
      const properties = schema.properties ?? {};
      const required = new Set(schema.required ?? []);
      const mapped = Object.fromEntries(
        Object.entries(properties).map(([key, value]) => [
          key,
          required.has(key) ? schemaToTypeBox(value) : Type.Optional(schemaToTypeBox(value) as never),
        ]),
      );
      return Type.Object(mapped, { description: schema.description });
    }
    default:
      return Type.Any({ description: schema.description });
  }
}

type JsonSchema = {
  type?: string;
  description?: string;
  enum?: unknown[];
  properties?: Record<string, JsonSchema>;
  required?: string[];
  items?: JsonSchema;
  minimum?: number;
  maximum?: number;
  maxLength?: number;
};

export function mcpToolSchemaToTypeBox(tool: McpToolDefinition) {
  const schema = tool.inputSchema;
  if (!schema || schema.type !== "object") {
    return Type.Object({});
  }
  return schemaToTypeBox(schema);
}

export function normalizeMcpToolResult(result: unknown) {
  const payload = (result as { content?: Array<{ type?: string; text?: string }> } | undefined) ?? {};
  const text = payload.content?.find((item) => item.type === "text")?.text ?? JSON.stringify(result, null, 2);
  let parsed: unknown = text;
  try {
    parsed = JSON.parse(text);
  } catch {
    // Keep plain text
  }
  return {
    text,
    parsed,
    content: [{ type: "text" as const, text }],
    details: { rawResult: result, parsed },
  };
}
```

### Step 2: Verify compilation

Run: `cd /home/nicco/projects/pi-mempalace && npx tsc --noEmit src/mcp-client.ts 2>&1 | head -20`
Expected: No errors.

### Step 3: Verify existing imports still work

The following files import from `mcp-client.ts`. Verify they still compile after this change:

Run: `cd /home/nicco/projects/pi-mempalace && npx tsc --noEmit src/runtime.ts src/local-backend.ts 2>&1 | head -20`

Expected: No errors. The re-exports (`getMcpErrorKind`, `McpToolDefinition`, `McpErrorKind`) ensure backward compatibility.

### Step 4: Commit

```bash
cd /home/nicco/projects/pi-mempalace
git add src/mcp-client.ts
git commit -m "refactor: make MemPalaceMcpClient a thin transport facade"
```


---

## Task 5: Wire transport selection into MemPalaceRuntime

**Files:**
- Modify: `src/runtime.ts`

This task updates `MemPalaceRuntime` to load config, instantiate the correct transport, and pass it to `MemPalaceMcpClient`.

### Step 1: Update imports at top of runtime.ts

Find the existing import block in `src/runtime.ts`:

```typescript
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { getDefaultPiHookSettings, normalizeHookSettingsPayload } from "./hook-settings-policy.js";
import { getMcpPromptGuidelines } from "./constants";
import { callLocalMemPalaceTool, discoverLocalMemPalaceTools, hasStructuredToolFailure, readRecentHookLog } from "./local-backend";
import { MemPalaceMcpClient, type McpToolDefinition, getMcpErrorKind, mcpToolSchemaToTypeBox, normalizeMcpToolResult } from "./mcp-client";
```

Replace with:

```typescript
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { getDefaultPiHookSettings, normalizeHookSettingsPayload } from "./hook-settings-policy.js";
import { getMcpPromptGuidelines } from "./constants";
import { callLocalMemPalaceTool, discoverLocalMemPalaceTools, hasStructuredToolFailure, readRecentHookLog } from "./local-backend";
import { MemPalaceMcpClient, type McpToolDefinition, getMcpErrorKind, mcpToolSchemaToTypeBox, normalizeMcpToolResult } from "./mcp-client";
import { loadMcpConfig } from "./mcp-config";
import { StdioTransport, HttpTransport, type McpTransport, createTaggedMcpError } from "./mcp-transport";
```

### Step 2: Add private transport field and update constructor

Add a private transport field to the `MemPalaceRuntime` class body, right after `private mcpClient?: MemPalaceMcpClient;`:

```typescript
private transport?: McpTransport;
```

### Step 3: Replace getMcpClient() with createTransport() + update ensureMcpConnected()

Replace the existing `getMcpClient()` method and `ensureMcpConnected()` method in the class:

**Old `getMcpClient()`:**
```typescript
getMcpClient() {
  if (!this.mcpClient) this.mcpClient = new MemPalaceMcpClient();
  return this.mcpClient;
}
```

**Replace with `createTransport()`:**
```typescript
async createTransport(signal?: AbortSignal): Promise<McpTransport> {
  if (this.transport) return this.transport;

  const config = await loadMcpConfig();

  if (config.mcpUrl) {
    // Remote MCP server configured — use HTTP transport
    const transport = new HttpTransport(config.mcpUrl, config.mcpTimeout);
    try {
      await transport.connect(signal);
      this.transport = transport;
      return transport;
    } catch (error) {
      // Remote failed — do NOT fall back to stdio. Return a failed transport.
      throw error instanceof Error ? error : createTaggedMcpError(String(error), "transport");
    }
  }

  // No remote configured — use stdio subprocess (current behavior)
  const transport = new StdioTransport();
  try {
    await transport.connect(signal);
    this.transport = transport;
    return transport;
  } catch (error) {
    throw error instanceof Error ? error : createTaggedMcpError(String(error), "transport");
  }
}
```

**Replace `ensureMcpConnected()`:**
```typescript
async ensureMcpConnected(signal?: AbortSignal) {
  if (this.mcpCircuitOpen) {
    this.mcpStartupError = this.mcpCircuitReason || this.mcpStartupError;
    return { tools: [] };
  }
  try {
    const transport = await this.createTransport(signal);
    const client = new MemPalaceMcpClient();
    client.setTransport(transport);
    this.mcpStartupError = undefined;
    this.registerDiscoveredMcpToolsFromTransport(transport);
    return { client, tools: transport.getTools?.() ?? [] };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    this.mcpStartupError = detail;
    if (getMcpErrorKind(error) === "transport" || getMcpErrorKind(error) === undefined) {
      await this.tripMcpCircuit(detail);
    }
    return { tools: [] };
  }
}
```

### Step 4: Add helper to register tools from transport

Add a new private method `registerDiscoveredMcpToolsFromTransport` alongside the existing `registerDiscoveredMcpTools()`:

```typescript
private registerDiscoveredMcpToolsFromTransport(transport: McpTransport) {
  for (const tool of transport.getTools()) {
    if (this.registeredMcpTools.has(tool.name)) continue;
    if (["mempalace_status", "mempalace_search"].includes(tool.name)) continue;
    this.registeredMcpTools.add(tool.name);
    this.registerDynamicTool(tool);
  }
}
```

(The `getTools()` and `getType()` methods are already on the `McpTransport` interface from Task 2, with implementations in both `StdioTransport` and `HttpTransport`. No need to add them again.)

### Step 5: Update shutdown() to close the transport

Find the existing `shutdown()` method and replace it:

**Old:**
```typescript
async shutdown() {
  await this.mcpClient?.close();
}
```

**New:**
```typescript
async shutdown() {
  await this.transport?.close();
  this.transport = undefined;
}
```

### Step 6: Store transport type on runtime and show in doctor

These methods are already on the `McpTransport` interface from Task 2 (`getType()`).

**In `src/runtime.ts`, add a public field to `MemPalaceRuntime`:**

```typescript
mcpTransportType: "stdio" | "http" | "none" = "none";
```

**Update `createTransport()` to set it:**

When creating `HttpTransport`:
```typescript
this.mcpTransportType = "http";
```

When creating `StdioTransport`:
```typescript
this.mcpTransportType = "stdio";
```

**In `src/commands.ts`, add to the doctor command output:**

After the existing line:
```typescript
lines.push(`mcp command: ${client.getCommandLine()}`);
```

Add:
```typescript
lines.push(`mcp transport: ${runtime.mcpTransportType}`);
```
```

### Step 7: Verify compilation

Run: `cd /home/nicco/projects/pi-mempalace && npx tsc --noEmit src/runtime.ts src/commands.ts 2>&1 | head -30`
Expected: No errors.

### Step 8: Commit

```bash
cd /home/nicco/projects/pi-mempalace
git add src/mcp-transport.ts src/mcp-client.ts src/runtime.ts src/commands.ts
git commit -m "feat: wire transport selection into MemPalaceRuntime"
```


---

## Task 6: Add tests for HttpTransport

**Files:**
- Create: `tests/http-transport.test.mjs`

### Step 1: Create test file

Create `tests/http-transport.test.mjs`:

```javascript
import test from "node:test";
import assert from "node:assert/strict";
import { HttpTransport } from "../src/mcp-transport.ts";

test("HttpTransport rejects connect when server is unreachable", async () => {
  const transport = new HttpTransport("http://localhost:99999/mcp", 1000);
  await assert.rejects(
    transport.connect(),
    /timed out|ECONNREFUSED|connection/i,
  );
});

test("HttpTransport getTools returns empty before connect", () => {
  const transport = new HttpTransport("http://localhost:9999/mcp");
  assert.deepEqual(transport.getTools(), []);
  assert.equal(transport.isConnected, false);
  assert.equal(transport.getCommandLine(), "http://localhost:9999/mcp");
  assert.equal(transport.getStderr(), "");
});

test("HttpTransport getType returns 'http'", () => {
  const transport = new HttpTransport("http://localhost:9999/mcp");
  assert.equal(transport.getType(), "http");
});

test("HttpTransport closes cleanly without connecting", async () => {
  const transport = new HttpTransport("http://localhost:9999/mcp");
  await transport.close();
  assert.equal(transport.isConnected, false);
});
```

### Step 2: Run the tests

Run: `cd /home/nicco/projects/pi-mempalace && node --test tests/http-transport.test.mjs`
Expected: All 4 tests pass (the unreachable server test should fail fast with timeout/connection error).

### Step 3: Commit

```bash
cd /home/nicco/projects/pi-mempalace
git add tests/http-transport.test.mjs
git commit -m "test: add HttpTransport unit tests"
```

---

## Task 7: Final integration — verify everything compiles and existing tests pass

**Files:**
- All modified files

### Step 1: Full compilation check

Run: `cd /home/nicco/projects/pi-mempalace && npx tsc --noEmit 2>&1 | head -30`

If there are type errors, fix them. Common issues:
- Missing imports
- Type mismatches after refactoring
- Missing method implementations on transport classes

### Step 2: Run existing tests

Run: `cd /home/nicco/projects/pi-mempalace && npm test 2>&1`

Expected: All existing tests pass. The existing `local-backend.test.mjs` tests should still work because the stdio transport code is verbatim.

### Step 3: Doctor command smoke test

If Python and mempalace are available locally, run a quick smoke test:

```bash
cd /home/nicco/projects/pi-mempalace
# Ensure no ~/.pi/mempalace.json exists (use stdio path)
node -e "
import('./src/index.ts').then(() => console.log('Extension loaded OK')).catch(e => console.error('Load failed:', e.message));
"
```

### Step 4: Final commit

```bash
cd /home/nicco/projects/pi-mempalace
git add -A
git commit -m "feat: complete remote MCP transport support

- Add mcp-config.ts for loading ~/.pi/mempalace.json
- Add mcp-transport.ts with McpTransport interface, StdioTransport, and HttpTransport
- Refactor MemPalaceMcpClient to delegate to transport
- Wire transport selection into MemPalaceRuntime
- Add tests for HttpTransport
- Update doctor command to show transport type"
```

---

## Summary of all files changed

| Action | File | Responsibility |
|--------|------|----------------|
| Create | `src/mcp-config.ts` | Config loading from `~/.pi/mempalace.json` |
| Create | `src/mcp-transport.ts` | `McpTransport` interface, `StdioTransport`, `HttpTransport` |
| Modify | `src/mcp-client.ts` | Thin facade delegating to transport; keep utilities |
| Modify | `src/runtime.ts` | Transport selection, wiring, shutdown |
| Modify | `src/commands.ts` | Doctor shows transport type |
| Create | `tests/http-transport.test.mjs` | Unit tests for HttpTransport |

## Verification checklist

- [ ] `npx tsc --noEmit` passes with no errors
- [ ] `npm test` passes all existing tests
- [ ] `tests/http-transport.test.mjs` passes
- [ ] Without `~/.pi/mempalace.json`: stdio transport works (backwards compatible)
- [ ] With `~/.pi/mempalace.json` pointing to unreachable URL: graceful error, circuit breaker trips
- [ ] With `~/.pi/mempalace.json` pointing to real MCP server: tools discovered and callable
- [ ] Doctor command shows correct transport type
