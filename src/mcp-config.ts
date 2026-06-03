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
