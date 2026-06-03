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
    // Step 1: initialize (first request — no session ID yet)
    const initBody = JSON.stringify({
      jsonrpc: "2.0",
      id: this.nextId++,
      method: "initialize",
      params: {
        protocolVersion: "2025-11-25",
        capabilities: { tools: {} },
        clientInfo: { name: "pi-mempalace", version: "0.2.2" },
      },
    });

    const initResponse = await fetch(this.url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: initBody,
      signal,
    });

    if (!initResponse.ok) {
      const text = await initResponse.text().catch(() => "");
      throw createTaggedMcpError(
        `MCP initialize HTTP ${initResponse.status}: ${text || initResponse.statusText}`,
        "transport",
      );
    }

    // Step 2: capture session ID from response headers
    const sessionId = initResponse.headers.get("Mcp-Session-Id");
    if (!sessionId) {
      throw createTaggedMcpError("MCP initialize did not return a session ID", "transport");
    }
    this.sessionId = sessionId;

    // Parse the initialize result
    const initData = await initResponse.json() as { id?: number; result?: unknown; error?: { message?: string } };
    if (initData.error) {
      throw createTaggedMcpError(
        `MCP initialize failed: ${initData.error.message || "unknown error"}`,
        "transport",
      );
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

function normalizeTimeout(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value || "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}
