import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { MemPalaceMcpClient, mcpToolSchemaToTypeBox, normalizeMcpToolResult } from "./mcp-client";

export class MemPalaceRuntime {
	lastAutoSaveCount = 0;
	lastPreCompactWarningKey?: string;
	private mcpClient?: MemPalaceMcpClient;
	mcpStartupError?: string;
	lastMcpToolError?: string;
	readonly registeredMcpTools = new Set<string>();
	readonly disabledMcpTools = new Set<string>();

	constructor(private readonly pi: ExtensionAPI) {}

	getMcpClient() {
		if (!this.mcpClient) this.mcpClient = new MemPalaceMcpClient();
		return this.mcpClient;
	}

	async ensureMcpConnected(signal?: AbortSignal) {
		try {
			const client = this.getMcpClient();
			const { tools } = await client.connect(signal);
			this.mcpStartupError = undefined;
			return { client, tools };
		} catch (error) {
			this.mcpStartupError = error instanceof Error ? error.message : String(error);
			return { tools: [] };
		}
	}

	async maybeCallMcpTool(toolName: string, args: Record<string, unknown>, signal?: AbortSignal) {
		if (this.disabledMcpTools.has(toolName)) return undefined;
		const { client } = await this.ensureMcpConnected(signal);
		if (!client) return undefined;
		const available = client.getTools().some((tool) => tool.name === toolName);
		if (!available) return undefined;
		try {
			const result = await client.callTool(toolName, args, signal);
			this.lastMcpToolError = undefined;
			const normalized = normalizeMcpToolResult(result);
			return {
				content: normalized.content,
				details: { transport: "mcp", toolName, ...normalized.details },
				isError: false,
			};
		} catch (error) {
			this.lastMcpToolError = error instanceof Error ? error.message : String(error);
			this.disabledMcpTools.add(toolName);
			await this.shutdown();
			return undefined;
		}
	}

	registerDiscoveredMcpTools() {
		const runtime = this;
		for (const tool of this.mcpClient?.getTools() ?? []) {
			if (runtime.registeredMcpTools.has(tool.name)) continue;
			if (["mempalace_status", "mempalace_search"].includes(tool.name)) continue;
			runtime.registeredMcpTools.add(tool.name);
			runtime.pi.registerTool({
				name: tool.name,
				label: tool.name,
				description: tool.description || `MemPalace MCP tool: ${tool.name}`,
				promptSnippet: tool.description || `Use the MemPalace MCP tool ${tool.name}`,
				parameters: mcpToolSchemaToTypeBox(tool),
				async execute(_toolCallId, params, signal) {
					if (runtime.disabledMcpTools.has(tool.name)) {
						return {
							content: [{ type: "text" as const, text: `MemPalace MCP tool disabled after previous failure: ${runtime.lastMcpToolError || tool.name}` }],
							details: { transport: "mcp", disabled: true, error: runtime.lastMcpToolError, toolName: tool.name },
							isError: true,
						};
					}

					const { client } = await runtime.ensureMcpConnected(signal);
					if (!client) {
						return {
							content: [{ type: "text" as const, text: `MemPalace MCP unavailable: ${runtime.mcpStartupError || "unknown error"}` }],
							details: { transport: "mcp", unavailable: true, error: runtime.mcpStartupError },
							isError: true,
						};
					}

					try {
						const result = await client.callTool(tool.name, params as Record<string, unknown>, signal);
						runtime.lastMcpToolError = undefined;
						const normalized = normalizeMcpToolResult(result);
						return {
							content: normalized.content,
							details: { transport: "mcp", toolName: tool.name, ...normalized.details },
							isError: false,
						};
					} catch (error) {
						runtime.lastMcpToolError = error instanceof Error ? error.message : String(error);
						runtime.disabledMcpTools.add(tool.name);
						await runtime.shutdown();
						return {
							content: [{ type: "text" as const, text: `MemPalace MCP tool failed: ${runtime.lastMcpToolError}` }],
							details: { transport: "mcp", toolName: tool.name, error: runtime.lastMcpToolError },
							isError: true,
						};
					}
				},
			});
		}
	}

	persistState() {
		this.pi.appendEntry("mempalace-state", {
			lastAutoSaveCount: this.lastAutoSaveCount,
			lastPreCompactWarningKey: this.lastPreCompactWarningKey,
			updatedAt: Date.now(),
		});
	}

	loadState(ctx: ExtensionContext) {
		this.lastAutoSaveCount = 0;
		this.lastPreCompactWarningKey = undefined;
		for (const entry of ctx.sessionManager.getBranch()) {
			if (entry.type !== "custom" || entry.customType !== "mempalace-state") continue;
			const data = entry.data as { lastAutoSaveCount?: number; lastPreCompactWarningKey?: string } | undefined;
			if (typeof data?.lastAutoSaveCount === "number") this.lastAutoSaveCount = data.lastAutoSaveCount;
			if (typeof data?.lastPreCompactWarningKey === "string") this.lastPreCompactWarningKey = data.lastPreCompactWarningKey;
		}
	}

	async shutdown() {
		await this.mcpClient?.close();
	}

	getMcpStderr() {
		return this.mcpClient?.getStderr() ?? "";
	}
}
