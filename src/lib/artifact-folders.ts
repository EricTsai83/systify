/**
 * "Recently changed" pulse threshold. The navigator marks any artifact
 * whose `_creationTime` is within this window as freshly produced so the
 * user can see *which* artifact a chat reply just generated without
 * scanning the full list. Five minutes balances "I just created this" with
 * "I came back from lunch and forgot which one was new".
 */
export const RECENT_CHANGE_WINDOW_MS = 5 * 60 * 1000;

export function isRecentlyChanged(timestamp: number, now: number = Date.now()): boolean {
  return now - timestamp < RECENT_CHANGE_WINDOW_MS;
}

/**
 * Folder-tree node assembled from the flat `listByRepository` result. The
 * navigator walks this tree to render the collapsible UI; we keep the type
 * narrow so the consumer doesn't accidentally treat a folder as an
 * artifact (or vice versa) and end up clicking the wrong navigation path.
 * Seeded System Design folders carry `systemKey` for stable lookup after rename.
 */
export type FolderTreeNode = {
  id: string;
  name: string;
  description?: string;
  parentFolderId: string | null;
  systemKey?: string;
  children: FolderTreeNode[];
};

export type FolderTreeInput = {
  _id: string;
  name: string;
  description?: string;
  parentFolderId?: string | null | undefined;
  systemKey?: string;
};

/**
 * Build a tree from the flat `listByRepository` payload. Unknown parent
 * pointers (e.g. a stale subscription frame after a folder delete) are
 * promoted to root so the tree never silently drops folders.
 */
export function buildFolderTree(folders: ReadonlyArray<FolderTreeInput>): FolderTreeNode[] {
  const byId = new Map<string, FolderTreeNode>();
  for (const folder of folders) {
    byId.set(folder._id, {
      id: folder._id,
      name: folder.name,
      description: folder.description,
      parentFolderId: folder.parentFolderId ?? null,
      systemKey: folder.systemKey,
      children: [],
    });
  }

  const roots: FolderTreeNode[] = [];
  for (const node of byId.values()) {
    if (node.parentFolderId && byId.has(node.parentFolderId)) {
      byId.get(node.parentFolderId)!.children.push(node);
    } else {
      roots.push(node);
    }
  }

  // Sort siblings by name for predictable rendering — the server stores
  // `sortOrder` for future drag-reorder, but until that ships, alpha order
  // is the most readable default.
  const sortChildren = (node: FolderTreeNode) => {
    node.children.sort((a, b) => a.name.localeCompare(b.name));
    node.children.forEach(sortChildren);
  };
  roots.sort((a, b) => a.name.localeCompare(b.name));
  roots.forEach(sortChildren);

  return roots;
}
