// ========= Copyright 2026 @ Strukto.AI All Rights Reserved. =========
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.
// ========= Copyright 2026 @ Strukto.AI All Rights Reserved. =========

import type { IndexCacheStore } from './cache/index/store.ts'
import type { FindOptions } from './resource/base.ts'
import { rstripSlash, stripSlash } from './utils/slash.ts'

// Any value that survives a JSON round trip: what a decoded payload holds,
// what jq evaluates over, what an API field hands back. The mirror of
// python's mirage.types.JsonValue.
export type JsonValue = null | boolean | number | string | JsonValue[] | { [k: string]: JsonValue }

export const MountMode = Object.freeze({
  READ: 'read',
  WRITE: 'write',
  EXEC: 'exec',
} as const)

export type MountMode = (typeof MountMode)[keyof typeof MountMode]

/**
 * How a mount is exposed to the outside world.
 *
 * `vfs` is the default: the mount lives only inside mirage's own filesystem
 * and is reached through the command surface, with nothing registered with
 * the kernel. `fuse` and `fskit` additionally expose it as a real mountpoint.
 *
 * `fskit` is macOS 15.4+ only and needs no kernel extension. It has no
 * `direct_io` equivalent, so it serves correct reads only for resources that
 * set `sizesAlwaysKnown`; the mount-time guard warns about resources whose
 * size-unknown files will read as empty. Writes are also limited: appends and
 * metadata ops persist, but the macFUSE FSKit shim flushes pages a file did
 * not already have (a new file, or truncate-then-write) as NUL bytes (pinned
 * in `integ/fuse/truth_fskit.json`). There is deliberately no `auto`:
 * auto-selecting fskit would silently degrade every API-backed mount.
 */
export const MountBackend = Object.freeze({
  VFS: 'vfs',
  FUSE: 'fuse',
  FSKIT: 'fskit',
} as const)

export type MountBackend = (typeof MountBackend)[keyof typeof MountBackend]

/** Backends that register a real mountpoint with the kernel. */
export const KERNEL_BACKENDS: readonly MountBackend[] = Object.freeze([
  MountBackend.FUSE,
  MountBackend.FSKIT,
])

const MOUNT_MODE_RANK: Readonly<Record<MountMode, number>> = Object.freeze({
  [MountMode.READ]: 1,
  [MountMode.WRITE]: 2,
  [MountMode.EXEC]: 3,
})

/** The weaker of two mount modes on the READ < WRITE < EXEC lattice. */
export function weakerMode(a: MountMode, b: MountMode): MountMode {
  return MOUNT_MODE_RANK[a] <= MOUNT_MODE_RANK[b] ? a : b
}

/**
 * What the data door treats as nonexistent for one session.
 *
 * A sibling of `Session.mountModes`: per-session narrowing that the
 * doors enforce, null-on-the-session means unrestricted. Hiding is
 * "does not exist", never "forbidden" — matching paths answer ENOENT
 * and drop out of listings, the same no-name-leak rule `mountAllowed`
 * applies to ungranted mounts.
 *
 * `paths` are exact virtual paths; hiding a path hides its whole
 * subtree (a name you cannot see cannot be a parent you traverse), so
 * a mount root entry hides the mount. `patterns` are globs: one with
 * no `/` matches any single name component anywhere; one containing
 * `/` is anchored to the full virtual path, with `*` crossing slashes
 * exactly as GNU `find -path` does.
 */
export interface HiddenPaths {
  readonly paths?: readonly string[]
  readonly patterns?: readonly string[]
}

/**
 * What the session door treats as unset for one session.
 *
 * Enforced where env leaves the session: `get` misses, `snapshot`
 * omits, expansion sees unset. Field names differ from `HiddenPaths`
 * on purpose — the planes' matching semantics differ, so the specs
 * are not interchangeable.
 */
export interface HiddenVars {
  readonly names?: readonly string[]
  readonly patterns?: readonly string[]
}

const MOUNT_MODE_ALIASES: Readonly<Record<string, MountMode>> = Object.freeze({
  r: MountMode.READ,
  rw: MountMode.WRITE,
  rwx: MountMode.EXEC,
})

/**
 * Coerce a mount mode, accepting cumulative filesystem aliases.
 *
 * The mode ladder is cumulative (exec implies write implies read), so
 * only the cumulative spellings `r`, `rw`, `rwx` alias the modes;
 * bit-style forms like `w` or `x` are rejected.
 */
export function parseMountMode(value: string): MountMode {
  const alias = MOUNT_MODE_ALIASES[value]
  if (alias !== undefined) return alias
  if ((Object.values(MountMode) as string[]).includes(value)) return value as MountMode
  throw new Error(`invalid mount mode: '${value}'`)
}

