import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { canForegroundIngestSatisfyPrecompact, chooseAutoIngestTarget, describeAutoIngestState } from "../src/auto-ingest-policy.js";
import { getDefaultPiHookSettings, normalizeHookSettingsPayload, shouldShowHookToast, shouldUseSilentSave } from "../src/hook-settings-policy.js";

function read(path) {
	return readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
}

test("save prompts follow the upstream memory filing protocol", () => {
	const constants = read("src/constants.ts");
	for (const needle of [
		"mempalace_diary_write",
		"mempalace_add_drawer",
		"mempalace_kg_add",
		"mempalace_check_duplicate",
	]) {
		assert.match(constants, new RegExp(needle));
	}
});

test("instructions tool prefers CLI-backed upstream instructions with bundled fallback", () => {
	const tools = read("src/tools.ts");
	assert.match(tools, /runMemPalace\(pi, \["instructions", params\.name\]/);
	assert.match(tools, /source: "cli"/);
	assert.match(tools, /source: "bundled"/);
});

test("auto-ingest target selection prefers env then session then cwd", () => {
	assert.deepEqual(chooseAutoIngestTarget({ envTarget: "/env", sessionTarget: "/session", cwdTarget: "/cwd" }), {
		targetPath: "/env",
		targetSource: "env",
	});
	assert.deepEqual(chooseAutoIngestTarget({ sessionTarget: "/session", cwdTarget: "/cwd" }), {
		targetPath: "/session",
		targetSource: "session",
	});
	assert.deepEqual(chooseAutoIngestTarget({ cwdTarget: "/cwd" }), {
		targetPath: "/cwd",
		targetSource: "cwd",
	});
	assert.deepEqual(chooseAutoIngestTarget({}), {});
});

test("precompact only treats env or session ingest as sufficient preservation", () => {
	assert.equal(canForegroundIngestSatisfyPrecompact({ started: true, targetSource: "env", result: { code: 0 } }), true);
	assert.equal(canForegroundIngestSatisfyPrecompact({ started: true, targetSource: "session", result: { code: 0 } }), true);
	assert.equal(canForegroundIngestSatisfyPrecompact({ started: true, targetSource: "cwd", result: { code: 0 } }), false);
	assert.equal(canForegroundIngestSatisfyPrecompact({ started: true, targetSource: "session", result: { code: 1 } }), false);
	assert.equal(canForegroundIngestSatisfyPrecompact({ started: false, targetSource: "session", result: { code: 0 } }), false);
});

test("doctor labels background auto-ingest as queued instead of implying success", () => {
	assert.equal(describeAutoIngestState({ started: true, mode: "background" }), "queued (background)");
	assert.equal(describeAutoIngestState({ started: true, mode: "foreground", result: { code: 0 } }), "exit 0");
});

test("hook settings map upstream fields onto Pi behavior with sensible defaults", () => {
	assert.deepEqual(getDefaultPiHookSettings(), { silent_save: false, desktop_toast: true });
	assert.deepEqual(normalizeHookSettingsPayload({ settings: { silent_save: true, desktop_toast: false } }), {
		silent_save: true,
		desktop_toast: false,
	});
	assert.equal(shouldUseSilentSave({ silent_save: true }), true);
	assert.equal(shouldUseSilentSave(undefined), false);
	assert.equal(shouldShowHookToast({ desktop_toast: false }), false);
	assert.equal(shouldShowHookToast(undefined), true);
});

test("precompact first attempts synchronous ingest and only blocks on fallback", () => {
	const hooks = read("src/hooks.ts");
	assert.match(hooks, /maybeAutoIngest\(pi, ctx, event\.signal, "foreground"\)/);
	assert.match(hooks, /canForegroundIngestSatisfyPrecompact\(ingest\)/);
	assert.match(hooks, /return \{ cancel: true \}/);
});

test("hook checkpoints honor hook settings semantics and surface toasts", () => {
	const hooks = read("src/hooks.ts");
	assert.match(hooks, /runtime\.refreshHookSettings/);
	assert.match(hooks, /runtime\.acknowledgeMemoriesFiledAway/);
	assert.match(hooks, /runtime\.reconnectPalace/);
	assert.match(hooks, /MemPalace auto-save checkpoint queued silently/);
	assert.match(hooks, /shouldUseSilentSave\(hookSettings\)/);
	assert.match(hooks, /shouldShowHookToast\(hookSettings\)/);
	assert.match(hooks, /MemPalace pre-compact ingest completed/);
	assert.match(hooks, /MemPalace pre-compact save checkpoint triggered/);
});

test("doctor reports parity-sensitive MCP visibility", () => {
	const commands = read("src/commands.ts");
	assert.match(commands, /memory filing tools available:/);
	assert.match(commands, /system support tools available:/);
	assert.match(commands, /upstream documented tools missing from current MCP server:/);
	assert.match(commands, /describeAutoIngestState/);
	assert.match(commands, /hook settings: silent_save=/);
	assert.match(commands, /memories filed away:/);
	assert.match(commands, /last reconnect:/);
});

test("successful MCP connection auto-registers discovered tools and caches hook settings", () => {
	const runtime = read("src/runtime.ts");
	assert.match(runtime, /this\.registerDiscoveredMcpTools\(\)/);
	assert.match(runtime, /registerDiscoveredFallbackTools/);
	assert.match(runtime, /async refreshHookSettings/);
	assert.match(runtime, /"mempalace_hook_settings"/);
	assert.match(runtime, /async acknowledgeMemoriesFiledAway/);
	assert.match(runtime, /async reconnectPalace/);
});

test("CLI write tools trigger reconnect after successful writes", () => {
	const tools = read("src/tools.ts");
	assert.match(tools, /await runtime\.reconnectPalace\(signal\)/);
	assert.match(tools, /MemPalace reconnect: refreshed MCP state after CLI mine/);
});


test("MCP client enforces internal connect and request timeouts", () => {
	const mcpClient = read("src/mcp-client.ts");
	assert.match(mcpClient, /DEFAULT_MCP_CONNECT_TIMEOUT_MS/);
	assert.match(mcpClient, /DEFAULT_MCP_REQUEST_TIMEOUT_MS/);
	assert.match(mcpClient, /timed out after \$\{timeoutMs\}ms during initialize\/tools\/list/);
	assert.match(mcpClient, /MemPalace MCP request timed out after \$\{timeoutMs\}ms: \$\{method\}/);
});


test("local backend discovers tools from MemPalace Python TOOLS and can call handlers without MCP transport", () => {
	const backend = read("src/local-backend.ts");
	assert.match(backend, /from mempalace\.mcp_server import TOOLS/);
	assert.match(backend, /spec.get\("input_schema"\)/);
	assert.match(backend, /tool\["handler"\]\(\*\*params\)/);
	assert.match(backend, /fallback_supported/);
});


test("runtime opens an MCP circuit breaker and routes dynamic tools through fallback", () => {
	const runtime = read("src/runtime.ts");
	assert.match(runtime, /mcpCircuitOpen = false/);
	assert.match(runtime, /tripMcpCircuit/);
	assert.match(runtime, /this\.mcpCircuitOpen \|\| this\.disabledMcpTools\.has\(toolName\)/);
	assert.match(runtime, /return this\.runFallbackTool\(tool\.name/);
	assert.match(runtime, /registerDynamicTool/);
	assert.match(runtime, /recordFallback\(/);
});


test("doctor and session start report fallback backend readiness and circuit state", () => {
	const commands = read("src/commands.ts");
	const hooks = read("src/hooks.ts");
	assert.match(commands, /mcp circuit:/);
	assert.match(commands, /local fallback discovery:/);
	assert.match(commands, /fallback-registered dynamic tools:/);
	assert.match(commands, /last fallback:/);
	assert.match(hooks, /ensureLocalFallbackTools/);
	assert.match(hooks, /MemPalace local fallback ready/);
});


test("status and search tools delegate fallback handling through the shared runtime", () => {
	const tools = read("src/tools.ts");
	assert.match(tools, /runtime\.runFallbackTool\("mempalace_status"/);
	assert.match(tools, /runtime\.runFallbackTool\(\s*"mempalace_search"/);
});

test("repo docs include Claude-plugin parity documentation", () => {
	const readme = read("README.md");
	const parity = read("docs/claude-plugin-parity.md");
	assert.match(readme, /docs\/claude-plugin-parity\.md/);
	assert.match(parity, /Parity matrix/);
	assert.match(parity, /Intentional Pi-specific deviations/);
});
