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

import { rstripSlash, stripSlash } from './utils/slash.ts'

export const MountMode = Object.freeze({
  READ: 'read',
  WRITE: 'write',
  EXEC: 'exec',
} as const)

export type MountMode = (typeof MountMode)[keyof typeof MountMode]

const MOUNT_MODE_RANK: Readonly<Record<MountMode, number>> = Object.freeze({
  [MountMode.READ]: 1,
  [MountMode.WRITE]: 2,
  [MountMode.EXEC]: 3,
})

/** The weaker of two mount modes on the READ < WRITE < EXEC lattice. */
export function weakerMode(a: MountMode, b: MountMode): MountMode {
  return MOUNT_MODE_RANK[a] <= MOUNT_MODE_RANK[b] ? a : b
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
 * Behaviour when a command's output exceeds its safeguard cap.
 * TRUNCATE returns the truncated bytes + a notice on stderr.
 * ERROR returns no stdout and exits 1 with the same notice.
 */
export const OnExceed = Object.freeze({
  ERROR: 'error',
  TRUNCATE: 'truncate',
} as const)

export type OnExceed = (typeof OnExceed)[keyof typeof OnExceed]

export interface CommandSafeguardInit {
  maxBytes?: number | null
  maxLines?: number | null
  timeoutSeconds?: number | null
  onExceed?: OnExceed
}

function minPositive(values: (number | null)[]): number | null {
  const positives = values.filter((v): v is number => v !== null && v > 0)
  return positives.length > 0 ? Math.min(...positives) : null
}

export class CommandSafeguard {
  readonly maxBytes: number | null
  readonly maxLines: number | null
  readonly timeoutSeconds: number | null
  readonly onExceed: OnExceed

  constructor(init: CommandSafeguardInit = {}) {
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

  static aggr(safeguards: Iterable<CommandSafeguard | null>): CommandSafeguard | null {
    const present = [...safeguards].filter((s): s is CommandSafeguard => s !== null)
    if (present.length === 0) return null
    return new CommandSafeguard({
      maxBytes: minPositive(present.map((s) => s.maxBytes)),
      maxLines: minPositive(present.map((s) => s.maxLines)),
      timeoutSeconds: minPositive(present.map((s) => s.timeoutSeconds)),
      onExceed: present.some((s) => s.onExceed === OnExceed.ERROR)
        ? OnExceed.ERROR
        : OnExceed.TRUNCATE,
    })
  }
}

export const ResourceName = Object.freeze({
  DISK: 'disk',
  S3: 's3',
  RAM: 'ram',
  GITHUB: 'github',
  LINEAR: 'linear',
  GDOCS: 'gdocs',
  GSHEETS: 'gsheets',
  GSLIDES: 'gslides',
  GDRIVE: 'gdrive',
  DROPBOX: 'dropbox',
  BOX: 'box',
  SLACK: 'slack',
  DISCORD: 'discord',
  GMAIL: 'gmail',
  TRELLO: 'trello',
  MONGODB: 'mongodb',
  NOTION: 'notion',
  LANGFUSE: 'langfuse',
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
  QDRANT: 'qdrant',
  HF_BUCKETS: 'hf_buckets',
  HF_DATASETS: 'hf_datasets',
  HF_MODELS: 'hf_models',
  HF_SPACES: 'hf_spaces',
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

export const DEFAULT_SESSION_ID = 'default'
export const DEFAULT_AGENT_ID = 'default'

export const FileType = Object.freeze({
  DIRECTORY: 'directory',
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
  PARQUET: 'parquet',
  ORC: 'orc',
  FEATHER: 'feather',
  HDF5: 'hdf5',
} as const)

export type FileType = (typeof FileType)[keyof typeof FileType]

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
}

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
