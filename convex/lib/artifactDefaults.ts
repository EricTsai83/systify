/**
 * Cap on artifact title length for manual user renames. Lives here (not in
 * `artifacts.ts`) so client-side surfaces — the navigator's inline rename
 * input — can mirror the cap in `maxLength` without dragging the
 * server-side mutation module (and its `mutation` / `query` value imports)
 * into the client bundle.
 *
 * The matching server-side validation runs in the `rename` mutation and
 * imports this constant directly, so the trim/reject threshold stays in
 * one place. 200 matches `MAX_RENAME_TITLE_LENGTH` for threads — manual
 * renames trust the user, autogen does not.
 */
export const MAX_ARTIFACT_TITLE_LENGTH = 200;
