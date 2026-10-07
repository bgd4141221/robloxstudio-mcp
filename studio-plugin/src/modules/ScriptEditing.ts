// Shared by preview and apply. All transformations finish before touching Studio source.
export interface ScriptEdit {
	old_string: string;
	new_string: string;
	replace_all?: boolean;
}

export const MAX_SOURCE_BYTES = 1024 * 1024;
const MAX_EDITS = 128;
const MAX_REPLACEMENTS = 10000;

export function transformSource(source: string, input: unknown): { source: string; replacements: number[] } {
	if (source.size() > MAX_SOURCE_BYTES) error("source_too_large: script exceeds 1 MiB");
	if (!typeIs(input, "table")) error("invalid_edits: edits must be an array");
	const edits = input as ScriptEdit[];
	if (edits.size() === 0 || edits.size() > MAX_EDITS) error("invalid_edits: provide 1 to 128 edits");
	let updated = source;
	let total = 0;
	const replacements: number[] = [];
	for (let index = 0; index < edits.size(); index++) {
		const edit = edits[index];
		if (!typeIs(edit, "table") || !typeIs(edit.old_string, "string") || edit.old_string === ""
			|| !typeIs(edit.new_string, "string") || edit.old_string === edit.new_string
			|| (edit.replace_all !== undefined && !typeIs(edit.replace_all, "boolean"))) {
			error(`invalid_edit: edit ${index + 1} needs nonempty old_string and different new_string`);
		}
		const parts: string[] = [];
		let position = 1;
		let count = 0;
		let length = updated.size();
		while (true) {
			const [found] = string.find(updated, edit.old_string, position, true);
			if (found === undefined) break;
			count++;
			if (!edit.replace_all && count > 1) error(`ambiguous_match: edit ${index + 1} matches more than once`);
			if (++total > MAX_REPLACEMENTS) error("too_many_replacements: batch exceeds 10000 matches");
			length += edit.new_string.size() - edit.old_string.size();
			if (length > MAX_SOURCE_BYTES) error("source_too_large: edit result exceeds 1 MiB");
			parts.push(string.sub(updated, position, found - 1), edit.new_string);
			position = found + edit.old_string.size();
		}
		if (count === 0) error(`missing_match: edit ${index + 1} did not match`);
		parts.push(string.sub(updated, position));
		updated = parts.join("");
		replacements.push(count);
	}
	return { source: updated, replacements };
}

// A bounded changed-block diff, not an executable patch. No quadratic LCS on large files.
export function previewDiff(before: string, after: string) {
	const oldLines = before.split("\n");
	const newLines = after.split("\n");
	let start = 0;
	while (start < oldLines.size() && start < newLines.size() && oldLines[start] === newLines[start]) start++;
	let oldEnd = oldLines.size();
	let newEnd = newLines.size();
	while (oldEnd > start && newEnd > start && oldLines[oldEnd - 1] === newLines[newEnd - 1]) { oldEnd--; newEnd--; }
	const lines: string[] = [];
	let bytes = 0;
	let truncated = false;
	for (const [prefix, values, limit] of [["-", oldLines, oldEnd], ["+", newLines, newEnd]] as [string, string[], number][]) {
		for (let i = start; i < limit; i++) {
			const line = prefix + values[i];
			if (lines.size() >= 120 || bytes + line.size() + 1 > 12000) { truncated = true; break; }
			lines.push(line);
			bytes += line.size() + 1;
		}
	}
	return { start_line: start + 1, removed_lines: oldEnd - start, added_lines: newEnd - start,
		diff: lines.join("\n"), truncated };
}
