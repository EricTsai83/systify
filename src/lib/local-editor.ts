import type { RepositoryId } from "@/lib/types";
import { readJSON, removeKey, writeJSON } from "@/lib/storage";

export type LocalEditorKind = "cursor" | "vscode";

export type LocalEditorRepositoryConfig = {
  editor: LocalEditorKind;
  rootPath: string;
  updatedAt: number;
};

export const LOCAL_EDITOR_REPOSITORY_STORAGE_PREFIX = "systify.localEditor.repo.";

export function readLocalEditorConfig(repositoryId: RepositoryId): LocalEditorRepositoryConfig | null {
  return readJSON(localEditorStorageKey(repositoryId), isLocalEditorRepositoryConfig);
}

export function writeLocalEditorConfig(repositoryId: RepositoryId, config: LocalEditorRepositoryConfig): void {
  writeJSON(localEditorStorageKey(repositoryId), config);
}

export function removeLocalEditorConfig(repositoryId: RepositoryId): void {
  removeKey(localEditorStorageKey(repositoryId));
}

export function buildEditorUrl(args: {
  editor: LocalEditorKind;
  rootPath: string;
  relativePath: string;
  line: number;
  column?: number;
}): string {
  const rootPath = args.rootPath.trim().replace(/\/+$/, "");
  if (!rootPath) {
    throw new Error("Local editor root path is required.");
  }
  const relativePath = args.relativePath.trim().replace(/^\/+/, "");
  if (!relativePath) {
    throw new Error("Code citation path is required.");
  }
  if (relativePath.split("/").some((segment) => segment === "..")) {
    throw new Error("Code citation path cannot contain parent-directory segments.");
  }
  if (!Number.isSafeInteger(args.line) || args.line < 1) {
    throw new Error("Code citation line must be a positive integer.");
  }

  const absolutePath = encodePathPreservingSlashes(`${rootPath}/${relativePath}`);
  if (args.editor === "cursor") {
    return `cursor://file/${absolutePath}:${args.line}`;
  }
  const column = args.column ?? 1;
  if (!Number.isSafeInteger(column) || column < 1) {
    throw new Error("Code citation column must be a positive integer.");
  }
  return `vscode://file/${absolutePath}:${args.line}:${column}`;
}

export function openEditorUrl(url: string): void {
  window.location.assign(url);
}

function localEditorStorageKey(repositoryId: RepositoryId): string {
  return `${LOCAL_EDITOR_REPOSITORY_STORAGE_PREFIX}${repositoryId}`;
}

function isLocalEditorRepositoryConfig(value: unknown): value is LocalEditorRepositoryConfig {
  if (!value || typeof value !== "object") {
    return false;
  }
  const candidate = value as Partial<LocalEditorRepositoryConfig>;
  return (
    (candidate.editor === "cursor" || candidate.editor === "vscode") &&
    typeof candidate.rootPath === "string" &&
    typeof candidate.updatedAt === "number" &&
    Number.isFinite(candidate.updatedAt)
  );
}

function encodePathPreservingSlashes(path: string): string {
  return path.split("/").map(encodeURIComponent).join("/");
}
