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
	assert.match(runtime, /async refreshHookSettings/);
	assert.match(runtime, /toolName === "mempalace_hook_settings"/);
	assert.match(runtime, /async acknowledgeMemoriesFiledAway/);
	assert.match(runtime, /async reconnectPalace/);
});

test("CLI write tools trigger reconnect after successful writes", () => {
	const tools = read("src/tools.ts");
	assert.match(tools, /await runtime\.reconnectPalace\(signal\)/);
	assert.match(tools, /MemPalace reconnect: refreshed MCP state after CLI mine/);
});

test("repo docs include Claude-plugin parity documentation", () => {
	const readme = read("README.md");
	const parity = read("docs/claude-plugin-parity.md");
	assert.match(readme, /docs\/claude-plugin-parity\.md/);
	assert.match(parity, /Parity matrix/);
	assert.match(parity, /Intentional Pi-specific deviations/);
});
