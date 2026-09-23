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

import { S3Accessor } from '@struktoai/mirage-core/accessor/s3'
import { makeResolveGlob } from '@struktoai/mirage-core/commands/builtin/generic_bind/index'
import { S3_COMMANDS } from '@struktoai/mirage-core/commands/builtin/s3/index'
import type { RegisteredCommand } from '@struktoai/mirage-core/commands/config'
import { SCOPE_ERROR as S3_SCOPE_ERROR } from '@struktoai/mirage-core/core/s3/constants'
import { copy as copyCore } from '@struktoai/mirage-core/core/s3/copy'
import { create as createCore } from '@struktoai/mirage-core/core/s3/create'
import {
  entries as duEntriesCore,
  size as duSizeCore,
} from '@struktoai/mirage-core/core/s3/du/index'
import { exists as existsCore } from '@struktoai/mirage-core/core/s3/exists'
import { find as findCore } from '@struktoai/mirage-core/core/s3/find'
import { mkdir as mkdirCore } from '@struktoai/mirage-core/core/s3/mkdir'
import { read as readCore } from '@struktoai/mirage-core/core/s3/read'
import { readdir as readdirCore } from '@struktoai/mirage-core/core/s3/readdir'
import { rename as renameCore } from '@struktoai/mirage-core/core/s3/rename'
import { rmR as rmRCore } from '@struktoai/mirage-core/core/s3/rm'
import { rmdir as rmdirCore } from '@struktoai/mirage-core/core/s3/rmdir'
import { stat as statCore } from '@struktoai/mirage-core/core/s3/stat'
import {
  rangeRead as rangeReadCore,
  stream as streamCore,
} from '@struktoai/mirage-core/core/s3/stream'
import { truncate as truncateCore } from '@struktoai/mirage-core/core/s3/truncate'
import { unlink as unlinkCore } from '@struktoai/mirage-core/core/s3/unlink'
import { write as writeCore } from '@struktoai/mirage-core/core/s3/write'
import type { RegisteredOp } from '@struktoai/mirage-core/ops/registry'
import { S3_OPS } from '@struktoai/mirage-core/ops/s3/index'
import { BaseVFS } from '@struktoai/mirage-core/vfs/base'
import type { FindOptions, VFS } from '@struktoai/mirage-core/vfs/base'
import { normalizeKeyPrefix } from '@struktoai/mirage-core/vfs/s3/config'
import type { S3HttpAgents } from '@struktoai/mirage-core/vfs/s3/config'
import { S3_PROMPT } from '@struktoai/mirage-core/vfs/s3/prompt'
import { s3StorageId } from '@struktoai/mirage-core/vfs/s3/storage_id'
import { PathSpec, VFSName } from '@struktoai/mirage-core/types'
import type { FileStat } from '@struktoai/mirage-core/types'
import { mountKey, mountPrefixOf } from '@struktoai/mirage-core/utils/key_prefix'
import { HttpProxyAgent } from 'http-proxy-agent'
import { HttpsProxyAgent } from 'https-proxy-agent'
import { redactConfig, type S3Config, type S3ConfigRedacted } from './config.ts'
import { buildDeltaHook } from '@struktoai/mirage-core/core/s3/watch'
import { type DeltaHook } from '@struktoai/mirage-core/watch/index'

const globCore = makeResolveGlob(readdirCore, S3_SCOPE_ERROR)

function createProxyAgents(proxy: string): S3HttpAgents {
  return { httpAgent: new HttpProxyAgent(proxy), httpsAgent: new HttpsProxyAgent(proxy) }
}

export interface S3VFSState {
  type: string
  config: S3ConfigRedacted
}

export class S3VFS extends BaseVFS implements VFS {
  readonly kind: string = VFSName.S3
  readonly cachesReads: boolean = true
  readonly supportsSnapshot: boolean = true
  // byte store: stat() sizes every file from metadata
  readonly sizesAlwaysKnown: boolean = true
  // stat and read both stamp the ETag, so the gate compares like with
  // like. Inherited by every S3AliasVFS provider.
  readonly readRevalidatable: boolean = true
  override readonly indexTtl: number = 600
  readonly prompt: string = S3_PROMPT
  readonly config: S3Config
  readonly accessor: S3Accessor
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
    du_size: duSizeCore,
    du_entries: duEntriesCore,
    create: createCore,
    truncate: truncateCore,
    exists: existsCore,
    find_flat: findCore,
  }

  constructor(config: S3Config) {
    super()
    const normalized = normalizeKeyPrefix(config.keyPrefix)
    const cfg: S3Config = { ...config }
    if (normalized !== undefined) {
      cfg.keyPrefix = normalized
    } else {
      delete cfg.keyPrefix
    }
    this.config = cfg
    const proxy = cfg.proxy
    this.accessor = new S3Accessor({
      ...cfg,
      ...(proxy !== undefined && proxy !== ''
        ? { httpAgentProvider: () => createProxyAgents(proxy) }
        : {}),
    })
  }

  override storageId(): string {
    return s3StorageId(this.kind, this.config)
  }

  open(): Promise<void> {
    return Promise.resolve()
  }

  commands(): readonly RegisteredCommand[] {
    return S3_COMMANDS.toArray()
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
    return duSizeCore(this.accessor, p)
  }

  find(p: PathSpec, options: FindOptions = {}): Promise<string[]> {
    return findCore(this.accessor, p, options)
  }

  glob(paths: readonly PathSpec[], prefix = ''): Promise<PathSpec[]> {
    const effective = prefix
      ? paths.map((p) =>
          mountPrefixOf(p.virtual, p.vfsPath)
            ? p
            : new PathSpec({
                virtual: p.virtual,
                directory: p.directory,
                ...(p.pattern !== null ? { pattern: p.pattern } : {}),
                resolved: p.resolved,
                vfsPath: mountKey(p.virtual, prefix),
              }),
        )
      : paths
    return globCore(this.accessor, effective, this.index)
  }

  deltaHook(): DeltaHook {
    return buildDeltaHook(this.accessor)
  }

  override getState(): Promise<S3VFSState> {
    return Promise.resolve({
      type: this.kind,
      config: redactConfig(this.config),
    })
  }

  override loadState(_state: S3VFSState): Promise<void> {
    return Promise.resolve()
  }
}
