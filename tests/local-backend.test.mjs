import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function runScenario(source) {
	return execFileSync(process.execPath, ["--experimental-strip-types", "--input-type=module", "-e", source], {
		cwd: repoRoot,
		encoding: "utf8",
	});
}

test("local backend restores stdout when mempalace.mcp_server redirects stdout on import", () => {
	const output = runScenario(String.raw`
		import assert from "node:assert/strict";
		import fs from "node:fs/promises";
		import os from "node:os";
		import path from "node:path";
		import { spawnSync } from "node:child_process";
		import { discoverLocalMemPalaceTools, callLocalMemPalaceTool } from "./src/local-backend.ts";

		const root = await fs.mkdtemp(path.join(os.tmpdir(), "mp-local-backend-"));
		try {
			await fs.mkdir(path.join(root, "mempalace"));
			await fs.writeFile(path.join(root, "mempalace", "__init__.py"), "", "utf8");
			const mcpServerSource = [
				"import os",
				"import sys",
				"_REAL_STDOUT = sys.stdout",
				"_REAL_STDOUT_FD = os.dup(1)",
				"os.dup2(2, 1)",
				"sys.stdout = sys.stderr",
				"",
				"def _restore_stdout():",
				"    os.dup2(_REAL_STDOUT_FD, 1)",
				"    sys.stdout = _REAL_STDOUT",
				"",
				"def diary_handler(agent_name, entry, topic='general', wing=''):",
				"    return {'success': True, 'agent_name': agent_name, 'entry': entry, 'topic': topic, 'wing': wing}",
				"",
				"TOOLS = {",
				"    'mempalace_diary_write': {",
				"        'description': 'Write diary',",
				"        'input_schema': {'type': 'object', 'properties': {'agent_name': {'type': 'string'}, 'entry': {'type': 'string'}}},",
				"        'handler': diary_handler,",
				"    }",
				"}",
				"",
			].join("\n");
			await fs.writeFile(path.join(root, "mempalace", "mcp_server.py"), mcpServerSource, "utf8");

			const pi = {
				exec(command, args) {
					const run = spawnSync(command, args, {
						encoding: "utf8",
						env: { ...process.env, PYTHONPATH: root },
					});
					return Promise.resolve({
						code: run.status ?? 1,
						stdout: run.stdout || "",
						stderr: run.stderr || "",
					});
				},
			};

			const discovered = await discoverLocalMemPalaceTools(pi);
			assert.equal(discovered.result.code, 0);
			assert.ok(discovered.tools.some((tool) => tool.name === "mempalace_diary_write"));

			const called = await callLocalMemPalaceTool(pi, "mempalace_diary_write", { agent_name: "agent", entry: "AAAK" });
			assert.equal(called.result.code, 0);
			assert.deepEqual(called.parsed, { success: true, agent_name: "agent", entry: "AAAK", topic: "general", wing: "" });
			console.log(JSON.stringify({ tools: discovered.tools.map((tool) => tool.name), called: called.parsed }));
		} finally {
			await fs.rm(root, { recursive: true, force: true });
		}
	`);
	assert.match(output, /mempalace_diary_write/);
	assert.match(output, /"success":true/);
});
