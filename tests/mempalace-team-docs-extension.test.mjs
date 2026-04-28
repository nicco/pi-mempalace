import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const extensionPath = path.join(repoRoot, "extensions", "mempalace-team-docs", "index.ts");
const globalExtensionPath = path.join(process.env.HOME ?? "", ".pi", "agent", "extensions", "mempalace-team-docs", "index.ts");

function runExtensionScenario(source) {
	return execFileSync(process.execPath, ["--experimental-strip-types", "--input-type=module", "-e", source], {
		cwd: repoRoot,
		encoding: "utf8",
		env: { ...process.env, MEMDOCS_EXTENSION_PATH: extensionPath },
	});
}

test("tracked MemPalace team docs extension source exists", () => {
	assert.equal(existsSync(extensionPath), true);
	const source = readFileSync(extensionPath, "utf8");
	assert.match(source, /before_agent_start/);
	assert.match(source, /tool_result/);
	assert.match(source, /mempalace_add_drawer/);
	assert.match(source, /memory-docs/);
});

test("global MemPalace team docs extension is installed from the tracked source", { skip: !existsSync(globalExtensionPath) }, () => {
	assert.equal(readFileSync(globalExtensionPath, "utf8"), readFileSync(extensionPath, "utf8"));
});

test("team-shareable decision memory creates a docs\/decisions Markdown file", () => {
	const output = runExtensionScenario(String.raw`
		import assert from "node:assert/strict";
		import fs from "node:fs/promises";
		import os from "node:os";
		import path from "node:path";
		const { __mempalaceTeamDocsTest: helpers } = await import(process.env.MEMDOCS_EXTENSION_PATH);
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "mp-team-docs-decision-"));
		try {
			await fs.mkdir(path.join(root, ".git"));
			const result = await helpers.processMemoryWrite("functions.mempalace_add_drawer", {
				wing: "wing_project",
				room: "Decision: API cache policy",
				added_by: "agent",
				content: "Decision: API cache policy\n\nWe decided to cache GET /catalog responses for 5 minutes. Follow-up: add integration test coverage."
			}, root);
			assert.equal(result.status, "created");
			assert.match(result.relativePath, /^docs\/decisions\/\d{4}-\d{2}-\d{2}-decision-api-cache-policy\.md$/);
			const markdown = await fs.readFile(path.join(root, result.relativePath), "utf8");
			assert.match(markdown, /^# Decision: API cache policy/m);
			assert.match(markdown, /Source: MemPalace/);
			assert.match(markdown, /Wing: wing_project/);
			assert.match(markdown, /Room: Decision: API cache policy/);
			assert.match(markdown, /## Why this matters for the team/);
			assert.match(markdown, /- \[ \] add integration test coverage\./);
			console.log(JSON.stringify(result));
		} finally {
			await fs.rm(root, { recursive: true, force: true });
		}
	`);
	assert.match(output, /"status":"created"/);
});

test("personal diary memory is classified as private and does not create docs", () => {
	runExtensionScenario(String.raw`
		import assert from "node:assert/strict";
		import fs from "node:fs/promises";
		import os from "node:os";
		import path from "node:path";
		const { __mempalaceTeamDocsTest: helpers } = await import(process.env.MEMDOCS_EXTENSION_PATH);
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "mp-team-docs-private-"));
		try {
			await fs.mkdir(path.join(root, ".git"));
			const result = await helpers.processMemoryWrite("mempalace_diary_write", {
				agent_name: "agent",
				topic: "personal",
				entry: "Personal diary: I felt tired and this is private reflection."
			}, root);
			assert.equal(result.status, "skipped");
			assert.match(result.reason, /personal|private|excluded/i);
			await assert.rejects(fs.stat(path.join(root, "docs")), /ENOENT/);
		} finally {
			await fs.rm(root, { recursive: true, force: true });
		}
	`);
});

