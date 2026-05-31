/**
 * Cap on artifact-folder name length. Lives here (not in
 * `artifactFolders.ts`) so client-side surfaces — the navigator's inline
 * rename, the folder overview's edit form, and the folder picker's
 * "+ New folder" input — can mirror the cap in `maxLength` without
 * dragging the server-side mutation module (and its `mutation` / `query`
 * value imports) into the client bundle.
 *
 * The matching server-side validation runs in `normalizeFolderName` and
 * imports this constant directly, so the trim/reject threshold stays in
 * one place.
 */
export const FOLDER_NAME_MAX_LENGTH = 80;
