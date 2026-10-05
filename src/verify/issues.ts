export type Severity = "error" | "warning";
export type IssueLayer = "parse" | "schema" | "rules" | "quality" | "grounding" | "process";

export interface Issue {
	severity: Severity;
	layer: IssueLayer;
	/** JSON pointer into the unit's data, when the issue concerns a specific value. */
	pointer?: string;
	message: string;
}

export function countIssues(issues: Issue[]): { errors: number; warnings: number } {
	let errors = 0;
	let warnings = 0;
	for (const issue of issues) {
		if (issue.severity === "error") errors++;
		else warnings++;
	}
	return { errors, warnings };
}

export function formatIssue(issue: Issue): string {
	const where = issue.pointer ? ` ${issue.pointer}` : "";
	return `${issue.severity.toUpperCase()} [${issue.layer}]${where}: ${issue.message}`;
}

export function formatIssues(issues: Issue[], max = 40): string {
	if (issues.length === 0) return "No issues.";
	const sorted = [...issues].sort((a, b) => (a.severity === b.severity ? 0 : a.severity === "error" ? -1 : 1));
	const lines = sorted.slice(0, max).map(formatIssue);
	if (sorted.length > max) lines.push(`…and ${sorted.length - max} more`);
	return lines.join("\n");
}
