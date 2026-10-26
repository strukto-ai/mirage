import type { Accessor } from '../accessor/base.ts'
import type { IndexCacheStore } from '../cache/index/store.ts'
import type { FileStat, PathSpec, SearchQuery } from '../types.ts'

/**
 * The stats a VFS function may be handed, each filled from the mount's
 * stored listings: what is at its path (`entry`), at its path's parent
 * (`parent`), and the same two at a rename's or a copy's destination
 * (`dstEntry`, `dstParent`). A function says which it takes in its VFS's
 * `handed`; Python's declares them as keyword parameters and is handed them
 * as keywords.
 */
export interface Handed {
  readonly entry?: FileStat | null
  readonly parent?: FileStat | null
  readonly dstEntry?: FileStat | null
  readonly dstParent?: FileStat | null
  // The store the call runs under, for a function that answers a fresh
  // check itself; Python's names `index`.
  readonly index?: IndexCacheStore
  // The most entries a walk can still keep, handed to `readdir` and
  // `readTree`; Python's names `limit`.
  readonly limit?: number
}

/**
 * What a dispatchable VFS function does to the mount. READ returns content
 * and METADATA an entry's metadata; neither changes the mount. WRITE changes
 * a file's bytes, CREATE makes a name that must not exist yet, REMOVE drops a
 * name, RENAME moves one with everything under it, COPY makes its `dst` hold
 * what its path holds, and ATTR changes an entry's metadata. Every effect but
 * READ and METADATA is a write: a read-only mount refuses the call and
 * admission judges it as one. A COPY reads its path and writes only its
 * `dst`. Mirrors Python's `Effect`.
 */
export const Effect = Object.freeze({
  READ: 'read',
  METADATA: 'metadata',
  WRITE: 'write',
  CREATE: 'create',
  REMOVE: 'remove',
  RENAME: 'rename',
  COPY: 'copy',
  ATTR: 'attr',
} as const)

export type Effect = (typeof Effect)[keyof typeof Effect]

/** What kind of entry a dispatchable function's path names. Mirrors Python's `Target`. */
export const Target = Object.freeze({
  FILE: 'file',
  DIR: 'dir',
  LINK: 'link',
  ANY: 'any',
} as const)

export type Target = (typeof Target)[keyof typeof Target]

/**
 * What `vfsCall` declares for one function, and what a `preVfs` / `postVfs`
 * method sees of the call: its name, its effect, the kind of entry its path
 * names, and whether a WRITE makes a missing file, as open(2) with O_CREAT.
 * Mirrors Python's `VfsCall`.
 */
export interface VfsCall {
  /** The function's name (`read`, `search`, ...). */
  readonly name: string
  readonly effect: Effect
  readonly target: Target
  readonly creates: boolean
  /** The call reaches everything below its paths, as a rename, a tree removal or a tree copy does. */
  readonly subtree: boolean
}

/**
 * One `[path, record]` pair per hit: the hit's virtual path and the text
 * record the `search` CLI prints. null declines; [] means no results.
 */
export type SearchOp<A extends Accessor = Accessor> = (
  accessor: A,
  path: PathSpec,
  query: SearchQuery,
) => Promise<[string, string][] | null>

/** Batch callback that preserves ranking and limits across scopes. */
export type SearchManyOp<A extends Accessor = Accessor> = (
  accessor: A,
  paths: PathSpec[],
  query: SearchQuery,
) => Promise<[string, string][] | null>

/** Optional resource search, what the `search` CLI asks. */
export interface SearchOps<A extends Accessor = Accessor> {
  search: SearchOp<A>
  searchMany: SearchManyOp<A>
}
