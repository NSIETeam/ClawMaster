/**
 * Vault tree: folders derived from flat note ids so the panel reads like the host's
 * own explorer instead of a flat list.
 *
 * Ordering is code-unit order — the same determinism the vault itself guarantees — with
 * folders before notes at every level, matching the file tree the sidebar already shows.
 */

/** One note row's payload, as the tree payload delivers it. */
export interface TreeNoteEntry {
  id: string;
  title: string;
  dir: string;
}

/** A folder node derived from note ids; a folder has no file of its own. */
export interface TreeFolder {
  kind: 'folder';
  /** Vault-relative folder path, or `''` for the vault root. */
  id: string;
  name: string;
  children: TreeNode[];
}

/** A note node. */
export interface TreeNote {
  kind: 'note';
  id: string;
  name: string;
  entry: TreeNoteEntry;
}

export type TreeNode = TreeFolder | TreeNote;

/** One flattened, renderable row. */
export interface TreeRow {
  kind: 'folder' | 'note';
  id: string;
  name: string;
  /** Nesting depth; the row's indent is `depth * 22 + 6`. */
  depth: number;
  entry?: TreeNoteEntry;
}

function compareNames(left: TreeNode, right: TreeNode): number {
  if (left.kind !== right.kind) return left.kind === 'folder' ? -1 : 1;
  return left.name < right.name ? -1 : left.name > right.name ? 1 : 0;
}

function sortChildren(folder: TreeFolder): void {
  folder.children.sort(compareNames);
  for (const child of folder.children) if (child.kind === 'folder') sortChildren(child);
}

/**
 * Build the folder tree for a vault.
 * @param entries - Flat note entries, in any order.
 * @returns The root's children: folders first, then notes, each by name.
 */
export function buildTree(entries: readonly TreeNoteEntry[]): TreeNode[] {
  const root: TreeFolder = { kind: 'folder', id: '', name: '', children: [] };
  const folders = new Map<string, TreeFolder>([['', root]]);

  const folderFor = (path: string): TreeFolder => {
    let current = root;
    let prefix = '';
    for (const segment of path.split('/')) {
      prefix = prefix === '' ? segment : `${prefix}/${segment}`;
      let next = folders.get(prefix);
      if (next === undefined) {
        next = { kind: 'folder', id: prefix, name: segment, children: [] };
        folders.set(prefix, next);
        current.children.push(next);
      }
      current = next;
    }
    return current;
  };

  for (const entry of entries) {
    const slash = entry.id.lastIndexOf('/');
    const parent = slash < 0 ? root : folderFor(entry.id.slice(0, slash));
    parent.children.push({ kind: 'note', id: entry.id, name: entry.title, entry });
  }

  sortChildren(root);
  return root.children;
}

/**
 * Flatten a tree into rows, omitting the children of a collapsed folder.
 * @param nodes - Nodes at one level.
 * @param collapsed - Folder ids whose children are hidden.
 * @param depth - Nesting depth of `nodes`.
 * @returns Rows in render order.
 */
export function flattenTree(nodes: readonly TreeNode[], collapsed: ReadonlySet<string>, depth = 0): TreeRow[] {
  const rows: TreeRow[] = [];
  for (const node of nodes) {
    if (node.kind === 'folder') {
      rows.push({ kind: 'folder', id: node.id, name: node.name, depth });
      if (!collapsed.has(node.id)) rows.push(...flattenTree(node.children, collapsed, depth + 1));
      continue;
    }
    rows.push({ kind: 'note', id: node.id, name: node.name, depth, entry: node.entry });
  }
  return rows;
}

/**
 * Every folder on the path to a note, outermost first.
 * @param id - A note id.
 * @returns Folder ids that must be expanded for the note to be visible.
 */
export function ancestorsOf(id: string): string[] {
  const segments = id.split('/');
  segments.pop();
  const ancestors: string[] = [];
  let prefix = '';
  for (const segment of segments) {
    prefix = prefix === '' ? segment : `${prefix}/${segment}`;
    ancestors.push(prefix);
  }
  return ancestors;
}
