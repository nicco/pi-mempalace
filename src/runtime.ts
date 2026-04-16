import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { getDefaultPiHookSettings, normalizeHookSettingsPayload } from "./hook-settings-policy.js";
import { getMcpPromptGuidelines } from "./constants";
import { MemPalaceMcpClient, mcpToolSchemaToTypeBox, normalizeMcpToolResult } from "./mcp-client";
import type { AutoIngestOutcome } from "./utils";

export type PiHookSettings = {
	silent_save: boolean;
	desktop_toast: boolean;
	source: "default" | "mcp";
	updatedAt: string;
};

export type MemoriesFiledAwayState = {
	status: string;
	message?: string;
	count?: number;
	timestamp?: string | null;
	source: "mcp";
	checkedAt: string;
};

export type ReconnectState = {
	success: boolean;
	message?: string;
	error?: string;
	drawers?: number;
	source: "mcp";
	checkedAt: string;
};

export class MemPalaceRuntime {
	lastAutoSaveCount = 0;
	lastPreCompactWarningKey?: string;
	lastAutoIngest?: AutoIngestOutcome & { timestamp: string };
	hookSettings: PiHookSettings = {
		...getDefaultPiHookSettings(),
		source: "default",
		updatedAt: new Date(0).toISOString(),
	};
	lastMemoriesFiledAway?: MemoriesFiledAwayState;
	lastReconnect?: ReconnectState;
	private mcpClient?: MemPalaceMcpClient;
	mcpStartupError?: string;
	lastMcpToolError?: string;
	hasShownSetupNotice = false;
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
			this.registerDiscoveredMcpTools();
			return { client, tools };
		} catch (error) {
			this.mcpStartupError = error instanceof Error ? error.message : String(error);
			return { tools: [] };
		}
	}

	private applyHookSettings(payload: unknown, source: "default" | "mcp") {
		const normalized = normalizeHookSettingsPayload(payload);
		this.hookSettings = {
			...normalized,
			source,
			updatedAt: new Date().toISOString(),
		};
	}

	async refreshHookSettings(signal?: AbortSignal) {
		const result = await this.maybeCallMcpTool("mempalace_hook_settings", {}, signal);
		const parsed = result?.details?.parsed;
		if (parsed && typeof parsed === "object") {
			this.applyHookSettings(parsed, "mcp");
			return this.hookSettings;
		}
		if (!this.hookSettings || this.hookSettings.source !== "default") {
			this.applyHookSettings(undefined, "default");
		}
		return this.hookSettings;
	}

	async acknowledgeMemoriesFiledAway(signal?: AbortSignal) {
		const result = await this.maybeCallMcpTool("mempalace_memories_filed_away", {}, signal);
		const parsed = result?.details?.parsed;
		if (!parsed || typeof parsed !== "object") return undefined;
		const record = {
			status: typeof (parsed as { status?: unknown }).status === "string" ? (parsed as { status: string }).status : "unknown",
			message: typeof (parsed as { message?: unknown }).message === "string" ? (parsed as { message: string }).message : undefined,
			count: typeof (parsed as { count?: unknown }).count === "number" ? (parsed as { count: number }).count : undefined,
			timestamp: typeof (parsed as { timestamp?: unknown }).timestamp === "string" || (parsed as { timestamp?: unknown }).timestamp === null
				? ((parsed as { timestamp?: string | null }).timestamp ?? null)
				: undefined,
			source: "mcp" as const,
			checkedAt: new Date().toISOString(),
		};
		this.lastMemoriesFiledAway = record;
		return record;
	}

	async reconnectPalace(signal?: AbortSignal) {
		const result = await this.maybeCallMcpTool("mempalace_reconnect", {}, signal);
		const parsed = result?.details?.parsed;
		if (!parsed || typeof parsed !== "object") return undefined;
		const record = {
			success: Boolean((parsed as { success?: unknown }).success),
			message: typeof (parsed as { message?: unknown }).message === "string" ? (parsed as { message: string }).message : undefined,
			error: typeof (parsed as { error?: unknown }).error === "string" ? (parsed as { error: string }).error : undefined,
			drawers: typeof (parsed as { drawers?: unknown }).drawers === "number" ? (parsed as { drawers: number }).drawers : undefined,
			source: "mcp" as const,
			checkedAt: new Date().toISOString(),
		};
		this.lastReconnect = record;
		return record;
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
			if (toolName === "mempalace_hook_settings") {
				this.applyHookSettings(normalized.parsed, "mcp");
			}
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
				promptGuidelines: getMcpPromptGuidelines(tool.name),
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
						if (tool.name === "mempalace_hook_settings") {
							runtime.applyHookSettings(normalized.parsed, "mcp");
						}
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

	recordAutoIngest(outcome: AutoIngestOutcome) {
		if (!outcome.started) return;
		this.lastAutoIngest = {
			...outcome,
			timestamp: new Date().toISOString(),
		};
	}

	persistState() {
		this.pi.appendEntry("mempalace-state", {
			lastAutoSaveCount: this.lastAutoSaveCount,
			lastPreCompactWarningKey: this.lastPreCompactWarningKey,
			lastAutoIngest: this.lastAutoIngest,
			lastMemoriesFiledAway: this.lastMemoriesFiledAway,
			lastReconnect: this.lastReconnect,
			updatedAt: Date.now(),
		});
	}

	loadState(ctx: ExtensionContext) {
		this.lastAutoSaveCount = 0;
		this.lastPreCompactWarningKey = undefined;
		this.lastAutoIngest = undefined;
		this.lastMemoriesFiledAway = undefined;
		this.lastReconnect = undefined;
		this.hookSettings = {
			...getDefaultPiHookSettings(),
			source: "default",
			updatedAt: new Date(0).toISOString(),
		};
		for (const entry of ctx.sessionManager.getBranch()) {
			if (entry.type !== "custom" || entry.customType !== "mempalace-state") continue;
			const data = entry.data as {
				lastAutoSaveCount?: number;
				lastPreCompactWarningKey?: string;
				lastAutoIngest?: (AutoIngestOutcome & { timestamp?: string }) | undefined;
				lastMemoriesFiledAway?: MemoriesFiledAwayState | undefined;
				lastReconnect?: ReconnectState | undefined;
			} | undefined;
			if (typeof data?.lastAutoSaveCount === "number") this.lastAutoSaveCount = data.lastAutoSaveCount;
			if (typeof data?.lastPreCompactWarningKey === "string") this.lastPreCompactWarningKey = data.lastPreCompactWarningKey;
			if (data?.lastAutoIngest?.started && typeof data.lastAutoIngest.timestamp === "string") {
				this.lastAutoIngest = data.lastAutoIngest as AutoIngestOutcome & { timestamp: string };
			}
			if (data?.lastMemoriesFiledAway && typeof data.lastMemoriesFiledAway.checkedAt === "string") {
				this.lastMemoriesFiledAway = data.lastMemoriesFiledAway;
			}
			if (data?.lastReconnect && typeof data.lastReconnect.checkedAt === "string") {
				this.lastReconnect = data.lastReconnect;
			}
		}
	}

	async shutdown() {
		await this.mcpClient?.close();
	}

	getMcpStderr() {
		return this.mcpClient?.getStderr() ?? "";
	}
}