test("high-risk API key content is skipped without writing a team doc", () => {
	runExtensionScenario(String.raw`
		import assert from "node:assert/strict";
		import fs from "node:fs/promises";
		import os from "node:os";
		import path from "node:path";
		const { __mempalaceTeamDocsTest: helpers } = await import(process.env.MEMDOCS_EXTENSION_PATH);
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "mp-team-docs-secret-"));
		try {
			await fs.mkdir(path.join(root, ".git"));
			const result = await helpers.processMemoryWrite("mempalace_add_drawer", {
				wing: "wing_project",
				room: "Decision: payment deploy",
				added_by: "agent",
				content: "Decision: rotate payment deploy key. The old key was " + "sk" + "_live_1234567890abcdefghijklmnop" + " and must not be shared."
			}, root);
			assert.equal(result.status, "skipped");
			assert.equal(result.isSecret, true);
			assert.match(result.reason, /high-risk secret pattern/i);
			await assert.rejects(fs.stat(path.join(root, "docs")), /ENOENT/);
		} finally {
			await fs.rm(root, { recursive: true, force: true });
		}
	`);
});

test("memory-docs status command reports enabled state, config, repo root, and docs root", () => {
	runExtensionScenario(String.raw`
		import assert from "node:assert/strict";
		import fs from "node:fs/promises";
		import os from "node:os";
		import path from "node:path";
		const extension = (await import(process.env.MEMDOCS_EXTENSION_PATH)).default;
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "mp-team-docs-status-"));
		try {
			await fs.mkdir(path.join(root, ".git"));
			const commands = new Map();
			extension({
				on() {},
				registerCommand(name, command) { commands.set(name, command); }
			});
			const notices = [];
			await commands.get("memory-docs").handler("status", {
				cwd: root,
				hasUI: true,
				ui: { notify(message, level) { notices.push({ message, level }); } }
			});
			assert.equal(notices.length, 1);
			assert.match(notices[0].message, /enabled: true/);
			assert.match(notices[0].message, /config: defaults/);
			assert.ok(notices[0].message.includes("repo root: " + root));
			assert.match(notices[0].message, /docs root: .*docs/);
		} finally {
			await fs.rm(root, { recursive: true, force: true });
		}
	`);
});

test("import-existing command mirrors existing repo memories from MemPalace search", () => {
	runExtensionScenario(String.raw`
		import assert from "node:assert/strict";
		import fs from "node:fs/promises";
		import os from "node:os";
		import path from "node:path";
		const extension = (await import(process.env.MEMDOCS_EXTENSION_PATH)).default;
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "mp-team-docs-import-"));
		try {
			await fs.mkdir(path.join(root, ".git"));
			const commands = new Map();
			const execCalls = [];
			extension({
				on() {},
				registerCommand(name, command) { commands.set(name, command); },
				async exec(command, args) {
					execCalls.push([command, args]);
					if (args[0] === "status") return { code: 0, stdout: "WING: mempalace_pi\n  ROOM: decisions 2 drawers\n", stderr: "" };
					if (args[0] === "search") return { code: 0, stdout: [
						"============================================================",
						"  Results for: \"\"",
						"  Wing: mempalace_pi",
						"============================================================",
						"",
						"  [1] mempalace_pi / decisions",
						"      Source: session:2026-04-16",
						"      Match:  -0.1",
						"",
						"      Decision: use deterministic team docs import.",
						"      Follow-up: document the import command.",
						"",
						"  ────────────────────────────────────────────────────────",
						"  [2] mempalace_pi / personal",
						"      Source: session:2026-04-16",
						"      Match:  -0.2",
						"",
						"      Personal diary: private reflection.",
					].join("\n"), stderr: "" };
					throw new Error("unexpected exec " + command + " " + args.join(" "));
				}
			});
			const notices = [];
			await commands.get("memory-docs").handler("import-existing --wing mempalace_pi --limit 10", {
				cwd: root,
				hasUI: true,
				ui: { notify(message, level) { notices.push({ message, level }); } }
			});
			assert.equal(execCalls.length, 2);
			assert.match(notices[0].message, /MemPalace existing-memory import/);
			assert.match(notices[0].message, /created: 1/);
			assert.match(notices[0].message, /skipped: 1/);
			const files = await fs.readdir(path.join(root, "docs", "decisions"));
			assert.equal(files.length, 1);
			const markdown = await fs.readFile(path.join(root, "docs", "decisions", files[0]), "utf8");
			assert.match(markdown, /Decision: use deterministic team docs import/);
			assert.match(markdown, /- \[ \] document the import command\./);
		} finally {
			await fs.rm(root, { recursive: true, force: true });
		}
	`);
});

