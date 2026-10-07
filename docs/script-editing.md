# Script editing

Use `get_script_source` to read a script, or `preview_script_edits` to review a
proposed batch. Both return an opaque `revision` covering the entire source,
including text outside a returned line range or truncated read. Revisions also
identify the particular script and plugin session: replacing an instance or
restarting the plugin invalidates old revisions. Older Studio versions unable to
compute revisions can still use the existing tools without revision checking.

## Preview and apply

```json
{
  "instancePath": "game.ServerScriptService.Main",
  "instance_id": "<connected Studio instance>",
  "edits": [
    { "old_string": "local speed = 10", "new_string": "local speed = 15" },
    { "old_string": "oldName", "new_string": "newName", "replace_all": true }
  ]
}
```

Pass this to `preview_script_edits`. To apply it, call `edit_script` with the same
arguments plus `expected_revision` from the preview and a unique `operation_id`.
Preview itself does not reserve or lock the script.

Edits run in order on the result of the preceding edit. They use literal text,
not patterns, and preserve Unicode, line endings and trailing newlines. Each
`old_string` must be nonempty and occur exactly once unless `replace_all` is true.
Identical old and new strings are rejected. Every edit must validate before any
source write; a later missing or ambiguous match leaves the script untouched.
A successful batch uses one source update and one undo recording. A batch whose
net result is unchanged creates no recording.

Preview returns per-edit replacement counts and a combined changed-block diff,
bounded to 120 lines and 12,000 UTF-8 bytes. `truncated` indicates omitted lines;
`removed_lines` and `added_lines` count the full changed block. Unchanged lines
between separate edits may appear in that block. This is a review view, not an
executable patch. Limits are 128 edits, 10,000 total matches, and 1 MiB for source
and intermediate results.

New editing tools resolve unambiguous paths and target the edit peer. Mutations
refuse to run during playtests. The write also compares the editor source with
the original snapshot, so an intervening editor change cannot be overwritten by
the direct-assignment fallback. Engine errors after dispatch can still leave
an uncertain outcome; inspect source and request status before retrying.

## Create a script

Call `create_script` with `parent`, `name`, `className`, `source`, `instance_id`,
and a unique `operation_id`. `className` must be `Script`, `LocalScript` or
`ModuleScript`. The parent must already exist below `game`. Names are literal
and limited to 100 UTF-8 bytes; an existing child with the same name is rejected.

Initial source is assigned and verified before parenting the instance. Runnable
scripts default to disabled; explicitly set `enabled: true` to enable them.
Omit `enabled` for ModuleScript. Creation uses one undo recording and destroys
the newly allocated instance if initialization fails.

## Existing tools and recovery

`set_script_source`, `edit_script_lines`, `insert_script_lines`, and
`delete_script_lines` retain their existing arguments and add optional
`expected_revision` and `operation_id`. Use the revision from the last read to
protect against changes outside the section being edited. On `revision_conflict`,
read the source again and reconsider the edits.

Operation recovery uses the existing bridge. Keep `instance_id` explicit and
query `get_request_status` with the operation ID after a timeout. Identical
arguments on the same peer reuse retained outcomes; changed payloads or targets
are rejected. Recovery lasts up to five minutes within the current server
session, and result payloads can be evicted earlier. An unknown operation does
not mean it never executed. Cancellation does not roll back source changes.
