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
  TELEGRAM: 'telegram',
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
  PAPERCLIP: 'paperclip',
  OPFS: 'opfs',
  SUPABASE: 'supabase',
  POSTGRES: 'postgres',
  SSCHOLAR_PAPER: 'sscholar-paper',
  SSCHOLAR_AUTHOR: 'sscholar-author',
  VERCEL: 'vercel',
  POSTHOG: 'posthog',
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
}

export class PathSpec {
  readonly original: string
  readonly directory: string
  readonly pattern: string | null
  readonly resolved: boolean
  readonly prefix: string

  constructor(init: PathSpecInit) {
    this.original = init.original
    this.directory = init.directory
    this.pattern = init.pattern ?? null
    this.resolved = init.resolved ?? true
    this.prefix = init.prefix ?? ''
    Object.freeze(this)
  }

  get stripPrefix(): string {
    if (this.prefix && this.original.startsWith(this.prefix)) {
      return this.original.slice(this.prefix.length) || '/'
    }
    return this.original
  }

  get key(): string {
    return this.stripPrefix.replace(/^\/+|\/+$/g, '')
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
    return `${this.original.replace(/\/+$/, '')}/${name}`
  }

  static fromStrPath(path: string, prefix = ''): PathSpec {
    const idx = path.lastIndexOf('/')
    const directory = path.slice(0, idx + 1) || '/'
    return new PathSpec({ original: path, directory, prefix })
  }
}
