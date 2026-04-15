import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { AUTO_SAVE_MARKER } from "./constants";

type SessionEntryLike = {
	id?: string;
	type?: string;
	message?: {
		role?: string;
		content?: unknown;
	};
};

export type ExecResult = {
	stdout: string;
	stderr: string;
	code: number;
	killed?: boolean;
};

export function stripAtPrefix(value: string): string {
	return value.startsWith("@") ? value.slice(1) : value;
}

export function quoteArg(value: string): string {
	return JSON.stringify(value);
}

export function extractText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.map((part) => {
			if (!part || typeof part !== "object") return "";
			const maybeText = (part as { type?: string; text?: string }).type === "text" ? (part as { text?: string }).text : "";
			return typeof maybeText === "string" ? maybeText : "";
		})
		.join("\n")
		.trim();
}

export function getRelevantUserMessages(entries: Iterable<SessionEntryLike>) {
	const relevant: Array<{ id?: string; text: string }> = [];
	for (const entry of entries) {
		if (entry.type !== "message") continue;
		const message = entry.message;
		if (message?.role !== "user") continue;
		const text = extractText(message.content);
		if (!text) continue;
		if (text.includes(AUTO_SAVE_MARKER)) continue;
		if (text.trim().startsWith("/")) continue;
		relevant.push({ id: entry.id, text });
	}
	return relevant;
}

export function countRelevantUserMessages(ctx: ExtensionContext): number {
	return getRelevantUserMessages(ctx.sessionManager.getBranch()).length;
}

export function getRelevantUserMessageKey(entries: Iterable<SessionEntryLike>): string | undefined {
	const relevant = getRelevantUserMessages(entries);
	if (relevant.length === 0) return undefined;
	const last = relevant[relevant.length - 1];
	const lastId = last?.id?.trim();
	const lastText = last?.text.trim().replace(/\s+/g, " ").slice(0, 160);
	return `${relevant.length}:${lastId || lastText}`;
}

export function truncate(text: string, max = 12000): string {
	if (text.length <= max) return text;
	return `${text.slice(0, max)}\n\n… output truncated …`;
}

export function formatExecOutput(label: string, command: string[], result: ExecResult): string {
	const sections: string[] = [`${label}: ${command.join(" ")}`, `exit code: ${result.code}`];
	if (result.stdout.trim()) sections.push(`stdout:\n${truncate(result.stdout.trim())}`);
	if (result.stderr.trim()) sections.push(`stderr:\n${truncate(result.stderr.trim())}`);
	return sections.join("\n\n");
}

export async function runMemPalace(
	pi: ExtensionAPI,
	args: string[],
	signal?: AbortSignal,
): Promise<{ command: string[]; result: ExecResult }> {
	const candidates: Array<[string, string[]]> = [
		["python3", ["-m", "mempalace", ...args]],
		["python", ["-m", "mempalace", ...args]],
		["mempalace", args],
	];

	let last: { command: string[]; result: ExecResult } | undefined;
	for (const [command, commandArgs] of candidates) {
		const result = (await pi.exec(command, commandArgs, { signal })) as ExecResult;
		last = { command: [command, ...commandArgs], result };
		if (result.code === 0) return last;

		const combined = `${result.stdout}\n${result.stderr}`.toLowerCase();
		const commandMissing =
			combined.includes("command not found") ||
			combined.includes("not recognized as an internal or external command") ||
			combined.includes("no such file or directory") ||
			combined.includes("no module named mempalace");
		if (!commandMissing) return last;
	}

	if (!last) throw new Error("No MemPalace command candidates were attempted.");
	return last;
}

export function toolResult(label: string, command: string[], result: ExecResult) {
	return {
		content: [{ type: "text" as const, text: formatExecOutput(label, command, result) }],
		details: { command, stdout: result.stdout, stderr: result.stderr, exitCode: result.code },
		isError: result.code !== 0,
	};
}

export async function maybeAutoIngest(pi: ExtensionAPI) {
	const mempalDir = process.env.MEMPAL_DIR?.trim();
	if (!mempalDir) return;
	void runMemPalace(pi, ["mine", mempalDir]).catch(() => undefined);
}

export function sendUserMessage(pi: ExtensionAPI, ctx: ExtensionContext, text: string) {
	if (ctx.isIdle()) {
		pi.sendUserMessage(text);
	} else {
		pi.sendUserMessage(text, { deliverAs: "followUp" });
	}
}
