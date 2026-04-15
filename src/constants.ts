export const SAVE_INTERVAL = 15;
export const AUTO_SAVE_MARKER = "<mempalace-auto-save>";
export const STOP_BLOCK_REASON =
	"AUTO-SAVE checkpoint. Save key topics, decisions, quotes, and code from this session to MemPalace. Organize them into appropriate categories. Use verbatim quotes where possible. Continue the conversation after saving.";
export const PRECOMPACT_BLOCK_REASON =
	"COMPACTION IMMINENT. Save ALL topics, decisions, quotes, code, and important context from this session to MemPalace. Be thorough because detailed context will be lost after compaction. Save everything, then compact again.";

export const CORE_COMMANDS = [
	"mempalace:help",
	"mempalace:init",
	"mempalace:search",
	"mempalace:mine",
	"mempalace:status",
	"mempalace:doctor",
] as const;

export const CORE_TOOLS = [
	"mempalace_instructions",
	"mempalace_init",
	"mempalace_search",
	"mempalace_mine",
	"mempalace_status",
] as const;
