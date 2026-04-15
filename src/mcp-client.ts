import { Type } from "@sinclair/typebox";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import * as readline from "node:readline";

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

type JsonRpcResponse = {
	jsonrpc?: string;
	id?: number;
	result?: unknown;
	error?: { code?: number; message?: string };
};

export class MemPalaceMcpClient {
	private child?: ChildProcessWithoutNullStreams;
	private nextId = 1;
	private readonly pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
	private readonly discoveredTools = new Map<string, McpToolDefinition>();
	private stderrBuffer = "";
	private commandLine = "";

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

	async connect(signal?: AbortSignal): Promise<{ commandLine: string; tools: McpToolDefinition[] }> {
		if (this.isConnected && this.discoveredTools.size > 0) {
			return { commandLine: this.commandLine, tools: this.getTools() };
		}

		const attempts: Array<[string, string[]]> = [
			["python3", ["-m", "mempalace.mcp_server"]],
			["python", ["-m", "mempalace.mcp_server"]],
		];

		let lastError: Error | undefined;
		for (const [command, args] of attempts) {
			try {
				await this.spawnAndInitialize(command, args, signal);
				return { commandLine: this.commandLine, tools: this.getTools() };
			} catch (error) {
				lastError = error instanceof Error ? error : new Error(String(error));
				await this.close();
			}
		}

		throw lastError ?? new Error("Failed to start MemPalace MCP server.");
	}

	async callTool(name: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<unknown> {
		if (!this.isConnected) {
			await this.connect(signal);
		}
		return this.request("tools/call", { name, arguments: args }, signal);
	}

	async close(): Promise<void> {
		for (const [, pending] of this.pending) {
			pending.reject(new Error("MemPalace MCP client closed."));
		}
		this.pending.clear();

		if (this.child && !this.child.killed) {
			this.child.kill();
		}
		this.child = undefined;
		this.discoveredTools.clear();
		this.commandLine = "";
	}

	private async spawnAndInitialize(command: string, args: string[], signal?: AbortSignal): Promise<void> {
		this.stderrBuffer = "";
		this.commandLine = [command, ...args].join(" ");
		const child = spawn(command, args, { stdio: ["pipe", "pipe", "pipe"] });
		this.child = child;

		const rl = readline.createInterface({ input: child.stdout });
		rl.on("line", (line) => this.handleLine(line));
		child.stderr.on("data", (chunk) => {
			this.stderrBuffer += chunk.toString();
		});
		child.once("exit", (code, sig) => {
			const reason = `MemPalace MCP server exited (${sig ?? code ?? "unknown"}).`;
			for (const [, pending] of this.pending) pending.reject(new Error(reason));
			this.pending.clear();
			this.child = undefined;
		});

		let startupComplete = false;
		const abortStartup = () => {
			if (startupComplete || child.killed) return;
			child.kill();
		};
		signal?.addEventListener("abort", abortStartup, { once: true });

		try {
			await this.request(
				"initialize",
				{
					protocolVersion: "2025-11-25",
					capabilities: { tools: {} },
					clientInfo: { name: "pi-mempalace", version: "0.1.1" },
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
		} finally {
			signal?.removeEventListener("abort", abortStartup);
		}
	}

	private async notify(method: string, params: Record<string, unknown>): Promise<void> {
		if (!this.child) throw new Error("MemPalace MCP server is not running.");
		this.child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`);
	}

	private request(method: string, params: Record<string, unknown>, signal?: AbortSignal): Promise<unknown> {
		if (!this.child) throw new Error("MemPalace MCP server is not running.");
		const id = this.nextId++;

		return new Promise((resolve, reject) => {
			const abort = () => {
				this.pending.delete(id);
				reject(new Error(`MemPalace MCP request aborted: ${method}`));
			};
			if (signal?.aborted) return abort();
			signal?.addEventListener("abort", abort, { once: true });

			this.pending.set(id, {
				resolve: (value) => {
					signal?.removeEventListener("abort", abort);
					resolve(value);
				},
				reject: (error) => {
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
		let message: JsonRpcResponse;
		try {
			message = JSON.parse(trimmed) as JsonRpcResponse;
		} catch {
			return;
		}
		if (typeof message.id !== "number") return;
		const pending = this.pending.get(message.id);
		if (!pending) return;
		this.pending.delete(message.id);
		if (message.error) {
			pending.reject(new Error(message.error.message || "Unknown MCP error"));
			return;
		}
		pending.resolve(message.result);
	}
}

function schemaToType(schema: JsonSchema | undefined): unknown {
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
			return Type.Array(schemaToType(schema.items) as never, { description: schema.description });
		case "object": {
			const properties = schema.properties ?? {};
			const required = new Set(schema.required ?? []);
			const mapped = Object.fromEntries(
				Object.entries(properties).map(([key, value]) => [
					key,
					required.has(key) ? schemaToType(value) : Type.Optional(schemaToType(value) as never),
				]),
			);
			return Type.Object(mapped, { description: schema.description });
		}
		default:
			return Type.Any({ description: schema.description });
	}
}

export function mcpToolSchemaToTypeBox(tool: McpToolDefinition) {
	const schema = tool.inputSchema;
	if (!schema || schema.type !== "object") {
		return Type.Object({});
	}
	return schemaToType(schema);
}

export function normalizeMcpToolResult(result: unknown): {
	text: string;
	parsed: unknown;
	content: Array<{ type: "text"; text: string }>;
	details: Record<string, unknown>;
} {
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
		content: [{ type: "text", text }],
		details: { rawResult: result, parsed },
	};
}