export const ConsistencyPolicy = Object.freeze({
  LAZY: 'lazy',
  ALWAYS: 'always',
} as const)

export type ConsistencyPolicy = (typeof ConsistencyPolicy)[keyof typeof ConsistencyPolicy]

/**
 * Behaviour when a remote resource's live fingerprint differs from the
 * value recorded at snapshot time.
 */
export const DriftPolicy = Object.freeze({
  /** Raise ContentDriftError on first mismatch. */
  STRICT: 'strict',
  /** Skip drift checks entirely. */
  OFF: 'off',
} as const)

export type DriftPolicy = (typeof DriftPolicy)[keyof typeof DriftPolicy]

/**
 * Behaviour when a command's output exceeds its limit cap.
 * TRUNCATE returns the truncated bytes + a notice on stderr.
 * ERROR returns no stdout and exits 1 with the same notice.
 */
export const OnExceed = Object.freeze({
  ERROR: 'error',
  TRUNCATE: 'truncate',
} as const)

export type OnExceed = (typeof OnExceed)[keyof typeof OnExceed]

export interface LimitInit {
  maxBytes?: number | null
  maxLines?: number | null
  timeoutSeconds?: number | null
  onExceed?: OnExceed
}

function minPositive(values: (number | null)[]): number | null {
  const positives = values.filter((v): v is number => v !== null && v > 0)
  return positives.length > 0 ? Math.min(...positives) : null
}

/**
 * A bound on a result: the policy layer's limit arm and the shape
 * every cap config parses into. Carries its fields inline (the Deny
 * precedent: an action is its payload). `kind` is the wire
 * discriminant; `aggr` is the composition law (AND to the tightest
 * per bound, ANY on error mode).
 */
export class Limit {
  readonly kind = 'limit' as const
  readonly maxBytes: number | null
  readonly maxLines: number | null
  readonly timeoutSeconds: number | null
  readonly onExceed: OnExceed

  constructor(init: LimitInit = {}) {
    const maxBytes = init.maxBytes ?? null
    const maxLines = init.maxLines ?? null
    const timeoutSeconds = init.timeoutSeconds ?? null
    if (maxBytes !== null && (!Number.isInteger(maxBytes) || maxBytes < 0)) {
      throw new TypeError(`maxBytes must be a non-negative integer, got ${String(maxBytes)}`)
    }
    if (maxLines !== null && (!Number.isInteger(maxLines) || maxLines < 0)) {
      throw new TypeError(`maxLines must be a non-negative integer, got ${String(maxLines)}`)
    }
    if (timeoutSeconds !== null && (!Number.isFinite(timeoutSeconds) || timeoutSeconds < 0)) {
      throw new TypeError(
        `timeoutSeconds must be a non-negative number, got ${String(timeoutSeconds)}`,
      )
    }
    this.maxBytes = maxBytes
    this.maxLines = maxLines
    this.timeoutSeconds = timeoutSeconds
    this.onExceed = init.onExceed ?? OnExceed.TRUNCATE
  }

  /**
   * Aggregate several limits using each field's declared rule.
   *
   * Reads the rules off LIMIT_AGGR rather than naming the fields here, so a
   * new bound composes as soon as it is declared — the same property Python
   * gets from walking `model_fields` for each field's `Aggr(rule)`. Returns
   * null when nothing is configured. Used wherever bounds stack (policy
   * composition, cross-mount fan-out, layered configs).
   */
  static aggr(limits: Iterable<Limit | null>): Limit | null {
    const present = [...limits].filter((s): s is Limit => s !== null)
    if (present.length === 0) return null
    const init: LimitInit = {}
    for (const key of Object.keys(LIMIT_AGGR) as LimitAggrField[]) {
      Object.assign(init, { [key]: LIMIT_AGGR[key](present) })
    }
    return new Limit(init)
  }
}

/** Every Limit field that composes; `kind` is the wire discriminant, not a bound. */
type LimitAggrField = Exclude<keyof Limit, 'kind'>

/**
 * Each bound's composition law, keyed by field.
 *
 * The mapped type is what makes this a table rather than a second copy of the
 * field list: declaring a new bound on Limit without adding its rule here is a
 * compile error, where the old inline literal would have silently dropped it.
 */
const LIMIT_AGGR: { [K in LimitAggrField]: (present: readonly Limit[]) => Limit[K] } = {
  maxBytes: (present) => minPositive(present.map((s) => s.maxBytes)),
  maxLines: (present) => minPositive(present.map((s) => s.maxLines)),
  timeoutSeconds: (present) => minPositive(present.map((s) => s.timeoutSeconds)),
  onExceed: (present) =>
    present.some((s) => s.onExceed === OnExceed.ERROR) ? OnExceed.ERROR : OnExceed.TRUNCATE,
}

