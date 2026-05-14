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

import {
  copy as copyCore,
  create as createCore,
  du as duCore,
  duAll as duAllCore,
  exists as existsCore,
  type FileStat,
  type FindOptions,
  find as findCore,
  type IndexCacheStore,
  mkdir as mkdirCore,
  PathSpec,
  RAMIndexCacheStore,
  rangeRead as rangeReadCore,
  S3_COMMANDS,
  read as readCore,
  readdir as readdirCore,
  type RegisteredCommand,
  type RegisteredOp,
  rename as renameCore,
  type Resource,
  ResourceName,
  resolveS3Glob as globCore,
  rmR as rmRCore,
  rmdir as rmdirCore,
  S3_OPS,
  S3_PROMPT,
  S3Accessor,
  stat as statCore,
  stream as streamCore,
  truncate as truncateCore,
  unlink as unlinkCore,
  write as writeCore,
} from '@struktoai/mirage-core'
import { redactConfig, type S3Config, type S3ConfigRedacted } from './config.ts'

export interface S3ResourceState {
  type: string
  needsOverride: boolean
  redactedFields: readonly string[]
  config: S3ConfigRedacted
}

export class S3Resource implements Resource {
  readonly kind: string = ResourceName.S3
  readonly isRemote: boolean = true
  readonly supportsSnapshot: boolean = true
  readonly indexTtl: number = 600
  readonly prompt: string = S3_PROMPT
  readonly config: S3Config
  readonly accessor: S3Accessor
  readonly index: IndexCacheStore
  readonly opsMap: Record<string, unknown> = {
    read_bytes: readCore,
    write: writeCore,
    readdir: readdirCore,
    stat: statCore,
    unlink: unlinkCore,
    rmdir: rmdirCore,
    copy: copyCore,
    rename: renameCore,
    mkdir: mkdirCore,
    read_stream: streamCore,
    range_read: rangeReadCore,
    rm_recursive: rmRCore,
    du_total: duCore,
    du_all: duAllCore,
    create: createCore,
    truncate: truncateCore,
    exists: existsCore,
    find_flat: findCore,
  }

  constructor(config: S3Config) {
    this.config = config
    this.accessor = new S3Accessor(this.config)
    this.index = new RAMIndexCacheStore({ ttl: this.indexTtl })
  }

  open(): Promise<void> {
    return Promise.resolve()
  }

  close(): Promise<void> {
    return Promise.resolve()
  }

  commands(): readonly RegisteredCommand[] {
    return S3_COMMANDS
  }

  ops(): readonly RegisteredOp[] {
    return S3_OPS
  }

  streamPath(p: PathSpec): AsyncIterable<Uint8Array> {
    return streamCore(this.accessor, p)
  }

  readFile(p: PathSpec): Promise<Uint8Array> {
    return readCore(this.accessor, p)
  }

  writeFile(p: PathSpec, data: Uint8Array): Promise<void> {
    return writeCore(this.accessor, p, data)
  }

  async appendFile(p: PathSpec, data: Uint8Array): Promise<void> {
    let existing: Uint8Array
    try {
      existing = await readCore(this.accessor, p)
    } catch (err) {
      if ((err as { code?: string } | null)?.code === 'ENOENT') {
        existing = new Uint8Array()
      } else {
        throw err
      }
    }
    const merged = new Uint8Array(existing.byteLength + data.byteLength)
    merged.set(existing, 0)
    merged.set(data, existing.byteLength)
    await writeCore(this.accessor, p, merged)
  }

  readdir(p: PathSpec): Promise<string[]> {
    return readdirCore(this.accessor, p, this.index)
  }

  stat(p: PathSpec): Promise<FileStat> {
    return statCore(this.accessor, p)
  }

  exists(p: PathSpec): Promise<boolean> {
    return existsCore(this.accessor, p)
  }

  mkdir(p: PathSpec): Promise<void> {
    return mkdirCore(this.accessor, p)
  }

  rmdir(p: PathSpec): Promise<void> {
    return rmdirCore(this.accessor, p)
  }

  unlink(p: PathSpec): Promise<void> {
    return unlinkCore(this.accessor, p)
  }

  rename(src: PathSpec, dst: PathSpec): Promise<void> {
    return renameCore(this.accessor, src, dst)
  }

  truncate(p: PathSpec, length: number): Promise<void> {
    return truncateCore(this.accessor, p, length)
  }

  copy(src: PathSpec, dst: PathSpec): Promise<void> {
    return copyCore(this.accessor, src, dst)
  }

  rmR(p: PathSpec): Promise<void> {
    return rmRCore(this.accessor, p)
  }

  du(p: PathSpec): Promise<number> {
    return duCore(this.accessor, p)
  }

  find(p: PathSpec, options: FindOptions = {}): Promise<string[]> {
    return findCore(this.accessor, p, options)
  }

  glob(paths: readonly PathSpec[], prefix = ''): Promise<PathSpec[]> {
    const effective = prefix
      ? paths.map((p) =>
          p.prefix
            ? p
            : new PathSpec({
                original: p.original,
                directory: p.directory,
                ...(p.pattern !== null ? { pattern: p.pattern } : {}),
                resolved: p.resolved,
                prefix,
              }),
        )
      : paths
    return globCore(this.accessor, effective, this.index)
  }

  async fingerprint(p: PathSpec): Promise<string | null> {
    try {
      const s = await statCore(this.accessor, p)
      const etag = (s.extra as { etag?: unknown }).etag
      return typeof etag === 'string' && etag !== '' ? etag : null
    } catch (err) {
      if ((err as { code?: string } | null)?.code === 'ENOENT') return null
      throw err
    }
  }

  getState(): Promise<S3ResourceState> {
    return Promise.resolve({
      type: this.kind,
      needsOverride: true,
      redactedFields: ['accessKeyId', 'secretAccessKey', 'sessionToken'],
      config: redactConfig(this.config),
    })
  }

  loadState(_state: S3ResourceState): Promise<void> {
    return Promise.resolve()
  }
}
