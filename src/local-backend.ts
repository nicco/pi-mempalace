import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { McpToolDefinition } from "./mcp-client";
import type { ExecResult } from "./utils";

export type LocalMemPalaceToolCall = {
	command: string[];
	result: ExecResult;
	parsed: unknown;
	text: string;
};

const DISCOVER_LOCAL_TOOLS_SCRIPT = `
import json
from mempalace.mcp_server import TOOLS
print(json.dumps({
    "tools": [
        {
            "name": name,
            "description": spec.get("description"),
            "inputSchema": spec.get("input_schema") or {"type": "object", "properties": {}},
        }
        for name, spec in TOOLS.items()
    ]
}, ensure_ascii=False, default=str))
`;

const CALL_LOCAL_TOOL_SCRIPT = `
import json
import sys
from mempalace.mcp_server import TOOLS

tool_name = sys.argv[1]
payload_path = sys.argv[2]
with open(payload_path, encoding="utf-8") as fh:
    params = json.load(fh)

tool = TOOLS.get(tool_name)
if not tool:
    print(json.dumps({
        "success": False,
        "fallback_supported": False,
        "error": f"No local MemPalace backend for {tool_name}",
    }, ensure_ascii=False, default=str))
    raise SystemExit(4)

try:
    result = tool["handler"](**params)
except Exception as exc:
    print(json.dumps({
        "success": False,
        "fallback_supported": True,
        "error": str(exc),
        "exception_type": type(exc).__name__,
    }, ensure_ascii=False, default=str))
    raise SystemExit(5)

print(json.dumps(result, ensure_ascii=False, default=str))
`;

export async function discoverLocalMemPalaceTools(pi: ExtensionAPI, signal?: AbortSignal): Promise<{
	command: string[];
	result: ExecResult;
	tools: McpToolDefinition[];
}> {
	const { command, result } = await runPythonMemPalaceScript(pi, DISCOVER_LOCAL_TOOLS_SCRIPT, [], signal);
	const parsed = parseStructuredOutput(result.stdout);
	const tools =
		parsed && typeof parsed === "object" && Array.isArray((parsed as { tools?: unknown[] }).tools)
			? (((parsed as { tools: unknown[] }).tools as unknown[]).filter(isToolDefinition) as McpToolDefinition[])
			: [];
	return { command, result, tools };
}

export async function callLocalMemPalaceTool(
	pi: ExtensionAPI,
	toolName: string,
	params: Record<string, unknown>,
	signal?: AbortSignal,
): Promise<LocalMemPalaceToolCall> {
	const tempDir = await mkdtemp(join(tmpdir(), "mempalace-pi-"));
	const payloadPath = join(tempDir, "payload.json");
	try {
		await writeFile(payloadPath, JSON.stringify(params), "utf8");
		const { command, result } = await runPythonMemPalaceScript(pi, CALL_LOCAL_TOOL_SCRIPT, [toolName, payloadPath], signal);
		const parsed = parseStructuredOutput(result.stdout);
		return {
			command,
			result,
			parsed,
			text: formatStructuredToolText(parsed, result),
		};
	} finally {
		await rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
	}
}

async function runPythonMemPalaceScript(
	pi: ExtensionAPI,
	script: string,
	args: string[],
	signal?: AbortSignal,
): Promise<{ command: string[]; result: ExecResult }> {
	const candidates: Array<[string, string[]]> = [
		["python3", ["-c", script, ...args]],
		["python", ["-c", script, ...args]],
	];

	let last: { command: string[]; result: ExecResult } | undefined;
	let missingModule: { command: string[]; result: ExecResult } | undefined;
	for (const [command, commandArgs] of candidates) {
		const result = (await pi.exec(command, commandArgs, { signal })) as ExecResult;
		last = { command: [command, ...commandArgs], result };
		if (result.code === 0) return last;

		const combined = `${result.stdout}\n${result.stderr}`.toLowerCase();
		const missingCommand =
			combined.includes("command not found") ||
			combined.includes("not recognized as an internal or external command") ||
			combined.includes("no such file or directory");
		const missingMemPalaceModule = combined.includes("no module named mempalace");

		if (missingMemPalaceModule && !missingModule) {
			missingModule = last;
		}
		if (!missingCommand && !missingMemPalaceModule) return last;
	}

	if (missingModule) return missingModule;
	if (!last) throw new Error("No local MemPalace backend commands were attempted.");
	return last;
}

function parseStructuredOutput(stdout: string): unknown {
	const text = stdout.trim();
	if (!text) return undefined;
	try {
		return JSON.parse(text);
	} catch {
		return text;
	}
}

function formatStructuredToolText(parsed: unknown, result: ExecResult): string {
	if (typeof parsed === "string") return parsed;
	if (parsed !== undefined) return JSON.stringify(parsed, null, 2);
	const stderr = result.stderr.trim();
	return stderr || `MemPalace local backend exited with code ${result.code}`;
}

function isToolDefinition(value: unknown): value is McpToolDefinition {
	return Boolean(value) && typeof value === "object" && typeof (value as { name?: unknown }).name === "string";
}

export function hasStructuredToolFailure(parsed: unknown): boolean {
	if (!parsed || typeof parsed !== "object") return false;
	if ((parsed as { fallback_supported?: unknown }).fallback_supported === false) return true;
	if ((parsed as { success?: unknown }).success === false) return true;
	if (typeof (parsed as { error?: unknown }).error === "string" && (parsed as { partial?: unknown }).partial !== true) return true;
	return false;
}