/**
 * Provenance of a result: who produced it, and where.
 *
 * Rides the IO envelope from the dispatch site to the workspace
 * boundary; merge keeps the rightmost producer, so this names the
 * command whose stream the caller actually sees. Post-layer policies
 * (output caps today; budgets and attribution later) read it as
 * context. Facts only: policy decisions never travel on the envelope.
 * `declared` is the bound the command's own registration declared,
 * when the dispatch site knows it (e.g. a CLI leaf).
 */
export interface Producer {
  readonly command: string
  readonly prefixes: readonly string[]
  readonly declared: Limit | null
}

export const ResourceName = Object.freeze({
  DISK: 'disk',
  S3: 's3',
  RAM: 'ram',
  GITHUB: 'github',
  LINEAR: 'linear',
  GCAL: 'gcal',
  GDOCS: 'gdocs',
  GSHEETS: 'gsheets',
  GSLIDES: 'gslides',
  GDRIVE: 'gdrive',
  ONEDRIVE: 'onedrive',
  SHAREPOINT: 'sharepoint',
  DROPBOX: 'dropbox',
  BOX: 'box',
  SLACK: 'slack',
  DISCORD: 'discord',
  GMAIL: 'gmail',
  TRELLO: 'trello',
  MONGODB: 'mongodb',
  GRIDFS: 'gridfs',
  NOTION: 'notion',
  LANGFUSE: 'langfuse',
  JAEGER: 'jaeger',
  SSH: 'ssh',
  REDIS: 'redis',
  GITHUB_CI: 'github_ci',
  GCS: 'gcs',
  OCI: 'oci',
  R2: 'r2',
  EMAIL: 'email',
  OPFS: 'opfs',
  SUPABASE: 'supabase',
  POSTGRES: 'postgres',
  LANCEDB: 'lancedb',
  CHROMA: 'chroma',
  DIFY: 'dify',
  MEM0: 'mem0',
  QDRANT: 'qdrant',
  HF_BUCKETS: 'hf_buckets',
  HF_DATASETS: 'hf_datasets',
  HF_MODELS: 'hf_models',
  HF_SPACES: 'hf_spaces',
  NEXTCLOUD: 'nextcloud',
  DATABRICKS_VOLUME: 'databricks_volume',
  MINIO: 'minio',
  CEPH: 'ceph',
  SEAWEEDFS: 'seaweedfs',
  WASABI: 'wasabi',
  BACKBLAZE: 'backblaze',
  DIGITALOCEAN: 'digitalocean',
  TENCENT: 'tencent',
  ALIYUN: 'aliyun',
  SCALEWAY: 'scaleway',
  QINGSTOR: 'qingstor',
  HISTORY: 'history',
} as const)

export type ResourceName = (typeof ResourceName)[keyof typeof ResourceName]

export const FileType = Object.freeze({
  DIRECTORY: 'directory',
  SYMLINK: 'symlink',
  TEXT: 'text',
  BINARY: 'binary',
  JSON: 'json',
  CSV: 'csv',
  IMAGE_PNG: 'image/png',
  IMAGE_JPEG: 'image/jpeg',
  IMAGE_GIF: 'image/gif',
  ZIP: 'application/zip',
  GZIP: 'application/gzip',
  PDF: 'application/pdf',
} as const)

export type FileType = (typeof FileType)[keyof typeof FileType]

// FileStat.extra key holding a symlink's target, verbatim as it was
// typed. A link has no backend inode, so this is the only place the
// target travels with the stat row.
export const LINK_TARGET_KEY = 'link_target'

export interface FileStatInit {
  name: string
  size?: number | null
  modified?: string | null
  fingerprint?: string | null
  revision?: string | null
  type?: FileType | null
  mode?: number | null
  uid?: number | string | null
  gid?: number | string | null
  atime?: string | null
  extra?: Record<string, unknown>
}

export class FileStat {
  readonly name: string
  readonly size: number | null
  readonly modified: string | null
  readonly fingerprint: string | null
  readonly revision: string | null
  readonly type: FileType | null
  readonly mode: number | null
  readonly uid: number | string | null
  readonly gid: number | string | null
  readonly atime: string | null
  readonly extra: Record<string, unknown>

