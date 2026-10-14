import type { Accessor } from '../accessor/base.ts'
import type { IndexCacheStore } from '../cache/index/store.ts'
import type { PredNode } from '../core/generic/find_eval.ts'
import type { ByteSource } from '../io/types.ts'
import type {
  FileStat,
  PathSpec,
  JsonValue,
  CopyFn,
  MoveFn,
  ReadBytesFn,
  ReadStreamFn,
  ReaddirFn,
  StatFn,
  SetAttrFields,
} from '../types.ts'

export type SetAttrsOp<A extends Accessor = Accessor> = (
  accessor: A,
  path: PathSpec,
  fields: SetAttrFields,
) => Promise<Record<string, number | string>>

export type DuEntries = [entries: [string, number][], total: number]

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

export type ReaddirOp<A extends Accessor = Accessor> = ReaddirFn<
  [accessor: A, path: PathSpec, index?: IndexCacheStore]
>

export type ReadBytesOp<A extends Accessor = Accessor> = ReadBytesFn<
  [accessor: A, path: PathSpec, index?: IndexCacheStore]
>

export type ReadStreamOp<A extends Accessor = Accessor> = ReadStreamFn<
  [accessor: A, path: PathSpec, index?: IndexCacheStore]
>

export type StatOp<A extends Accessor = Accessor> = StatFn<
  [accessor: A, path: PathSpec, index?: IndexCacheStore]
>

export type WriteOp<A extends Accessor = Accessor> = (
  accessor: A,
  path: PathSpec,
  data: Uint8Array,
) => Promise<void>

/**
 * Write `data` at `offset`, keeping every byte outside it, as pwrite(2)
 * does; a gap past the end reads back as zeros and a missing file is created.
 */
export type PwriteOp<A extends Accessor = Accessor> = (
  accessor: A,
  path: PathSpec,
  data: Uint8Array,
  offset: number,
) => Promise<void>

export type ExistsOp<A extends Accessor = Accessor> = (
  accessor: A,
  path: PathSpec,
) => Promise<boolean>

export type PathOp<A extends Accessor = Accessor> = (accessor: A, path: PathSpec) => Promise<void>

// `PathOp` plus the rmdir slot's optional `index`: the hidden-remnant
// guard turns a refused rmdir into a raw listing of the same directory,
// and an indexed backend cannot list a nested path without it. Backend
// rmdirs keep their two-parameter shape and simply never receive it.
export type RmdirOp<A extends Accessor = Accessor> = (
  accessor: A,
  path: PathSpec,
  index?: IndexCacheStore,
) => Promise<void>

export type MkdirOp<A extends Accessor = Accessor> = (
  accessor: A,
  path: PathSpec,
  parents?: boolean,
) => Promise<void>

export type RenameOp<A extends Accessor = Accessor> = MoveFn<
  [accessor: A, src: PathSpec, dst: PathSpec]
>

export type CopyOp<A extends Accessor = Accessor> = CopyFn<
  [accessor: A, src: PathSpec, dst: PathSpec]
>

export type ResolveGlobOp<A extends Accessor = Accessor> = (
  accessor: A,
  paths: readonly PathSpec[],
  index?: IndexCacheStore,
) => Promise<PathSpec[]>

/** A resource query and backend-specific arguments, validated by the backend. */
export interface SearchQuery {
  readonly query: string
  readonly options?: Readonly<Record<string, JsonValue>>
}

/**
 * One `[path, record]` pair per hit: the hit's virtual path and the text
 * record the `search` command prints. null declines; [] means no results.
 */
export type SearchOp<A extends Accessor = Accessor> = (
  accessor: A,
  path: PathSpec,
  query: SearchQuery,
  index?: IndexCacheStore,
) => Promise<[string, string][] | null>

/** Optional batch callback preserves ranking and limits across scopes. */
export type SearchManyOp<A extends Accessor = Accessor> = (
  accessor: A,
  paths: PathSpec[],
  query: SearchQuery,
  index?: IndexCacheStore,
) => Promise<[string, string][] | null>

/** Files under `path` whose content may contain `text`; null when the search cannot answer for every file. */
export type FilesContainingOp<A extends Accessor = Accessor> = (
  accessor: A,
  path: PathSpec,
  text: string,
  opts: { wholeWord: boolean; ignoreCase: boolean },
  index?: IndexCacheStore,
) => Promise<PathSpec[] | null>

/** The lines of `path` that may contain `text`, in file order, whole or streamed; null when the search cannot answer for this file. */
export type LinesContainingOp<A extends Accessor = Accessor> = (
  accessor: A,
  path: PathSpec,
  text: string,
  opts: { ignoreCase: boolean },
  index?: IndexCacheStore,
) => Promise<ByteSource | null>

/** The first `n` lines of `path`; null when the file is to be read. */
export type FirstLinesOp<A extends Accessor = Accessor> = (
  accessor: A,
  path: PathSpec,
  n: number,
  index?: IndexCacheStore,
) => Promise<Uint8Array | null>

/** The last `n` lines of `path`; null when the file is to be read. */
export type LastLinesOp<A extends Accessor = Accessor> = (
  accessor: A,
  path: PathSpec,
  n: number,
  index?: IndexCacheStore,
) => Promise<Uint8Array | null>

/** How many lines `path` holds; null when the file is to be read. */
export type LineCountOp<A extends Accessor = Accessor> = (
  accessor: A,
  path: PathSpec,
  index?: IndexCacheStore,
) => Promise<number | null>

/** The digest `path`'s backend keeps for `algorithm`; null when the file is to be read and hashed. */
export type ChecksumOp<A extends Accessor = Accessor> = (
  accessor: A,
  path: PathSpec,
  algorithm: string,
  index?: IndexCacheStore,
) => Promise<string | null>

/** Every entry under `path`, keyed by its path below it; null when the directory is to be walked. */
export type ReadTreeOp<A extends Accessor = Accessor> = (
  accessor: A,
  path: PathSpec,
  index?: IndexCacheStore,
) => Promise<Map<string, FileStat> | null>

/** The last `n` lines of `path`, then the lines added to it; null when the file is to be polled. */
export type FollowOp<A extends Accessor = Accessor> = (
  accessor: A,
  path: PathSpec,
  n: number,
  interval: number,
  index?: IndexCacheStore,
) => Promise<AsyncIterable<Uint8Array> | null>

/** Optional resource search, what the `search` command asks. */
export interface SearchOps<A extends Accessor = Accessor> {
  search: SearchOp<A>
  searchMany?: SearchManyOp<A>
}

export interface FindOptions {
  name?: string | null
  type?: string | null
  minSize?: number | null
  maxSize?: number | null
  maxDepth?: number | null
  minDepth?: number | null
  nameExclude?: string | null
  orNames?: string[] | null
  iname?: string | null
  pathPattern?: string | null
  empty?: boolean | null
  tree?: PredNode | null
  mtimeMin?: number | null
  mtimeMax?: number | null
}
