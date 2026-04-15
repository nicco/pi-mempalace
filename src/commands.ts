import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { CORE_COMMANDS, CORE_TOOLS } from "./constants";
import type { MemPalaceRuntime } from "./runtime";
import {
	getMemPalaceSetupGuidance,
	getMemPalaceSetupGuidanceFromExec,
	probePythonEnvironment,
	quoteArg,
	refineSetupGuidance,
	runMemPalace,
	sendUserMessage,
	summarizePythonProbe,
	truncate,
} from "./utils";

function queuePrompt(pi: ExtensionAPI, ctx: ExtensionContext, text: string) {
	sendUserMessage(pi, ctx, text);
	ctx.ui.notify("MemPalace request sent", "info");
}

export function registerCommands(pi: ExtensionAPI, runtime: MemPalaceRuntime) {
	pi.registerCommand("mempalace:help", {
		description: "Show MemPalace help and available workflows",
		handler: async (_args, ctx) => {
			queuePrompt(
				pi,
				ctx,
				"Use the mempalace_instructions tool with name \"help\". Then give me a concise overview of the available MemPalace commands, tools, and workflows.",
			);
		},
	});

	pi.registerCommand("mempalace:init", {
		description: "Set up MemPalace for the current project or a target directory",
		handler: async (args, ctx) => {
			const directory = args.trim() || ctx.cwd;
			queuePrompt(
				pi,
				ctx,
				[
					`Set up MemPalace for this directory: ${quoteArg(directory)}.`,
					"Use the mempalace_instructions tool with name \"init\" for the guided flow, and use mempalace_init when you are ready to initialize the directory.",
				].join(" "),
			);
		},
	});

	pi.registerCommand("mempalace:search", {
		description: "Search memories in MemPalace",
		handler: async (args, ctx) => {
			const query = args.trim();
			if (!query) {
				ctx.ui.notify("Usage: /mempalace:search <query>", "warning");
				return;
			}
			queuePrompt(
				pi,
				ctx,
				`Search my MemPalace for ${quoteArg(query)}. Use the mempalace_search tool directly, and summarize the results with source attribution if anything is found.`,
			);
		},
	});

	pi.registerCommand("mempalace:mine", {
		description: "Mine a project directory or conversation export into MemPalace",
		handler: async (args, ctx) => {
			const source = args.trim() || ctx.cwd;
			queuePrompt(
				pi,
				ctx,
				[
					`Mine this source into MemPalace: ${quoteArg(source)}.`,
					"Use the mempalace_mine tool. If the source type is ambiguous, ask me whether it is a project directory or conversation export before proceeding.",
				].join(" "),
			);
		},
	});

	pi.registerCommand("mempalace:status", {
		description: "Show the current MemPalace status",
		handler: async (_args, ctx) => {
			queuePrompt(
				pi,
				ctx,
				"Use the mempalace_status tool and give me a quick MemPalace health summary with counts and one suggested next action.",
			);
		},
	});

	pi.registerCommand("mempalace:doctor", {
		description: "Check whether the MemPalace pi extension, MCP bridge, and CLI are working",
		handler: async (_args, ctx) => {
			const lines: string[] = [];
			const commands = pi.getCommands().map((command) => command.name);
			const missingCommands = [...CORE_COMMANDS].filter((name) => !commands.includes(name));
			lines.push(`extension commands: ${missingCommands.length === 0 ? "ok" : `missing ${missingCommands.join(", ")}`}`);

			const tools = pi.getAllTools().map((tool) => tool.name);
			const missingTools = [...CORE_TOOLS].filter((name) => !tools.includes(name));
			lines.push(`core extension tools: ${missingTools.length === 0 ? "ok" : `missing ${missingTools.join(", ")}`}`);

			const pythonProbe = await probePythonEnvironment(pi).catch(() => undefined);

			const { client, tools: mcpTools } = await runtime.ensureMcpConnected();
			runtime.registerDiscoveredMcpTools();
			lines.push(`mcp bridge: ${client ? "ok" : `unavailable (${runtime.mcpStartupError || "unknown error"})`}`);
			const mcpGuidance = refineSetupGuidance(getMemPalaceSetupGuidance(runtime.mcpStartupError), pythonProbe);
			if (mcpGuidance) {
				lines.push(`mcp setup required: ${mcpGuidance}`);
			}
			if (pythonProbe) {
				lines.push(`python visibility in Pi:\n${summarizePythonProbe(pythonProbe).join("\n")}`);
			}
			if (client) {
				lines.push(`mcp command: ${client.getCommandLine()}`);
				lines.push(`mcp tool count: ${mcpTools.length}`);
				lines.push(`mcp registered dynamically: ${[...runtime.registeredMcpTools].sort().join(", ") || "none"}`);
				lines.push(`mcp disabled tools: ${[...runtime.disabledMcpTools].sort().join(", ") || "none"}`);
			} else if (runtime.getMcpStderr()) {
				lines.push(`mcp stderr:\n${truncate(runtime.getMcpStderr(), 2000)}`);
			}

			if (runtime.lastMcpToolError) {
				lines.push(`last mcp tool error: ${runtime.lastMcpToolError}`);
			}

			lines.push(`cwd: ${ctx.cwd}`);
			lines.push(`MEMPAL_DIR: ${process.env.MEMPAL_DIR?.trim() || "not set"}`);

			const versionRun = await runMemPalace(pi, ["--help"]);
			lines.push(`cli probe: ${versionRun.result.code === 0 ? "ok" : `failed (exit ${versionRun.result.code})`}`);
			lines.push(`cli command: ${versionRun.command.join(" ")}`);
			const cliGuidance = refineSetupGuidance(getMemPalaceSetupGuidanceFromExec(versionRun.command, versionRun.result), pythonProbe);
			if (cliGuidance) {
				lines.push(`cli setup required: ${cliGuidance}`);
			}
			if (versionRun.result.code !== 0 && versionRun.result.stderr.trim()) {
				lines.push(`cli stderr: ${truncate(versionRun.result.stderr.trim(), 1000)}`);
			}

			const statusRun = await runMemPalace(pi, ["status"]);
			lines.push(`cli status probe: ${statusRun.result.code === 0 ? "ok" : `failed (exit ${statusRun.result.code})`}`);
			if (statusRun.result.stdout.trim()) {
				lines.push(`status stdout:\n${truncate(statusRun.result.stdout.trim(), 2000)}`);
			}
			if (statusRun.result.code !== 0 && statusRun.result.stderr.trim()) {
				lines.push(`status stderr:\n${truncate(statusRun.result.stderr.trim(), 2000)}`);
			}

			const unavailableTools = [
				"mempalace_status",
				"mempalace_init",
				"mempalace_search",
				"mempalace_mine",
			].filter(() => !!mcpGuidance || !!cliGuidance);
			lines.push(`bundled tools always available: mempalace_instructions`);
			lines.push(`backend-dependent tools: ${unavailableTools.length > 0 ? `unavailable (${unavailableTools.join(", ")})` : "ok"}`);

			const ok =
				missingCommands.length === 0 &&
				missingTools.length === 0 &&
				versionRun.result.code === 0 &&
				statusRun.result.code === 0 &&
				!!client;
			const report = lines.join("\n\n");

			pi.sendMessage({
				customType: "mempalace-doctor",
				content: report,
				display: true,
				details: { ok },
			});

			if (ctx.hasUI) {
				ctx.ui.notify("MemPalace doctor completed", ok ? "success" : "warning");
			}
			console.log(report);
		},
	});
}
