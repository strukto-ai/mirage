import type { Accessor } from '../accessor/base.ts'
import type { IndexCacheStore } from '../cache/index/store.ts'
import type { FindOptions } from './base.ts'
import type {
  PathSpec,
  JsonValue,
  CopyFn,
  FindFn,
  MoveFn,
  ReadBytesFn,
  ReadStreamFn,
  ReaddirFn,
  StatFn,
} from '../types.ts'

export type DuEntries = [entries: [string, number][], total: number]

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

export type FindOp<A extends Accessor = Accessor> = FindFn<
  [accessor: A, path: PathSpec, options: FindOptions, index?: IndexCacheStore]
>

export type DuSizeOp<A extends Accessor = Accessor> = (
  accessor: A,
  path: PathSpec,
  index?: IndexCacheStore,
) => Promise<number>

export type DuEntriesOp<A extends Accessor = Accessor> = (
  accessor: A,
  path: PathSpec,
  index?: IndexCacheStore,
) => Promise<DuEntries>

export type ResolveGlobOp<A extends Accessor = Accessor> = (
  accessor: A,
  paths: readonly PathSpec[],
  index?: IndexCacheStore,
) => Promise<PathSpec[]>

// A backend's native du, both halves at once. The generic derives its
// per-directory rows from `entries`, so a backend offering only the
// cheaper `size` would silently print operand totals with no directory
// rows and an inert `-a`. Pairing them makes native du all-or-nothing,
// so that degraded shape cannot be reached by omission (#645).
//
// A native op answers from one pass over the stored files, so a directory
// holding no file never appears in `entries` and gets no row, where the
// shared readdir walk (and GNU) prints its `0` row. The difference is
// accepted for the speed and pinned in integ/unix/du/empty.json.
export interface DuOps<A extends Accessor = Accessor> {
  size: DuSizeOp<A>
  entries: DuEntriesOp<A>
}

export interface ReadOps<A extends Accessor = Accessor> {
  readdir: ReaddirOp<A>
  readBytes: ReadBytesOp<A>
  stat: StatOp<A>
}

export interface NativeReadOps<A extends Accessor = Accessor> {
  readStream?: ReadStreamOp<A>
  readRange?: (
    accessor: A,
    path: PathSpec,
    index: IndexCacheStore | undefined,
    offset: number,
    size: number | null,
  ) => Promise<Uint8Array>
  exists?: ExistsOp<A>
  find?: FindOp<A>
  du?: DuOps<A>
}

export interface WriteOps<A extends Accessor = Accessor> {
  write?: WriteOp<A>
  append?: WriteOp<A>
  pwrite?: PwriteOp<A>
  create?: PathOp<A>
  mkdir?: MkdirOp<A>
  unlink?: PathOp<A>
  rmdir?: RmdirOp<A>
  rmR?: PathOp<A>
  rename?: RenameOp<A>
  copy?: CopyOp<A>
  dirCopy?: CopyOp<A>
  /** noCreate requires an atomic existence precondition, or ENOTSUP before writing. */
  truncate?: (accessor: A, path: PathSpec, length: number, noCreate?: boolean) => Promise<void>
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  setAttrs?: (...args: any[]) => unknown
}

/** A resource query and backend-specific arguments, validated by the backend. */
export interface SearchQuery {
  readonly query: string
  readonly options?: Readonly<Record<string, JsonValue>>
}

/** A canonical file path paired with one complete rendered record. */
export type SearchResult = readonly [PathSpec, string]

/** Path-addressed records. null declines; [] means no results.
 * Integrations such as grep require an explicit declaration in metadata. */
export type SearchOp<A extends Accessor = Accessor> = (
  accessor: A,
  path: PathSpec,
  query: SearchQuery,
  index?: IndexCacheStore,
) => Promise<SearchResult[] | null>

/** Optional batch callback preserves ranking and limits across scopes. */
export type SearchManyOp<A extends Accessor = Accessor> = (
  accessor: A,
  paths: PathSpec[],
  query: SearchQuery,
  index?: IndexCacheStore,
) => Promise<SearchResult[] | null>

/** Optional resource search. Consumers validate their own metadata namespace. */
/**
 * Files under the scopes that may hold the whole-word literal `query`. A
 * superset is harmless, since the scan still runs over the answer; null
 * means the index cannot answer and the scan walks everything.
 */
export type NarrowPathsOp<A extends Accessor = Accessor> = (
  accessor: A,
  query: string,
  paths: PathSpec[],
) => Promise<PathSpec[] | null>

/**
 * A content index that narrows a recursive grep/rg to candidate files. The
 * scan still runs locally over the files it names, so an empty answer falls
 * back to the full walk: a search index lags recent writes. Mirrors Python's
 * `ContentSearchOps`.
 */
export interface ContentSearchOps<A extends Accessor = Accessor> {
  narrowPaths: NarrowPathsOp<A>
  enabled: (accessor: A) => boolean
}

export interface SearchOps<A extends Accessor = Accessor> {
  search: SearchOp<A>
  searchMany?: SearchManyOp<A>
  meta?: Readonly<Record<string, JsonValue>>
}
