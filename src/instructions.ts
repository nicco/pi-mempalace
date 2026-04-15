const INSTRUCTIONS: Record<string, string> = {
	help: `MemPalace workflows

Available slash commands:
- /mempalace:help
- /mempalace:init
- /mempalace:search <query>
- /mempalace:mine [path]
- /mempalace:status
- /mempalace:doctor

Available tools:
- mempalace_instructions({ name })
- mempalace_init({ directory })
- mempalace_search({ query, wing?, room?, limit?, max_distance?, context? })
- mempalace_mine({ path, mode?, extract?, wing?, split? })
- mempalace_status()

Recommended flow:
1. Check status
2. Initialize a palace for your project
3. Mine a project or conversation export
4. Search for previously saved knowledge
5. Use /mempalace:doctor if the backend is unavailable`,

	init: `MemPalace setup

Prerequisites:
- Python 3.9+
- The Python package 'mempalace' installed in the interpreter Pi can access

Typical steps:
1. Install Python 3
2. Install MemPalace: python3 -m pip install mempalace
3. Run mempalace_init with your project directory
4. Verify with mempalace_status or /mempalace:doctor`,

	search: `MemPalace search

Use mempalace_search with:
- query: required semantic query
- wing: optional wing filter
- room: optional room filter
- limit: optional result limit
- max_distance: optional similarity threshold
- context: optional extra context

Typical flow:
1. Start with a natural-language query
2. Narrow with wing/room if results are broad
3. Summarize results with source attribution`,

	mine: `MemPalace mining

Use mempalace_mine with:
- path: required source path
- mode: optional, project or convos
- extract: optional extraction preset
- wing: optional target wing override
- split: optional pre-splitting mode

Typical flow:
1. Choose the source path
2. Optionally split large inputs
3. Mine the source into MemPalace
4. Verify results with search or status`,

	status: `MemPalace status

Use mempalace_status to inspect:
- whether MemPalace is reachable
- health and counts
- whether MCP is available

If status fails:
- run /mempalace:doctor
- verify Python 3 is installed
- verify the Python package 'mempalace' is installed`,
};

export function getBundledInstructions(name: string): string {
	return INSTRUCTIONS[name] ?? INSTRUCTIONS.help;
}
