import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

// We need to dynamically import mcp-config so we can control the config file path.
// The module reads ~/.pi/mempalace.json at import time via the constant CONFIG_PATH,
// so we monkey-patch the path for testing.

// Helper: create a temporary config directory and file
function setupConfigDir(configContent) {
  const dir = join(homedir(), ".pi");
  mkdirSync(dir, { recursive: true });
  const configFile = join(dir, "mempalace.json");
  if (configContent === undefined) {
    // Don't create the file — test missing-file behavior
  } else {
    writeFileSync(configFile, JSON.stringify(configContent), "utf8");
  }
  return configFile;
}

function cleanupConfigFile(configFile) {
  try {
    rmSync(configFile, { force: true });
  } catch {
    // Ignore cleanup errors
  }
}

test("loadMcpConfig returns empty config when file does not exist", async () => {
  // Ensure no config file exists
  const configFile = join(homedir(), ".pi", "mempalace.json");
  try {
    rmSync(configFile, { force: true });
  } catch {
    /* already gone */
  }

  // Re-import to get a fresh module instance (clear require cache)
  // Since we're in ESM, we use dynamic import with a unique URL to bypass caching
  const { loadMcpConfig } = await import("../src/mcp-config.ts?" + Date.now());
  const config = await loadMcpConfig();
  assert.deepEqual(config, {});
});

test("loadMcpConfig parses valid mcpUrl and mcpTimeout", async () => {
  const configFile = setupConfigDir({ mcpUrl: "https://mcp.example.com", mcpTimeout: 5000 });
  try {
    const { loadMcpConfig } = await import("../src/mcp-config.ts?" + Date.now());
    const config = await loadMcpConfig();
    assert.equal(config.mcpUrl, "https://mcp.example.com");
    assert.equal(config.mcpTimeout, 5000);
  } finally {
    cleanupConfigFile(configFile);
  }
});

test("loadMcpConfig strips whitespace from mcpUrl", async () => {
  const configFile = setupConfigDir({ mcpUrl: "  https://mcp.example.com  ", mcpTimeout: 3000 });
  try {
    const { loadMcpConfig } = await import("../src/mcp-config.ts?" + Date.now());
    const config = await loadMcpConfig();
    assert.equal(config.mcpUrl, "https://mcp.example.com");
    assert.equal(config.mcpTimeout, 3000);
  } finally {
    cleanupConfigFile(configFile);
  }
});

test("loadMcpConfig ignores whitespace-only mcpUrl", async () => {
  const configFile = setupConfigDir({ mcpUrl: "   ", mcpTimeout: 3000 });
  try {
    const { loadMcpConfig } = await import("../src/mcp-config.ts?" + Date.now());
    const config = await loadMcpConfig();
    assert.equal(config.mcpUrl, undefined);
    assert.equal(config.mcpTimeout, 3000);
  } finally {
    cleanupConfigFile(configFile);
  }
});

test("loadMcpConfig defaults timeout when mcpTimeout is zero", async () => {
  const configFile = setupConfigDir({ mcpUrl: "https://mcp.example.com", mcpTimeout: 0 });
  try {
    const { loadMcpConfig } = await import("../src/mcp-config.ts?" + Date.now());
    const config = await loadMcpConfig();
    assert.equal(config.mcpUrl, "https://mcp.example.com");
    assert.equal(config.mcpTimeout, 8000); // DEFAULT_TIMEOUT_MS
  } finally {
    cleanupConfigFile(configFile);
  }
});

test("loadMcpConfig defaults timeout when mcpTimeout is negative", async () => {
  const configFile = setupConfigDir({ mcpUrl: "https://mcp.example.com", mcpTimeout: -100 });
  try {
    const { loadMcpConfig } = await import("../src/mcp-config.ts?" + Date.now());
    const config = await loadMcpConfig();
    assert.equal(config.mcpUrl, "https://mcp.example.com");
    assert.equal(config.mcpTimeout, 8000);
  } finally {
    cleanupConfigFile(configFile);
  }
});

test("loadMcpConfig defaults timeout when mcpTimeout is a string", async () => {
  const configFile = setupConfigDir({ mcpUrl: "https://mcp.example.com", mcpTimeout: "fast" });
  try {
    const { loadMcpConfig } = await import("../src/mcp-config.ts?" + Date.now());
    const config = await loadMcpConfig();
    assert.equal(config.mcpUrl, "https://mcp.example.com");
    assert.equal(config.mcpTimeout, 8000);
  } finally {
    cleanupConfigFile(configFile);
  }
});

test("loadMcpConfig handles invalid JSON gracefully", async () => {
  const dir = join(homedir(), ".pi");
  mkdirSync(dir, { recursive: true });
  const configFile = join(dir, "mempalace.json");
  writeFileSync(configFile, "{ not valid json !!!", "utf8");
  try {
    const { loadMcpConfig } = await import("../src/mcp-config.ts?" + Date.now());
    const config = await loadMcpConfig();
    assert.deepEqual(config, {});
  } finally {
    rmSync(configFile, { force: true });
  }
});

test("loadMcpConfig handles non-object JSON (array, string, number)", async () => {
  const dir = join(homedir(), ".pi");
  mkdirSync(dir, { recursive: true });
  const configFile = join(dir, "mempalace.json");

  // Test with array
  writeFileSync(configFile, "[1, 2, 3]", "utf8");
  {
    const { loadMcpConfig } = await import("../src/mcp-config.ts?" + Date.now());
    const config = await loadMcpConfig();
    // JSON.parse on an array returns the array, then typeof parsed.mcpUrl is "undefined"
    // which means the config returns {}
    assert.deepEqual(config, { mcpUrl: undefined, mcpTimeout: 8000 });
  }

  // Test with string
  writeFileSync(configFile, '"hello"', "utf8");
  {
    const { loadMcpConfig } = await import("../src/mcp-config.ts?" + Date.now());
    const config = await loadMcpConfig();
    assert.deepEqual(config, { mcpUrl: undefined, mcpTimeout: 8000 });
  }

  // Test with number
  writeFileSync(configFile, "42", "utf8");
  {
    const { loadMcpConfig } = await import("../src/mcp-config.ts?" + Date.now());
    const config = await loadMcpConfig();
    assert.deepEqual(config, { mcpUrl: undefined, mcpTimeout: 8000 });
  }

  rmSync(configFile, { force: true });
});

test("loadMcpConfig only reads mcpUrl and mcpTimeout, ignores extra fields", async () => {
  const configFile = setupConfigDir({
    mcpUrl: "https://mcp.example.com",
    mcpTimeout: 7000,
    extraField: "should be ignored",
    nested: { deep: true },
  });
  try {
    const { loadMcpConfig } = await import("../src/mcp-config.ts?" + Date.now());
    const config = await loadMcpConfig();
    assert.equal(config.mcpUrl, "https://mcp.example.com");
    assert.equal(config.mcpTimeout, 7000);
    assert.equal(config.extraField, undefined);
    assert.equal(config.nested, undefined);
  } finally {
    cleanupConfigFile(configFile);
  }
});
