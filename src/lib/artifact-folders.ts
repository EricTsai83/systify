/**
 * Folder-tree node assembled from the flat `listByRepository` result. The
 * navigator walks this tree to render the collapsible UI; we keep the type
 * narrow so the consumer doesn't accidentally treat a folder as an
 * artifact (or vice versa) and end up clicking the wrong navigation path.
 * Seeded System Design folders carry `systemKey` for stable lookup after rename.
 * `pinnedAt` is the wall-clock at which the user pinned this folder; the
 * navigator floats pinned folders above the alphabetical tail.
 */
export type FolderTreeNode = {
  id: string;
  name: string;
  description?: string;
  parentFolderId: string | null;
  pinnedAt?: number;
  systemKey?: string;
  children: FolderTreeNode[];
};

export type FolderTreeInput = {
  _id: string;
  name: string;
  description?: string;
  parentFolderId?: string | null | undefined;
  pinnedAt?: number;
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
      pinnedAt: folder.pinnedAt,
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

  // Pinned folders float to the top of each sibling group; within the
  // pinned and unpinned partitions, siblings sort alphabetically by name.
  const compare = (a: FolderTreeNode, b: FolderTreeNode) => {
    const aPinned = a.pinnedAt !== undefined;
    const bPinned = b.pinnedAt !== undefined;
    if (aPinned !== bPinned) return aPinned ? -1 : 1;
    return a.name.localeCompare(b.name);
  };
  const sortChildren = (node: FolderTreeNode) => {
    node.children.sort(compare);
    node.children.forEach(sortChildren);
  };
  roots.sort(compare);
  roots.forEach(sortChildren);

  return roots;
}