test("import-existing dry-run reports targets without writing docs", () => {
	runExtensionScenario(String.raw`
		import assert from "node:assert/strict";
		import fs from "node:fs/promises";
		import os from "node:os";
		import path from "node:path";
		const extension = (await import(process.env.MEMDOCS_EXTENSION_PATH)).default;
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "mp-team-docs-import-dry-"));
		try {
			await fs.mkdir(path.join(root, ".git"));
			const commands = new Map();
			extension({
				on() {},
				registerCommand(name, command) { commands.set(name, command); },
				async exec(_command, args) {
					if (args[0] === "status") return { code: 0, stdout: "WING: mempalace_pi\n  ROOM: architecture 1 drawers\n", stderr: "" };
					return { code: 0, stdout: [
						"  [1] mempalace_pi / architecture",
						"      Source: session",
						"      Match: -0.1",
						"",
						"      Architecture: import-existing uses MemPalace search output as its source.",
					].join("\n"), stderr: "" };
				}
			});
			const notices = [];
			await commands.get("memory-docs").handler("import-existing --dry-run --wing mempalace_pi", {
				cwd: root,
				hasUI: true,
				ui: { notify(message) { notices.push(message); } }
			});
			assert.match(notices[0], /dry run/);
			assert.match(notices[0], /targets:/);
			await assert.rejects(fs.stat(path.join(root, "docs")), /ENOENT/);
		} finally {
			await fs.rm(root, { recursive: true, force: true });
		}
	`);
});

test("tool_result hook appends created, skipped, and secret notes", () => {
	runExtensionScenario(String.raw`
		import assert from "node:assert/strict";
		import fs from "node:fs/promises";
		import os from "node:os";
		import path from "node:path";
		const extension = (await import(process.env.MEMDOCS_EXTENSION_PATH)).default;
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "mp-team-docs-hook-"));
		try {
			await fs.mkdir(path.join(root, ".git"));
			const handlers = new Map();
			extension({ on(name, handler) { handlers.set(name, handler); }, registerCommand() {} });
			const ctx = { cwd: root, hasUI: true, ui: { notify() {} } };
			const created = await handlers.get("tool_result")({
				toolName: "functions.mempalace_add_drawer",
				isError: false,
				input: { wing: "wing_project", room: "Architecture: workers", content: "Architecture: workers process queue jobs asynchronously." },
				content: [{ type: "text", text: "drawer added" }]
			}, ctx);
			assert.match(created.content[0].text, /Team doc created: docs\/architecture\//);

			const skipped = await handlers.get("tool_result")({
				toolName: "mempalace_diary_write",
				isError: false,
				input: { agent_name: "agent", topic: "personal", entry: "Personal diary: private reflection." },
				content: [{ type: "text", text: "diary added" }]
			}, ctx);
			assert.match(skipped.content[0].text, /Team doc skipped: .*personal/i);

			const secret = await handlers.get("tool_result")({
				toolName: "mempalace_add_drawer",
				isError: false,
				input: { wing: "wing_project", room: "Decision: deploy key", content: "Decision: deploy key contains " + "sk" + "_live_1234567890abcdefghijklmnop" },
				content: [{ type: "text", text: "drawer added" }]
			}, ctx);
			assert.match(secret.content[0].text, /Team doc skipped: high-risk secret pattern detected/i);
		} finally {
			await fs.rm(root, { recursive: true, force: true });
		}
	`);
});
