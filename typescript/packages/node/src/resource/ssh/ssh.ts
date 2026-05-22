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
  BaseResource,
  type FileStat,
  type FindOptions,
  PathSpec,
  type RegisteredCommand,
  type RegisteredOp,
  type Resource,
  ResourceName,
} from '@struktoai/mirage-core'
import { SSHAccessor } from '../../accessor/ssh.ts'
import { SSH_COMMANDS } from '../../commands/builtin/ssh/index.ts'
import { appendBytes as appendCore } from '../../core/ssh/append.ts'
import { copy as copyCore } from '../../core/ssh/copy.ts'
import { create as createCore } from '../../core/ssh/create.ts'
import { du as duCore, duAll as duAllCore } from '../../core/ssh/du.ts'
import { exists as existsCore } from '../../core/ssh/exists.ts'
import { find as findCore, type FindOptions as SshFindOptions } from '../../core/ssh/find.ts'
import { resolveGlob as globCore } from '../../core/ssh/glob.ts'
import { mkdir as mkdirCore } from '../../core/ssh/mkdir.ts'
import { read as readCoreFn } from '../../core/ssh/read.ts'
import { readdir as readdirCore } from '../../core/ssh/readdir.ts'
import { rename as renameCore } from '../../core/ssh/rename.ts'
import { rmR as rmRCore } from '../../core/ssh/rm.ts'
import { rmdir as rmdirCore } from '../../core/ssh/rmdir.ts'
import { stat as statCore } from '../../core/ssh/stat.ts'
import { rangeRead as rangeReadCore, stream as streamCore } from '../../core/ssh/stream.ts'
import { truncate as truncateCore } from '../../core/ssh/truncate.ts'
import { unlink as unlinkCore } from '../../core/ssh/unlink.ts'
import { writeBytes as writeCore } from '../../core/ssh/write.ts'
import { SSH_OPS } from '../../ops/ssh/index.ts'
import { type SSHConfig, type SSHConfigRedacted, redactSshConfig } from './config.ts'
import { SSH_PROMPT } from './prompt.ts'

export interface SSHResourceState {
  type: string
  config: SSHConfigRedacted
}

export class SSHResource extends BaseResource implements Resource {
  readonly kind = ResourceName.SSH
  readonly isRemote: boolean = true
  readonly indexTtl: number = 60
  readonly prompt = SSH_PROMPT
  readonly config: SSHConfig
  readonly accessor: SSHAccessor
  readonly opsMap: Record<string, unknown> = {
    read_bytes: readCoreFn,
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
    append: appendCore,
  }

  constructor(config: SSHConfig) {
    super()
    this.config = config
    this.accessor = new SSHAccessor(config)
  }

  open(): Promise<void> {
    return Promise.resolve()
  }

  close(): Promise<void> {
    return this.accessor.close()
  }

  ops(): readonly RegisteredOp[] {
    return SSH_OPS
  }

  commands(): readonly RegisteredCommand[] {
    return SSH_COMMANDS
  }

  streamPath(p: PathSpec): AsyncIterable<Uint8Array> {
    return streamCore(this.accessor, p)
  }

  readFile(p: PathSpec): Promise<Uint8Array> {
    return readCoreFn(this.accessor, p)
  }

  writeFile(p: PathSpec, data: Uint8Array): Promise<void> {
    return writeCore(this.accessor, p, data)
  }

  appendFile(p: PathSpec, data: Uint8Array): Promise<void> {
    return appendCore(this.accessor, p, data)
  }

  readdir(p: PathSpec): Promise<string[]> {
    return readdirCore(this.accessor, p)
  }

  stat(p: PathSpec): Promise<FileStat> {
    return statCore(this.accessor, p)
  }

  exists(p: PathSpec): Promise<boolean> {
    return existsCore(this.accessor, p)
  }

  mkdir(p: PathSpec, options?: { recursive?: boolean }): Promise<void> {
    return mkdirCore(this.accessor, p, options?.recursive === true)
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
    return findCore(this.accessor, p, options as SshFindOptions)
  }

  async fingerprint(p: PathSpec): Promise<string | null> {
    try {
      const remote = await statCore(this.accessor, p)
      const mtime = remote.modified ?? ''
      const size = String(remote.size ?? 0)
      return `${mtime}:${size}`
    } catch (err) {
      if ((err as { code?: string }).code === 'ENOENT') return null
      throw err
    }
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
    return globCore(this.accessor, effective)
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async getState(): Promise<SSHResourceState> {
    return {
      type: this.kind,
      config: redactSshConfig(this.config),
    }
  }

  loadState(_state: SSHResourceState): Promise<void> {
    return Promise.resolve()
  }
}
