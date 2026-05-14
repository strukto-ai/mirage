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
  S3Accessor,
  stat as statCore,
  stream as streamCore,
  truncate as truncateCore,
  unlink as unlinkCore,
  write as writeCore,
} from '@struktoai/mirage-core'
import { redactConfig, type S3Config, type S3ConfigRedacted } from './config.ts'

export const S3_BROWSER_PROMPT = `{prefix}
  Remote S3 bucket accessed via presigned URLs (browser runtime).
  Supports the full filesystem command set: ls/tree/cat/grep/find/du/cp/mv/rm/etc.
  Listing operations require the presigner to sign LIST/COPY operations in
  addition to GET/PUT/HEAD/DELETE — see S3BrowserPresignedUrlProvider docs.`

export interface S3ResourceState {
  type: string
  needsOverride: boolean
  redactedFields: readonly string[]
  config: S3ConfigRedacted
}

export class S3Resource implements Resource {
  readonly supportsSnapshot: boolean = true
  readonly kind: string = ResourceName.S3
  readonly isRemote: boolean = true
  readonly indexTtl: number = 600
  readonly prompt: string = S3_BROWSER_PROMPT
  readonly config: S3Config
  readonly accessor: S3Accessor
  readonly index: IndexCacheStore

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
    return statCore(this.accessor, p, this.index)
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
      const s = await statCore(this.accessor, p, this.index)
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
      redactedFields: ['presignedUrlProvider'],
      config: redactConfig(this.config),
    })
  }

  loadState(_state: S3ResourceState): Promise<void> {
    return Promise.resolve()
  }

  // Ignored — duAll is not yet on the public Resource interface, but keeping
  // it around matches the node-side S3Resource.opsMap hook for completeness.
  _duAll(p: PathSpec): Promise<[string, number][]> {
    return duAllCore(this.accessor, p)
  }

  _rangeRead(p: PathSpec, offset: number, size: number): Promise<Uint8Array> {
    return rangeReadCore(this.accessor, p, offset, size)
  }

  _create(p: PathSpec): Promise<void> {
    return createCore(this.accessor, p)
  }
}
