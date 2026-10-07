// Weak keys bind a revision to the actual script, without retaining deleted instances or source copies.
let identities: Map<LuaSourceContainer, string> | undefined;

export function sourceRevision(instance: LuaSourceContainer, source: string): string | undefined {
	const [ok, revision] = pcall(() => {
		if (identities === undefined) identities = setmetatable(new Map<LuaSourceContainer, string>(), { __mode: "k" });
		let identity = identities.get(instance);
		if (identity === undefined) {
			identity = game.GetService("HttpService").GenerateGUID(false);
			identities.set(instance, identity);
		}
		const digest = game.GetService("EncodingService").ComputeStringHash(source, Enum.HashAlgorithm.Blake3);
		// Encode even if the engine returns binary digest bytes rather than printable text.
		const hex: string[] = [];
		for (let i = 1; i <= digest.size(); i++) hex.push(string.format("%02x", string.byte(digest, i)[0]));
		return `${identity}:${hex.join("")}`;
	});
	return ok ? revision as string : undefined;
}

export function checkRevision(instance: LuaSourceContainer, source: string, expected: unknown) {
	if (expected === undefined) return;
	if (!typeIs(expected, "string") || expected === "") error("invalid_revision: expected_revision must be a nonempty string");
	const current = sourceRevision(instance, source);
	if (current === undefined) error("revision_unavailable: this Studio cannot compute source revisions");
	if (current !== expected) error("revision_conflict: script changed or was replaced; read it again before editing");
}
