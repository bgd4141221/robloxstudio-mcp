import Utils from "../Utils";
import Recording from "../Recording";
import { transformSource, previewDiff, MAX_SOURCE_BYTES } from "../ScriptEditing";
import { sourceRevision, checkRevision } from "../ScriptRevision";

function failure(result: unknown) {
	return { error: tostring(result) };
}

function prepare(request: Record<string, unknown>) {
	if (!typeIs(request.instancePath, "string") || request.instancePath === "") error("instancePath is required");
	const instance = Utils.getInstanceByPathStrict(request.instancePath);
	if (!instance || !instance.IsA("LuaSourceContainer")) error("script_not_found: target must be an existing script");
	const source = Utils.readScriptSource(instance);
	checkRevision(instance, source, request.expected_revision);
	const revision = sourceRevision(instance, source);
	if (revision === undefined) error("revision_unavailable: this Studio cannot compute source revisions");
	return { instance, source, revision, transformed: transformSource(source, request.edits) };
}

function previewScriptEdits(request: Record<string, unknown>) {
	const [ok, result] = pcall(() => {
		const prepared = prepare(request);
		return { instancePath: Utils.getInstancePath(prepared.instance), revision: prepared.revision,
			replacements: prepared.transformed.replacements,
			preview: previewDiff(prepared.source, prepared.transformed.source) };
	});
	return ok ? result : failure(result);
}

function editScript(request: Record<string, unknown>) {
	let recording: string | undefined;
	const [ok, result] = pcall(() => {
		if (game.GetService("RunService").IsRunning()) error("edit_mode_required: stop the playtest before editing");
		if (request.expected_revision === undefined) error("expected_revision is required; read or preview the script first");
		const prepared = prepare(request);
		if (prepared.source === prepared.transformed.source) return { success: true, changed: false,
			instancePath: Utils.getInstancePath(prepared.instance), revision: prepared.revision,
			replacements: prepared.transformed.replacements };
		recording = Recording.beginRecording(`Edit script: ${prepared.instance.Name}`);
		if (recording === undefined) error("recording_unavailable: cannot begin an undo recording; no source changed");
		const applied = Utils.applyScriptSource(prepared.instance, prepared.transformed.source, prepared.source);
		if (!applied.success) error(`write_failed: ${applied.error}`);
		return { success: true, changed: true, instancePath: Utils.getInstancePath(prepared.instance),
			revision: sourceRevision(prepared.instance, prepared.transformed.source), replacements: prepared.transformed.replacements };
	});
	Recording.finishRecording(recording, ok);
	return ok ? result : failure(result);
}

function createScript(request: Record<string, unknown>) {
	let recording: string | undefined;
	let created: Script | LocalScript | ModuleScript | undefined;
	const [ok, result] = pcall(() => {
		if (game.GetService("RunService").IsRunning()) error("edit_mode_required: stop the playtest before creating a script");
		if (!typeIs(request.parent, "string") || request.parent === "") error("parent is required");
		if (!typeIs(request.name, "string") || request.name === "" || request.name.size() > 100) error("name must contain 1 to 100 bytes");
		if (!typeIs(request.source, "string") || request.source.size() > MAX_SOURCE_BYTES) error("source must be a string of at most 1 MiB");
		if (request.enabled !== undefined && !typeIs(request.enabled, "boolean")) error("enabled must be a boolean");
		const className = request.className;
		if (className !== "Script" && className !== "LocalScript" && className !== "ModuleScript") error("invalid_class: use Script, LocalScript or ModuleScript");
		if (className === "ModuleScript" && request.enabled !== undefined) error("ModuleScript does not have enabled state");
		const parent = Utils.getInstanceByPathStrict(request.parent);
		if (!parent || parent === game) error("invalid_parent: choose an existing instance below game");
		if (parent.FindFirstChild(request.name)) error("name_collision: a child with this name already exists");
		recording = Recording.beginRecording(`Create ${className}: ${request.name}`);
		if (recording === undefined) error("recording_unavailable: cannot begin an undo recording");
		created = new Instance(className);
		created.Name = request.name;
		if (created.IsA("BaseScript")) created.Enabled = false;
		// Initialize while detached. No runnable script is exposed with empty or partial source.
		(created as unknown as { Source: string }).Source = request.source;
		if (Utils.readScriptSource(created) !== request.source) error("write_failed: initial source could not be verified");
		const revision = sourceRevision(created, request.source);
		if (revision === undefined) error("revision_unavailable: this Studio cannot compute source revisions");
		if (!parent.IsDescendantOf(game) || parent.FindFirstChild(request.name)) error("name_collision: parent changed during creation");
		if (created.IsA("BaseScript")) created.Enabled = request.enabled === true;
		created.Parent = parent;
		return { success: true, instancePath: Utils.getInstancePath(created), className, revision,
			...(className !== "ModuleScript" ? { enabled: request.enabled === true } : {}) };
	});
	if (!ok && created !== undefined) pcall(() => created!.Destroy());
	Recording.finishRecording(recording, ok);
	return ok ? result : failure(result);
}

export = { previewScriptEdits, editScript, createScript };
