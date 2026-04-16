export function chooseAutoIngestTarget({ envTarget, sessionTarget, cwdTarget }) {
	if (envTarget) return { targetPath: envTarget, targetSource: "env" };
	if (sessionTarget) return { targetPath: sessionTarget, targetSource: "session" };
	if (cwdTarget) return { targetPath: cwdTarget, targetSource: "cwd" };
	return {};
}

export function canForegroundIngestSatisfyPrecompact(ingest) {
	return Boolean(ingest?.started && ingest?.result?.code === 0 && ingest?.targetSource && ingest.targetSource !== "cwd");
}

export function describeAutoIngestState(ingest) {
	if (!ingest?.started) return "not started";
	if (typeof ingest.result?.code === "number") return `exit ${ingest.result.code}`;
	if (ingest.mode === "background") return "queued (background)";
	return ingest.mode;
}
