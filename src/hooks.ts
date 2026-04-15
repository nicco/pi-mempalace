import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { AUTO_SAVE_MARKER, PRECOMPACT_BLOCK_REASON, SAVE_INTERVAL, STOP_BLOCK_REASON } from "./constants";
import type { MemPalaceRuntime } from "./runtime";
import { countRelevantUserMessages, getRelevantUserMessageKey, maybeAutoIngest, sendUserMessage } from "./utils";

export function registerHooks(pi: ExtensionAPI, runtime: MemPalaceRuntime) {
	pi.on("session_start", async (_event, ctx) => {
		runtime.loadState(ctx);
		const { tools } = await runtime.ensureMcpConnected();
		runtime.registerDiscoveredMcpTools();
		if (ctx.hasUI && tools.length > 0) {
			ctx.ui.notify(`MemPalace MCP connected (${tools.length} tools)`, "success");
		}
	});

	pi.on("session_tree", async (_event, ctx) => {
		runtime.loadState(ctx);
	});

	pi.on("session_shutdown", async () => {
		await runtime.shutdown();
	});

	pi.on("agent_end", async (_event, ctx) => {
		const currentCount = countRelevantUserMessages(ctx);
		if (currentCount <= 0) return;
		if (currentCount - runtime.lastAutoSaveCount < SAVE_INTERVAL) return;

		runtime.lastAutoSaveCount = currentCount;
		runtime.persistState();
		await maybeAutoIngest(pi);
		sendUserMessage(pi, ctx, `${AUTO_SAVE_MARKER}\n${STOP_BLOCK_REASON}`);
	});

	pi.on("session_before_compact", async (event, ctx) => {
		const warningKey = getRelevantUserMessageKey(event.branchEntries);
		if (!warningKey) {
			return;
		}
		if (runtime.lastPreCompactWarningKey === warningKey) {
			return;
		}

		runtime.lastPreCompactWarningKey = warningKey;
		runtime.persistState();
		await maybeAutoIngest(pi);
		sendUserMessage(pi, ctx, `${AUTO_SAVE_MARKER}\n${PRECOMPACT_BLOCK_REASON}`);
		return { cancel: true };
	});
}