  constructor(init: FileStatInit) {
    this.name = init.name
    this.size = init.size ?? null
    this.modified = init.modified ?? null
    this.fingerprint = init.fingerprint ?? null
    this.revision = init.revision ?? null
    this.type = init.type ?? null
    this.mode = init.mode ?? null
    this.uid = init.uid ?? null
    this.gid = init.gid ?? null
    this.atime = init.atime ?? null
    this.extra = init.extra ?? {}
    Object.freeze(this)
  }

  // Copy with some fields replaced, the mirror of Python's
  // `model_copy(update=...)`. Callers that rename a row (ls printing an
  // operand as typed, a link row taking the link's name) must use this
  // rather than re-listing fields at the call site: a hand-written list
  // silently drops whatever it forgot, which is how link ownership went
  // missing. This is the one place the field list is repeated, and it
  // sits next to the declarations so an added field is hard to miss.
  with(update: Partial<FileStatInit>): FileStat {
    return new FileStat({
      name: this.name,
      size: this.size,
      modified: this.modified,
      fingerprint: this.fingerprint,
      revision: this.revision,
      type: this.type,
      mode: this.mode,
      uid: this.uid,
      gid: this.gid,
      atime: this.atime,
      extra: this.extra,
      ...update,
    })
  }
}

export const FileChangeKind = Object.freeze({
  CREATE: 'create',
  UPDATE: 'update',
  DELETE: 'delete',
  MOVE: 'move',
  UNKNOWN: 'unknown',
} as const)

export type FileChangeKind = (typeof FileChangeKind)[keyof typeof FileChangeKind]

export interface FileMetadataInit {
  fingerprint?: string | null
  size?: number | null
  modified?: string | null
}

export class FileMetadata {
  readonly fingerprint: string | null
  readonly size: number | null
  readonly modified: string | null

  constructor(init: FileMetadataInit = {}) {
    this.fingerprint = init.fingerprint ?? null
    this.size = init.size ?? null
    this.modified = init.modified ?? null
    Object.freeze(this)
  }
}

export interface FileEventInit {
  kind: FileChangeKind
  path: PathSpec
  timestamp: Date
  previousPath?: PathSpec | null
  metadata?: FileMetadata | null
}

export class FileEvent {
  readonly kind: FileChangeKind
  readonly path: PathSpec
  readonly timestamp: Date
  readonly previousPath: PathSpec | null
  readonly metadata: FileMetadata | null

  constructor(init: FileEventInit) {
    this.kind = init.kind
    this.path = init.path
    this.timestamp = init.timestamp
    this.previousPath = init.previousPath ?? null
    this.metadata = init.metadata ?? null
    Object.freeze(this)
  }
}

export interface DeltaInit {
  changes: readonly FileEvent[]
  checkpoint: string | null
}

export class Delta {
  readonly changes: readonly FileEvent[]
  readonly checkpoint: string | null

  constructor(init: DeltaInit) {
    this.changes = Object.freeze([...init.changes])
    this.checkpoint = init.checkpoint
    Object.freeze(this)
  }
}

export interface WalkEntry {
  virtual: string
  isDir: boolean
  fingerprint: string | null
  size?: number | null
  modified?: string | null
}

export type WalkFn = (root: PathSpec) => AsyncIterable<WalkEntry>

export const OverflowPolicy = Object.freeze({
  COLLAPSE: 'collapse',
  DROP_OLDEST: 'drop_oldest',
  ERROR: 'error',
} as const)

export type OverflowPolicy = (typeof OverflowPolicy)[keyof typeof OverflowPolicy]

// How a mount's capacity relates to a df-style report. QUOTA: real
// total/used/available are known (a real filesystem, or a provider that
// exposes a storage quota). ELASTIC: no fixed size (object stores that grow
// without a quota). NA: no filesystem-capacity concept (message/table
// surfaces). UNKNOWN: bounded but not cheaply measurable / not reported yet.
// df renders real numbers for QUOTA and a literal `-` for the rest — never a
// fabricated total.
export const CapacityState = {
  QUOTA: 'quota',
  ELASTIC: 'elastic',
  NA: 'na',
  UNKNOWN: 'unknown',
} as const
export type CapacityState = (typeof CapacityState)[keyof typeof CapacityState]

// One mount's capacity for df. Byte counts are null/undefined unless the
// state is QUOTA.
export interface CapacityResult {
  state: CapacityState
  total?: number | null
  used?: number | null
  available?: number | null
  inodes?: number | null
  inodesUsed?: number | null
  inodesFree?: number | null
}

export type ReadBytesFn<Args extends unknown[] = [path: PathSpec]> = (
  ...args: Args
) => Promise<Uint8Array>

export type ReadStreamFn<Args extends unknown[] = [path: PathSpec]> = (
  ...args: Args
) => AsyncIterable<Uint8Array>

