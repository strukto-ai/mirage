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
  extra?: Record<string, unknown>
}

export class FileStat {
  readonly name: string
  readonly size: number | null
  readonly modified: string | null
  readonly fingerprint: string | null
  readonly revision: string | null
  readonly type: FileType | null
  readonly extra: Record<string, unknown>

  constructor(init: FileStatInit) {
    this.name = init.name
    this.size = init.size ?? null
    this.modified = init.modified ?? null
    this.fingerprint = init.fingerprint ?? null
    this.revision = init.revision ?? null
    this.type = init.type ?? null
    this.extra = init.extra ?? {}
    Object.freeze(this)
  }
}

export interface PathSpecInit {
  original: string
  directory: string
  pattern?: string | null
  resolved?: boolean
  prefix?: string
  asTyped?: string | null
}

export class PathSpec {
  readonly original: string
  readonly directory: string
  readonly pattern: string | null
  readonly resolved: boolean
  readonly prefix: string
  readonly asTyped: string | null

  constructor(init: PathSpecInit) {
    this.original = init.original
    this.directory = init.directory
    this.pattern = init.pattern ?? null
    this.resolved = init.resolved ?? true
    this.prefix = init.prefix ?? ''
    this.asTyped = init.asTyped ?? null
    Object.freeze(this)
  }

  // The path as the user typed it, for rendering in output. Falls back to
  // `original` (the resolved absolute path) when no as-typed form was
  // recorded, e.g. for absolute arguments.
  get display(): string {
    return this.asTyped ?? this.original
  }

  get stripPrefix(): string {
    if (this.prefix && this.original.startsWith(this.prefix)) {
      const rest = this.original.slice(this.prefix.length)
      if (this.prefix.endsWith('/') || rest === '' || rest.startsWith('/')) {
        return rest === '' ? '/' : rest
      }
    }
    return this.original
  }

  get key(): string {
    return stripSlash(this.stripPrefix)
  }

  get dir(): PathSpec {
    return new PathSpec({
      original: this.directory,
      directory: this.directory,
      pattern: this.pattern,
      resolved: false,
      prefix: this.prefix,
    })
  }

  child(name: string): string {
    return `${rstripSlash(this.original)}/${name}`
  }

  static fromStrPath(path: string, prefix = ''): PathSpec {
    const idx = path.lastIndexOf('/')
    const directory = path.slice(0, idx + 1) || '/'
    return new PathSpec({ original: path, directory, prefix })
  }
}