export type PolymorphicReadResult =
  | Uint8Array
  | AsyncIterable<Uint8Array>
  | Promise<Uint8Array | AsyncIterable<Uint8Array>>

export type PolymorphicReadFn<Args extends unknown[] = [path: PathSpec]> = (
  ...args: Args
) => PolymorphicReadResult

export type CopyFn<Args extends unknown[] = [src: PathSpec, target: PathSpec]> = (
  ...args: Args
) => Promise<void>

export type MoveFn<Args extends unknown[] = [src: PathSpec, target: PathSpec]> = (
  ...args: Args
) => Promise<void>

export type FindFn<Args extends unknown[] = [src: PathSpec, options: FindOptions]> = (
  ...args: Args
) => Promise<string[]>

export type ReaddirFn<Args extends unknown[] = [path: PathSpec]> = (
  ...args: Args
) => Promise<string[]>

export type StatFn<Args extends unknown[] = [path: PathSpec, index?: IndexCacheStore]> = (
  ...args: Args
) => Promise<FileStat>

export interface NativeCopy {
  copy: CopyFn
  find: FindFn
  dirCopy?: CopyFn
  /**
   * Lets the per-entry policy path (--update/--backup, which cannot use a
   * whole-tree dirCopy) still materialize directories that hold no files.
   */
  mkdir?: CopyFn<[path: PathSpec]>
}

export interface PrimitiveCopy {
  readBytes: ReadBytesFn
  write: CopyFn<[target: PathSpec, data: Uint8Array]>
  mkdir: CopyFn<[path: PathSpec]>
  readdir: ReaddirFn
}

export type CopyStrategy = NativeCopy | PrimitiveCopy

export interface NativeMove {
  rename: MoveFn
}

export interface PrimitiveMove {
  readBytes: ReadBytesFn
  write: MoveFn<[target: PathSpec, data: Uint8Array]>
  mkdir: MoveFn<[path: PathSpec]>
  readdir: ReaddirFn
  unlink: MoveFn<[path: PathSpec]>
  rmdir: MoveFn<[path: PathSpec]>
}

export type MoveStrategy = NativeMove | PrimitiveMove

export interface PathSpecInit {
  virtual: string
  directory: string
  resourcePath: string
  pattern?: string | null
  resolved?: boolean
  rawPath?: string
}

export class PathSpec {
  readonly virtual: string
  readonly directory: string
  readonly resourcePath: string
  readonly pattern: string | null
  readonly resolved: boolean
  // The word's spelling: as typed for relative words, the absolute path
  // for everything else (defaults to `virtual`).
  readonly rawPath: string

  constructor(init: PathSpecInit) {
    this.virtual = init.virtual
    this.directory = init.directory
    this.resourcePath = init.resourcePath
    this.pattern = init.pattern ?? null
    this.resolved = init.resolved ?? true
    this.rawPath = init.rawPath ?? init.virtual
    Object.freeze(this)
  }

  // Mount-relative path with a leading slash. Pure formatting of
  // `resourcePath` ('' -> '/', 'sub/x' -> '/sub/x'); used for
  // byte-accounting keys and path arithmetic in slash-framed
  // mount-relative space.
  get mountPath(): string {
    return `/${this.resourcePath}`
  }

  get dir(): PathSpec {
    // The directory's resourcePath is its virtual form with this path's
    // mount prefix removed; the prefix length is recovered from the
    // (virtual, resourcePath) pair. Idempotent for specs that are already
    // directories.
    const cut = rstripSlash(this.virtual).length - this.resourcePath.length
    return new PathSpec({
      virtual: this.directory,
      directory: this.directory,
      resourcePath: stripSlash(this.directory.slice(cut)),
      pattern: this.pattern,
      resolved: false,
    })
  }

  child(name: string): string {
    return `${rstripSlash(this.virtual)}/${name}`
  }

  // Wrap a path string; defaults to a root-mounted resourcePath (the path
  // is assumed to carry no mount prefix).
  static fromStrPath(path: string, resourcePath?: string): PathSpec {
    const idx = path.lastIndexOf('/')
    const directory = path.slice(0, idx + 1) || '/'
    return new PathSpec({
      virtual: path,
      directory,
      resourcePath: resourcePath ?? stripSlash(path),
    })
  }
}

// Shell-text form of an argv word. Text words pass through; paths render
// as spelled (`rawPath`). Use wherever a word re-enters string space (env
// values, function args, the argv text view). Mount I/O keeps using
// `virtual`.
export function wordText(word: string | PathSpec): string {
  return word instanceof PathSpec ? word.rawPath : word
}
